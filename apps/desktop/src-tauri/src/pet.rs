//! 桌面宠物：宠物窗口与任务框窗口，均为透明、无边框、置顶、不显示在任务栏的窗口。
//!
//! 只承载宠物页面（`pet.html`、`pet.html#box`），不连接 `qy serve`：显示的状态由主窗口推送（`pet://state`），
//! 点击由本模块唤起主窗口后转交（`pet://open`）。未查看结果因此只在主窗口记录一份。
//!
//! 宠物窗口只容纳宠物，尺寸只随宠物包改变，以宠物的左下角为基准调整。气泡与列表在任务框窗口中，
//! 位置由本模块按宠物窗口计算：展开与收起只改变任务框窗口，宠物窗口的位置与尺寸不变。
//! 不要把两者合回一个窗口：窗口位置改变的那一帧 WebView 仍按左上角显示上一帧画面，宠物会跳动一次。

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "pet";
pub const BOX_LABEL: &str = "pet-box";
const MAIN: &str = "main";
/// 首次创建时的边长（逻辑像素）。页面读取到宠物尺寸后经 `pet_window_resize` 调整。
const INITIAL: f64 = 92.0;
/// 未给出位置时距主窗口（或屏幕工作区）右下角的边距（逻辑像素）。
const MARGIN: f64 = 16.0;
/// 页面可请求的尺寸范围（逻辑像素）。超出时拒绝：越界的尺寸只可能来自错误的调用。
const MIN_SIDE: f64 = 40.0;
const MAX_SIDE: f64 = 640.0;
/// 任务框与宠物窗口的水平内缩、与宠物窗口顶边的间距（逻辑像素）。
const BOX_INSET: f64 = 8.0;
const BOX_GAP: f64 = 8.0;

/// 两个窗口共用的创建参数。
fn builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("qywork 宠物")
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false);
    // macOS 上透明窗口需要私有接口特性，本项目未开启；该平台以不透明窗口显示。
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    // 与主窗口共用用户数据目录，环境参数必须完全相同，见 `shell_browser_args`。
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&crate::shell_browser_args());
    #[cfg(all(windows, not(feature = "custom-protocol")))]
    let builder = match crate::dev_webview_dir(app) {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    builder
}

/// 显示宠物；不存在时创建宠物窗口与任务框窗口。`left` / `bottom` 是上次保存的宠物左下角（逻辑坐标），
/// 缺省或已不在任何显示器上时放在主窗口右下角的内侧，主窗口不可见时放在主显示器工作区的右下角。
/// 新窗口为紧凑尺寸，页面随后调整尺寸时固定左下角，宠物因此回到保存的位置。
///
/// 任务框窗口创建后一直处于显示状态，没有内容时为 1 × 1（`pet_box_place`）：
/// 只有第一次显示不激活窗口，之后隐藏再显示会把它激活为前台窗口。
///
/// 必须是异步命令：Windows 上在同步命令中创建 WebView 窗口会使主线程死锁。
#[tauri::command]
pub async fn pet_window_show(
    app: AppHandle,
    left: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return window.show().map_err(|e| e.to_string());
    }
    let window = builder(&app, LABEL, "pet.html")
        .inner_size(INITIAL, INITIAL)
        .build()
        .map_err(|e| e.to_string())?;
    match (left, bottom.map(|b| b - INITIAL)) {
        (Some(x), Some(y)) if on_screen(&window, x, y) => {
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            window
                .set_position(PhysicalPosition::new(
                    (x * scale).round() as i32,
                    (y * scale).round() as i32,
                ))
                .map_err(|e| e.to_string())?;
        }
        _ => place_default(&window)?,
    }
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    builder(&app, BOX_LABEL, "pet.html#box")
        .inner_size(1.0, 1.0)
        .position(f64::from(pos.x) / scale, f64::from(pos.y) / scale)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭宠物窗口与任务框窗口。销毁而不是隐藏：不显示宠物时不应保留 WebView 进程。
#[tauri::command]
pub fn pet_window_hide(app: AppHandle) -> Result<(), String> {
    for label in [BOX_LABEL, LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 按逻辑尺寸调整宠物窗口，保持左下角不动。只接受宠物窗口自身的调用；只在宠物包的尺寸改变时调用。
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
    let next = PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    );
    if next == size {
        return Ok(());
    }
    let bottom = pos.y + size.height as i32;
    window.set_size(next).map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(pos.x, bottom - next.height as i32))
        .map_err(|e| e.to_string())?;
    follow_box(window.app_handle());
    Ok(())
}

/// 设置任务框窗口的逻辑尺寸并按宠物窗口放置；尺寸为 0 时缩为 1 × 1。只接受任务框窗口自身的调用。
/// 先缩小再展开由页面按顺序调用，见 `PetBox.tsx`。
#[tauri::command]
pub fn pet_box_place(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if window.label() != BOX_LABEL {
        return Err("只用于任务框窗口".into());
    }
    let collapse = width == 0.0 || height == 0.0;
    if !collapse && (!(1.0..=MAX_SIDE).contains(&width) || !(1.0..=MAX_SIDE).contains(&height)) {
        return Err(format!("尺寸超出范围：{width}×{height}"));
    }
    let pet = window
        .app_handle()
        .get_webview_window(LABEL)
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    let scale = pet.scale_factor().map_err(|e| e.to_string())?;
    let size = if collapse {
        PhysicalSize::new(1, 1)
    } else {
        PhysicalSize::new(
            (width * scale).round() as u32,
            (height * scale).round() as u32,
        )
    };
    window.set_size(size).map_err(|e| e.to_string())?;
    place_box(&pet, &window, size)
}

/// 按宠物窗口当前的位置放置任务框窗口。1 × 1 时放在宠物窗口的左上角（宠物四周的透明留白内）。
fn place_box(
    pet: &WebviewWindow,
    b: &WebviewWindow,
    size: PhysicalSize<u32>,
) -> Result<(), String> {
    let pos = pet.outer_position().map_err(|e| e.to_string())?;
    let at = if size.width <= 1 && size.height <= 1 {
        pos
    } else {
        let scale = pet.scale_factor().map_err(|e| e.to_string())?;
        let pet_size = pet.outer_size().map_err(|e| e.to_string())?;
        let area = pet
            .current_monitor()
            .map_err(|e| e.to_string())?
            .map(|m| {
                let a = m.work_area();
                (a.position.x, a.position.x + a.size.width as i32)
            })
            .unwrap_or((i32::MIN, i32::MAX));
        let (x, y) = box_origin(
            (pos.x, pos.y, pet_size.width as i32),
            (size.width as i32, size.height as i32),
            area,
            (
                (BOX_INSET * scale).round() as i32,
                (BOX_GAP * scale).round() as i32,
            ),
        );
        PhysicalPosition::new(x, y)
    };
    b.set_position(at).map_err(|e| e.to_string())
}

/// 任务框窗口的左上角（物理像素）：位于宠物窗口上方，左边内缩 `inset`，底边与宠物窗口顶边相距 `gap`；
/// 右侧超出工作区时改为与宠物窗口右边内缩 `inset` 对齐，仍超出左边时贴工作区左边。
/// `pet` 为宠物窗口的左、上与宽度，`area` 为工作区的左右边界。
fn box_origin(
    pet: (i32, i32, i32),
    size: (i32, i32),
    area: (i32, i32),
    (inset, gap): (i32, i32),
) -> (i32, i32) {
    let (px, py, pw) = pet;
    let (w, h) = size;
    let mut x = px + inset;
    if x + w > area.1 {
        x = px + pw - inset - w;
    }
    (x.max(area.0), py - gap - h)
}

/// 宠物窗口移动或改变尺寸后，任务框窗口随之移动。
fn follow_box(app: &AppHandle) {
    let (Some(pet), Some(b)) = (
        app.get_webview_window(LABEL),
        app.get_webview_window(BOX_LABEL),
    ) else {
        return;
    };
    let result = b
        .inner_size()
        .map_err(|e| e.to_string())
        .and_then(|size| place_box(&pet, &b, size));
    if let Err(e) = result {
        log::warn!("任务框未能随宠物移动：{e}");
    }
}

/// 唤起主窗口，给出会话时把它交给主窗口打开。主窗口可能已隐藏到托盘或最小化。
/// 列表为空时单击宠物不带会话，只唤起主窗口：否则主窗口隐藏到托盘后，单击宠物没有任何反应。
///
/// 唤起失败只记入日志，不阻止发送 `pet://open`：主窗口未能置前时仍应切换到该会话。
/// 任务框页面不显示报错，这些日志是「点击后没有跳转」的唯一记录。
///
/// 先短暂置顶再取消：Windows 的前台锁会拒绝 `set_focus` 且不报错，主窗口留在其他窗口之下；
/// 被遮挡的 WebView 不重绘，用户看到的是切换前的画面，表现为「点击没有反应」。
#[tauri::command]
pub fn pet_open_main(app: AppHandle, conversation_id: Option<String>) -> Result<(), String> {
    log::info!("宠物唤起主窗口 会话={conversation_id:?}");
    // 按窗口获取，理由同 `lib.rs` 的 `show_main_window`：浏览器宿主为主窗口添加子 webview 后，
    // `get_webview_window(MAIN)` 恒返回 None，隐藏到托盘的主窗口因此无法唤起。
    match app.get_window(MAIN) {
        Some(main) => {
            for (step, result) in [
                ("显示", main.show()),
                ("还原", main.unminimize()),
                ("置顶", main.set_always_on_top(true)),
                ("取消置顶", main.set_always_on_top(false)),
                ("置前", main.set_focus()),
            ] {
                if let Err(e) = result {
                    log::warn!("主窗口{step}失败：{e}");
                }
            }
        }
        None => log::warn!("主窗口不存在"),
    }
    let Some(conversation_id) = conversation_id else {
        return Ok(());
    };
    app.emit_to(MAIN, "pet://open", conversation_id)
        .map_err(|e| {
            log::warn!("会话未能交给主窗口：{e}");
            e.to_string()
        })
}

/// 宠物窗口移动后把窗口左上角的逻辑坐标交给宠物页面，由它换算为宠物的左下角后交给主窗口保存；
/// 任务框窗口随之移动。
pub fn moved(window: &tauri::Window, pos: PhysicalPosition<i32>) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let at = serde_json::json!({ "x": f64::from(pos.x) / scale, "y": f64::from(pos.y) / scale });
    if let Err(e) = window.app_handle().emit_to(LABEL, "pet://window-moved", at) {
        log::warn!("宠物窗口位置未能交给宠物页面：{e}");
    }
    follow_box(window.app_handle());
}

/// 首次显示的位置：主窗口右下角的内侧，与输入框右侧的空白对齐；之后的位置由用户拖动决定。
/// 主窗口隐藏或最小化时取主显示器工作区的右下角：此时主窗口的坐标不在可见区域内。
fn place_default(window: &WebviewWindow) -> Result<(), String> {
    let main = window
        .app_handle()
        .get_window(MAIN)
        .filter(|m| m.is_visible().unwrap_or(false) && !m.is_minimized().unwrap_or(true));
    let (origin, size, scale) = match main {
        Some(m) => (
            m.outer_position().map_err(|e| e.to_string())?,
            m.outer_size().map_err(|e| e.to_string())?,
            m.scale_factor().map_err(|e| e.to_string())?,
        ),
        None => {
            let Some(monitor) = window.primary_monitor().map_err(|e| e.to_string())? else {
                return Ok(());
            };
            let area = monitor.work_area();
            (area.position, area.size, monitor.scale_factor())
        }
    };
    let offset = ((INITIAL + MARGIN) * scale).round() as i32;
    window
        .set_position(PhysicalPosition::new(
            origin.x + size.width as i32 - offset,
            origin.y + size.height as i32 - offset,
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

#[cfg(test)]
mod tests {
    use super::box_origin;

    #[test]
    fn box_sits_above_pet_with_left_inset() {
        assert_eq!(
            box_origin((100, 500, 92), (244, 40), (0, 1920), (8, 8)),
            (108, 452)
        );
    }

    #[test]
    fn box_aligns_to_pet_right_edge_when_right_side_overflows() {
        // 1808 + 244 超出 1920：右边与宠物窗口右边内缩 8 对齐，即 1800 + 92 - 8 - 244。
        assert_eq!(
            box_origin((1800, 500, 92), (244, 34), (0, 1920), (8, 8)),
            (1640, 458)
        );
    }

    #[test]
    fn box_stays_inside_work_area_left_edge() {
        // 两侧都无法容纳时贴工作区左边：100 + 92 - 8 - 244 = -60。
        assert_eq!(
            box_origin((100, 500, 92), (244, 40), (0, 300), (8, 8)),
            (0, 452)
        );
    }
}
