//! 原生浏览器宿主。
//!
//! 本模块是真实浏览器资源的唯一权威：tabId、profile 占用、控制归属与一次性下载授权
//! 都保存在此处，组件卸载或插件退出均不销毁它们。页面由引擎承载，每个构建目标只编译
//! 一个引擎：Windows 上是主窗口下的 WebView2 子视图（`webview2`），macOS 与 Linux 上是
//! 本机已安装的 Chromium 系浏览器的独立窗口（`chromium`）。两者对服务端使用同一份协议。
//!
//! 三条不变量：
//!
//! 1. **AI 路径不改变系统焦点。** AI 创建的页不获取焦点：WebView2 的子视图移出可视区，
//!    Chromium 的页在后台页签中打开。
//! 2. **任何引擎调用都不得持有 `state` 锁。** WebView2 的 `add_child` 内部是
//!    `run_on_main_thread` 加阻塞等待，Chromium 引擎的调用需要等待 CDP 响应，而两种引擎的
//!    事件回调都需要获取同一把锁。
//! 3. **归属的唯一判据是 `conversation_id`。** AI 页属于创建它的会话，跨消息保持不变；
//!    用户页为 `None`。下载裁决按它分支，会话删除时关闭其名下的页。

/// 前端调用的命令。所有平台都编译整个模块，移动端的每条命令都返回同一条不支持的错误：
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
/// 进程内唯一的宿主。一个 qywork 进程只打开一份 profile，该静态变量即是唯一权威。
static HOST: OnceLock<Arc<BrowserHost>> = OnceLock::new();

/// 一次下载的裁决结果，由引擎的下载钩子执行。
///
/// `Allow` 携带被消费授权的 downloadId：引擎将其绑定到本次下载，终态按它上报。
/// 缺少该身份时，同一页上的旧终态会结算新调用。
#[cfg(desktop)]
pub enum DownloadVerdict {
    /// 用户页：使用浏览器建议的路径，不绑定身份，也不上报终态。
    Default,
    /// 命中授权：写入该绝对路径，终态按该身份上报。
    Allow(std::path::PathBuf, String),
    /// 取消。`download.blocked` 已在裁决时发出。
    Cancel,
}

/// 引擎就绪时提供的调试端点与运行时版本。`host.ready` 据此生成。
#[cfg(desktop)]
pub struct Runtime {
    pub debug_port: u16,
    pub version: String,
}

/// 创建页面时交给引擎的三项参数：页面 id、注入的标记、目标地址。
#[cfg(desktop)]
pub struct OpenSpec<'a> {
    pub tab_id: &'a str,
    pub marker: &'a str,
    pub url: &'a str,
    /// 该页不应置于前台。AI 创建的页为真，用户新建的页为假。
    /// 嵌入式引擎的页一律不获取焦点，放入面板后才可见，因此忽略该字段。
    #[cfg_attr(windows, allow(dead_code))]
    pub background: bool,
}

/// 引擎创建的页面：原生句柄，以及返回时的地址与标题。
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
    /// 该页所属的工作区 id。创建时确定，此后不变：页面不在工作区之间移动。
    workspace_id: String,
    /// 外壳进程中的创建序号，与终端会话共用一个计数器。界面按它排列页签条。
    created_seq: u64,
    /// 拥有该页的会话 id；`None` 表示用户手动打开的页。归属由会话决定，跨消息保持不变。
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
    /// 用于发送 `browser:tabs`。界面的标签页清单是本状态的投影，只能由此处推送。
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
    /// 置位后连接线程不再重连。这是区分正常退出与异常断开的唯一依据。
    stopping: bool,
}

/// 启动宿主：启动引擎并连接 sidecar 的宿主路径。
///
/// 失败时只写日志并停用该能力：浏览器控制无法启动时不应阻止整个应用启动。
#[cfg(desktop)]
pub fn start(app: &AppHandle, port: u16, key: String) {
    if key.is_empty() {
        return;
    }
    let engine = match engine::Engine::start(app) {
        Ok(engine) => engine,
        Err(reason) => {
            log::error!("浏览器宿主未启用：{reason}");
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
        log::error!("浏览器宿主重复启动");
        return;
    }
    bridge::spawn(app.clone(), host, port, key);
}

#[cfg(desktop)]
/// 断开宿主连接、关闭自有页，再关闭引擎。在退出路径上调用，可重复调用。
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

/// 注入的标记。两种引擎在每个新文档创建时注入同一段脚本。
///
/// 必须是不可写且不可配置的属性：若可写，同源的另一个页面能把自身的标记改为该页的值，
/// CDP 侧按标记识别页面时就会识别错误。
#[cfg(desktop)]
fn marker_script(marker: &str) -> String {
    let value = serde_json::to_string(marker).unwrap_or_else(|_| "\"\"".into());
    format!(
        "Object.defineProperty(window,'__qyworkTab',{{value:{value},writable:false,configurable:false}});"
    )
}

/// 取请求帧中的工作区 id。空值与缺失一律拒绝：没有工作区的页在界面上没有归属位置，
/// 也无法判断是否允许另一个工作区的会话操作它。
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
                presentation: engine::PRESENTATION,
                runtime_version: runtime.version,
                debug_port: runtime.debug_port,
                tabs: state.tabs.iter().map(|(id, tab)| tab.snapshot(id)).collect(),
            }),
            Err(reason) => Hello::Unavailable(HostUnavailable { kind: "host.unavailable", reason }),
        }
    }

    /// 新连接接管发送端并自增纪元；旧纪元的请求与结果随之作废。
    ///
    /// 引擎仍在启动时，此处等待其结果：首帧要么携带可用的调试端点，要么声明没有可用浏览器。
    fn connected(&self, sender: Arc<WsSender>) -> (u64, Hello) {
        let runtime = self.engine.settled();
        let mut state = self.state.lock().expect("宿主状态锁被污染");
        state.connection_epoch += 1;
        state.sender = Some(sender);
        (state.connection_epoch, self.hello(&state, runtime))
    }

    /// 断开连接：撤销全部未消费的下载授权，保留归属与页面。
    ///
    /// 归属键是会话 id，跨重连保持不变，断开连接不会使页面失去归属；下载授权是
    /// 一次性凭据，重连后应重新登记，因此清除。socket 在锁外关闭，
    /// 读线程随之从阻塞中返回。
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

    /// 取页面的引擎句柄。引擎调用在锁外执行，此处只复制句柄。
    fn page(&self, tab_id: &str) -> Result<engine::Page, String> {
        let state = self.state.lock().expect("宿主状态锁被污染");
        state
            .tabs
            .get(tab_id)
            .map(|t| t.page.clone())
            .ok_or_else(|| format!("无法识别的标签页 {tab_id}"))
    }

    fn current_epoch(&self) -> u64 {
        self.state.lock().expect("宿主状态锁被污染").connection_epoch
    }

    /// 引擎按授权表是否为空切换下载行为。授权表每次变化后调用，调用方不得持有锁。
    fn sync_downloads(&self) {
        if let Err(e) = self.engine.sync_downloads() {
            log::warn!("下载行为切换失败：{e}");
        }
    }

    /// 界面使用的标签页清单，只包含 id、地址、标题与工作区：marker 与会话归属由 CDP 与
    /// 协调器处理，工具栏是标准浏览器 chrome，不区分用户页与 AI 页。
    /// 包含工作区是因为界面需要按它判断该页是否显示在当前页签条上。
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
        // HashMap 的遍历顺序不固定。按创建序号排序，与前端页签条的排序规则一致。
        list.sort_by_key(|view| view.created_seq);
        list
    }

    /// 把标签页清单推送给界面。存活页、地址、标题与归属只有这一个生产者。
    fn changed(&self) {
        let list = self.views();
        if let Err(e) = self.app.emit("browser:tabs", list) {
            log::warn!("标签页清单推送失败：{e}");
        }
    }

    /// 发送一条事件帧。socket 写入在锁外执行：它是阻塞写入，持有锁时会同时阻塞主线程。
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

    /// 执行一次资源操作。调用方已完成纪元与期限的准入检查。
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
            other => Err(format!("无法识别的操作 {other}")),
        }
    }

    /// 创建一页。返回服务端需要的结果数据，以及该页的创建序号：界面按序号排列页签条，
    /// 而序号不属于宿主连接的协议。
    fn create(
        &self,
        app: &AppHandle,
        url: &str,
        workspace_id: String,
        conversation_id: Option<String>,
    ) -> Result<(ResultData, u64), String> {
        // 序号与 tabId 在同一次加锁中分配：分开分配时，并发创建页面会使 `bt_N` 的编号
        // 与创建顺序不一致，页签上的「浏览器 2」会排在「浏览器 1」之前。
        let (tab_id, created_seq, marker) = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.next_tab += 1;
            (format!("bt_{}", state.next_tab), crate::next_created_seq(), new_host_key())
        };
        // 在锁外创建页面：引擎需要等待主线程或 CDP 响应，而它们的回调需要获取同一把锁。
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

    /// 页面进入存活集合。服务端只能从 `opened` 事件得知新页，用户新建的页同样经由此处。
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
        let tab = tab.ok_or_else(|| format!("无法识别的标签页 {tab_id}"))?;
        self.engine.close(tab.page);
        self.sync_downloads();
        self.emit("closed", tab_id.to_owned(), |_| {});
        self.changed();
        Ok(ResultData::default())
    }

    /// 接管一个已存在的标签页，将其归属于指定会话。
    ///
    /// 先判定工作区：跨工作区的接管一律拒绝，页面不在工作区之间移动。
    /// 归属规则：用户页（`None`）→ 归属本会话（模型只在用户于对话中指定该页后执行）；
    /// 已属于本会话 → 幂等放行；已属于另一条会话 → 拒绝，不抢占。不存在交接标记。
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
                .ok_or_else(|| format!("无法识别的标签页 {tab_id}"))?;
            if tab.workspace_id != workspace_id {
                return Err("该页属于另一个工作区，无法接管".to_owned());
            }
            let adopted = match tab.conversation_id.as_deref() {
                Some(owner) if owner != conversation_id => {
                    return Err("该页属于另一条会话，无法接管".to_owned())
                }
                Some(_) => false,
                None => {
                    tab.conversation_id = Some(conversation_id.to_owned());
                    true
                }
            };
            (tab.snapshot(tab_id), adopted)
        };
        // 仅在归属变化时上报：服务端的快照按事件维护，不上报时服务端无法得知新的归属。
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

    /// 关闭一条会话名下的全部页。只有删除会话调用此方法，以免留下孤立页面；归档不关闭页面。
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

    /// 登记一份授权。引擎切换到按授权写入磁盘的下载行为之后才返回成功：服务端收到响应即触发下载。
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
                .ok_or_else(|| format!("无法识别的标签页 {tab_id}"))?;
            if tab.conversation_id.as_deref() != Some(conversation_id) {
                return Err("该标签页不属于本会话".to_owned());
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

    /// 记录引擎回传的地址。
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

    /// 下载开始时的裁决。授权表是唯一判据，被拦截的下载当场发送 `download.blocked`。
    ///
    /// `tab_id` 为 `None` 表示本次下载不来自任何存活页（用户在浏览器窗口中自行打开的页），
    /// 按用户下载放行。拦截事件携带被消费授权的身份；未消费授权（页面自行发起的
    /// 下载）时不携带，服务端因此不会用它结算任何工具调用。
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

    /// 下载上报终态。只有消费过授权的下载会到达此处，因此身份必定存在。
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

/// 只有独立窗口引擎会发起的宿主操作：页面自行打开的新页、用户在浏览器中关闭的页、
/// 浏览器进程重启。嵌入式引擎的页只经由宿主命令创建与关闭。
#[cfg(all(desktop, not(windows)))]
impl BrowserHost {
    /// 授权表中是否还有授权。引擎据此决定下载行为。
    fn downloads_armed(&self) -> bool {
        !self.state.lock().expect("宿主状态锁被污染").arms.is_empty()
    }

    /// 存活页自行打开的新页。新页继承打开它的页的工作区与归属：
    /// 弹窗是原页面的操作结果，归属不因页面不同而改变。打开它的页已不存在时不接收。
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

    /// 浏览器中该页已不存在（用户关闭或页面自行关闭）。宿主关闭的页已先从表中移除，
    /// 到达此处时表中已无该页，不重复上报 `closed`。
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

    /// 浏览器进程退出或重新启动。上一个进程中的页与授权均已作废；连接仍存在时在同一条连接上
    /// 按新纪元重发首帧，服务端据此替换调试端点或撤销能力。
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
/// 供引擎回调获取宿主。回调取得的是同一份权威。
fn host() -> Option<&'static Arc<BrowserHost>> {
    HOST.get()
}

#[cfg(desktop)]
const NO_HOST: &str = "内置浏览器未启用";

/// 界面当前可见的标签页。宿主未启动时返回空列表而非错误：此时界面不显示入口。
#[cfg(desktop)]
pub fn tab_views() -> Vec<TabView> {
    host().map(|h| h.views()).unwrap_or_default()
}

/// 用户新建一页。
///
/// 使用 AI 新建页面的同一个 `create`，只是不带会话归属：同一个宿主、同一份 profile、
/// 同一套下载裁决。**不要另写用户专用的新建页面路径**：两条路径会在启动参数、
/// 标记注入与首个文档等待上逐渐不一致。
#[cfg(desktop)]
pub fn user_open(app: &AppHandle, url: Option<&str>, workspace_id: &str) -> Result<TabView, String> {
    let host = host().ok_or(NO_HOST)?;
    if workspace_id.is_empty() {
        return Err("新建标签页缺少工作区".to_owned());
    }
    // 不提供地址时创建空白标签页，地址由用户在地址栏中输入。
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

/// 用户导航。由引擎执行导航，地址由引擎的导航事件回传，此处不修改状态。
#[cfg(desktop)]
pub fn user_navigate(tab_id: &str, action: &str, url: Option<&str>) -> Result<(), String> {
    let host = host().ok_or(NO_HOST)?;
    let page = host.page(tab_id)?;
    host.engine.navigate(&page, action, url)
}

/// 用户查看某一页：把该页所在的浏览器窗口置于前台。只有页面位于独立窗口的引擎支持此操作。
#[cfg(all(desktop, not(windows)))]
pub fn user_activate(tab_id: &str) -> Result<(), String> {
    let host = host().ok_or(NO_HOST)?;
    let page = host.page(tab_id)?;
    host.engine.activate(&page)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::marker_script;

    #[test]
    fn marker_script_defines_a_locked_property() {
        let script = marker_script("ab\"cd");
        assert!(script.contains("writable:false"), "{script}");
        assert!(script.contains("configurable:false"), "{script}");
        // 标记经过 JSON 转义，注入的字符串无法逃逸出属性值。
        assert!(script.contains("\"ab\\\"cd\""), "{script}");
    }
}
