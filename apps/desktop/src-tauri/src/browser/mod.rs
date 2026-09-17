//! 原生浏览器宿主。
//!
//! 这一层是真实浏览器资源的唯一权威：子 WebView 句柄、tabId、profile 占用、
//! 控制归属、一次性下载授权都在这里，组件卸载或插件退出都不销毁它们。
//!
//! 三条不变量：
//!
//! 1. **AI 路径不碰系统焦点。** 子视图以 `.focused(false)` 建出，避让只用
//!    `set_position` 移出可视区——`hide()` 会让页面不再出帧，截图与等待一起挂起。
//! 2. **任何 Tauri webview 调用都不能握着 `state` 锁。** `add_child` 内部是
//!    `run_on_main_thread` 加阻塞等待，而下载与导航钩子在主线程上要拿同一把锁。
//! 3. **归属的唯一判据是 `conversation_id`。** AI 页归开它的会话、跨消息稳定；
//!    用户页 `None`。下载裁决按它分岔，会话删除即关它名下的页。

/// 前端要调的那几条命令。**整份编译**，Windows 之外只剩「没有内置浏览器」这一条答复——
/// `tauri::generate_handler!` 的清单在所有平台上引用同一组路径。
pub mod commands;

#[cfg(windows)]
mod bridge;
#[cfg(windows)]
mod downloads;
#[cfg(windows)]
mod frames;
#[cfg(windows)]
mod profile;
#[cfg(windows)]
mod tabs;
#[cfg(windows)]
mod ws;

#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(windows)]
use tauri::{AppHandle, Emitter, Wry};

#[cfg(windows)]
use commands::TabView;
#[cfg(windows)]
use downloads::{Arm, ArmTable, Decision};
#[cfg(windows)]
use frames::{EventFrame, HostReady, RequestFrame, ResultData};
#[cfg(windows)]
use profile::ProfileLock;
#[cfg(windows)]
use tabs::Tab;
#[cfg(windows)]
use ws::WsSender;

#[cfg(windows)]
/// 进程内唯一的宿主。一个 qywork 进程只打开一份 profile，这个静态就是那份权威。
static HOST: OnceLock<Arc<BrowserHost>> = OnceLock::new();

/// 一次下载的裁决结果，由原生下载钩子执行。
///
/// `Allow` 带着被消费掉的那份授权的 downloadId：钩子把它绑到下载对象上，终态按它回报。
/// 少了这个身份，同一页上的旧终态会结算新调用。
#[cfg(windows)]
pub enum DownloadVerdict {
    /// 用户页：沿用浏览器提议的路径，不绑身份，也不回报终态。
    Default,
    /// 命中授权：写这个绝对路径，终态按这个身份回报。
    Allow(std::path::PathBuf, String),
    /// 取消。`download.blocked` 已经在裁决时发出。
    Cancel,
}

#[cfg(windows)]
pub struct BrowserHost {
    /// 发 `browser:tabs` 用。界面那份标签页清单是这份状态的投影，只能由这里推。
    app: AppHandle,
    profile: ProfileLock,
    debug_port: u16,
    instance_id: String,
    runtime_version: String,
    state: Mutex<HostState>,
}

#[cfg(windows)]
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

#[cfg(windows)]
/// 一次随机凭据。只在本次启动有效，经受控环境变量交给 sidecar。
pub fn new_host_key() -> String {
    let mut raw = [0u8; 32];
    // SAFETY: 缓冲区长度与传入的字节数一致；系统首选 RNG 不需要算法句柄。
    let status = unsafe {
        windows::Win32::Security::Cryptography::BCryptGenRandom(
            None,
            &mut raw,
            windows::Win32::Security::Cryptography::BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status.is_err() {
        // 取不到系统随机数时不降级成可预测的凭据：没有凭据即不发布这条能力。
        log::error!("取系统随机数失败，浏览器宿主连接不启用：{status:?}");
        return String::new();
    }
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

/// 拉起宿主：占用 profile、分配回环 CDP 端口、连上 sidecar 的宿主路径。
///
/// 失败只写日志并结束这条能力——浏览器控制起不来不该拦住整个应用启动。
#[cfg(windows)]
pub fn start(app: &AppHandle, port: u16, key: String) {
    if key.is_empty() {
        return;
    }
    let Some(dir) = profile::profile_dir() else {
        log::error!("取不到配置根目录，浏览器宿主不启用");
        return;
    };
    let profile = match profile::lock(&dir) {
        Ok(lock) => lock,
        Err(reason) => {
            log::error!("浏览器宿主不启用：{reason}");
            return;
        }
    };
    let Some(debug_port) = free_loopback_port() else {
        log::error!("分配不到回环调试端口，浏览器宿主不启用");
        return;
    };
    let runtime_version = tauri::webview_version().unwrap_or_default();
    let host = Arc::new(BrowserHost {
        app: app.clone(),
        profile,
        debug_port,
        instance_id: new_host_key(),
        runtime_version,
        state: Mutex::new(HostState::default()),
    });
    if HOST.set(Arc::clone(&host)).is_err() {
        log::error!("浏览器宿主已经启动过一次");
        return;
    }
    log::info!(
        "浏览器宿主已就绪 profile={} debugPort={debug_port} runtime={}",
        host.profile.dir().display(),
        host.runtime_version
    );
    bridge::spawn(app.clone(), host, port, key);
}

#[cfg(windows)]
/// 断开宿主连接并关掉自有子视图。退出路径上调用，可重复调用。
pub fn shutdown() {
    let Some(host) = HOST.get() else { return };
    host.state.lock().expect("宿主状态锁被污染").stopping = true;
    host.disconnected();
    let views = {
        let mut state = host.state.lock().expect("宿主状态锁被污染");
        state.tabs.drain().map(|(_, tab)| tab).collect::<Vec<_>>()
    };
    for tab in views {
        tab.close();
    }
}

/// 让内核挑一个空闲回环端口。子视图共用一个 WebView2 environment，
/// 因此这个端口整个进程只分配一次。
#[cfg(windows)]
fn free_loopback_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

/// 取请求帧里的工作区 id。空值与缺席一律拒绝：没有工作区的页在界面上无处归属，
/// 也无从判断该不该让另一个工作区的会话操作它。
#[cfg(windows)]
fn workspace_of(frame: &RequestFrame, op: &str) -> Result<String, String> {
    match frame.workspace_id.as_deref() {
        Some(id) if !id.is_empty() => Ok(id.to_owned()),
        _ => Err(format!("{op} 缺少 workspaceId")),
    }
}

#[cfg(windows)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(windows)]
impl BrowserHost {
    fn debug_port(&self) -> u16 {
        self.debug_port
    }

    /// 新连接接管发送端并自增纪元；旧纪元的请求与结果随之作废。
    fn connected(&self, sender: Arc<WsSender>) -> HostReady {
        let mut state = self.state.lock().expect("宿主状态锁被污染");
        state.connection_epoch += 1;
        state.sender = Some(sender);
        HostReady {
            kind: "host.ready",
            host_instance_id: self.instance_id.clone(),
            connection_epoch: state.connection_epoch,
            platform: "windows",
            runtime_version: self.runtime_version.clone(),
            debug_port: self.debug_port,
            tabs: state.tabs.iter().map(|(id, tab)| tab.snapshot(id)).collect(),
        }
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
        self.changed();
    }

    fn is_stopping(&self) -> bool {
        self.state.lock().expect("宿主状态锁被污染").stopping
    }

    fn current_epoch(&self) -> u64 {
        self.state.lock().expect("宿主状态锁被污染").connection_epoch
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
            })
            .collect();
        // HashMap 的遍历顺序每次都不同，页签条会随之变动。按 tabId 排出稳定顺序。
        list.sort_by(|a, b| a.tab_id.cmp(&b.tab_id));
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
                Ok(ResultData { removed: Some(removed), ..ResultData::default() })
            }
            other => Err(format!("认不出的操作 {other}")),
        }
    }

    fn create(
        &self,
        app: &AppHandle,
        url: &str,
        workspace_id: String,
        conversation_id: Option<String>,
    ) -> Result<ResultData, String> {
        let (tab_id, marker) = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.next_tab += 1;
            (format!("bt_{}", state.next_tab), new_host_key())
        };
        // 建视图在锁外：`add_child` 会等主线程，而主线程上的下载钩子要拿同一把锁。
        let tab = tabs::create(
            app,
            tabs::NewTab {
                tab_id: tab_id.clone(),
                marker: marker.clone(),
                url: url.to_owned(),
                profile_dir: self.profile.dir().to_path_buf(),
                debug_port: self.debug_port(),
                workspace_id,
                conversation_id,
            },
        )?;
        let snapshot = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            let entry = state.tabs.entry(tab_id.clone()).or_insert(tab);
            entry.snapshot(&tab_id)
        };
        // 存活集合多了一页，服务端只能从这条事件知道——用户自己新开的页也走这里。
        self.emit("opened", tab_id.clone(), |f| {
            f.url = Some(snapshot.url.clone());
            f.title = Some(snapshot.title.clone());
            f.marker = Some(snapshot.marker.clone());
            f.workspace_id = Some(snapshot.workspace_id.clone());
            f.conversation_id = Some(snapshot.conversation_id.clone());
        });
        self.changed();
        Ok(ResultData {
            tab_id: Some(snapshot.tab_id),
            url: Some(snapshot.url),
            title: Some(snapshot.title),
            ..ResultData::default()
        })
    }

    fn close(&self, tab_id: &str) -> Result<ResultData, String> {
        let tab = {
            let mut state = self.state.lock().expect("宿主状态锁被污染");
            state.arms.disarm(tab_id, None);
            state.tabs.remove(tab_id)
        };
        let tab = tab.ok_or_else(|| format!("认不出的标签页 {tab_id}"))?;
        tab.close();
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
                    tab.close();
                    closed.push(id);
                }
            }
            closed
        };
        for id in closed {
            self.emit("closed", id, |_| {});
        }
        self.changed();
        Ok(ResultData::default())
    }

    fn arm(
        &self,
        tab_id: &str,
        path: &str,
        conversation_id: &str,
        download_id: &str,
        deadline: u64,
    ) -> Result<ResultData, String> {
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

    /// `DownloadStarting` 的裁决。授权表是唯一判据，拦下的那一次就地发 `download.blocked`。
    ///
    /// 拦截事件带上被消费掉的授权身份；没有消费到授权（页面自己发起的下载）时不带，
    /// 服务端因此不会用它结算任何工具调用。
    fn decide_download(
        &self,
        tab_id: &str,
        url: &str,
        suggested: Option<String>,
    ) -> DownloadVerdict {
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

    /// 下载对象报出终态。只有消费过授权的下载走到这里，身份因此一定在。
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

#[cfg(windows)]
/// 供子视图钩子取回宿主。钩子在主线程上跑，拿到的是同一份权威。
fn host() -> Option<&'static Arc<BrowserHost>> {
    HOST.get()
}

#[cfg(windows)]
const NO_HOST: &str = "内置浏览器没有启用";

/// 还没摆过的页移出可视区时用的尺寸。摆过一次之后按那一次的尺寸停。
#[cfg(windows)]
const DEFAULT_PARK_SIZE: (u32, u32) = (1280, 800);

/// 界面此刻看得见的标签页。宿主没起来时是空的，不是错误：入口本来就不显示。
#[cfg(windows)]
pub fn tab_views() -> Vec<TabView> {
    host().map(|h| h.views()).unwrap_or_default()
}

/// 用户新开一页。
///
/// 走的是 AI 建页那条 `create`，只是不带控制纪元——同一个宿主、同一份 profile、
/// 同一套下载裁决。**不要另写一条用户专用的建页路径**：两条路会在参数串、
/// 标记注入与首个文档等待上分头漂移。
#[cfg(windows)]
pub fn user_open(app: &AppHandle, url: Option<&str>, workspace_id: &str) -> Result<TabView, String> {
    let host = host().ok_or(NO_HOST)?;
    if workspace_id.is_empty() {
        return Err("新建标签页缺少工作区".to_owned());
    }
    // 不给地址就是一页空标签，地址由用户在地址栏里输入。
    let target = url.unwrap_or(tabs::BLANK);
    if target != tabs::BLANK && !target.starts_with("http://") && !target.starts_with("https://") {
        return Err("只能打开 http / https 地址".to_owned());
    }
    let data = host.create(app, target, workspace_id.to_owned(), None)?;
    Ok(TabView {
        tab_id: data.tab_id.unwrap_or_default(),
        url: data.url.unwrap_or_default(),
        title: data.title.unwrap_or_default(),
        workspace_id: workspace_id.to_owned(),
    })
}

#[cfg(windows)]
pub fn user_close(tab_id: &str) -> Result<(), String> {
    host().ok_or(NO_HOST)?.close(tab_id).map(|_| ())
}

/// 人工导航。真实引擎导航，地址由 `on_navigation` 事件回投，不在这里改状态。
#[cfg(windows)]
pub fn user_navigate(tab_id: &str, action: &str, url: Option<&str>) -> Result<(), String> {
    let host = host().ok_or(NO_HOST)?;
    let view = {
        let state = host.state.lock().expect("宿主状态锁被污染");
        state
            .tabs
            .get(tab_id)
            .map(|t| t.view())
            .ok_or_else(|| format!("认不出的标签页 {tab_id}"))?
    };
    tabs::navigate(&view, action, url)
}

/// 摆放子视图：`active` 那一页落在给定的物理矩形上，其余全部移出可视区。
///
/// 一次调用摆完所有页，因此「哪一页该露出来」只有界面这一个说法。
/// `active` 为 `None`（面板收起、翻到别的页、浮层盖上来）时全部移出可视区。
#[cfg(windows)]
pub fn layout(active: Option<&str>, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    let host = host().ok_or(NO_HOST)?;
    let (views, sizes): (Vec<(String, tauri::Webview<Runtime>)>, HashMap<String, (u32, u32)>) = {
        let state = host.state.lock().expect("宿主状态锁被污染");
        (
            state.tabs.iter().map(|(id, tab)| (id.clone(), tab.view())).collect(),
            state.tabs.iter().map(|(id, tab)| (id.clone(), tab.size)).collect(),
        )
    };
    let mut placed = Vec::new();
    for (id, view) in views {
        if active == Some(id.as_str()) && width > 0 && height > 0 {
            tabs::place(&view, x, y, width, height);
            placed.push((id, (width, height)));
        } else {
            let size = sizes.get(&id).copied().unwrap_or(DEFAULT_PARK_SIZE);
            tabs::park(&view, size.0, size.1);
        }
    }
    if !placed.is_empty() {
        let mut state = host.state.lock().expect("宿主状态锁被污染");
        for (id, size) in placed {
            if let Some(tab) = state.tabs.get_mut(&id) {
                tab.size = size;
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
/// 子视图里挂的 Tauri 运行时类型。钩子签名要它。
type Runtime = Wry;

#[cfg(all(windows, test))]
mod tests {
    use super::new_host_key;

    #[test]
    fn host_key_is_long_hex_and_differs_per_call() {
        let a = new_host_key();
        let b = new_host_key();
        assert_eq!(a.len(), 64, "{a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
