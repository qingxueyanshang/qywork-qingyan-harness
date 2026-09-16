//! 子 WebView 的创建与投影。
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
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect, Url,
    Webview, WebviewUrl,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2DownloadOperation, ICoreWebView2DownloadStartingEventArgs, ICoreWebView2_4,
    COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
    COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
};
use webview2_com::{take_pwstr, DownloadStartingEventHandler, StateChangedEventHandler};
use windows::core::{Interface, HSTRING, PWSTR};

use super::frames::TabSnapshot;
use super::{DownloadVerdict, Runtime};

/// wry 在未指定 `additional_browser_args` 时传的默认值。
/// 指定该方法会**整体替换**默认值，所以必须自己带上。
const WRY_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 面板接上之前，子视图停在可视区之外。
/// 只能用位置避让：`hide()` 会让页面不再出帧，截图与依赖出帧的等待一起挂起。
const OFFSCREEN: (f64, f64) = (-8000.0, -8000.0);
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

/// 用户新开一页时的落点。地址栏空着，由用户输入真实地址。
///
/// **建这一页不等文档加载**：WebView2 不为它发 `on_page_load`（实测等满 20 秒），
/// 而它也没有要等的目标文档——标记由 `initialization_script` 在用户导航出的那个
/// 文档上注入，AI 要认页也只可能认那一个。
pub const BLANK: &str = "about:blank";

pub struct Tab {
    webview: Webview<Runtime>,
    pub url: String,
    pub title: String,
    pub marker: String,
    /// 拥有它的会话 id；`None` = 用户手动开的页。归属跟着会话走，跨消息稳定。
    pub conversation_id: Option<String>,
    /// 最后一次摆出来的物理尺寸。移出可视区时按它停，不缩小页面视口。
    pub size: (u32, u32),
}

impl Tab {
    pub fn snapshot(&self, tab_id: &str) -> TabSnapshot {
        TabSnapshot {
            tab_id: tab_id.to_owned(),
            url: self.url.clone(),
            title: self.title.clone(),
            marker: self.marker.clone(),
            conversation_id: self.conversation_id.clone(),
        }
    }

    /// 句柄副本。位置与导航要在宿主状态锁之外调用，所以取的是副本而不是引用。
    pub fn view(&self) -> Webview<Runtime> {
        self.webview.clone()
    }

    pub fn close(self) {
        if let Err(e) = self.webview.close() {
            log::warn!("关闭子视图失败：{e}");
        }
    }
}

/// 把子视图摆到窗口客户区的这个物理矩形上。
///
/// **只能传物理像素。** `set_bounds` 收到 `Logical` 会按子视图 HWND 的 DPI 再乘一次
/// 缩放；前端量到的 DOM 矩形已经是 CSS 像素乘 `devicePixelRatio` 的结果，再乘一次
/// 在 100% 之外的缩放下就摆错位置。坐标原点是父窗口客户区左上角。
pub fn place(view: &Webview<Runtime>, x: i32, y: i32, width: u32, height: u32) {
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
pub fn park(view: &Webview<Runtime>, width: u32, height: u32) {
    let scale = view.window().scale_factor().unwrap_or(1.0);
    let x = (OFFSCREEN.0 * scale) as i32;
    let y = (OFFSCREEN.1 * scale) as i32;
    place(view, x, y, width, height);
}

/// 人工导航。地址走引擎自己的导航接口，前进后退走历史接口，`on_navigation` 照常回投。
pub fn navigate(view: &Webview<Runtime>, action: &str, url: Option<&str>) -> Result<(), String> {
    match action {
        "goto" => {
            let raw = url.ok_or("goto 缺少 url")?;
            let parsed: Url = raw.parse().map_err(|e| format!("地址无法解析：{e}"))?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err("只能打开 http / https 地址".to_owned());
            }
            view.navigate(parsed).map_err(|e| e.to_string())
        }
        "reload" => view.reload().map_err(|e| e.to_string()),
        "back" => view.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => view.eval("history.forward()").map_err(|e| e.to_string()),
        other => Err(format!("认不出的导航动作 {other}")),
    }
}

pub struct NewTab {
    pub tab_id: String,
    pub marker: String,
    pub url: String,
    pub profile_dir: PathBuf,
    pub debug_port: u16,
    pub conversation_id: Option<String>,
}

/// 建一个子视图。**不能在主线程调用**：`add_child` 内部是 `run_on_main_thread`
/// 加阻塞等待，在主线程上调用会死锁。
pub fn create(app: &AppHandle, spec: NewTab) -> Result<Tab, String> {
    let window = app
        .get_window("main")
        .ok_or("主窗口不存在，建不出子视图")?;
    let url: Url = spec.url.parse().map_err(|e| format!("地址无法解析：{e}"))?;
    let args =
        format!("{WRY_DEFAULT_BROWSER_ARGS} --remote-debugging-port={}", spec.debug_port);

    let blank_target = spec.url == BLANK;
    let event_tab = spec.tab_id.clone();
    let title_tab = spec.tab_id.clone();
    let (loaded_tx, loaded_rx) = channel::<()>();
    let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
    let builder = WebviewBuilder::new(spec.tab_id.clone(), WebviewUrl::External(url))
        .data_directory(spec.profile_dir)
        .additional_browser_args(&args)
        // AI 建页不切换系统焦点。默认是 true，必须显式关掉。
        .focused(false)
        .initialization_script(marker_script(&spec.marker))
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
    bind_downloads(&webview, &spec.tab_id)?;

    if !blank_target && loaded_rx.recv_timeout(FIRST_LOAD_WAIT).is_err() {
        log::warn!("子视图 {} 在期限内没有加载出首个文档", spec.tab_id);
    }
    let url = webview.url().map(|u| u.to_string()).unwrap_or(spec.url);

    Ok(Tab {
        webview,
        url,
        title: String::new(),
        marker: spec.marker,
        conversation_id: spec.conversation_id,
        size: (DEFAULT_SIZE.0 as u32, DEFAULT_SIZE.1 as u32),
    })
}

/// 注入的标记。
///
/// 必须是不可写不可配置的属性：可写的话同源的另一个页面能把自己的标记改成这一页的值，
/// CDP 侧按标记认页就会认错。Tauri 已经会向外部页面注入自己的桥，这里只多一个常量。
fn marker_script(marker: &str) -> String {
    let value = serde_json::to_string(marker).unwrap_or_else(|_| "\"\"".into());
    format!(
        "Object.defineProperty(window,'__qyworkTab',{{value:{value},writable:false,configurable:false}});"
    )
}

/// 在这一页的 WebView2 上接管下载。
///
/// 绑的是 `DownloadStarting` 交出的那个 `ICoreWebView2DownloadOperation`：终态由该对象的
/// `StateChanged` 回报，一次下载的结果因此只能归发起它的那一次调用。
/// **不要换回 `WebviewBuilder::on_download`**：那条路的完成回报只带 tab 与路径，
/// 同一页上两次下载的终态分不开，先发起的那次会认领后发起的那次的结果。
fn bind_downloads(view: &Webview<Runtime>, tab_id: &str) -> Result<(), String> {
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
        match host.decide_download(tab_id, &url, suggested) {
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

#[cfg(test)]
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
