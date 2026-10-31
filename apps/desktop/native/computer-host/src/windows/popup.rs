//! 目标窗口的弹出窗口：与目标窗口同属一个应用、位于其上方的顶层窗口，即下拉框、菜单、自动补全、
//! 搜索结果面板与对话框。图像采集把它们合成进目标窗口的图像，按图像坐标的指针动作按同一判据确定
//! 落点所在的窗口。两处只经由本模块判定：判据不一致时，图像中显示的窗口不是点击实际到达的窗口。
//!
//! 三条边界：
//!
//! 1. **只计入同一进程的窗口。** 其他应用的内容不进入目标窗口的图像，也不接收按图像坐标的点击。
//! 2. **被目标窗口拥有的窗口一律计入，未被拥有的窗口只在它不是独立的应用窗口时计入**
//!    （`standalone`）。自绘界面的弹出窗口可能不设所有者（微信的部分弹出窗口未被拥有），因此不能只认所有关系；
//!    同一个浏览器进程的另一个窗口覆盖目标窗口时，合成它会遮住目标窗口的内容，按图点击会投递给
//!    一个未被认领的窗口，因此也不能只认进程。
//! 3. **不可见、最小化、被 DWM 隐藏与鼠标穿透（`WS_EX_TRANSPARENT`）的窗口不计入**：点击到达不了
//!    或穿过它们，合成后图像中该处显示的窗口与接收点击的窗口不一致。

use std::ffi::c_void;

use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetWindow, GetWindowLongW, GetWindowTextW, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE,
    GWL_STYLE, GW_HWNDPREV, GW_OWNER, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    WS_EX_TRANSPARENT, WS_THICKFRAME,
};

use super::capture::window_frame;
use super::sink::belongs_to;
use super::{cloaked, window_pid};
use crate::geometry::{popup_at as shown_at, Popup, ScreenPoint, ScreenRect, WindowFrame};

/// 一个计入目标窗口图像的弹出窗口。
pub struct Layer {
    pub hwnd: HWND,
    pub title: String,
    pub frame: WindowFrame,
}

impl Layer {
    /// 图像几何中记录的该弹出窗口。矩形取可见边框，与落点判定使用的矩形相同。
    pub fn popup(&self) -> Popup {
        Popup {
            window: self.hwnd.0 as i64,
            title: self.title.clone(),
            screen: self.frame.visible,
        }
    }
}

/// 未被拥有的窗口是否是独立的应用窗口，而不是弹出层。
///
/// 判据：带 `WS_EX_APPWINDOW`；或者不是工具窗口，且带标题栏或可调边框。应用主窗口与独立对话框都是
/// 这种形状，自绘标题栏的应用同样保留这两项样式，供系统贴靠与窗口动画使用。下拉框、菜单与搜索结果
/// 面板没有标题栏，也不可调整大小。
pub fn standalone(style: u32, ex_style: u32) -> bool {
    ex_style & WS_EX_APPWINDOW.0 != 0
        || (ex_style & WS_EX_TOOLWINDOW.0 == 0
            && (style & WS_CAPTION.0 == WS_CAPTION.0 || style & WS_THICKFRAME.0 != 0))
}

/// 该顶层窗口是否是 `target` 的弹出窗口。`pid` 是 `target` 所属的进程号。
pub fn in_view(hwnd: HWND, target: HWND, pid: u32) -> bool {
    if hwnd == target || window_pid(hwnd.0 as i64) != pid || !accepts_clicks(hwnd) || cloaked(hwnd) {
        return false;
    }
    // SAFETY: 只读查询；没有所有者时返回错误或空句柄。
    match unsafe { GetWindow(hwnd, GW_OWNER) } {
        Ok(owner) if !owner.is_invalid() => belongs_to(hwnd, target),
        _ => {
            // SAFETY: 两项都是只读查询。
            let (style, ex_style) = unsafe {
                (
                    GetWindowLongW(hwnd, GWL_STYLE) as u32,
                    GetWindowLongW(hwnd, GWL_EXSTYLE) as u32,
                )
            };
            !standalone(style, ex_style)
        }
    }
}

/// 窗口可见、未最小化，且不是鼠标穿透窗口。
///
/// 不要排除分层窗口：Qt 与 Chromium 的菜单、下拉框多为分层窗口，排除后点击会落到菜单下方的控件上，
/// 图像中也看不到菜单。
pub fn accepts_clicks(hwnd: HWND) -> bool {
    // SAFETY: 三项都是只读查询。
    unsafe {
        IsWindowVisible(hwnd).as_bool()
            && !IsIconic(hwnd).as_bool()
            && GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0 == 0
    }
}

/// 自目标窗口沿 z 序向上，逐个交给 `visit`，顺序为自下而上。
fn each_above(target: HWND, mut visit: impl FnMut(HWND)) {
    // SAFETY: 只读查询；到达顶端时返回错误或空句柄。
    let mut above = unsafe { GetWindow(target, GW_HWNDPREV) };
    while let Ok(next) = above {
        if next.is_invalid() {
            return;
        }
        visit(next);
        // SAFETY: 同上。
        above = unsafe { GetWindow(next, GW_HWNDPREV) };
    }
}

/// 合成进目标窗口图像的弹出窗口，按 z 序自下而上。
///
/// 与目标窗口的可见矩形或某个已计入的弹出窗口相交的才计入：级联菜单的子菜单只与上一级菜单相交。
/// 矩形取 DWM 的可见边框，与落点判定（`popup_at`）使用同一个矩形。
pub fn layers_above(target: HWND, visible: ScreenRect) -> Vec<Layer> {
    let pid = window_pid(target.0 as i64);
    let mut covered = vec![visible];
    let mut layers = Vec::new();
    each_above(target, |hwnd| {
        if !in_view(hwnd, target, pid) {
            return;
        }
        let Ok(frame) = window_frame(hwnd) else { return };
        if !covered.iter().any(|r| r.intersect(&frame.visible).is_some()) {
            return;
        }
        covered.push(frame.visible);
        layers.push(Layer {
            hwnd,
            title: title_of(hwnd),
            frame,
        });
    });
    layers
}

/// 此刻接收该屏幕点的弹出窗口及其可见矩形：覆盖该点的最上层一个；没有时为 `None`。
pub fn popup_at(target: HWND, at: ScreenPoint) -> Option<(HWND, ScreenRect)> {
    let pid = window_pid(target.0 as i64);
    let mut found = None;
    each_above(target, |hwnd| {
        if !in_view(hwnd, target, pid) {
            return;
        }
        if let Ok(frame) = window_frame(hwnd) {
            if frame.visible.contains(at) {
                found = Some((hwnd, frame.visible));
            }
        }
    });
    found
}

/// 图像中落点处显示的弹出窗口此刻是否仍在原处。返回该窗口；图像中该点显示的是目标窗口本身时
/// 返回 `None`。
///
/// 该窗口已关闭、不再是目标窗口的弹出窗口（句柄被复用），或可见矩形与采图时不同，都按图像失效拒绝：
/// 此时该坐标指向的已不是图像中的那块界面。
pub fn check_shown(target: i64, point: ScreenPoint, popups: &[Popup]) -> Result<Option<i64>, String> {
    let Some(shown) = shown_at(popups, point) else {
        return Ok(None);
    };
    let target = HWND(target as *mut c_void);
    let hwnd = HWND(shown.window as *mut c_void);
    // SAFETY: 只读查询。
    let alive = unsafe { IsWindow(Some(hwnd)) }.as_bool()
        && in_view(hwnd, target, window_pid(target.0 as i64));
    if !alive {
        return Err(format!(
            "geometry_changed: 图像中该位置的弹出窗口 {} 已关闭，请重新采图",
            shown.window
        ));
    }
    let now = window_frame(hwnd)?.visible;
    if now != shown.screen {
        return Err(format!(
            "geometry_changed: 图像中该位置的弹出窗口 {} 已移动或改变大小（{} → {}），请重新采图",
            shown.window,
            describe(shown.screen),
            describe(now)
        ));
    }
    Ok(Some(shown.window))
}

fn describe(r: ScreenRect) -> String {
    format!("{},{} {}×{}", r.x, r.y, r.width, r.height)
}

fn title_of(hwnd: HWND) -> String {
    let mut title = [0u16; 512];
    // SAFETY: 只读查询，出参是本栈帧上的缓冲区。
    let written = unsafe { GetWindowTextW(hwnd, &mut title) };
    String::from_utf16_lossy(&title[..written.max(0) as usize])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::windows::Win32::UI::WindowsAndMessaging::{
        WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOPMOST,
        WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_SYSMENU,
    };

    /// 本机读取到的窗口样式：微信的主窗口、未被拥有的面板窗口（位置与尺寸与搜索结果面板一致）与
    /// 工具弹出窗口，以及 Edge 主窗口的样式组合。自绘标题栏的主窗口仍带标题栏与可调边框；面板窗口
    /// 两者都没有，也不是工具窗口。
    #[test]
    fn main_windows_are_standalone_and_popups_are_not() {
        let weixin_main = 0x96c7_0000;
        let weixin_search =
            (WS_POPUP | WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN | WS_SYSMENU | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX)
                .0;
        assert_eq!(weixin_search, 0xc60b_0000);
        let edge_main = (WS_OVERLAPPEDWINDOW | WS_CLIPSIBLINGS | WS_CLIPCHILDREN).0;
        assert!(standalone(weixin_main, WS_EX_WINDOWEDGE.0));
        assert!(standalone(edge_main, WS_EX_WINDOWEDGE.0));
        assert!(!standalone(weixin_search, 0));
        // 工具窗口即使带标题栏也不是独立窗口：它不出现在任务栏上，是浮动面板。
        assert!(!standalone(weixin_main, WS_EX_TOOLWINDOW.0));
        let tool_popup = (WS_CLIPSIBLINGS | WS_CLIPCHILDREN).0;
        assert!(!standalone(
            tool_popup,
            (WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE).0
        ));
        // 带 WS_EX_APPWINDOW 的窗口出现在任务栏上，无论形状如何都是独立窗口。
        assert!(standalone(weixin_search, WS_EX_APPWINDOW.0));
    }
}
