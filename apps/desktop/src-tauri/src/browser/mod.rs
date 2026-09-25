//! 原生浏览器宿主。
//!
//! 这一层是真实浏览器资源的唯一权威：tabId、profile 占用、控制归属、一次性下载授权
//! 都在这里，组件卸载或插件退出都不销毁它们。页面本身由引擎承载，每个构建目标只编译
//! 一个引擎：Windows 是主窗口下的 WebView2 子视图（`webview2`），macOS 与 Linux 是
//! 本机已安装的 Chromium 系浏览器的独立窗口（`chromium`）。两者对服务端说同一份协议。
//!
//! 三条不变量：
//!
//! 1. **AI 路径不碰系统焦点。** AI 建的页不取焦点：WebView2 的子视图移出可视区避让，
//!    Chromium 的页开在后台页签。
//! 2. **任何引擎调用都不能握着 `state` 锁。** WebView2 的 `add_child` 内部是
//!    `run_on_main_thread` 加阻塞等待，Chromium 引擎的调用要等 CDP 回包，而两种引擎的
//!    事件回调都要拿同一把锁。
//! 3. **归属的唯一判据是 `conversation_id`。** AI 页归开它的会话、跨消息稳定；
//!    用户页 `None`。下载裁决按它分岔，会话删除即关它名下的页。

/// 前端要调的那几条命令。**整份编译**，移动端只剩「没有内置浏览器」这一条答复——
/// `tauri::generate_handler!` 的清单在所有平台上引用同一组路径。
pub mod commands;

#[cfg(desktop)]
mod address;
#[cfg(desktop)]
mod bridge;
#[cfg(desktop)]
mod downloads;
#[cfg(desktop)]
mod frames;
#[cfg(desktop)]
mod profile;

#[cfg(all(desktop, not(windows)))]
mod chromium;
#[cfg(windows)]
mod webview2;

#[cfg(all(desktop, not(windows)))]
use chromium as engine;
#[cfg(windows)]
use webview2 as engine;

#[cfg(desktop)]
use std::collections::HashMap;
#[cfg(desktop)]
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(desktop)]
use tauri::{AppHandle, Emitter};

#[cfg(desktop)]
use commands::TabView;
#[cfg(desktop)]
use downloads::{Arm, ArmTable, Decision};
#[cfg(desktop)]
use frames::{EventFrame, Hello, HostReady, HostUnavailable, RequestFrame, ResultData, TabSnapshot};

#[cfg(desktop)]
use crate::hostkey::new_host_key;
#[cfg(desktop)]
use crate::ws::WsSender;

#[cfg(desktop)]
/// 进程内唯一的宿主。一个 qywork 进程只打开一份 profile，这个静态就是那份权威。
static HOST: OnceLock<Arc<BrowserHost>> = OnceLock::new();

/// 一次下载的裁决结果，由引擎的下载钩子执行。
///
/// `Allow` 带着被消费掉的那份授权的 downloadId：引擎把它绑到这一次下载上，终态按它回报。
/// 少了这个身份，同一页上的旧终态会结算新调用。
#[cfg(desktop)]
pub enum DownloadVerdict {
    /// 用户页：沿用浏览器提议的路径，不绑身份，也不回报终态。
    Default,
    /// 命中授权：写这个绝对路径，终态按这个身份回报。
    Allow(std::path::PathBuf, String),
    /// 取消。`download.blocked` 已经在裁决时发出。
    Cancel,
}

/// 引擎就绪时给得出的调试端点与运行时版本。`host.ready` 按它写。
#[cfg(desktop)]
pub struct Runtime {
    pub debug_port: u16,
    pub version: String,
}

/// 建一页要交给引擎的三样：这一页的 id、注入的标记、目标地址。
#[cfg(desktop)]
pub struct OpenSpec<'a> {
    pub tab_id: &'a str,
    pub marker: &'a str,
    pub url: &'a str,
    /// 这一页不该被提到前面。AI 建的页为真，用户新开的页为假。
    /// 嵌入式引擎的页一律不取焦点，摆到面板上才可见，不看它。
    #[cfg_attr(windows, allow(dead_code))]
    pub background: bool,
}

/// 引擎建出的一页：原生句柄，以及回包时刻的地址与标题。
#[cfg(desktop)]
pub struct Opened {
    pub page: engine::Page,
    pub url: String,
    pub title: String,
}

#[cfg(desktop)]
struct Tab {
    page: engine::Page,
    url: String,
    title: String,
    marker: String,
    /// 这一页所属的工作区 id。建页时定，此后不改——页面不在工作区之间移动。
    workspace_id: String,
    /// 外壳进程里的创建序号，与终端会话共用一个计数器。界面按它排页签条。
    created_seq: u64,
    /// 拥有它的会话 id；`None` = 用户手动开的页。归属跟着会话走，跨消息稳定。
    conversation_id: Option<String>,
}

#[cfg(desktop)]
impl Tab {
    fn snapshot(&self, tab_id: &str) -> TabSnapshot {
        TabSnapshot {
            tab_id: tab_id.to_owned(),
            url: self.url.clone(),
            title: self.title.clone(),
            marker: self.marker.clone(),
            workspace_id: self.workspace_id.clone(),
            conversation_id: self.conversation_id.clone(),
        }
    }
}

#[cfg(desktop)]
pub struct BrowserHost {
    /// 发 `browser:tabs` 用。界面那份标签页清单是这份状态的投影，只能由这里推。
    app: AppHandle,
    engine: engine::Engine,
    instance_id: String,
    state: Mutex<HostState>,
}

#[cfg(desktop)]
#[derive(Default)]
struct HostState {
    tabs: HashMap<String, Tab>,
    arms: ArmTable,
    sender: Option<Arc<WsSender>>,
    connection_epoch: u64,
    seq: u64,
    next_tab: u64,
    /// 置上之后连接线程不再重连。退出与异常断开的唯一分界。
    stopping: bool,
}

/// 拉起宿主：启动引擎、连上 sidecar 的宿主路径。
///
/// 失败只写日志并结束这条能力——浏览器控制起不来不该拦住整个应用启动。
#[cfg(desktop)]
pub fn start(app: &AppHandle, port: u16, key: String) {
    if key.is_empty() {
        return;
    }
    let engine = match engine::Engine::start(app) {
        Ok(engine) => engine,
        Err(reason) => {
            log::error!("浏览器宿主不启用：{reason}");
            return;
        }
    };
    let host = Arc::new(BrowserHost {
        app: app.clone(),
        engine,
        instance_id: new_host_key(),
        state: Mutex::new(HostState::default()),
    });
    if HOST.set(Arc::clone(&host)).is_err() {
        log::error!("浏览器宿主已经启动过一次");
        return;
    }
    bridge::spawn(app.clone(), host, port, key);
}

#[cfg(desktop)]
/// 断开宿主连接、关掉自有页，再让引擎收场。退出路径上调用，可重复调用。
pub fn shutdown() {
    let Some(host) = HOST.get() else { return };
    host.state.lock().expect("宿主状态锁被污染").stopping = true;
    host.disconnected();
    let pages = {
        let mut state = host.state.lock().expect("宿主状态锁被污染");
        state.tabs.drain().map(|(_, tab)| tab.page).collect::<Vec<_>>()
    };
    for page in pages {
        host.engine.close(page);
    }
    host.engine.shutdown();
}

/// 注入的标记。两种引擎在每个新文档创建时注入同一段。
///
/// 必须是不可写不可配置的属性：可写的话同源的另一个页面能把自己的标记改成这一页的值，
/// CDP 侧按标记认页就会认错。
#[cfg(desktop)]
fn marker_script(marker: &str) -> String {
    let value = serde_json::to_string(marker).unwrap_or_else(|_| "\"\"".into());
    format!(
        "Object.defineProperty(window,'__qyworkTab',{{value:{value},writable:false,configurable:false}});"
    )
}

/// 取请求帧里的工作区 id。空值与缺席一律拒绝：没有工作区的页在界面上无处归属，
/// 也无从判断该不该让另一个工作区的会话操作它。
#[cfg(desktop)]
fn workspace_of(frame: &RequestFrame, op: &str) -> Result<String, String> {
    match frame.workspace_id.as_deref() {
        Some(id) if !id.is_empty() => Ok(id.to_owned()),
        _ => Err(format!("{op} 缺少 workspaceId")),
    }
}

#[cfg(desktop)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(desktop)]
impl BrowserHost {
    /// 连接的首帧：引擎就绪时是 `host.ready`，没有可用浏览器时是 `host.unavailable`。
    fn hello(&self, state: &HostState, runtime: Result<Runtime, &'static str>) -> Hello {
        match runtime {
            Ok(runtime) => Hello::Ready(HostReady {
                kind: "host.ready",
                host_instance_id: self.instance_id.clone(),
                connection_epoch: state.connection_epoch,
                platform: std::env::consts::OS,
                runtime_version: runtime.version,
                debug_port: runtime.debug_port,
                tabs: state.tabs.iter().map(|(id, tab)| tab.snapshot(id)).collect(),
            }),
            Err(reason) => Hello::Unavailable(HostUnavailable { kind: "host.unavailable", reason }),
        }
    }

    /// 新连接接管发送端并自增纪元；旧纪元的请求与结果随之作废。
    ///
    /// 引擎还在启动时这里等到它给出结果：首帧要么带着可用的调试端点，要么如实说没有。
    fn connected(&self, sender: Arc<WsSender>) -> (u64, Hello) {
        let runtime = self.engine.settled();
        let mut state = self.state.lock().expect("宿主状态锁被污染");
        state.connection_epoch += 1;
        state.sender = Some(sender);
        (state.connection_epoch, self.hello(&state, runtime))
    }

    /// 断连：撤销全部未消费下载授权，**归属与页面都保留**。
    ///
    /// 归属键是会话 id、跨重连稳定，不像旧的控制纪元那样一断就失主；下载授权是
    /// 单次的一次性凭据，重连后本该重新登记，所以清掉。关 socket 在锁外做，
    /// 读线程随之从阻塞里返回。
    fn disconnected(&self) {
        let sender = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.arms.clear();
            state.sender.take()
        };
        if let Some(sender) = sender {
            sender.shutdown();
        }
        self.sync_downloads();
        self.changed();
    }

    fn is_stopping(&self) -> bool {
        self.state.lock().expect("宿主状态锁被污染").stopping
    }

    fn current_epoch(&self) -> u64 {
        self.state.lock().expect("宿主状态锁被污染").connection_epoch
    }

    /// 引擎按授权表是否为空切换下载行为。授权表一变就调，调用方不握锁。
    fn sync_downloads(&self) {
        if let Err(e) = self.engine.sync_downloads() {
            log::warn!("下载行为切换失败：{e}");
        }
    }

    /// 界面用的标签页清单。**只有 id / 地址 / 标题 / 工作区**：marker 与会话归属是 CDP 与
    /// 协调器的事，工具栏只是标准浏览器 chrome，不区分人工页与 AI 页。
    /// 工作区在这里出现，是因为界面要按它决定这一页在不在当前页签条上。
    fn views(&self) -> Vec<TabView> {
        let state = self.state.lock().expect("宿主状态锁被污染");
        let mut list: Vec<TabView> = state
            .tabs
            .iter()
            .map(|(id, tab)| TabView {
                tab_id: id.clone(),
                url: tab.url.clone(),
                title: tab.title.clone(),
                workspace_id: tab.workspace_id.clone(),
                created_seq: tab.created_seq,
            })
            .collect();
        // HashMap 的遍历顺序每次都不同。按创建序号排，与前端页签条的顺序规则同一份。
        list.sort_by_key(|view| view.created_seq);
        list
    }

    /// 把标签页清单推给界面。存活页、地址、标题、归属都只有这一个生产者。
    fn changed(&self) {
        let list = self.views();
        if let Err(e) = self.app.emit("browser:tabs", list) {
            log::warn!("标签页清单推送失败：{e}");
        }
    }

    /// 发一条事件帧。写 socket 在锁外做：它是阻塞写，握着锁会把主线程也拖住。
    fn emit(&self, event: &'static str, tab_id: String, fill: impl FnOnce(&mut EventFrame)) {
        let (sender, epoch, seq) = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.seq += 1;
            (state.sender.clone(), state.connection_epoch, state.seq)
        };
        let Some(sender) = sender else { return };
        let mut frame = EventFrame::new(epoch, seq, event, tab_id);
        fill(&mut frame);
        match serde_json::to_string(&frame) {
            Ok(text) => {
                if let Err(e) = sender.send_text(&text) {
                    log::warn!("浏览器事件发送失败：{e}");
                }
            }
            Err(e) => log::error!("浏览器事件序列化失败：{e}"),
        }
    }

    /// 执行一次资源操作。调用方已经做过纪元与期限准入。
    fn dispatch(&self, app: &AppHandle, frame: &RequestFrame) -> Result<ResultData, String> {
        match frame.op.as_str() {
            "create" => {
                let url = frame.url.clone().ok_or("create 缺少 url")?;
                let workspace_id = workspace_of(frame, "create")?;
                self.create(app, &url, workspace_id, frame.conversation_id.clone())
                    .map(|(data, _)| data)
            }
            "close" => self.close(frame.tab_id.as_deref().ok_or("close 缺少 tabId")?),
            "bind" => self.bind(
                frame.tab_id.as_deref().ok_or("bind 缺少 tabId")?,
                &workspace_of(frame, "bind")?,
                frame.conversation_id.as_deref().ok_or("bind 缺少 conversationId")?,
            ),
            "close.conversation" => self.close_conversation(
                frame.conversation_id.as_deref().ok_or("close.conversation 缺少 conversationId")?,
            ),
            "download.arm" => self.arm(
                frame.tab_id.as_deref().ok_or("download.arm 缺少 tabId")?,
                frame.path.as_deref().ok_or("download.arm 缺少 path")?,
                frame.conversation_id.as_deref().ok_or("download.arm 缺少 conversationId")?,
                frame.download_id.as_deref().ok_or("download.arm 缺少 downloadId")?,
                frame.deadline,
            ),
            "download.disarm" => {
                let tab_id = frame.tab_id.as_deref().ok_or("download.disarm 缺少 tabId")?;
                let download_id =
                    frame.download_id.as_deref().ok_or("download.disarm 缺少 downloadId")?;
                let removed = self
                    .state
                    .lock()
                    .expect("宿主状态锁被污染")
                    .arms
                    .disarm(tab_id, Some(download_id));
                self.sync_downloads();
                Ok(ResultData { removed: Some(removed), ..ResultData::default() })
            }
            other => Err(format!("认不出的操作 {other}")),
        }
    }

    /// 建一页。回的是服务端要的结果数据，以及这一页的创建序号——界面按序号排页签条，
    /// 而序号不属于宿主连接的协议。
    fn create(
        &self,
        app: &AppHandle,
        url: &str,
        workspace_id: String,
        conversation_id: Option<String>,
    ) -> Result<(ResultData, u64), String> {
        // 序号与 tabId 在同一把锁里领：分开领的话并发建页会让 `bt_N` 的编号
        // 与创建顺序不一致，页签上的「浏览器 2」排在「浏览器 1」前面。
        let (tab_id, created_seq, marker) = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.next_tab += 1;
            (format!("bt_{}", state.next_tab), crate::next_created_seq(), new_host_key())
        };
        // 建页在锁外：引擎要等主线程或 CDP 回包，而它们的回调要拿同一把锁。
        let opened = self.engine.open(
            app,
            OpenSpec {
                tab_id: &tab_id,
                marker: &marker,
                url,
                background: conversation_id.is_some(),
            },
        )?;
        let tab = Tab {
            page: opened.page,
            url: opened.url,
            title: opened.title,
            marker,
            workspace_id,
            created_seq,
            conversation_id,
        };
        Ok((self.admit(tab_id, tab), created_seq))
    }

    /// 一页进入存活集合。服务端只能从 `opened` 事件知道——用户自己新开的页也走这里。
    fn admit(&self, tab_id: String, tab: Tab) -> ResultData {
        let snapshot = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let entry = state.tabs.entry(tab_id.clone()).or_insert(tab);
            entry.snapshot(&tab_id)
        };
        self.emit("opened", tab_id, |f| {
            f.url = Some(snapshot.url.clone());
            f.title = Some(snapshot.title.clone());
            f.marker = Some(snapshot.marker.clone());
            f.workspace_id = Some(snapshot.workspace_id.clone());
            f.conversation_id = Some(snapshot.conversation_id.clone());
        });
        self.changed();
        ResultData {
            tab_id: Some(snapshot.tab_id),
            url: Some(snapshot.url),
            title: Some(snapshot.title),
            ..ResultData::default()
        }
    }

    fn close(&self, tab_id: &str) -> Result<ResultData, String> {
        let tab = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.arms.disarm(tab_id, None);
            state.tabs.remove(tab_id)
        };
        let tab = tab.ok_or_else(|| format!("认不出的标签页 {tab_id}"))?;
        self.engine.close(tab.page);
        self.sync_downloads();
        self.emit("closed", tab_id.to_owned(), |_| {});
        self.changed();
        Ok(ResultData::default())
    }

    /// 接管一个已存在的标签页，把它归给某条会话。
    ///
    /// 工作区先判：跨工作区的接管一律拒绝，页面不在工作区之间移动。
    /// 归属规则：用户页（`None`）→ 归给这条会话（用户在聊天里点名后模型才这么做）；
    /// 已归本会话 → 幂等放行；已归另一条会话 → 拒绝，不抢占。没有交接标记这一说。
    fn bind(
        &self,
        tab_id: &str,
        workspace_id: &str,
        conversation_id: &str,
    ) -> Result<ResultData, String> {
        let (snapshot, adopted) = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let tab = state
                .tabs
                .get_mut(tab_id)
                .ok_or_else(|| format!("认不出的标签页 {tab_id}"))?;
            if tab.workspace_id != workspace_id {
                return Err("这一页属于另一个工作区，接管不了".to_owned());
            }
            let adopted = match tab.conversation_id.as_deref() {
                Some(owner) if owner != conversation_id => {
                    return Err("这一页归另一条会话，接管不了".to_owned())
                }
                Some(_) => false,
                None => {
                    tab.conversation_id = Some(conversation_id.to_owned());
                    true
                }
            };
            (tab.snapshot(tab_id), adopted)
        };
        // 归属变了才报：服务端那份快照按事件维护，不报的话它认不到新主。
        if adopted {
            self.emit("control", tab_id.to_owned(), |f| {
                f.conversation_id = Some(Some(conversation_id.to_owned()));
            });
            self.changed();
        }
        Ok(ResultData {
            marker: Some(snapshot.marker),
            url: Some(snapshot.url),
            title: Some(snapshot.title),
            ..ResultData::default()
        })
    }

    /// 关掉一条会话名下的全部页。只有会话删除走这一条，页面不留孤儿；归档不关页。
    fn close_conversation(&self, conversation_id: &str) -> Result<ResultData, String> {
        let closed = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let ids: Vec<String> = state
                .tabs
                .iter()
                .filter(|(_, t)| t.conversation_id.as_deref() == Some(conversation_id))
                .map(|(id, _)| id.clone())
                .collect();
            let mut closed = Vec::new();
            for id in ids {
                state.arms.disarm(&id, None);
                if let Some(tab) = state.tabs.remove(&id) {
                    closed.push((id, tab.page));
                }
            }
            closed
        };
        for (id, page) in closed {
            self.engine.close(page);
            self.emit("closed", id, |_| {});
        }
        self.sync_downloads();
        self.changed();
        Ok(ResultData::default())
    }

    /// 登记一份授权。引擎切到按授权落盘的下载行为之后才回成功：服务端拿到回包就触发下载。
    fn arm(
        &self,
        tab_id: &str,
        path: &str,
        conversation_id: &str,
        download_id: &str,
        deadline: u64,
    ) -> Result<ResultData, String> {
        {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| format!("认不出的标签页 {tab_id}"))?;
            if tab.conversation_id.as_deref() != Some(conversation_id) {
                return Err("该标签页不归本会话".to_owned());
            }
            state.arms.arm(
                tab_id.to_owned(),
                Arm {
                    path: path.into(),
                    deadline_ms: deadline,
                    download_id: download_id.to_owned(),
                },
            )?;
        }
        if let Err(e) = self.engine.sync_downloads() {
            self.state.lock().expect("宿主状态锁被污染").arms.disarm(tab_id, Some(download_id));
            self.sync_downloads();
            return Err(format!("下载行为切换失败：{e}"));
        }
        Ok(ResultData::default())
    }

    /// 记下引擎投影回来的地址。
    fn note_navigated(&self, tab_id: &str, url: &str) {
        {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let Some(tab) = state.tabs.get_mut(tab_id) else { return };
            tab.url = url.to_owned();
        }
        self.emit("navigated", tab_id.to_owned(), |f| f.url = Some(url.to_owned()));
        self.changed();
    }

    fn note_title(&self, tab_id: &str, title: &str) {
        {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let Some(tab) = state.tabs.get_mut(tab_id) else { return };
            tab.title = title.to_owned();
        }
        self.emit("title", tab_id.to_owned(), |f| f.title = Some(title.to_owned()));
        self.changed();
    }

    /// 一次下载开始时的裁决。授权表是唯一判据，拦下的那一次就地发 `download.blocked`。
    ///
    /// `tab_id` 为 `None` 表示这次下载不来自任何存活页（用户在浏览器窗口里自己开的页），
    /// 按用户下载放行。拦截事件带上被消费掉的授权身份；没有消费到授权（页面自己发起的
    /// 下载）时不带，服务端因此不会用它结算任何工具调用。
    fn decide_download(
        &self,
        tab_id: Option<&str>,
        url: &str,
        suggested: Option<String>,
    ) -> DownloadVerdict {
        let Some(tab_id) = tab_id else { return DownloadVerdict::Default };
        let decision = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let manual = state
                .tabs
                .get(tab_id)
                .map(|t| t.conversation_id.is_none())
                .unwrap_or(true);
            state.arms.decide(tab_id, manual, now_ms())
        };
        match decision {
            Decision::AllowDefault => DownloadVerdict::Default,
            Decision::Allow(path, download_id) => DownloadVerdict::Allow(path, download_id),
            Decision::Block(reason, download_id) => {
                let url = url.to_owned();
                self.emit("download.blocked", tab_id.to_owned(), move |f| {
                    f.reason = Some(reason);
                    f.url = Some(url);
                    f.suggested_name = suggested;
                    f.download_id = download_id;
                });
                DownloadVerdict::Cancel
            }
        }
    }

    /// 下载报出终态。只有消费过授权的下载走到这里，身份因此一定在。
    fn note_download_finished(
        &self,
        tab_id: &str,
        path: Option<String>,
        success: bool,
        download_id: &str,
    ) {
        let download_id = download_id.to_owned();
        self.emit("download.finished", tab_id.to_owned(), move |f| {
            f.path = path;
            f.success = Some(success);
            f.download_id = Some(download_id);
        });
    }
}

/// 只有独立窗口的引擎会发起的宿主操作：页面自己开的新页、用户在浏览器里关掉的页、
/// 浏览器进程换代。嵌入式引擎的页只经宿主的命令进出。
#[cfg(all(desktop, not(windows)))]
impl BrowserHost {
    /// 授权表里还有没有授权。引擎按它决定下载行为。
    fn downloads_armed(&self) -> bool {
        !self.state.lock().expect("宿主状态锁被污染").arms.is_empty()
    }

    /// 一个存活页自己开出来的新页。它继承开它的那一页的工作区与归属：
    /// 弹窗是那一页的操作结果，归属不因为换了一页而变。开它的页已经不在时不收。
    fn note_popup(
        &self,
        opener_tab: &str,
        page: engine::Page,
        marker: String,
        url: String,
        title: String,
    ) -> Option<String> {
        let (tab_id, tab) = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let opener = state.tabs.get(opener_tab)?;
            let workspace_id = opener.workspace_id.clone();
            let conversation_id = opener.conversation_id.clone();
            state.next_tab += 1;
            let tab_id = format!("bt_{}", state.next_tab);
            let tab = Tab {
                page,
                url,
                title,
                marker,
                workspace_id,
                created_seq: crate::next_created_seq(),
                conversation_id,
            };
            (tab_id, tab)
        };
        self.admit(tab_id.clone(), tab);
        Some(tab_id)
    }

    /// 浏览器那边已经没有这一页了（用户关掉、页面自己关掉）。宿主关的页已先从表里摘掉，
    /// 走到这里时查不到，不重复报 `closed`。
    fn note_closed(&self, tab_id: &str) {
        let removed = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.arms.disarm(tab_id, None);
            state.tabs.remove(tab_id).is_some()
        };
        if !removed {
            return;
        }
        self.sync_downloads();
        self.emit("closed", tab_id.to_owned(), |_| {});
        self.changed();
    }

    /// 浏览器进程退出或重新起来。上一个进程里的页与授权都已作废；连着的话在同一条连接上
    /// 按新纪元重发首帧，服务端据此换掉调试端点或撤下能力。
    fn engine_changed(&self, runtime: Result<Runtime, &'static str>) {
        let (sender, hello) = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.tabs.clear();
            state.arms.clear();
            let Some(sender) = state.sender.clone() else {
                drop(state);
                self.changed();
                return;
            };
            state.connection_epoch += 1;
            (sender, self.hello(&state, runtime))
        };
        match serde_json::to_string(&hello) {
            Ok(text) => {
                if let Err(e) = sender.send_text(&text) {
                    log::warn!("浏览器宿主首帧发送失败：{e}");
                }
            }
            Err(e) => log::error!("浏览器宿主首帧序列化失败：{e}"),
        }
        self.changed();
    }
}

#[cfg(desktop)]
/// 供引擎的回调取回宿主。回调拿到的是同一份权威。
fn host() -> Option<&'static Arc<BrowserHost>> {
    HOST.get()
}

#[cfg(desktop)]
const NO_HOST: &str = "内置浏览器没有启用";

/// 界面此刻看得见的标签页。宿主没起来时是空的，不是错误：入口本来就不显示。
#[cfg(desktop)]
pub fn tab_views() -> Vec<TabView> {
    host().map(|h| h.views()).unwrap_or_default()
}

/// 用户新开一页。
///
/// 走的是 AI 建页那条 `create`，只是不带会话归属——同一个宿主、同一份 profile、
/// 同一套下载裁决。**不要另写一条用户专用的建页路径**：两条路会在参数串、
/// 标记注入与首个文档等待上分头漂移。
#[cfg(desktop)]
pub fn user_open(app: &AppHandle, url: Option<&str>, workspace_id: &str) -> Result<TabView, String> {
    let host = host().ok_or(NO_HOST)?;
    if workspace_id.is_empty() {
        return Err("新建标签页缺少工作区".to_owned());
    }
    // 不给地址就是一页空标签，地址由用户在地址栏里输入。
    let target = url.unwrap_or(address::BLANK);
    let (data, created_seq) = host.create(app, target, workspace_id.to_owned(), None)?;
    Ok(TabView {
        tab_id: data.tab_id.unwrap_or_default(),
        url: data.url.unwrap_or_default(),
        title: data.title.unwrap_or_default(),
        workspace_id: workspace_id.to_owned(),
        created_seq,
    })
}

#[cfg(desktop)]
pub fn user_close(tab_id: &str) -> Result<(), String> {
    host().ok_or(NO_HOST)?.close(tab_id).map(|_| ())
}

/// 人工导航。真实引擎导航，地址由引擎的导航事件回投，不在这里改状态。
#[cfg(desktop)]
pub fn user_navigate(tab_id: &str, action: &str, url: Option<&str>) -> Result<(), String> {
    let host = host().ok_or(NO_HOST)?;
    let page = {
        let state = host.state.lock().expect("宿主状态锁被污染");
        state
            .tabs
            .get(tab_id)
            .map(|t| t.page.clone())
            .ok_or_else(|| format!("认不出的标签页 {tab_id}"))?
    };
    host.engine.navigate(&page, action, url)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::marker_script;

    #[test]
    fn marker_script_defines_a_locked_property() {
        let script = marker_script("ab\"cd");
        assert!(script.contains("writable:false"), "{script}");
        assert!(script.contains("configurable:false"), "{script}");
        // 标记经 JSON 转义，注入的字符串不能从属性值里逃出去。
        assert!(script.contains("\"ab\\\"cd\""), "{script}");
    }
}
