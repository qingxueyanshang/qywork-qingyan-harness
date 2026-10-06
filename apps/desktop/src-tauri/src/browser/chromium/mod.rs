//! macOS 与 Linux 的浏览器引擎：本机已安装的 Chrome / Edge / Chromium，独立窗口。
//!
//! 外壳以专用 profile 启动浏览器，并与其保持一条自身的 CDP 连接，只承担宿主职责；
//! 页内观察与动作由服务端按 `host.ready` 中的调试端口另建一条 CDP 连接执行。
//!
//! 四条不变量：
//!
//! 1. **每个新页面及其每个跨站子帧都在启动时挂起**（`waitForDebuggerOnStart`），启用 Page 域
//!    后才放行。帧表与下载归属依赖 Page 域的帧事件，提前放行会遗漏最早出现的帧。
//! 2. **标记在目标文档之前注入。** 宿主新建的页面先停在 `about:blank`，注入后再导航；页面自行
//!    打开的新页面在挂起期间注入。直接以目标地址新建页面时，第一份文档在注入之前就开始加载。
//! 3. **下载归属按帧查找页面。** `Browser.downloadWillBegin` 只带 frameId，无法对应到存活页面的帧按用户
//!    下载处理。保存位置：平时按浏览器默认行为；存在授权期间整个浏览器切换为按 guid 写入暂存目录，
//!    完成后由宿主移动到授权路径；同一期间用户页面的下载移回用户的下载目录。
//! 4. **浏览器进程退出即全部状态作废。** 页面、会话、帧表、在途下载随进程丢弃，宿主按退避策略重启浏览器，
//!    服务端通过同一连接上重发的首帧得知。

mod cdp;
mod launch;
mod staging;
mod table;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::address::{navigation_url, BLANK};
use super::profile::{self, ProfileLock};
use super::{marker_script, DownloadVerdict, Opened, OpenSpec, Runtime};
use crate::hostkey::new_host_key;
use crate::restart;
use cdp::{Cdp, Event};
use launch::Found;
use table::{Popup, Table};

/// `host.unavailable` 的原因，与 `native-browser.ts` 的 `BrowserUnavailableReason` 逐字一致。
const NOT_FOUND: &str = "not_found";
const EXITED: &str = "exited";

/// `host.ready` 报告的显示位置：页面位于浏览器自身的窗口中，面板只列出页签。
pub const PRESENTATION: &str = "window";

/// 宿主新建页面后等待页面附加并放行的上限。附加与放行都在本机毫秒级完成。
const ATTACH_WAIT: Duration = Duration::from_secs(10);
/// 新建页面后等待目标文档导航完成的上限，与 Windows 等待首个文档的上限取同一值。
const FIRST_LOAD_WAIT: Duration = Duration::from_secs(20);
/// 调试连接断开或请求关闭之后，等待浏览器进程自行退出的上限。超时后强制终止：
/// 不等待即强制终止会中断其写入 profile。
const EXIT_WAIT: Duration = Duration::from_secs(5);

/// 页面会话与子帧会话上的自动附加：只附加跨站子帧，挂起至启用 Page 域。
fn child_attach() -> Value {
    json!({
        "autoAttach": true,
        "waitForDebuggerOnStart": true,
        "flatten": true,
        "filter": [{ "type": "iframe" }],
    })
}

/// 浏览器级会话上的自动附加：只附加顶层页面。
fn page_attach() -> Value {
    json!({
        "autoAttach": true,
        "waitForDebuggerOnStart": true,
        "flatten": true,
        "filter": [{ "type": "page" }],
    })
}

pub struct Engine {
    inner: Arc<Inner>,
}

/// 页面在本引擎中的句柄：浏览器的 targetId。会话随进程变化，按需从页表中获取。
#[derive(Clone)]
pub struct Page {
    target: String,
}

struct Inner {
    found: Option<Found>,
    profile: Option<ProfileLock>,
    life: Mutex<Life>,
    changed: Condvar,
}

struct Life {
    status: Status,
    instance: Option<Arc<Instance>>,
    stopping: bool,
    /// 监督线程仍在运行。退出路径等待它回收浏览器进程。
    supervising: bool,
}

enum Status {
    /// 首次启动尚无结果。宿主连接的首帧需要等待该结果。
    Starting,
    Running { debug_port: u16, version: String },
    Unavailable(&'static str),
}

impl Status {
    fn runtime(&self) -> Result<Runtime, &'static str> {
        match self {
            Status::Running { debug_port, version } => {
                Ok(Runtime { debug_port: *debug_port, version: version.clone() })
            }
            Status::Unavailable(reason) => Err(reason),
            Status::Starting => Err(EXITED),
        }
    }
}

impl Engine {
    /// 查找浏览器、占用 profile、启动监督线程。未找到浏览器不是错误：宿主照常连接服务端，
    /// 首帧如实报告 `not_found`，设置页据此显示原因。
    pub fn start(_app: &AppHandle) -> Result<Engine, String> {
        let found = launch::discover();
        let (profile, status) = match &found {
            Some(found) => {
                let dir = launch::profile_dir(found).ok_or("无法取得配置根目录")?;
                let lock = profile::lock(&dir)?;
                log::info!("浏览器宿主使用 {} profile={}", found.exe.display(), dir.display());
                (Some(lock), Status::Starting)
            }
            None => {
                log::warn!("未找到 Chrome、Edge 或 Chromium，浏览器控制不可用");
                (None, Status::Unavailable(NOT_FOUND))
            }
        };
        let supervising = found.is_some();
        let inner = Arc::new(Inner {
            found,
            profile,
            life: Mutex::new(Life { status, instance: None, stopping: false, supervising }),
            changed: Condvar::new(),
        });
        if supervising {
            let supervised = Arc::clone(&inner);
            std::thread::spawn(move || supervise(&supervised));
        }
        Ok(Engine { inner })
    }

    /// 当前的调试端点。首次启动尚无结果时等待。
    pub fn settled(&self) -> Result<Runtime, &'static str> {
        let mut life = self.inner.lock();
        while matches!(life.status, Status::Starting) && !life.stopping {
            life = self.inner.changed.wait(life).expect("浏览器引擎状态锁被污染");
        }
        life.status.runtime()
    }

    pub fn open(&self, _app: &AppHandle, spec: OpenSpec) -> Result<Opened, String> {
        let url = if spec.url == BLANK { None } else { Some(navigation_url(spec.url)?) };
        self.instance()?.open(&spec, url.as_ref().map(|u| u.as_str()))
    }

    pub fn close(&self, page: Page) {
        if let Ok(instance) = self.instance() {
            instance.close(&page.target);
        }
    }

    pub fn navigate(&self, page: &Page, action: &str, url: Option<&str>) -> Result<(), String> {
        self.instance()?.navigate(&page.target, action, url)
    }

    /// 把该页面切换为所在窗口的当前页签，并把窗口置于前台；窗口最小化时一并还原。
    /// 能否实际取得前台由窗口管理器决定。
    pub fn activate(&self, page: &Page) -> Result<(), String> {
        self.instance()?
            .call("Target.activateTarget", json!({ "targetId": page.target }), None)
            .map(|_| ())
    }

    /// 按授权表切换下载行为。浏览器未运行时无需切换。
    pub fn sync_downloads(&self) -> Result<(), String> {
        match self.instance() {
            Ok(instance) => instance.sync_downloads(),
            Err(_) => Ok(()),
        }
    }

    /// 停止重启并关闭浏览器。先请求其自行关闭，超时仍在运行才强制终止。
    ///
    /// 等待监督线程回收进程，期限取回收期限的两倍：监督线程自身到期会先强制终止并回收，
    /// 此处的强制终止只在它阻塞于别处时发生，不向可能已被回收的 pid 发送信号。
    pub fn shutdown(&self) {
        let instance = {
            let mut life = self.inner.lock();
            life.stopping = true;
            self.inner.changed.notify_all();
            life.instance.clone()
        };
        if let Some(instance) = &instance {
            if let Err(e) = instance.cdp.call("Browser.close", json!({}), None) {
                log::warn!("浏览器未按请求关闭：{e}");
            }
        }
        let deadline = Instant::now() + EXIT_WAIT * 2;
        let mut life = self.inner.lock();
        while life.supervising {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            life = self.inner.changed.wait_timeout(life, left).expect("浏览器引擎状态锁被污染").0;
        }
        if life.supervising {
            if let Some(instance) = instance {
                log::warn!("浏览器进程 pid={} 在期限内未退出，强制结束", instance.pid);
                force_kill(instance.pid);
            }
        }
    }

    fn instance(&self) -> Result<Arc<Instance>, String> {
        self.inner.lock().instance.clone().ok_or_else(|| "浏览器未运行".to_owned())
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Life> {
        self.life.lock().expect("浏览器引擎状态锁被污染")
    }

    /// 切换状态并通知等待的线程。返回此刻是否正在退出。
    fn set(&self, status: Status, instance: Option<Arc<Instance>>) -> bool {
        let mut life = self.lock();
        life.status = status;
        life.instance = instance;
        self.changed.notify_all();
        life.stopping
    }

    /// 休眠至退避结束或退出开始。返回是否正在退出。
    fn backoff(&self, delay: Duration) -> bool {
        let deadline = Instant::now() + delay;
        let mut life = self.lock();
        while !life.stopping {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            life = self.changed.wait_timeout(life, left).expect("浏览器引擎状态锁被污染").0;
        }
        life.stopping
    }
}

/// 监督线程：启动浏览器，消费其事件直至进程退出，按退避策略重启。
///
/// 浏览器进程必须由该线程启动：Linux 的父进程退出信号按启动它的线程判定，
/// 而该线程运行至外壳退出。
fn supervise(inner: &Arc<Inner>) {
    let (Some(found), Some(profile)) = (&inner.found, &inner.profile) else { return };
    let profile = profile.dir().to_path_buf();
    let mut attempt = 0u32;
    loop {
        let started = Instant::now();
        match Instance::launch(found, &profile) {
            Ok((instance, events, mut child)) => {
                let runtime = Status::Running {
                    debug_port: instance.debug_port,
                    version: instance.version.clone(),
                };
                log::info!(
                    "浏览器已就绪 pid={} debugPort={} version={}",
                    instance.pid,
                    instance.debug_port,
                    instance.version
                );
                let stopping = inner.set(runtime, Some(Arc::clone(&instance)));
                if stopping {
                    let _ = instance.cdp.call("Browser.close", json!({}), None);
                } else if let Some(host) = super::host() {
                    host.engine_changed(Ok(Runtime {
                        debug_port: instance.debug_port,
                        version: instance.version.clone(),
                    }));
                }
                instance.pump(events);
                instance.cdp.close();
                reap(&mut child);
                log::warn!("浏览器进程已退出 pid={}", instance.pid);
            }
            Err(e) => log::warn!("浏览器启动失败：{e}"),
        }
        if inner.set(Status::Unavailable(EXITED), None) {
            break;
        }
        if let Some(host) = super::host() {
            host.engine_changed(Err(EXITED));
        }
        attempt = restart::next_attempt(attempt, started.elapsed());
        let Some(delay) = restart::restart_delay(attempt) else {
            log::error!("浏览器连续 {attempt} 次启动后很快退出，不再重启");
            break;
        };
        if inner.backoff(delay) {
            break;
        }
    }
    let mut life = inner.lock();
    life.supervising = false;
    inner.changed.notify_all();
}

/// 等待浏览器进程自行退出，超时后强制终止，最后回收。
fn reap(child: &mut Child) {
    let deadline = Instant::now() + EXIT_WAIT;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::warn!("浏览器进程在调试连接断开后未退出，强制结束");
    let _ = child.kill();
    let _ = child.wait();
}

/// 强制终止浏览器进程。只在关闭请求等待超过期限后调用，且 `pid` 只能是本引擎启动的进程。
fn force_kill(pid: u32) {
    const SIGKILL: i32 = 9;
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    // SAFETY: 只传入一个进程号与一个信号编号，两者都是本函数构造的合法值。
    if unsafe { kill(pid as i32, SIGKILL) } != 0 {
        log::warn!("强制终止浏览器进程 pid={pid} 失败");
    }
}

/// 运行中的浏览器进程及宿主与它的 CDP 连接。进程退出即全部丢弃。
struct Instance {
    cdp: Arc<Cdp>,
    pid: u32,
    debug_port: u16,
    version: String,
    staging: PathBuf,
    table: Mutex<Table>,
    /// 页表变化的通知。宿主新建页面时，等待附加与导航完成都依赖该通知。
    table_changed: Condvar,
    downloads: Mutex<Downloads>,
}

#[derive(Default)]
struct Downloads {
    /// 浏览器此刻是否按 guid 写入暂存目录。
    staging: bool,
    /// 按 guid 记录的在途下载。
    pending: HashMap<String, Pending>,
}

enum Pending {
    /// 已消费一份授权：完成后移动到授权路径，终态按该授权的身份回报。
    Authorized { tab: String, path: PathBuf, download_id: String },
    /// 用户下载：若保存在暂存目录中，完成后按建议名移回用户的下载目录。
    Manual { name: String },
}

impl Instance {
    /// 启动浏览器并建立连接，启用宿主所需的三项：目标发现、下载事件、顶层页面的自动附加。
    fn launch(found: &Found, profile: &std::path::Path) -> Result<(Arc<Instance>, Receiver<Event>, Child), String> {
        let staging = profile.join(staging::DIR);
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|e| format!("无法创建下载暂存目录：{e}"))?;
        let launch::Launched { mut child, port, path } = launch::launch(found, profile)?;
        let pid = child.id();
        let connected = (|| {
            let (cdp, events) =
                Cdp::connect(port, &path).map_err(|e| format!("无法连接浏览器调试端点：{e}"))?;
            let version = cdp.call("Browser.getVersion", json!({}), None)?;
            let product = version.get("product").and_then(Value::as_str).unwrap_or_default();
            cdp.call("Target.setDiscoverTargets", json!({ "discover": true }), None)?;
            cdp.call(
                "Browser.setDownloadBehavior",
                json!({ "behavior": "default", "eventsEnabled": true }),
                None,
            )?;
            cdp.call("Target.setAutoAttach", page_attach(), None)?;
            Ok::<_, String>((cdp, events, launch::product_version(product)))
        })();
        match connected {
            Ok((cdp, events, version)) => Ok((
                Arc::new(Instance {
                    cdp,
                    pid,
                    debug_port: port,
                    version,
                    staging,
                    table: Mutex::new(Table::default()),
                    table_changed: Condvar::new(),
                    downloads: Mutex::new(Downloads::default()),
                }),
                events,
                child,
            )),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(e)
            }
        }
    }

    fn table(&self) -> MutexGuard<'_, Table> {
        self.table.lock().expect("浏览器页表锁被污染")
    }

    fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        self.cdp.call(method, params, session)
    }

    /// 消费事件直至连接断开。所有事件都在本线程上按到达顺序处理：处理期间发送的命令由
    /// CDP 的读线程接收响应，不会阻塞本线程。**处理事件时不持有页表锁发送命令或回调宿主。**
    fn pump(&self, events: Receiver<Event>) {
        for event in events.iter() {
            let session = event.session.as_deref();
            let p = &event.params;
            match event.method.as_str() {
                "Target.attachedToTarget" => self.attached(session, p),
                "Target.detachedFromTarget" => {
                    if let Some(s) = p.get("sessionId").and_then(Value::as_str) {
                        self.table().session_detached(s);
                    }
                }
                "Target.targetDestroyed" => {
                    if let Some(target) = p.get("targetId").and_then(Value::as_str) {
                        self.destroyed(target);
                    }
                }
                "Target.targetInfoChanged" => self.info_changed(&p["targetInfo"]),
                "Page.frameAttached" => {
                    if let (Some(s), Some(frame)) = (session, p.get("frameId").and_then(Value::as_str)) {
                        self.table().frame_seen(s, frame);
                    }
                }
                "Page.frameNavigated" => {
                    if let Some(s) = session {
                        self.frame_navigated(s, &p["frame"]);
                    }
                }
                "Page.frameDetached" => {
                    let removed = p.get("reason").and_then(Value::as_str) != Some("swap");
                    if let (true, Some(frame)) = (removed, p.get("frameId").and_then(Value::as_str)) {
                        self.table().frame_removed(frame);
                    }
                }
                "Page.frameStoppedLoading" => {
                    if let (Some(s), Some(frame)) = (session, p.get("frameId").and_then(Value::as_str)) {
                        self.frame_stopped(s, frame);
                    }
                }
                "Page.domContentEventFired" | "Page.loadEventFired" | "Page.navigatedWithinDocument" => {
                    if let Some(s) = session {
                        self.reread_info(s);
                    }
                }
                "Browser.downloadWillBegin" => self.download_began(p),
                "Browser.downloadProgress" => self.download_progressed(p),
                _ => {}
            }
        }
    }

    /// 处理目标附加。顶层页面及其跨站子帧启用 Page 域并设置子帧自动附加，页面自行打开的新页面注入标记，
    /// 最后放行。
    fn attached(&self, parent: Option<&str>, p: &Value) {
        let Some(session) = p.get("sessionId").and_then(Value::as_str) else { return };
        let info = &p["targetInfo"];
        let target = info.get("targetId").and_then(Value::as_str).unwrap_or_default();
        let kind = info.get("type").and_then(Value::as_str).unwrap_or_default();
        let waiting = p.get("waitingForDebugger").and_then(Value::as_bool).unwrap_or(false);
        match (parent, kind) {
            (None, "page") => {
                let url = info.get("url").and_then(Value::as_str).unwrap_or_default();
                let title = info.get("title").and_then(Value::as_str).unwrap_or_default();
                let opener_tab = {
                    let mut table = self.table();
                    let opener = info
                        .get("openerId")
                        .and_then(Value::as_str)
                        .and_then(|o| table.tab_of_target(o));
                    table.page_attached(target, session, url, title);
                    opener
                };
                self.enable(session);
                let popup = opener_tab.and_then(|opener_tab| {
                    let marker = new_host_key();
                    let source = json!({ "source": marker_script(&marker) });
                    match self.call("Page.addScriptToEvaluateOnNewDocument", source, Some(session)) {
                        Ok(_) => Some(Popup { opener_tab, marker }),
                        Err(e) => {
                            log::warn!("新页面注入标记失败，不加入存活集合：{e}");
                            None
                        }
                    }
                });
                self.resume(session, waiting);
                if let Some(entry) = self.table().page_mut(target) {
                    entry.ready = true;
                    entry.popup = popup;
                }
                self.table_changed.notify_all();
            }
            (Some(parent), "iframe") => {
                if self.table().child_attached(parent, session, target) {
                    self.enable(session);
                }
                self.resume(session, waiting);
            }
            _ => self.resume(session, waiting),
        }
    }

    /// 启用 Page 域并设置跨站子帧的自动附加。失败只记录日志：该页面照常可用，只是帧表缺少其帧。
    fn enable(&self, session: &str) {
        if let Err(e) = self.call("Page.enable", json!({}), Some(session)) {
            log::warn!("启用 Page 域失败：{e}");
        }
        if let Err(e) = self.call("Target.setAutoAttach", child_attach(), Some(session)) {
            log::warn!("子帧自动附加失败：{e}");
        }
    }

    fn resume(&self, session: &str, waiting: bool) {
        if !waiting {
            return;
        }
        if let Err(e) = self.call("Runtime.runIfWaitingForDebugger", json!({}), Some(session)) {
            log::warn!("放行挂起的目标失败：{e}");
        }
    }

    fn destroyed(&self, target: &str) {
        let entry = self.table().page_destroyed(target);
        self.table_changed.notify_all();
        if let (Some(tab), Some(host)) = (entry.and_then(|e| e.tab), super::host()) {
            host.note_closed(&tab);
        }
    }

    /// 地址与标题的投影。`Target.targetInfoChanged` 与重新读取的 `Target.getTargetInfo` 都经由此处，
    /// 只报告变化的项。
    fn info_changed(&self, info: &Value) {
        if info.get("type").and_then(Value::as_str) != Some("page") {
            return;
        }
        let Some(target) = info.get("targetId").and_then(Value::as_str) else { return };
        let url = info.get("url").and_then(Value::as_str).unwrap_or_default();
        let title = info.get("title").and_then(Value::as_str).unwrap_or_default();
        let change = self.table().page_info(target, url, title);
        let (Some(change), Some(host)) = (change, super::host()) else { return };
        if let Some(url) = &change.url {
            host.note_navigated(&change.tab, url);
        }
        if let Some(title) = &change.title {
            host.note_title(&change.tab, title);
        }
    }

    /// 顶层页面的主帧 DOMContentLoaded、load 或同文档导航之后重新读取一次地址与标题。
    ///
    /// 不要只依赖 `Target.targetInfoChanged`：Chrome 只在导航提交时发送该事件，此时标题仍是地址，
    /// 文档标题出现后不再发送（154 版实测）；DOMContentLoaded 时重新读取到的已是文档标题。
    /// 加载完成后脚本修改的标题，要到下一次发生这三种事件时才投影。
    fn reread_info(&self, session: &str) {
        let Some(target) = self.table().page_of_session(session).map(str::to_owned) else { return };
        match self.call("Target.getTargetInfo", json!({ "targetId": target }), None) {
            Ok(result) => self.info_changed(&result["targetInfo"]),
            Err(e) => log::warn!("重新读取页面的地址与标题失败：{e}"),
        }
    }

    /// 帧提交。主帧首次提交时，页面自行打开的新页面以提交的地址加入存活集合。
    fn frame_navigated(&self, session: &str, frame: &Value) {
        let Some(id) = frame.get("id").and_then(Value::as_str) else { return };
        let url = frame.get("url").and_then(Value::as_str).unwrap_or_default();
        let admitted = {
            let mut table = self.table();
            table.frame_seen(session, id);
            let Some(entry) = table.main_frame(session, id) else { return };
            entry.committed = true;
            let popup = entry.popup.take();
            if popup.is_some() {
                url.clone_into(&mut entry.url);
            }
            popup.map(|popup| (popup, entry.title.clone()))
        };
        self.table_changed.notify_all();
        let (Some((popup, title)), Some(host)) = (admitted, super::host()) else { return };
        let page = Page { target: id.to_owned() };
        if let Some(tab) = host.note_popup(&popup.opener_tab, page, popup.marker, url.to_owned(), title) {
            if let Some(entry) = self.table().page_mut(id) {
                entry.tab = Some(tab);
            }
        }
    }

    fn frame_stopped(&self, session: &str, frame: &str) {
        {
            let mut table = self.table();
            let Some(entry) = table.main_frame(session, frame) else { return };
            if !entry.committed {
                return;
            }
            entry.loaded = true;
        }
        self.table_changed.notify_all();
    }

    /// 宿主新建页面：`about:blank` → 等待附加并放行 → 认领 tabId → 注入标记 → 导航 → 等待导航完成。
    fn open(&self, spec: &OpenSpec, url: Option<&str>) -> Result<Opened, String> {
        let created = self.call(
            "Target.createTarget",
            json!({ "url": BLANK, "background": spec.background }),
            None,
        )?;
        let target = created
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or("浏览器未返回新页面的 targetId")?
            .to_owned();
        match self.prepare(&target, spec, url) {
            Ok(opened) => Ok(opened),
            Err(e) => {
                self.close(&target);
                Err(e)
            }
        }
    }

    fn prepare(&self, target: &str, spec: &OpenSpec, url: Option<&str>) -> Result<Opened, String> {
        let session = {
            let table = self.table();
            let (mut table, timeout) = self
                .table_changed
                .wait_timeout_while(table, ATTACH_WAIT, |t| !t.page(target).is_some_and(|e| e.ready))
                .expect("浏览器页表锁被污染");
            if timeout.timed_out() {
                return Err("新页面未在期限内附加".to_owned());
            }
            let entry = table.page_mut(target).ok_or("新页面已关闭")?;
            // 认领在导航之前：该页面打开的新页面与发起的下载从第一份文档起即归属该页面。
            entry.tab = Some(spec.tab_id.to_owned());
            entry.session.clone()
        };
        let source = json!({ "source": marker_script(spec.marker) });
        self.call("Page.addScriptToEvaluateOnNewDocument", source, Some(&session))?;
        if let Some(url) = url {
            let nav = self.call("Page.navigate", json!({ "url": url }), Some(&session))?;
            let settled = nav.get("errorText").is_some()
                || nav.get("isDownload").and_then(Value::as_bool) == Some(true);
            if !settled && !self.wait_loaded(target) {
                log::warn!("新页面 {} 在期限内未完成首个导航", spec.tab_id);
            }
        }
        let table = self.table();
        let entry = table.page(target).ok_or("新页面已关闭")?;
        let url = match (entry.url.as_str(), url) {
            ("" | BLANK, Some(requested)) => requested.to_owned(),
            (current, _) => current.to_owned(),
        };
        Ok(Opened { page: Page { target: target.to_owned() }, url, title: entry.title.clone() })
    }

    fn wait_loaded(&self, target: &str) -> bool {
        let table = self.table();
        let (table, _) = self
            .table_changed
            .wait_timeout_while(table, FIRST_LOAD_WAIT, |t| {
                t.page(target).is_some_and(|e| !e.loaded)
            })
            .expect("浏览器页表锁被污染");
        table.page(target).is_some_and(|e| e.loaded)
    }

    fn close(&self, target: &str) {
        if let Err(e) = self.call("Target.closeTarget", json!({ "targetId": target }), None) {
            log::warn!("关闭页面失败：{e}");
        }
    }

    /// 人工导航。地址使用 `Page.navigate`，前进后退使用页面历史，地址由 `targetInfoChanged` 回传。
    fn navigate(&self, target: &str, action: &str, url: Option<&str>) -> Result<(), String> {
        let session = self
            .table()
            .page(target)
            .map(|e| e.session.clone())
            .ok_or("该页面已不在浏览器中")?;
        let (method, params) = match action {
            "goto" => {
                let parsed = navigation_url(url.ok_or("goto 缺少 url")?)?;
                ("Page.navigate", json!({ "url": parsed.as_str() }))
            }
            "reload" => ("Page.reload", json!({})),
            "back" => ("Runtime.evaluate", json!({ "expression": "history.back()" })),
            "forward" => ("Runtime.evaluate", json!({ "expression": "history.forward()" })),
            other => return Err(format!("无法识别的导航动作 {other}")),
        };
        self.call(method, params, Some(&session)).map(|_| ())
    }

    /// 下载开始。裁决在宿主的授权表中完成；宿主未连接时取消，理由与 Windows 相同：
    /// 没有授权表就无法判定该下载是否应放行。
    ///
    /// 裁决与在途登记持有同一把下载锁：若在授权被消费到在途登记之间有其他线程切回默认行为，
    /// 该授权下载会保存到默认目录。
    fn download_began(&self, p: &Value) {
        let Some(guid) = p.get("guid").and_then(Value::as_str) else { return };
        let frame = p.get("frameId").and_then(Value::as_str).unwrap_or_default();
        let url = p.get("url").and_then(Value::as_str).unwrap_or_default();
        let suggested = p.get("suggestedFilename").and_then(Value::as_str).map(str::to_owned);
        let tab = self.table().tab_of_frame(frame);
        let mut downloads = self.downloads();
        let verdict = match super::host() {
            Some(host) => host.decide_download(tab.as_deref(), url, suggested.clone()),
            None => DownloadVerdict::Cancel,
        };
        let pending = match (verdict, tab) {
            (DownloadVerdict::Cancel, _) => {
                drop(downloads);
                if let Err(e) = self.call("Browser.cancelDownload", json!({ "guid": guid }), None) {
                    log::warn!("取消下载失败：{e}");
                }
                return;
            }
            (DownloadVerdict::Allow(path, download_id), Some(tab)) => {
                Pending::Authorized { tab, path, download_id }
            }
            _ => Pending::Manual { name: suggested.unwrap_or_default() },
        };
        downloads.pending.insert(guid.to_owned(), pending);
    }

    /// 下载到达终态。授权下载从暂存目录移动到授权路径并回报；用户下载若保存在暂存目录，
    /// 移回用户的下载目录。
    fn download_progressed(&self, p: &Value) {
        let Some(guid) = p.get("guid").and_then(Value::as_str) else { return };
        let state = p.get("state").and_then(Value::as_str).unwrap_or_default();
        if state != "completed" && state != "canceled" {
            return;
        }
        let Some(pending) = self.downloads().pending.remove(guid) else { return };
        let staged = self.staging.join(guid);
        match pending {
            Pending::Authorized { tab, path, download_id } => {
                let moved = if state == "completed" {
                    staging::move_to(&staged, &path).map_err(|e| e.to_string())
                } else {
                    Err("下载被取消".to_owned())
                };
                if let Err(e) = &moved {
                    log::warn!("授权下载未能移动到 {}：{e}", path.display());
                    let _ = std::fs::remove_file(&staged);
                }
                if let Some(host) = super::host() {
                    let landed = moved.is_ok().then(|| path.to_string_lossy().into_owned());
                    host.note_download_finished(&tab, landed, moved.is_ok(), &download_id);
                }
            }
            Pending::Manual { name } => {
                if state == "completed" && staged.exists() {
                    match staging::user_downloads() {
                        Some(dir) => {
                            let to = staging::free_name(&dir, &name, guid);
                            match staging::move_to(&staged, &to) {
                                Ok(()) => log::info!("用户下载已从暂存目录移动到 {}", to.display()),
                                Err(e) => log::warn!("用户下载未能移回 {}：{e}", to.display()),
                            }
                        }
                        None => log::warn!("无法取得用户的下载目录，下载保留在 {}", staged.display()),
                    }
                }
            }
        }
        if let Err(e) = self.sync_downloads() {
            log::warn!("下载行为切换失败：{e}");
        }
    }

    fn downloads(&self) -> MutexGuard<'_, Downloads> {
        self.downloads.lock().expect("下载状态锁被污染")
    }

    /// 存在授权或仍有授权下载在途时，整个浏览器按 guid 写入暂存目录；两者都不存在时恢复默认行为。
    ///
    /// 在途的授权下载结束前不切回：浏览器在下载开始之后才确定保存位置，提前切回会使其保存到默认目录。
    /// 持有下载锁发送命令，因此两个线程的切换按先后顺序生效，不会交错。
    fn sync_downloads(&self) -> Result<(), String> {
        let mut downloads = self.downloads();
        let armed = super::host().is_some_and(|h| h.downloads_armed());
        let want = armed
            || downloads.pending.values().any(|p| matches!(p, Pending::Authorized { .. }));
        if want == downloads.staging {
            return Ok(());
        }
        let params = if want {
            json!({
                "behavior": "allowAndName",
                "downloadPath": self.staging.to_string_lossy(),
                "eventsEnabled": true,
            })
        } else {
            json!({ "behavior": "default", "eventsEnabled": true })
        };
        self.call("Browser.setDownloadBehavior", params, None)?;
        downloads.staging = want;
        Ok(())
    }
}
