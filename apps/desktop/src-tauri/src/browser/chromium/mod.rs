//! macOS 与 Linux 的浏览器引擎：本机已安装的 Chrome / Edge / Chromium，独立窗口。
//!
//! 外壳按专用 profile 拉起浏览器，并对它保持一条自己的 CDP 连接，只做宿主职责；
//! 页内观察与动作由服务端按 `host.ready` 里的调试端口另连一条 CDP 执行。
//!
//! 四条不变量：
//!
//! 1. **每个新页与它的每个跨站子帧都在启动时挂起**（`waitForDebuggerOnStart`），开完 Page 域
//!    才放行。帧表与下载归属靠 Page 域的帧事件，先放行就会漏掉最早出现的帧。
//! 2. **标记在目标文档之前注入。** 宿主建的页先停在 `about:blank`，注入后再导航；页面自己
//!    开出的新页在挂起期间注入。直接带目标地址建页，第一份文档在注入之前就开始加载。
//! 3. **下载归属按帧查页。** `Browser.downloadWillBegin` 只带 frameId，查不到存活页的帧按用户
//!    下载处理。落点：平时按浏览器默认行为，有授权期间整个浏览器切到按 guid 写进暂存目录，
//!    完成后由宿主搬到授权路径；同一期间用户页的下载搬回用户的下载目录。
//! 4. **浏览器进程退出即整份状态作废。** 页、会话、帧表、在途下载随进程丢弃，宿主按退避重启它，
//!    服务端经同一条连接上重发的首帧得知。

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

/// `host.ready` 报的显示位置：页在浏览器自己的窗口里，面板只列页签。
pub const PRESENTATION: &str = "window";

/// 宿主建页后等页面附上来并放行的上限。附上与放行都是本机毫秒级的事。
const ATTACH_WAIT: Duration = Duration::from_secs(10);
/// 建页之后等目标文档导航完成的上限，与 Windows 等首个文档取同一个数。
const FIRST_LOAD_WAIT: Duration = Duration::from_secs(20);
/// 调试连接断开或要求关闭之后，等浏览器进程自己退出的上限。到点强杀：
/// 不等就强杀会打断它写 profile。
const EXIT_WAIT: Duration = Duration::from_secs(5);

/// 页会话与子帧会话上的自动附加：只附跨站子帧，挂起到开完 Page 域。
fn child_attach() -> Value {
    json!({
        "autoAttach": true,
        "waitForDebuggerOnStart": true,
        "flatten": true,
        "filter": [{ "type": "iframe" }],
    })
}

/// 浏览器级会话上的自动附加：只附顶层页。
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

/// 一页在这个引擎里的句柄：浏览器的 targetId。会话随进程变，按需从页表里取。
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
    /// 监督线程还在。退出路径等它把浏览器进程收完。
    supervising: bool,
}

enum Status {
    /// 第一次拉起还没有结果。宿主连接的首帧要等它。
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
    /// 找浏览器、占 profile、起监督线程。找不到浏览器不是错误：宿主照常连上服务端，
    /// 首帧如实报 `not_found`，设置页据此显示原因。
    pub fn start(_app: &AppHandle) -> Result<Engine, String> {
        let found = launch::discover();
        let (profile, status) = match &found {
            Some(found) => {
                let dir = launch::profile_dir(found).ok_or("取不到配置根目录")?;
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

    /// 此刻的调试端点。第一次拉起还没有结果时等它。
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

    /// 按授权表切换下载行为。浏览器不在时没有要切的对象。
    pub fn sync_downloads(&self) -> Result<(), String> {
        match self.instance() {
            Ok(instance) => instance.sync_downloads(),
            Err(_) => Ok(()),
        }
    }

    /// 停止重启并关掉浏览器。先请它自己关，到点仍在才强杀。
    ///
    /// 等的是监督线程收完进程，期限取回收期限的两倍：监督线程自己到点会先强杀并回收，
    /// 这里的强杀只在它卡在别处时才发生，不对一个可能已被回收的 pid 发信号。
    pub fn shutdown(&self) {
        let instance = {
            let mut life = self.inner.lock();
            life.stopping = true;
            self.inner.changed.notify_all();
            life.instance.clone()
        };
        if let Some(instance) = &instance {
            if let Err(e) = instance.cdp.call("Browser.close", json!({}), None) {
                log::warn!("浏览器没有按请求关闭：{e}");
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
                log::warn!("浏览器进程 pid={} 在期限内没有退出，强制结束", instance.pid);
                force_kill(instance.pid);
            }
        }
    }

    fn instance(&self) -> Result<Arc<Instance>, String> {
        self.inner.lock().instance.clone().ok_or_else(|| "浏览器没有在运行".to_owned())
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Life> {
        self.life.lock().expect("浏览器引擎状态锁被污染")
    }

    /// 换一个状态并通知等它的线程。返回此刻是否在退出。
    fn set(&self, status: Status, instance: Option<Arc<Instance>>) -> bool {
        let mut life = self.lock();
        life.status = status;
        life.instance = instance;
        self.changed.notify_all();
        life.stopping
    }

    /// 睡到退避结束，或者退出开始。返回是否在退出。
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

/// 监督线程：拉起浏览器、消费它的事件直到进程退出、按退避重启。
///
/// 浏览器进程必须由这个线程拉起：Linux 的父进程退出信号按拉起它的线程计算，
/// 这个线程活到外壳退出为止。
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

/// 等浏览器进程自己退出，到点强杀，最后回收。
fn reap(child: &mut Child) {
    let deadline = Instant::now() + EXIT_WAIT;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::warn!("浏览器进程在调试连接断开后没有退出，强制结束");
    let _ = child.kill();
    let _ = child.wait();
}

/// 强杀一个浏览器进程。只在关闭请求等过期限之后调用，且 `pid` 只能是本引擎拉起的那一个。
fn force_kill(pid: u32) {
    const SIGKILL: i32 = 9;
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    // SAFETY: 只传一个进程号与一个信号号，两者都是本函数构造的合法值。
    if unsafe { kill(pid as i32, SIGKILL) } != 0 {
        log::warn!("强杀浏览器进程 pid={pid} 失败");
    }
}

/// 一个在跑的浏览器进程与宿主对它的那条 CDP 连接。进程退出即整份丢弃。
struct Instance {
    cdp: Arc<Cdp>,
    pid: u32,
    debug_port: u16,
    version: String,
    staging: PathBuf,
    table: Mutex<Table>,
    /// 页表变化的通知。宿主建页等附上与导航完成都等它。
    table_changed: Condvar,
    downloads: Mutex<Downloads>,
}

#[derive(Default)]
struct Downloads {
    /// 浏览器此刻是不是按 guid 写进暂存目录。
    staging: bool,
    /// 按 guid 记的在途下载。
    pending: HashMap<String, Pending>,
}

enum Pending {
    /// 消费了一份授权：完成后搬到授权路径，终态按这份身份回报。
    Authorized { tab: String, path: PathBuf, download_id: String },
    /// 用户下载：若落在暂存目录里，完成后按建议名搬回用户的下载目录。
    Manual { name: String },
}

impl Instance {
    /// 拉起浏览器、连上它、开好宿主要的三样：目标发现、下载事件、顶层页的自动附加。
    fn launch(found: &Found, profile: &std::path::Path) -> Result<(Arc<Instance>, Receiver<Event>, Child), String> {
        let staging = profile.join(staging::DIR);
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|e| format!("建不出下载暂存目录：{e}"))?;
        let launch::Launched { mut child, port, path } = launch::launch(found, profile)?;
        let pid = child.id();
        let connected = (|| {
            let (cdp, events) =
                Cdp::connect(port, &path).map_err(|e| format!("连不上浏览器调试端点：{e}"))?;
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

    /// 消费事件直到连接断开。所有事件都在这一个线程上按到达顺序处理：处理当中发的命令由
    /// CDP 的读线程取回包，不会卡住这里。**处理事件时不握页表锁发命令或回调宿主。**
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
                "Browser.downloadWillBegin" => self.download_began(p),
                "Browser.downloadProgress" => self.download_progressed(p),
                _ => {}
            }
        }
    }

    /// 一个目标附上来。顶层页与它的跨站子帧开 Page 域、挂子帧自动附加，页面自开的新页注入标记，
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
                            log::warn!("新开的页注入标记失败，不进存活集合：{e}");
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

    /// 开 Page 域并挂上跨站子帧的自动附加。失败只记日志：这一页照常可用，只是帧表缺了它的帧。
    fn enable(&self, session: &str) {
        if let Err(e) = self.call("Page.enable", json!({}), Some(session)) {
            log::warn!("开 Page 域失败：{e}");
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

    /// 地址与标题的投影。只报变了的那一项。
    fn info_changed(&self, info: &Value) {
        if info.get("type").and_then(Value::as_str) != Some("page") {
            return;
        }
        let Some(target) = info.get("targetId").and_then(Value::as_str) else { return };
        let url = info.get("url").and_then(Value::as_str).unwrap_or_default();
        let title = info.get("title").and_then(Value::as_str).unwrap_or_default();
        let (tab, url_changed, title_changed) = {
            let mut table = self.table();
            let Some(entry) = table.page_mut(target) else { return };
            let url_changed = entry.url != url;
            let title_changed = entry.title != title;
            url.clone_into(&mut entry.url);
            title.clone_into(&mut entry.title);
            (entry.tab.clone(), url_changed, title_changed)
        };
        let (Some(tab), Some(host)) = (tab, super::host()) else { return };
        if url_changed {
            host.note_navigated(&tab, url);
        }
        if title_changed {
            host.note_title(&tab, title);
        }
    }

    /// 帧提交。主帧第一次提交时，页面自开的新页以提交的地址进存活集合。
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

    /// 宿主建页：`about:blank` → 等附上并放行 → 认领 tabId → 注入标记 → 导航 → 等导航完成。
    fn open(&self, spec: &OpenSpec, url: Option<&str>) -> Result<Opened, String> {
        let created = self.call(
            "Target.createTarget",
            json!({ "url": BLANK, "background": spec.background }),
            None,
        )?;
        let target = created
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or("浏览器没有给出新页的 targetId")?
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
                return Err("新页没有在期限内附上".to_owned());
            }
            let entry = table.page_mut(target).ok_or("新页已经关闭")?;
            // 认领在导航之前：这一页开出的新页与发起的下载从第一份文档起就归它。
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
                log::warn!("新页 {} 在期限内没有完成首个导航", spec.tab_id);
            }
        }
        let table = self.table();
        let entry = table.page(target).ok_or("新页已经关闭")?;
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
            log::warn!("关页失败：{e}");
        }
    }

    /// 人工导航。地址走 `Page.navigate`，前进后退走页面历史，地址由 `targetInfoChanged` 回投。
    fn navigate(&self, target: &str, action: &str, url: Option<&str>) -> Result<(), String> {
        let session = self
            .table()
            .page(target)
            .map(|e| e.session.clone())
            .ok_or("这一页已经不在浏览器里")?;
        let (method, params) = match action {
            "goto" => {
                let parsed = navigation_url(url.ok_or("goto 缺少 url")?)?;
                ("Page.navigate", json!({ "url": parsed.as_str() }))
            }
            "reload" => ("Page.reload", json!({})),
            "back" => ("Runtime.evaluate", json!({ "expression": "history.back()" })),
            "forward" => ("Runtime.evaluate", json!({ "expression": "history.forward()" })),
            other => return Err(format!("认不出的导航动作 {other}")),
        };
        self.call(method, params, Some(&session)).map(|_| ())
    }

    /// 一次下载开始。裁决在宿主的授权表里做完；宿主不在时取消，理由与 Windows 相同：
    /// 没有授权表就判不了这次下载该不该放行。
    ///
    /// 裁决与登记在途握着同一把下载锁：授权被消费到在途登记之间若有别的线程切回默认行为，
    /// 这次授权下载会落进默认目录。
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

    /// 一次下载到了终态。授权下载从暂存目录搬到授权路径并回报；用户下载若落在暂存目录，
    /// 搬回用户的下载目录。
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
                    log::warn!("授权下载没有落到 {}：{e}", path.display());
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
                                Ok(()) => log::info!("用户下载已从暂存目录搬到 {}", to.display()),
                                Err(e) => log::warn!("用户下载没能搬回 {}：{e}", to.display()),
                            }
                        }
                        None => log::warn!("取不到用户的下载目录，下载留在 {}", staged.display()),
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

    /// 有授权、或还有授权下载在途时，整个浏览器按 guid 写进暂存目录；都没有时回到默认行为。
    ///
    /// 在途的授权下载结束前不切回：浏览器在下载开始之后才定落点，提前切回会让它落进默认目录。
    /// 握着下载锁发命令，两个线程的切换因此按先后生效，不会交错。
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
