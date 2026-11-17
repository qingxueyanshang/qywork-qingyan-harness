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

use tauri::webview::{PlatformWebview, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect,
    Webview, WebviewUrl, Wry,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2DownloadOperation, ICoreWebView2DownloadStartingEventArgs,
    ICoreWebView2Environment, ICoreWebView2Environment5, ICoreWebView2_11, ICoreWebView2_4,
    COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
    COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
};
use webview2_com::{
    take_pwstr, BrowserProcessExitedEventHandler, ContextMenuRequestedEventHandler,
    DownloadStartingEventHandler, StateChangedEventHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetAncestor, GetWindow, PostMessageW, CHILDID_SELF, EVENT_OBJECT_SHOW,
    GA_ROOT, GW_OWNER, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    WM_CANCELMODE,
};

use super::address::{navigation_url, BLANK};
use super::profile::{self, ProfileLock};
use super::{marker_script, DownloadVerdict, Opened, OpenSpec, Runtime};

/// 子视图使用的 Tauri 运行时类型。钩子签名需要该类型。
type Wv = Wry;

/// `host.ready` 上报的显示位置：页面是主窗口中的子视图，由界面放入面板。
pub const PRESENTATION: &str = "embedded";

/// 子视图的浏览器参数。`additional_browser_args` 会整体替换 wry 的默认值，因此包含其中的
/// `msWebOOUI`、`msPdfOOUI`、`msSmartScreenProtection` 三项。
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 面板挂载之前，子视图位于可视区之外。
/// 只能通过位置移出：`hide()` 会使页面停止渲染新帧，截图与依赖新帧的等待都会挂起。
const OFFSCREEN: (f64, f64) = (-8000.0, -8000.0);
/// 子视图创建时的尺寸。尚未放置过的页移出可视区时也使用该尺寸。
const DEFAULT_SIZE: (f64, f64) = (1280.0, 800.0);

/// 创建页面后等待目标文档加载的时间上限，只用于 `OpenSpec::await_document` 为真的页。
///
/// `add_child` 返回时子视图仍处于 `about:blank`，注入的标记在目标文档创建后才存在；
/// 实测该间隔约为 700 ms。不等待就返回时，调用方无法立即按标记识别页面。
const FIRST_LOAD_WAIT: Duration = Duration::from_secs(20);

/// 子视图创建完成并绑定下载与右键菜单钩子的等待上限。
///
/// `with_webview` 把闭包排入主线程执行，因此此处必须等待回执：不等待就返回时，绑定失败不会立即报告，
/// 只在之后以「该页的下载全部按未授权取消」的形式出现。`add_child` 不报告创建失败（Tauri 只写入日志，
/// 子视图不存在时闭包不会执行），到期未收到回执即表示子视图未创建完成。
const HOOK_WAIT: Duration = Duration::from_secs(10);

/// 跨线程传递的 environment。只在主线程上调用其方法；工作线程只把它交给 `WebviewBuilder`，
/// 与 Tauri 在构建参数中跨线程传递 environment 的方式相同。
#[derive(Clone)]
struct SharedEnvironment(ICoreWebView2Environment);

unsafe impl Send for SharedEnvironment {}
unsafe impl Sync for SharedEnvironment {}

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
        Ok(Runtime { debug_port: self.debug_port, version: self.runtime_version.clone() })
    }

    /// 创建一个子视图。**不得在主线程调用**：`add_child` 内部是 `run_on_main_thread`
    /// 加阻塞等待，在主线程上调用会死锁。
    pub fn open(&self, app: &AppHandle, spec: OpenSpec) -> Result<Opened, String> {
        let profile = self.profile.as_ref().ok_or("浏览器配置已被另一个 qywork 进程占用")?;
        let window = app
            .get_window("main")
            .ok_or("主窗口不存在，无法创建子视图")?;
        let url = navigation_url(spec.url)?;
        let requested = url.to_string();
        let args = format!("{BROWSER_ARGS} --remote-debugging-port={}", self.debug_port);

        // WebView2 不为 `about:blank` 触发 `on_page_load`（实测会等待完整的 20 秒），因此空白页不等待。
        let blank_target = spec.url == BLANK;
        let event_tab = spec.tab_id.to_owned();
        let title_tab = spec.tab_id.to_owned();
        let (loaded_tx, loaded_rx) = channel::<()>();
        let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
        let builder = WebviewBuilder::new(spec.tab_id, WebviewUrl::External(url))
            .data_directory(profile.dir().to_path_buf())
            .additional_browser_args(&args)
            // AI 创建的页不切换系统焦点。默认值为 true，必须显式关闭。
            .focused(false)
            .initialization_script(marker_script(spec.marker))
            .on_navigation(move |url| {
                if let Some(host) = super::host() {
                    host.note_navigated(&event_tab, url.as_str());
                }
                true
            })
            .on_document_title_changed(move |_webview, title| {
                if let Some(host) = super::host() {
                    host.note_title(&title_tab, &title);
                }
            })
            // 等待的是目标文档：`about:blank` 是创建后的初始文档，不计入。
            .on_page_load(move |_webview, payload| {
                if payload.url().as_str() == BLANK {
                    return;
                }
                if let Ok(mut slot) = loaded_tx.lock() {
                    if let Some(tx) = slot.take() {
                        let _ = tx.send(());
                    }
                }
            });
        let shared = self.environment.lock().expect("environment 状态锁被污染").clone();
        let builder = match shared {
            Some(env) => builder.with_environment(env.0),
            None => builder,
        };

        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(OFFSCREEN.0, OFFSCREEN.1),
                LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1),
            )
            .map_err(|e| format!("创建子视图失败：{e}"))?;

        // 在等待首个文档之前绑定：文档加载后即可能发起下载或请求右键菜单，此时钩子必须已经存在。
        // 绑定失败时回收该子视图：`add_child` 已将其附加到窗口，直接返回错误会留下一个
        // 不在存活表中、界面也无法关闭的视图。
        if let Err(e) = bind_hooks(&webview, spec.tab_id) {
            close_view(webview);
            return Err(e);
        }

        // 不等待时子视图仍是 `about:blank`，返回请求的地址；实际地址随导航事件更新。
        let url = if spec.await_document && !blank_target {
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

    /// 用户导航。地址使用引擎自身的导航接口，前进与后退使用历史接口，`on_navigation` 照常回传。
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

/// 在该页的 WebView2 上注册下载与右键菜单钩子，并记录其 environment；首次调用时注册弹出窗口事件。
fn bind_hooks(view: &Webview<Wv>, tab_id: &str) -> Result<(), String> {
    let tab = tab_id.to_owned();
    let (tx, rx) = channel::<Result<(), String>>();
    view.with_webview(move |platform| {
        watch_popups(&platform);
        remember_environment(&platform);
        let registered = register_downloads(&platform, tab.clone())
            .and_then(|()| register_context_menu(&platform, tab));
        let _ = tx.send(registered);
    })
    .map_err(|e| format!("无法取得子视图的原生句柄：{e}"))?;
    rx.recv_timeout(HOOK_WAIT)
        .map_err(|_| "内置浏览器的页面未在期限内创建完成".to_owned())?
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
