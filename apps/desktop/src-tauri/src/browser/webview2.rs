//! Windows 的浏览器引擎：主窗口下的 WebView2 子视图。
//!
//! 所有子视图共用同一个 `data_directory` 与同一组 `additional_browser_args`，
//! 因此它们并入同一个 WebView2 environment：一个 CDP 端点、一份登录状态。
//! 参数有任何差别都会另建一个 environment，使同一份 profile 被打开两次。

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::webview::{PageLoadEvent, PlatformWebview, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect, Url,
    Webview, WebviewUrl, Wry,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Deferral, ICoreWebView2DownloadOperation,
    ICoreWebView2DownloadStartingEventArgs, ICoreWebView2Environment, ICoreWebView2Environment5,
    ICoreWebView2NewWindowRequestedEventArgs, ICoreWebView2Settings5, ICoreWebView2_11,
    ICoreWebView2_4,
    COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
    COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
};
use webview2_com::{
    take_pwstr, BrowserProcessExitedEventHandler, ContextMenuRequestedEventHandler,
    DownloadStartingEventHandler, ExecuteScriptCompletedHandler, HistoryChangedEventHandler,
    NewWindowRequestedEventHandler,
    SourceChangedEventHandler, StateChangedEventHandler, WindowCloseRequestedEventHandler,
    ZoomFactorChangedEventHandler,
};
use windows::core::{w, Interface, BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, FindWindowExW, GetAncestor, GetWindow, PostMessageW, SetWindowPos,
    CHILDID_SELF, EVENT_OBJECT_SHOW, GA_ROOT, GW_OWNER, HWND_TOP, OBJID_WINDOW, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_CANCELMODE,
};

use super::address::{navigation_url, BLANK};
use super::profile::{self, ProfileLock};
use super::{marker_script, DownloadVerdict, Opened, OpenSpec, Runtime};

/// 子视图使用的 Tauri 运行时类型。钩子签名需要该类型。
type Wv = Wry;

/// `host.ready` 上报的显示位置：页面是主窗口中的子视图，由界面放入面板。
const PRESENTATION: &str = "embedded";

/// 子视图的浏览器参数。`additional_browser_args` 会整体替换 wry 的默认值，因此包含其中的
/// `msWebOOUI`、`msPdfOOUI`、`msSmartScreenProtection` 三项。
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 面板挂载之前，子视图位于可视区之外。
/// 只能通过位置移出：`hide()` 会使页面停止渲染新帧，截图与依赖新帧的等待都会挂起。
const OFFSCREEN: (f64, f64) = (-8000.0, -8000.0);
/// 子视图创建时的尺寸。尚未放置过的页移出可视区时也使用该尺寸。
const DEFAULT_SIZE: (f64, f64) = (1280.0, 800.0);

/// 创建页面后等待目标文档加载的时间上限，只用于 `OpenSpec::await_document` 或 `await_load` 为真的页。
///
/// `add_child` 返回时子视图仍处于 `about:blank`，目标文档约 700 ms 后才创建（实测）。
const FIRST_LOAD_WAIT: Duration = Duration::from_secs(20);

/// 子视图创建完成并绑定下载与右键菜单钩子的等待上限。
///
/// `with_webview` 把闭包排入主线程执行，因此此处必须等待回执：不等待就返回时，绑定失败不会立即报告，
/// 只在之后以「该页的下载全部按未授权取消」的形式出现。`add_child` 不报告创建失败（Tauri 只写入日志，
/// 子视图不存在时闭包不会执行），到期未收到回执即表示子视图未创建完成。
const HOOK_WAIT: Duration = Duration::from_secs(10);

/// 地址栏缩放按钮的档位，与页面中 Ctrl+加减号的档位相同，两者交替使用时比例不会落在档位之间。
const ZOOM_LEVELS: [f64; 17] = [
    0.25,
    1.0 / 3.0,
    0.5,
    2.0 / 3.0,
    0.75,
    0.8,
    0.9,
    1.0,
    1.1,
    1.25,
    1.5,
    1.75,
    2.0,
    2.5,
    3.0,
    4.0,
    5.0,
];

/// 跨线程传递的 environment。只在主线程上调用其方法；工作线程只把它交给 `WebviewBuilder`，
/// 与 Tauri 在构建参数中跨线程传递 environment 的方式相同。
#[derive(Clone)]
struct SharedEnvironment(ICoreWebView2Environment);

unsafe impl Send for SharedEnvironment {}
unsafe impl Sync for SharedEnvironment {}

/// 一次新窗口请求的事件参数与延迟。只在主线程上调用其方法；工作线程只负责传递。
struct PendingWindow {
    args: ICoreWebView2NewWindowRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
}

unsafe impl Send for PendingWindow {}

impl PendingWindow {
    /// 交付新页并完成延迟。`view` 为 `None` 或交付失败时同样完成：事件已置为已处理，不打开窗口。
    /// 在主线程上调用。
    fn finish(self, view: Option<&ICoreWebView2>) -> windows::core::Result<()> {
        unsafe {
            let delivered = match view {
                Some(view) => self.args.SetNewWindow(view),
                None => Ok(()),
            };
            let completed = self.deferral.Complete();
            delivered.and(completed)
        }
    }
}

/// 页面请求的新窗口，交给 `Engine::open_window` 创建新页。
///
/// 释放时尚未交付即在主线程上完成延迟并拒绝该请求：打开它的页已关闭、子视图创建失败等
/// 任何途径都使请求到达终态，不会停留在延迟中。
pub struct WindowRequest {
    app: AppHandle,
    /// 打开它的页的 environment。新页必须在其上创建，WebView2 不接受另一个 environment 的视图。
    environment: SharedEnvironment,
    pending: Option<PendingWindow>,
}

impl WindowRequest {
    /// 把新建的页交给请求。在主线程上调用，此后释放不再拒绝。
    fn deliver(mut self, platform: &PlatformWebview) -> Result<(), String> {
        let Some(pending) = self.pending.take() else { return Ok(()) };
        let view = unsafe { platform.controller().CoreWebView2() };
        let delivered = pending.finish(view.as_ref().ok());
        view.and(delivered).map_err(|e| format!("新窗口交付失败：{e}"))
    }
}

impl Drop for WindowRequest {
    fn drop(&mut self) {
        let Some(pending) = self.pending.take() else { return };
        let posted = self.app.run_on_main_thread(move || {
            if let Err(e) = pending.finish(None) {
                log::warn!("拒绝新窗口请求失败：{e}");
            }
        });
        if let Err(e) = posted {
            log::warn!("拒绝新窗口请求失败：{e}");
        }
    }
}

/// 本进程的 WebView2 environment：profile 占用、回环 CDP 端口与运行时版本。
pub struct Engine {
    /// `None` 表示 profile 已被另一个 qywork 进程占用：引擎不创建任何子视图，`settled` 报告 `IN_USE`。
    profile: Option<ProfileLock>,
    debug_port: u16,
    runtime_version: String,
    /// 当前放在面板中的页，只由 `layout` 写入；`None` 表示全部移出可视区。右键菜单与弹出窗口事件按它裁决。
    shown: Mutex<Option<String>>,
    /// 本 profile 当前浏览器进程的 environment，新建的页都在其上创建；由 `remember_environment` 写入，
    /// 浏览器进程退出（全部页面关闭或进程崩溃）时清除，之后新建的页另行创建 environment。
    ///
    /// 不要改为每页各自创建 environment：WebView2 运行时在应用运行期间更新后，新创建的 environment
    /// 取新版本，而同一 profile 的浏览器进程仍是旧版本，此后新建页面全部以 `RPC_E_DISCONNECTED` 失败，
    /// 直到全部页面关闭（2026-11-17 实测：运行时由 157.0.4341.57 更新为 157.0.4341.60 之后）。
    environment: Mutex<Option<SharedEnvironment>>,
}

/// 页面的原生句柄与最后一次放置时的物理尺寸。移出可视区时保持该尺寸，不缩小页面视口。
#[derive(Clone)]
pub struct Page {
    webview: Webview<Wv>,
    size: (u32, u32),
}

impl Engine {
    /// 占用 profile 并分配回环 CDP 端口。子视图共用一个 environment，端口在整个进程中只分配一次。
    /// profile 被占用不是错误：宿主照常连接服务端，首帧报告 `IN_USE`，界面据此显示原因。
    pub fn start(_app: &AppHandle) -> Result<Engine, String> {
        let dir = profile::profile_dir().ok_or("无法取得配置根目录")?;
        let profile = profile::lock(&dir)?;
        let debug_port = free_loopback_port().ok_or("无法分配回环调试端口")?;
        let runtime_version = tauri::webview_version().unwrap_or_default();
        match &profile {
            Some(profile) => log::info!(
                "浏览器宿主已就绪 profile={} debugPort={debug_port} runtime={runtime_version}",
                profile.dir().display()
            ),
            None => log::warn!("浏览器配置已被另一个 qywork 进程占用，浏览器控制不可用"),
        }
        Ok(Engine {
            profile,
            debug_port,
            runtime_version,
            shown: Mutex::new(None),
            environment: Mutex::new(None),
        })
    }

    /// 端口在创建子视图之前已分配，因此成功占用 profile 时启动后即就绪。
    pub fn settled(&self) -> Result<Runtime, &'static str> {
        if self.profile.is_none() {
            return Err(profile::IN_USE);
        }
        Ok(Runtime {
            debug_port: self.debug_port,
            version: self.runtime_version.clone(),
            presentation: PRESENTATION,
        })
    }

    /// 创建一个子视图。**不得在主线程调用**：`add_child` 内部是 `run_on_main_thread`
    /// 加阻塞等待，在主线程上调用会死锁。
    pub fn open(&self, app: &AppHandle, spec: OpenSpec) -> Result<Opened, String> {
        let url = navigation_url(spec.url)?;
        let requested = url.to_string();
        self.build(app, spec, url, requested, None)
    }

    /// 创建一个子视图并交给页面的新窗口请求。不得在主线程调用，原因同 `open`。
    ///
    /// 子视图在 `about:blank` 上创建且不导航：WebView2 只接受未导航过的视图，新窗口的导航由
    /// 打开它的页发起，因此 `spec.url` 不经地址规则裁决。
    pub fn open_window(
        &self,
        app: &AppHandle,
        spec: OpenSpec,
        window: WindowRequest,
    ) -> Result<Opened, String> {
        let blank = Url::parse(BLANK).map_err(|e| format!("地址无法解析：{e}"))?;
        let requested = spec.url.to_owned();
        self.build(app, spec, blank, requested, Some(window))
    }

    /// 在主窗口下创建子视图并绑定钩子；`window` 存在时在绑定钩子之后交给该请求。
    /// `requested` 是不等待首个文档时返回的地址。
    fn build(
        &self,
        app: &AppHandle,
        spec: OpenSpec,
        url: Url,
        requested: String,
        window: Option<WindowRequest>,
    ) -> Result<Opened, String> {
        let profile = self.profile.as_ref().ok_or("浏览器配置已被另一个 qywork 进程占用")?;
        let main = app
            .get_window("main")
            .ok_or("主窗口不存在，无法创建子视图")?;
        let args = format!("{BROWSER_ARGS} --remote-debugging-port={}", self.debug_port);

        // WebView2 不为 `about:blank` 触发 `on_page_load`（实测会等待完整的 20 秒），因此空白页不等待。
        let blank_target = spec.url == BLANK;
        let await_load = spec.await_load;
        let title_tab = spec.tab_id.to_owned();
        let (loaded_tx, loaded_rx) = channel::<()>();
        let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
        let builder = WebviewBuilder::new(spec.tab_id, WebviewUrl::External(url))
            .data_directory(profile.dir().to_path_buf())
            .additional_browser_args(&args)
            // AI 创建的页不切换系统焦点。默认值为 true，必须显式关闭。
            .focused(false)
            // 用户可以用 Ctrl+滚轮与 Ctrl+加减号缩放页面。默认值为 false，页面宽于面板或弹窗高于面板时无法看全。
            // 页面缩放后，模型按元素位置发出的点击仍然准确（2026-11-18 在真实 WebView2 中按 80% 与 125% 实测）。
            // 该选项同时打开双指缩放，由 `disable_pinch_zoom` 关闭。
            .zoom_hotkeys_enabled(true)
            .initialization_script(marker_script(spec.marker))
            .on_document_title_changed(move |_webview, title| {
                if let Some(host) = super::host() {
                    host.note_title(&title_tab, &title);
                }
            })
            // 等待的是目标文档：`about:blank` 是创建后的初始文档，不计入。等待加载完成的页只计完成事件。
            .on_page_load(move |_webview, payload| {
                if payload.url().as_str() == BLANK {
                    return;
                }
                if await_load && !matches!(payload.event(), PageLoadEvent::Finished) {
                    return;
                }
                if let Ok(mut slot) = loaded_tx.lock() {
                    if let Some(tx) = slot.take() {
                        let _ = tx.send(());
                    }
                }
            });
        let shared = match &window {
            Some(window) => Some(window.environment.clone()),
            None => self.environment.lock().expect("environment 状态锁被污染").clone(),
        };
        let builder = match shared {
            Some(env) => builder.with_environment(env.0),
            None => builder,
        };

        let webview = main
            .add_child(
                builder,
                LogicalPosition::new(OFFSCREEN.0, OFFSCREEN.1),
                LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1),
            )
            .map_err(|e| format!("创建子视图失败：{e}"))?;

        // 在等待首个文档之前绑定：文档加载后即可能发起下载或请求右键菜单，此时钩子必须已经存在。
        // 绑定或交付失败时回收该子视图：`add_child` 已将其附加到窗口，直接返回错误会留下一个
        // 不在存活表中、界面也无法关闭的视图。
        if let Err(e) = bind_hooks(&webview, spec.tab_id, window)
            .and_then(|()| mark_document(&webview, spec.marker))
        {
            close_view(webview);
            return Err(e);
        }

        // 不等待时子视图仍是 `about:blank`，返回请求的地址；实际地址随地址变化事件更新。
        let url = if (spec.await_document || spec.await_load) && !blank_target {
            if loaded_rx.recv_timeout(FIRST_LOAD_WAIT).is_err() {
                log::warn!("子视图 {} 未在期限内加载首个文档", spec.tab_id);
            }
            webview.url().map(|u| u.to_string()).unwrap_or(requested)
        } else {
            requested
        };

        Ok(Opened {
            page: Page { webview, size: (DEFAULT_SIZE.0 as u32, DEFAULT_SIZE.1 as u32) },
            url,
            title: String::new(),
        })
    }

    pub fn close(&self, page: Page) {
        close_view(page.webview);
    }

    /// 用户导航。地址使用引擎自身的导航接口，前进与后退使用历史接口，新地址由 `SourceChanged` 回传。
    pub fn navigate(&self, page: &Page, action: &str, url: Option<&str>) -> Result<(), String> {
        let view = &page.webview;
        match action {
            "goto" => {
                let raw = url.ok_or("goto 缺少 url")?;
                let parsed = navigation_url(raw)?;
                view.navigate(parsed).map_err(|e| e.to_string())
            }
            "reload" => view.reload().map_err(|e| e.to_string()),
            "back" => view.eval("history.back()").map_err(|e| e.to_string()),
            "forward" => view.eval("history.forward()").map_err(|e| e.to_string()),
            other => Err(format!("无法识别的导航动作 {other}")),
        }
    }

    /// 用户按档位放大（`in`）或缩小（`out`）页面，已在端点时不变；`reset` 恢复为 100%。
    ///
    /// 新比例在此处上报：经属性设置缩放比例时 WebView2 不触发 `ZoomFactorChanged`。
    pub fn zoom(&self, page: &Page, action: &str) -> Result<(), String> {
        let step = match action {
            "in" => Some(true),
            "out" => Some(false),
            "reset" => None,
            other => return Err(format!("无法识别的缩放动作 {other}")),
        };
        let tab = page.webview.label().to_owned();
        let (tx, rx) = channel::<Result<(), String>>();
        page.webview
            .with_webview(move |platform| {
                let controller = platform.controller();
                let set = unsafe {
                    let mut current = 1.0;
                    controller
                        .ZoomFactor(&mut current)
                        .and_then(|()| {
                            controller.SetZoomFactor(step.map_or(1.0, |zoom_in| zoom_step(current, zoom_in)))
                        })
                };
                let reported = set.and_then(|()| report_zoom(&tab, &controller));
                let _ = tx.send(reported.map_err(|e| format!("缩放页面失败：{e}")));
            })
            .map_err(|e| format!("无法取得子视图的原生句柄：{e}"))?;
        rx.recv_timeout(HOOK_WAIT).map_err(|_| "缩放页面未在期限内完成".to_owned())?
    }

    /// 上报该页当前的缩放比例。页进入存活集合之后调用：此前触发的 `ZoomFactorChanged` 因表中尚无该页而被忽略，
    /// 而页面打开时 WebView2 按站点恢复上次的缩放比例。
    pub fn report_zoom(&self, page: &Page) {
        let tab = page.webview.label().to_owned();
        let posted = page.webview.with_webview(move |platform| {
            if let Err(e) = report_zoom(&tab, &platform.controller()) {
                log::warn!("读取 {tab} 的缩放比例失败：{e}");
            }
        });
        if let Err(e) = posted {
            log::warn!("读取缩放比例失败：{e}");
        }
    }

    /// 每次下载的钩子直接指定保存路径，无需按授权切换引擎级的下载行为。
    pub fn sync_downloads(&self) -> Result<(), String> {
        Ok(())
    }

    /// 子视图随主窗口关闭，引擎自身没有需要回收的进程。
    pub fn shutdown(&self) {}
}

/// 由内核分配一个空闲的回环端口。
fn free_loopback_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

/// 摆放子视图：`active` 指定的页放在给定的物理矩形上，其余全部移出可视区。
///
/// 一次调用摆放所有页，因此哪一页可见只由界面决定。
/// `active` 为 `None`（面板收起、切换到其他页、被浮层遮挡）时全部移出可视区。
pub fn layout(active: Option<&str>, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    let host = super::host().ok_or(super::NO_HOST)?;
    let pages: Vec<(String, Page)> = {
        let state = host.state.lock().expect("宿主状态锁被污染");
        state.tabs.iter().map(|(id, tab)| (id.clone(), tab.page.clone())).collect()
    };
    let mut placed = Vec::new();
    for (id, page) in pages {
        if active == Some(id.as_str()) && width > 0 && height > 0 {
            place(&page.webview, x, y, width, height);
            placed.push((id, (width, height)));
        } else {
            park(&page.webview, page.size.0, page.size.1);
        }
    }
    let current = placed.first().map(|(id, _)| id.clone());
    *host.engine.shown.lock().expect("显示页状态锁被污染") = current;
    if !placed.is_empty() {
        let mut state = host.state.lock().expect("宿主状态锁被污染");
        for (id, size) in placed {
            if let Some(tab) = state.tabs.get_mut(&id) {
                tab.page.size = size;
            }
        }
    }
    Ok(())
}

/// 关闭一个子视图。构造中途失败时的回收与正常关闭使用同一路径。
fn close_view(view: Webview<Wv>) {
    if let Err(e) = view.close() {
        log::warn!("关闭子视图失败：{e}");
    }
}

/// 把子视图摆放到窗口客户区的指定物理矩形上。
///
/// **只能传入物理像素。** `set_bounds` 收到 `Logical` 时会按子视图 HWND 的 DPI 再乘一次
/// 缩放；前端测得的 DOM 矩形已经是 CSS 像素乘以 `devicePixelRatio` 的结果，再乘一次
/// 会在非 100% 的缩放下使位置错误。坐标原点是父窗口客户区左上角。
///
/// 移动后调用 `NotifyParentWindowPositionChanged`：已打开的下拉列表（`<select>`）是顶层窗口，
/// 不随子视图移动，WebView2 收到该通知后关闭它。wry 的 `set_bounds` 对子视图不发出该通知，
/// 缺少它时页面移出可视区后下拉列表仍停留在移出前的位置上。
fn place(view: &Webview<Wv>, x: i32, y: i32, width: u32, height: u32) {
    let bounds = Rect {
        position: PhysicalPosition::new(x, y).into(),
        size: PhysicalSize::new(width.max(1), height.max(1)).into(),
    };
    if let Err(e) = view.set_bounds(bounds) {
        log::warn!("摆放子视图失败：{e}");
    }
    let notified = view.with_webview(|platform| unsafe {
        if let Err(e) = platform.controller().NotifyParentWindowPositionChanged() {
            log::warn!("通知子视图位置变化失败：{e}");
        }
    });
    if let Err(e) = notified {
        log::warn!("通知子视图位置变化失败：{e}");
    }
}

/// 把子视图移出可视区，尺寸保持不变：缩小到 1×1 会使页面视口同样变为 1×1，
/// 页面按该宽度重排，截图与坐标随之失真。
///
/// **不要改成 `hide()`**：它执行 `ShowWindow(SW_HIDE)` 与 `SetIsVisible(false)`，
/// 页面停止渲染新帧，`Page.captureScreenshot` 与依赖新帧的等待都会挂起，每条 `mouseMoved`
/// 约 5 秒后才得到响应。只对容器窗口执行 `SW_HIDE` 的结果相同：WebView2 随父窗口转为隐藏。
fn park(view: &Webview<Wv>, width: u32, height: u32) {
    let scale = view.window().scale_factor().unwrap_or(1.0);
    let x = (OFFSCREEN.0 * scale) as i32;
    let y = (OFFSCREEN.1 * scale) as i32;
    place(view, x, y, width, height);
    cancel_popups(view);
}

/// 关闭该页已打开的右键菜单与提示。二者是不随子视图移动的顶层窗口，页面移出可视区后仍停留在
/// 移出前的位置上；WebView2 没有关闭它们的接口，页面的窗口收到 `WM_CANCELMODE` 时 Chromium 关闭它们。
/// 下拉列表不响应该消息，由 `place` 中的位置通知关闭。
fn cancel_popups(view: &Webview<Wv>) {
    let posted = view.with_webview(|platform| unsafe {
        let mut container = HWND::default();
        if platform.controller().ParentWindow(&mut container).is_ok() {
            let _ = EnumChildWindows(Some(container), Some(post_cancel_mode), LPARAM(0));
        }
    });
    if let Err(e) = posted {
        log::warn!("关闭子视图的弹出窗口失败：{e}");
    }
}

/// `EnumChildWindows` 的回调：向容器下的每一级窗口投递 `WM_CANCELMODE`。投递而不发送：
/// 这些窗口属于 WebView2 的其他进程，同步发送会使主线程等待那些进程。
unsafe extern "system" fn post_cancel_mode(child: HWND, _: LPARAM) -> BOOL {
    let _ = PostMessageW(Some(child), WM_CANCELMODE, WPARAM(0), LPARAM(0));
    true.into()
}

/// 主窗口的句柄，由 `watch_popups` 写入一次。弹出窗口事件的回调按它判定窗口归属。
static MAIN_WINDOW: OnceLock<isize> = OnceLock::new();

/// 监听主窗口所属弹出窗口的显示。在主线程上执行，进程内只注册一次。
///
/// 移出面板的页仍会显示提示：AI 用 Tab 键把焦点移到带 `title` 的元素上时，Chromium 按元素的屏幕位置
/// 显示提示，页面位于可视区之外时提示按屏幕边界移到左上角。提示窗口属于主窗口而不属于某一页，
/// 无法按窗口判定来源，因此向所有不在面板中的页投递 `WM_CANCELMODE`：只有显示该提示的页关闭它，
/// 面板中的页不受影响。
///
/// 不要改为在浏览器参数中禁用 `KeyboardAccessibleTooltip`：该参数作用于所有页，面板中的页同样不再显示
/// 键盘提示。不要改为向移出的页投递 `WM_ENTERMENULOOP` 以停用提示：Chromium 在一个进程中只允许一个窗口
/// 处于菜单循环，第二个移出的页即触发浏览器进程的检查失败。
fn watch_popups(platform: &PlatformWebview) {
    unsafe {
        let mut container = HWND::default();
        if platform.controller().ParentWindow(&mut container).is_err() {
            return;
        }
        let main = GetAncestor(container, GA_ROOT);
        if MAIN_WINDOW.set(main.0 as isize).is_err() {
            return;
        }
        let hook = SetWinEventHook(
            EVENT_OBJECT_SHOW,
            EVENT_OBJECT_SHOW,
            None,
            Some(popup_shown),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        if hook.is_invalid() {
            log::warn!("注册弹出窗口事件失败，移出面板的页显示的提示不会关闭");
        }
    }
}

/// 其他进程的窗口显示时由系统调用，在主线程的消息循环中执行。主窗口所属的窗口显示时，
/// 关闭不在面板中的页的提示与菜单。
///
/// 此处等待宿主状态锁：主线程上持有该锁的代码不得在锁内处理窗口消息，否则主线程死锁。
unsafe extern "system" fn popup_shown(
    _: HWINEVENTHOOK,
    _: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _: u32,
    _: u32,
) {
    if object != OBJID_WINDOW.0 || child != CHILDID_SELF as i32 {
        return;
    }
    let owned = GetWindow(hwnd, GW_OWNER)
        .is_ok_and(|owner| MAIN_WINDOW.get() == Some(&(owner.0 as isize)));
    if !owned {
        return;
    }
    let Some(host) = super::host() else { return };
    let shown = host.engine.shown.lock().expect("显示页状态锁被污染").clone();
    let parked: Vec<Page> = {
        let state = host.state.lock().expect("宿主状态锁被污染");
        state
            .tabs
            .iter()
            .filter(|(id, _)| shown.as_deref() != Some(id.as_str()))
            .map(|(_, tab)| tab.page.clone())
            .collect()
    };
    for page in parked {
        cancel_popups(&page.webview);
    }
}

/// 在该页的 WebView2 上注册地址、历史、下载、右键菜单、新窗口与关闭钩子，并记录其 environment；
/// 首次调用时注册弹出窗口事件。`window` 存在时在钩子注册之后交给该请求：此后新页开始加载，
/// 加载前钩子必须已经存在。
fn bind_hooks(
    view: &Webview<Wv>,
    tab_id: &str,
    window: Option<WindowRequest>,
) -> Result<(), String> {
    let tab = tab_id.to_owned();
    let (tx, rx) = channel::<Result<(), String>>();
    view.with_webview(move |platform| {
        watch_popups(&platform);
        remember_environment(&platform);
        raise_resize_borders(&platform);
        let registered = disable_pinch_zoom(&platform)
            .and_then(|()| register_source(&platform, tab.clone()))
            .and_then(|()| register_history(&platform, tab.clone()))
            .and_then(|()| register_zoom(&platform, tab.clone()))
            .and_then(|()| register_downloads(&platform, tab.clone()))
            .and_then(|()| register_context_menu(&platform, tab.clone()))
            .and_then(|()| register_new_window(&platform, tab.clone()))
            .and_then(|()| register_close(&platform, tab))
            .and_then(|()| window.map_or(Ok(()), |window| window.deliver(&platform)));
        let _ = tx.send(registered);
    })
    .map_err(|e| format!("无法取得子视图的原生句柄：{e}"))?;
    rx.recv_timeout(HOOK_WAIT)
        .map_err(|_| "内置浏览器的页面未在期限内创建完成".to_owned())?
}

/// 在子视图当前的文档中写入标记，等待执行完成。
///
/// `initialization_script` 只作用于此后创建的文档：新建的子视图停在没有标记的初始文档上，空白页一直如此，
/// 有目标地址的页在目标文档创建之前同样如此。服务端在这段时间内按标记附加（远程查看、AI 接管）时无法识别该页。
fn mark_document(view: &Webview<Wv>, marker: &str) -> Result<(), String> {
    let script = HSTRING::from(marker_script(marker));
    let (tx, rx) = channel::<Result<(), String>>();
    view.with_webview(move |platform| {
        let core = match unsafe { platform.controller().CoreWebView2() } {
            Ok(core) => core,
            Err(e) => {
                let _ = tx.send(Err(format!("无法取得 CoreWebView2：{e}")));
                return;
            }
        };
        let done = tx.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, _| {
            let _ = done.send(result.map_err(|e| format!("写入页面标记失败：{e}")));
            Ok(())
        }));
        if let Err(e) = unsafe { core.ExecuteScript(&script, &handler) } {
            let _ = tx.send(Err(format!("写入页面标记失败：{e}")));
        }
    })
    .map_err(|e| format!("无法取得子视图的原生句柄：{e}"))?;
    rx.recv_timeout(HOOK_WAIT)
        .map_err(|_| "写入页面标记未在期限内完成".to_owned())?
}

/// 主窗口四边的缩放边框窗口的类名。该窗口由 Tauri 为无装饰窗口创建，覆盖整个客户区，区域只保留四条边。
const RESIZE_BORDERS_CLASS: PCWSTR = w!("TAURI_DRAG_RESIZE_BORDERS");

/// 把缩放边框窗口移到全部子视图之上。在主线程上执行。
///
/// 新建的子视图插入在同级窗口的最上层，Tauri 只在主窗口尺寸变化时把边框窗口移回最上层：不移动时，
/// 紧贴窗口边缘摆放的页面遮住该处的边框，窗口在下一次尺寸变化之前无法从这些边拖动缩放。
/// 边框窗口的区域只有四条边，位于页面之上不影响页面其余部分接收输入。
fn raise_resize_borders(platform: &PlatformWebview) {
    unsafe {
        let mut container = HWND::default();
        if platform.controller().ParentWindow(&mut container).is_err() {
            return;
        }
        let main = GetAncestor(container, GA_ROOT);
        // 有系统标题栏的窗口没有该窗口，此时无需移动。
        let Ok(borders) = FindWindowExW(Some(main), None, RESIZE_BORDERS_CLASS, PCWSTR::null())
        else {
            return;
        };
        let raised = SetWindowPos(
            borders,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        if let Err(e) = raised {
            log::warn!("移动窗口缩放边框失败，紧贴页面的窗口边暂时无法拖动缩放：{e}");
        }
    }
}

/// 注册 `SourceChanged`：页面的地址变化时交给宿主，宿主据此更新界面与服务端记录的地址。在主线程上执行。
///
/// 不要改用 `WebviewBuilder::on_navigation`：它对应 `NavigationStarting`，在导航开始时按请求的地址触发。
/// `pushState`、锚点跳转与同文档的后退不触发它，返回 204 而未提交的导航却触发它，记录的地址随之错误。
fn register_source(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let mut token = 0i64;
    unsafe {
        platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("无法取得 CoreWebView2：{e}"))?
            .add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |core, _| {
                    let Some(core) = core else { return Ok(()) };
                    let mut raw = PWSTR::null();
                    core.Source(&mut raw)?;
                    let url = take_pwstr(raw);
                    if let Some(host) = super::host() {
                        host.note_navigated(&tab_id, &url);
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|e| format!("注册地址变化事件失败：{e}"))
    }
}

/// 注册 `HistoryChanged`：会话历史变化时读取能否后退与前进并交给宿主。在主线程上执行。
fn register_history(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let mut token = 0i64;
    unsafe {
        platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("无法取得 CoreWebView2：{e}"))?
            .add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |core, _| {
                    let Some(core) = core else { return Ok(()) };
                    let mut back = BOOL::default();
                    let mut forward = BOOL::default();
                    core.CanGoBack(&mut back)?;
                    core.CanGoForward(&mut forward)?;
                    if let Some(host) = super::host() {
                        host.note_history(&tab_id, back.as_bool(), forward.as_bool());
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|e| format!("注册历史变化事件失败：{e}"))
    }
}

/// 关闭双指缩放，只保留页面缩放。双指缩放改变可视视口，可视视口缩放后模型点击的落点未经验证，不要打开。
/// 在主线程上执行。
fn disable_pinch_zoom(platform: &PlatformWebview) -> Result<(), String> {
    unsafe {
        platform
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|settings| settings.cast::<ICoreWebView2Settings5>())
            .and_then(|settings| settings.SetIsPinchZoomEnabled(false))
            .map_err(|e| format!("无法关闭双指缩放：{e}"))
    }
}

/// 注册 `ZoomFactorChanged`：用户在页面中按 Ctrl+滚轮或 Ctrl+加减号缩放、导航后按站点恢复缩放比例时上报。
/// 在主线程上执行。
fn register_zoom(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let mut token = 0i64;
    unsafe {
        platform
            .controller()
            .add_ZoomFactorChanged(
                &ZoomFactorChangedEventHandler::create(Box::new(move |controller, _| {
                    controller.map_or(Ok(()), |controller| report_zoom(&tab_id, &controller))
                })),
                &mut token,
            )
            .map_err(|e| format!("注册缩放事件失败：{e}"))
    }
}

/// 读取该页的缩放比例并交给宿主。在主线程上执行。
fn report_zoom(tab_id: &str, controller: &ICoreWebView2Controller) -> windows::core::Result<()> {
    let mut zoom = 1.0;
    unsafe { controller.ZoomFactor(&mut zoom)? };
    if let Some(host) = super::host() {
        host.note_zoom(tab_id, zoom);
    }
    Ok(())
}

/// 当前比例的上一档或下一档；比例不在档位上时取其上方或下方最近的一档，已在端点时不变。
fn zoom_step(current: f64, zoom_in: bool) -> f64 {
    const EPSILON: f64 = 1e-3;
    let next = if zoom_in {
        ZOOM_LEVELS.iter().copied().find(|z| *z > current + EPSILON)
    } else {
        ZOOM_LEVELS.iter().rev().copied().find(|z| *z < current - EPSILON)
    };
    next.unwrap_or(current)
}

/// 尚未记录 environment 时记录该页的 environment，并在其浏览器进程退出时清除。在主线程上执行。
///
/// 无法注册退出事件时不记录：记录后无法得知进程何时退出，之后新建的页会一直在已退出的进程上创建。
fn remember_environment(platform: &PlatformWebview) {
    let Some(host) = super::host() else { return };
    let mut slot = host.engine.environment.lock().expect("environment 状态锁被污染");
    if slot.is_some() {
        return;
    }
    let env = platform.environment();
    let mut token = 0i64;
    let registered = unsafe {
        env.cast::<ICoreWebView2Environment5>().and_then(|env5| {
            env5.add_BrowserProcessExited(
                &BrowserProcessExitedEventHandler::create(Box::new(|sender, _| {
                    forget_environment(sender);
                    Ok(())
                })),
                &mut token,
            )
        })
    };
    match registered {
        Ok(()) => *slot = Some(SharedEnvironment(env)),
        Err(e) => log::warn!("注册浏览器进程退出事件失败，新建的页不共用 environment：{e}"),
    }
}

/// 浏览器进程已退出：清除记录的 environment。只清除与事件来源相同的一个，退出事件晚于新记录到达时不影响新记录。
fn forget_environment(exited: Option<ICoreWebView2Environment>) {
    let Some(host) = super::host() else { return };
    let mut slot = host.engine.environment.lock().expect("environment 状态锁被污染");
    if slot.as_ref().map(|s| &s.0) == exited.as_ref() {
        *slot = None;
    }
}

/// 注册 `DownloadStarting`，在该页的 WebView2 上接管下载。在主线程上执行，句柄由 `PlatformWebview` 给出。
///
/// 绑定的是 `DownloadStarting` 提供的 `ICoreWebView2DownloadOperation`：终态由该对象的
/// `StateChanged` 上报，因此一次下载的结果只能归属于发起它的调用。
/// **不要改用 `WebviewBuilder::on_download`**：其完成通知只携带 tab 与路径，
/// 无法区分同一页上两次下载的终态，先发起的下载会认领后发起的下载的结果。
fn register_downloads(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let mut token = 0i64;
    unsafe {
        let core = platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("无法取得 CoreWebView2：{e}"))?;
        let core4: ICoreWebView2_4 = core
            .cast()
            .map_err(|e| format!("该 WebView2 运行时不支持下载事件：{e}"))?;
        core4
            .add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    starting(&tab_id, &args)
                })),
                &mut token,
            )
            .map_err(|e| format!("注册下载事件失败：{e}"))?;
    }
    Ok(())
}

/// 注册 `ContextMenuRequested`：不在面板中的页不显示右键菜单。在主线程上执行。
///
/// 菜单是顶层窗口，按点击处的屏幕坐标定位，页面移出可视区时按屏幕边界移到左上角，显示在其他会话之上。
/// 不在面板中的页只会收到 AI 发送的右键，原生菜单不出现在页面截图中，AI 也无法操作它；
/// 页面自身的 `contextmenu` 事件照常派发。不要改用 `AreDefaultContextMenusEnabled`：
/// 运行中修改该设置对之后的右键菜单不生效（运行时 157 实测）。
fn register_context_menu(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let mut token = 0i64;
    unsafe {
        let core11: ICoreWebView2_11 = platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("无法取得 CoreWebView2：{e}"))?
            .cast()
            .map_err(|e| format!("该 WebView2 运行时不支持右键菜单事件：{e}"))?;
        core11
            .add_ContextMenuRequested(
                &ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    if !shown(&tab_id) {
                        args.SetHandled(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|e| format!("注册右键菜单事件失败：{e}"))?;
    }
    Ok(())
}

/// 注册 `NewWindowRequested`：页面请求的新窗口（`target=_blank` 链接、`window.open`）由宿主创建为新页。
/// 在主线程上执行。
///
/// 不要改用 `WebviewBuilder::on_new_window`：它只能把新窗口交给另一个顶层窗口中的首个 WebView，
/// 无法交给主窗口下的子视图。不注册时 wry 把请求置为已处理，页面打开新窗口没有任何效果。
fn register_new_window(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let environment = SharedEnvironment(platform.environment());
    let mut token = 0i64;
    unsafe {
        platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("无法取得 CoreWebView2：{e}"))?
            .add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    window_requested(&tab_id, &environment, args)
                })),
                &mut token,
            )
            .map_err(|e| format!("注册新窗口事件失败：{e}"))?;
    }
    Ok(())
}

/// 页面请求新窗口。在主线程上执行。
///
/// 先置为已处理：只有交付新页时才打开窗口，任何失败都不会打开 WebView2 默认的独立弹出窗口。
/// 创建子视图须在主线程之外等待主线程，因此取得延迟后交给工作线程，新页由 `bind_hooks` 在主线程上交付。
fn window_requested(
    tab_id: &str,
    environment: &SharedEnvironment,
    args: ICoreWebView2NewWindowRequestedEventArgs,
) -> windows::core::Result<()> {
    unsafe {
        args.SetHandled(true)?;
        let Some(host) = super::host() else { return Ok(()) };
        let mut raw = PWSTR::null();
        args.Uri(&mut raw)?;
        let url = take_pwstr(raw);
        let deferral = args.GetDeferral()?;
        let window = WindowRequest {
            app: host.app.clone(),
            environment: environment.clone(),
            pending: Some(PendingWindow { args, deferral }),
        };
        let opener = tab_id.to_owned();
        std::thread::spawn(move || {
            if let Err(e) = host.open_window(&opener, &url, window) {
                log::warn!("页面请求的新窗口未创建：{e}");
            }
        });
    }
    Ok(())
}

/// 注册 `WindowCloseRequested`：页面调用 `window.close()` 时经由宿主的 `close` 关闭该页并上报 `closed`。
/// 在主线程上执行。
///
/// wry 对该事件只销毁子视图的容器窗口；不经由宿主时该页留在存活集合中，界面与服务端仍列出一个
/// 已无内容的页。`close` 在工作线程上执行：它等待宿主状态锁并调用引擎。
fn register_close(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let mut token = 0i64;
    unsafe {
        platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("无法取得 CoreWebView2：{e}"))?
            .add_WindowCloseRequested(
                &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    let Some(host) = super::host() else { return Ok(()) };
                    let tab = tab_id.clone();
                    // 宿主已先行关闭该页时表中已无该页，不重复上报 `closed`。
                    std::thread::spawn(move || {
                        let _ = host.close(&tab);
                    });
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|e| format!("注册关闭事件失败：{e}"))?;
    }
    Ok(())
}

/// 该页此刻是否放在面板中。宿主不存在时按不在面板中处理。
fn shown(tab_id: &str) -> bool {
    super::host().is_some_and(|host| {
        host.engine.shown.lock().expect("显示页状态锁被污染").as_deref() == Some(tab_id)
    })
}

/// 下载开始。裁决在宿主的授权表中完成，放行时把身份绑定到下载对象上。
///
/// 宿主不存在时取消：没有授权表就无法判定是否放行本次下载，放行即未经裁决写入磁盘。
fn starting(
    tab_id: &str,
    args: &ICoreWebView2DownloadStartingEventArgs,
) -> windows::core::Result<()> {
    unsafe {
        let Some(host) = super::host() else {
            return args.SetCancel(true);
        };
        let operation = args.DownloadOperation()?;
        let mut raw = PWSTR::null();
        operation.Uri(&mut raw)?;
        let url = take_pwstr(raw);
        let mut raw = PWSTR::null();
        args.ResultFilePath(&mut raw)?;
        let suggested = PathBuf::from(take_pwstr(raw))
            .file_name()
            .map(|n| n.to_string_lossy().into_owned());
        match host.decide_download(Some(tab_id), &url, suggested) {
            // 用户页使用浏览器建议的目标路径；`SetHandled` 只用于不显示默认下载 UI。
            DownloadVerdict::Default => args.SetHandled(true),
            DownloadVerdict::Allow(path, download_id) => {
                args.SetResultFilePath(&HSTRING::from(path.as_os_str()))?;
                args.SetHandled(true)?;
                watch_state(tab_id, &operation, download_id)
            }
            // 宿主在裁决时已发送 `download.blocked`，此处只执行取消。
            DownloadVerdict::Cancel => args.SetCancel(true),
        }
    }
}

/// 把本次身份绑定到下载对象上，终态由该对象上报。
///
/// 回调在终态时当场解除：注册与解除都在该下载对象上完成，不保留一个存续到对象析构的闭包。
/// `IN_PROGRESS` 不是终态，收到时不上报。
fn watch_state(
    tab_id: &str,
    operation: &ICoreWebView2DownloadOperation,
    download_id: String,
) -> windows::core::Result<()> {
    let tab = tab_id.to_owned();
    let token = Rc::new(Cell::new(0i64));
    let slot = Rc::clone(&token);
    let mut fresh = 0i64;
    unsafe {
        operation.add_StateChanged(
            &StateChangedEventHandler::create(Box::new(move |op, _| {
                let Some(op) = op else { return Ok(()) };
                let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                op.State(&mut state)?;
                if state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                    return Ok(());
                }
                let success = state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED;
                let path = if success {
                    let mut raw = PWSTR::null();
                    op.ResultFilePath(&mut raw)?;
                    Some(take_pwstr(raw))
                } else {
                    None
                };
                if let Some(host) = super::host() {
                    host.note_download_finished(&tab, path, success, &download_id);
                }
                op.remove_StateChanged(slot.get())
            })),
            &mut fresh,
        )?;
    }
    token.set(fresh);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{zoom_step, ZOOM_LEVELS};

    #[test]
    fn zoom_step_moves_one_level_and_stops_at_the_ends() {
        assert_eq!(zoom_step(1.0, true), 1.1);
        assert_eq!(zoom_step(1.0, false), 0.9);
        assert_eq!(zoom_step(5.0, true), 5.0);
        assert_eq!(zoom_step(0.25, false), 0.25);
    }

    #[test]
    fn zoom_step_from_between_levels_takes_the_adjacent_level() {
        assert_eq!(zoom_step(1.2, true), 1.25);
        assert_eq!(zoom_step(1.2, false), 1.1);
        assert_eq!(zoom_step(ZOOM_LEVELS[1] + 1e-9, true), 0.5);
    }
}
