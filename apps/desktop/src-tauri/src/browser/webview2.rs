//! Windows 的浏览器引擎：主窗口下的 WebView2 子视图。
//!
//! 所有子视图共用同一个 `data_directory` 与同一串 `additional_browser_args`，
//! 因此它们合流进同一个 WebView2 environment：一个 CDP 端点、一份登录状态。
//! 参数串有任何差别都会另起一个 environment，而那会让同一份 profile 被开两次。

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::webview::{PlatformWebview, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect,
    Webview, WebviewUrl, Wry,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2DownloadOperation, ICoreWebView2DownloadStartingEventArgs, ICoreWebView2_4,
    COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
    COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
};
use webview2_com::{take_pwstr, DownloadStartingEventHandler, StateChangedEventHandler};
use windows::core::{Interface, HSTRING, PWSTR};

use super::address::{navigation_url, BLANK};
use super::profile::{self, ProfileLock};
use super::{marker_script, DownloadVerdict, Opened, OpenSpec, Runtime};

/// 子视图里挂的 Tauri 运行时类型。钩子签名要它。
type Wv = Wry;

/// wry 在未指定 `additional_browser_args` 时传的默认值。
/// 指定该方法会**整体替换**默认值，所以必须自己带上。
const WRY_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 面板接上之前，子视图停在可视区之外。
/// 只能用位置避让：`hide()` 会让页面不再出帧，截图与依赖出帧的等待一起挂起。
const OFFSCREEN: (f64, f64) = (-8000.0, -8000.0);
/// 子视图建出时的尺寸。还没摆过的页移出可视区时也按它停。
const DEFAULT_SIZE: (f64, f64) = (1280.0, 800.0);

/// 建页之后等目标文档加载的上限。
///
/// `add_child` 返回时子视图还停在 `about:blank`，注入的标记要等目标文档创建出来才存在；
/// 实测这段是 700 ms 量级。不等就返回的话，调用方按标记去认页必然认不到。
const FIRST_LOAD_WAIT: Duration = Duration::from_secs(20);

/// 下载钩子绑到原生对象上的等待上限。
///
/// `with_webview` 把闭包排到主线程再执行，因此这里必须等一个回执：不等就返回的话，
/// 绑定失败会以「这一页的下载全部按未授权取消」的形式出现在很久之后。
const DOWNLOAD_HOOK_WAIT: Duration = Duration::from_secs(10);

/// 这一进程的 WebView2 environment：profile 占用、回环 CDP 端口与运行时版本。
pub struct Engine {
    profile: ProfileLock,
    debug_port: u16,
    runtime_version: String,
}

/// 一页的原生句柄与最后一次摆出来的物理尺寸。移出可视区时按尺寸停，不缩小页面视口。
#[derive(Clone)]
pub struct Page {
    webview: Webview<Wv>,
    size: (u32, u32),
}

impl Engine {
    /// 占用 profile、分配回环 CDP 端口。子视图共用一个 environment，端口整个进程只分配一次。
    pub fn start(_app: &AppHandle) -> Result<Engine, String> {
        let dir = profile::profile_dir().ok_or("取不到配置根目录")?;
        let profile = profile::lock(&dir)?;
        let debug_port = free_loopback_port().ok_or("分配不到回环调试端口")?;
        let runtime_version = tauri::webview_version().unwrap_or_default();
        log::info!(
            "浏览器宿主已就绪 profile={} debugPort={debug_port} runtime={runtime_version}",
            profile.dir().display()
        );
        Ok(Engine { profile, debug_port, runtime_version })
    }

    /// 子视图建出来之前端口就已分配，因此一经启动即就绪。
    pub fn settled(&self) -> Result<Runtime, &'static str> {
        Ok(Runtime { debug_port: self.debug_port, version: self.runtime_version.clone() })
    }

    /// 建一个子视图。**不能在主线程调用**：`add_child` 内部是 `run_on_main_thread`
    /// 加阻塞等待，在主线程上调用会死锁。
    pub fn open(&self, app: &AppHandle, spec: OpenSpec) -> Result<Opened, String> {
        let window = app
            .get_window("main")
            .ok_or("主窗口不存在，建不出子视图")?;
        let url = navigation_url(spec.url)?;
        let args =
            format!("{WRY_DEFAULT_BROWSER_ARGS} --remote-debugging-port={}", self.debug_port);

        // WebView2 不为 `about:blank` 发 `on_page_load`（实测等满 20 秒），所以空白页不等。
        let blank_target = spec.url == BLANK;
        let event_tab = spec.tab_id.to_owned();
        let title_tab = spec.tab_id.to_owned();
        let (loaded_tx, loaded_rx) = channel::<()>();
        let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
        let builder = WebviewBuilder::new(spec.tab_id, WebviewUrl::External(url))
            .data_directory(self.profile.dir().to_path_buf())
            .additional_browser_args(&args)
            // AI 建页不切换系统焦点。默认是 true，必须显式关掉。
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
            // 等的是**目标文档**：`about:blank` 是创建后的初始文档，不算数。
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

        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(OFFSCREEN.0, OFFSCREEN.1),
                LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1),
            )
            .map_err(|e| format!("建子视图失败：{e}"))?;

        // 绑在等首个文档之前：文档一加载出来就可能发起下载，那时钩子必须已经在。
        // 失败即回收这一个子视图：`add_child` 已经把它挂上窗口，直接返回错误会留下一个
        // 存活表里没有、界面也关不掉的视图。
        if let Err(e) = bind_downloads(&webview, spec.tab_id) {
            close_view(webview);
            return Err(e);
        }

        if !blank_target && loaded_rx.recv_timeout(FIRST_LOAD_WAIT).is_err() {
            log::warn!("子视图 {} 在期限内没有加载出首个文档", spec.tab_id);
        }
        let url = webview.url().map(|u| u.to_string()).unwrap_or_else(|_| spec.url.to_owned());

        Ok(Opened {
            page: Page { webview, size: (DEFAULT_SIZE.0 as u32, DEFAULT_SIZE.1 as u32) },
            url,
            title: String::new(),
        })
    }

    pub fn close(&self, page: Page) {
        close_view(page.webview);
    }

    /// 人工导航。地址走引擎自己的导航接口，前进后退走历史接口，`on_navigation` 照常回投。
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
            other => Err(format!("认不出的导航动作 {other}")),
        }
    }

    /// 逐下载钩子直接指定落点，不需要按授权切换引擎级的下载行为。
    pub fn sync_downloads(&self) -> Result<(), String> {
        Ok(())
    }

    /// 子视图随主窗口关闭，引擎本身没有要收的进程。
    pub fn shutdown(&self) {}
}

/// 让内核挑一个空闲回环端口。
fn free_loopback_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

/// 摆放子视图：`active` 那一页落在给定的物理矩形上，其余全部移出可视区。
///
/// 一次调用摆完所有页，因此「哪一页该露出来」只有界面这一个说法。
/// `active` 为 `None`（面板收起、翻到别的页、浮层盖上来）时全部移出可视区。
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

/// 关掉一个子视图。构造中途失败的回收与正常关闭走同一条路。
fn close_view(view: Webview<Wv>) {
    if let Err(e) = view.close() {
        log::warn!("关闭子视图失败：{e}");
    }
}

/// 把子视图摆到窗口客户区的这个物理矩形上。
///
/// **只能传物理像素。** `set_bounds` 收到 `Logical` 会按子视图 HWND 的 DPI 再乘一次
/// 缩放；前端量到的 DOM 矩形已经是 CSS 像素乘 `devicePixelRatio` 的结果，再乘一次
/// 在 100% 之外的缩放下就摆错位置。坐标原点是父窗口客户区左上角。
fn place(view: &Webview<Wv>, x: i32, y: i32, width: u32, height: u32) {
    let bounds = Rect {
        position: PhysicalPosition::new(x, y).into(),
        size: PhysicalSize::new(width.max(1), height.max(1)).into(),
    };
    if let Err(e) = view.set_bounds(bounds) {
        log::warn!("摆放子视图失败：{e}");
    }
}

/// 把子视图移出可视区。**尺寸保持原样**：收缩到 1×1 等于把页面视口也缩成 1×1，
/// 页面会按那个宽度重排，截图和坐标一起失真。
///
/// **不要改成 `hide()`**：它是 `ShowWindow(SW_HIDE)` 加 `SetIsVisible(false)`，
/// 页面不再出帧，`Page.captureScreenshot` 与依赖出帧的等待一起挂起。
fn park(view: &Webview<Wv>, width: u32, height: u32) {
    let scale = view.window().scale_factor().unwrap_or(1.0);
    let x = (OFFSCREEN.0 * scale) as i32;
    let y = (OFFSCREEN.1 * scale) as i32;
    place(view, x, y, width, height);
}

/// 在这一页的 WebView2 上接管下载。
///
/// 绑的是 `DownloadStarting` 交出的那个 `ICoreWebView2DownloadOperation`：终态由该对象的
/// `StateChanged` 回报，一次下载的结果因此只能归发起它的那一次调用。
/// **不要换回 `WebviewBuilder::on_download`**：那条路的完成回报只带 tab 与路径，
/// 同一页上两次下载的终态分不开，先发起的那次会认领后发起的那次的结果。
fn bind_downloads(view: &Webview<Wv>, tab_id: &str) -> Result<(), String> {
    let tab = tab_id.to_owned();
    let (tx, rx) = channel::<Result<(), String>>();
    view.with_webview(move |platform| {
        let _ = tx.send(register_downloads(&platform, tab));
    })
    .map_err(|e| format!("取不到子视图的原生句柄：{e}"))?;
    rx.recv_timeout(DOWNLOAD_HOOK_WAIT)
        .map_err(|_| "下载钩子在期限内没有注册成功".to_owned())?
}

/// 注册 `DownloadStarting`。在主线程上执行，句柄由 `PlatformWebview` 给出。
fn register_downloads(platform: &PlatformWebview, tab_id: String) -> Result<(), String> {
    let mut token = 0i64;
    unsafe {
        let core = platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("取不到 CoreWebView2：{e}"))?;
        let core4: ICoreWebView2_4 = core
            .cast()
            .map_err(|e| format!("这个 WebView2 运行时没有下载事件：{e}"))?;
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

/// 一次下载开始。裁决在宿主的授权表里做完，放行的那一次把身份绑到下载对象上。
///
/// 宿主不在时取消：没有授权表就判不了这次下载该不该放行，放行等于无裁决写盘。
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
            // 人工页沿用浏览器提议的目标路径；`SetHandled` 只是不弹默认下载 UI。
            DownloadVerdict::Default => args.SetHandled(true),
            DownloadVerdict::Allow(path, download_id) => {
                args.SetResultFilePath(&HSTRING::from(path.as_os_str()))?;
                args.SetHandled(true)?;
                watch_state(tab_id, &operation, download_id)
            }
            // 宿主在裁决时已经发过 `download.blocked`，这里只执行取消。
            DownloadVerdict::Cancel => args.SetCancel(true),
        }
    }
}

/// 把本次身份绑到下载对象上，终态由它自己回报。
///
/// 回调在终态时就地解除：注册与解除都在这个下载对象上完成，不留一个跟着对象到析构的闭包。
/// `IN_PROGRESS` 不是终态，收到它不回报。
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
