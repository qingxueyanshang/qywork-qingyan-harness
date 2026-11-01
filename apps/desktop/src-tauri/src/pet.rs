//! 桌面宠物窗口：透明、无边框、置顶、不显示在任务栏。
//!
//! 只承载宠物页面（`pet.html`），不连接 `qy serve`：显示的状态由主窗口推送（`pet://state`），
//! 点击由本模块唤起主窗口后转交（`pet://open`）。未查看结果因此只在主窗口记录一份。
//!
//! 调整尺寸以左下角为基准：页面中的宠物固定在左下角，展开列表或气泡时宠物在屏幕上的位置不变。

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "pet";
const MAIN: &str = "main";
/// 首次创建时的边长（逻辑像素）。页面读取到宠物尺寸后经 `pet_window_resize` 调整。
const INITIAL: f64 = 92.0;
/// 未给出位置时距屏幕工作区右下角的边距（逻辑像素）。
const MARGIN: f64 = 24.0;
/// 页面可请求的尺寸范围（逻辑像素）。超出时拒绝：越界的尺寸只可能来自错误的调用。
const MIN_SIDE: f64 = 40.0;
const MAX_SIDE: f64 = 640.0;

/// 显示宠物窗口；不存在时创建。`x` / `y` 是上次移动后保存的逻辑坐标，
/// 缺省或已不在任何显示器上时放在主显示器工作区的右下角。
///
/// 必须是异步命令：Windows 上在同步命令中创建 WebView 窗口会使主线程死锁。
#[tauri::command]
pub async fn pet_window_show(app: AppHandle, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return window.show().map_err(|e| e.to_string());
    }
    let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("pet.html".into()))
        .title("qywork 宠物")
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .inner_size(INITIAL, INITIAL);
    // macOS 上透明窗口需要私有接口特性，本项目未开启；该平台以不透明窗口显示。
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    // 与主窗口共用用户数据目录，环境参数必须完全相同，见 `shell_browser_args`。
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&crate::shell_browser_args());
    let window = builder.build().map_err(|e| e.to_string())?;
    match (x, y) {
        (Some(x), Some(y)) if on_screen(&window, x, y) => {
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            window
                .set_position(PhysicalPosition::new(
                    (x * scale).round() as i32,
                    (y * scale).round() as i32,
                ))
                .map_err(|e| e.to_string())
        }
        _ => place_default(&window),
    }
}

/// 关闭宠物窗口。销毁而不是隐藏：不显示宠物时不应保留一个 WebView 进程。
#[tauri::command]
pub fn pet_window_hide(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(window) => window.destroy().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 按逻辑尺寸调整宠物窗口，保持左下角不动。只接受宠物窗口自身的调用。
#[tauri::command]
pub fn pet_window_resize(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("只用于宠物窗口".into());
    }
    if !(MIN_SIDE..=MAX_SIDE).contains(&width) || !(MIN_SIDE..=MAX_SIDE).contains(&height) {
        return Err(format!("尺寸超出范围：{width}×{height}"));
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let next = PhysicalSize::new((width * scale).round() as u32, (height * scale).round() as u32);
    if next == size {
        return Ok(());
    }
    let bottom = pos.y + size.height as i32;
    window.set_size(next).map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(pos.x, bottom - next.height as i32))
        .map_err(|e| e.to_string())
}

/// 唤起主窗口并把要打开的会话交给它。主窗口可能已隐藏到托盘或最小化。
#[tauri::command]
pub fn pet_open_main(app: AppHandle, conversation_id: String) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN)
        .ok_or_else(|| "主窗口不存在".to_string())?;
    main.show().map_err(|e| e.to_string())?;
    main.unminimize().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())?;
    app.emit_to(MAIN, "pet://open", conversation_id)
        .map_err(|e| e.to_string())
}

/// 宠物窗口移动后把逻辑坐标交给主窗口保存，下次显示时放回原处。
pub fn moved(window: &tauri::Window, pos: PhysicalPosition<i32>) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let at = serde_json::json!({ "x": f64::from(pos.x) / scale, "y": f64::from(pos.y) / scale });
    if let Err(e) = window.app_handle().emit_to(MAIN, "pet://moved", at) {
        log::warn!("宠物窗口位置未能交给主窗口：{e}");
    }
}

/// 用户关闭宠物窗口（Alt+F4 等）时交给主窗口改为「隐藏」：显示位置的记录在主窗口，
/// 直接销毁窗口会使记录仍为「桌面」，下次启动时宠物又出现。
pub fn close_requested(window: &tauri::Window) {
    let action = serde_json::json!({ "type": "hide" });
    if let Err(e) = window.app_handle().emit_to(MAIN, "pet://action", action) {
        log::warn!("宠物窗口关闭未能交给主窗口：{e}");
    }
}

fn place_default(window: &WebviewWindow) -> Result<(), String> {
    let Some(monitor) = window.primary_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let offset = ((INITIAL + MARGIN) * monitor.scale_factor()).round() as i32;
    window
        .set_position(PhysicalPosition::new(
            area.position.x + area.size.width as i32 - offset,
            area.position.y + area.size.height as i32 - offset,
        ))
        .map_err(|e| e.to_string())
}

/// 逻辑坐标是否落在某个显示器内。显示器拔除后保存的位置可能已不可见。
fn on_screen(window: &WebviewWindow, x: f64, y: f64) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let (px, py) = ((x * scale) as i32, (y * scale) as i32);
        let p = m.position();
        let s = m.size();
        px >= p.x && py >= p.y && px < p.x + s.width as i32 && py < p.y + s.height as i32
    })
}
