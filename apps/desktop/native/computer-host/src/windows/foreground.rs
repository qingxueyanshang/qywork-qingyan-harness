//! 前台接管：指针、键盘与窗口操作。
//!
//! 七条边界：
//!
//! 1. **本模块的每个动作都会占用用户的前台**，因此只在请求启用前台模式时执行；前台模式
//!    关闭时，准入判定在 `protocol::admit` 中拒绝请求，不发出任何系统调用。
//! 2. **落点在派发时重新计算。** 重新定位控件、读取当前包围盒、核对落点属于目标窗口，
//!    三步缺一不可：观察时记录的包围盒在控件移动之后指向其他位置。按控件定位时，
//!    落点位于控件所在的、目标窗口拥有的弹出窗口上，同样视为属于目标。
//! 3. **按下的键在按下时登记，任何中止路径都释放。** 登记与释放由 `input::Hold` 负责，
//!    本模块不直接编写释放调用。
//! 4. **指针与键盘输入在定位前先将目标窗口提升到前台**（`prepare`，由后端在定位前调用），
//!    再读取控件与几何并做派发核对：指针核对落点属于目标窗口，键盘核对前台窗口是
//!    目标窗口且该窗口未被禁用。指定了控件时还核对该控件持有键盘焦点，焦点不在该控件上即
//!    拒绝：激活窗口不等于更改控件焦点，本模块不替用户更改焦点。未指定控件时以窗口为目标。
//!    带 `meta`（Windows 徽标键）的组合键例外：它发给系统，不提升目标窗口，改为提升任务栏
//!    （`system_shortcut`）。
//! 5. **中途前台改变时立即停止**，如实返回已发出的数量，执行事实记为 `unknown`，不向另一个
//!    窗口继续输入。本条适用于动作进行期间，不适用于派发前。
//! 6. **窗口动作的生效证据按动作分别读取**（前台窗口、显示状态、窗口矩形），
//!    不沿用后台模式的三项证据：激活本身就会改变前台，「同进程出现新的顶层窗口」无法证明激活生效。
//! 7. **文字按接收窗口选择投递方式，不按字符选择**：一般窗口投递字符消息，UWP 的 `CoreWindow`
//!    注入 Unicode 键盘事件（`sink.rs`）。两种方式都不修改剪贴板，对字符集也没有限制。

use std::ffi::c_void;
use std::time::Duration;

use ::windows::core::w;
use ::windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use ::windows::Win32::UI::Accessibility::{
    IUIAutomationElement, IUIAutomationTransformPattern, IUIAutomationWindowPattern,
    UIA_TransformPatternId, UIA_WindowPatternId, WindowVisualState,
};
use ::windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use ::windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use ::windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetSystemMetrics,
    FindWindowW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsZoomed,
    SendMessageTimeoutW, SetForegroundWindow,
    ShowWindow, WindowFromPoint, GA_ROOT, GA_ROOTOWNER, GUITHREADINFO, HTCAPTION,
    SMTO_ABORTIFHUNG, SM_CXVIRTUALSCREEN, WM_NCHITTEST,
    SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE,
};

use super::sink::{post_text, CharSink, SystemCharSink, SystemSink};
use super::{current_pattern, defer, dispatch_call, CallWatch, StateWatch};
use crate::backend::{confirm, lands_on_target, settled, Attempt, Outcome};
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::input::{drag_path, key_stroke, wheel_of, Event, Hold, Sink};
use crate::protocol::{
    classify_input, key_name, ActionEvidence, ActionSpec, Dispatch, Modifier, MouseButton,
    WindowState,
};

/// 一次拖拽分段移动的段数。
///
/// 一次移动到终点时，被拖拽的控件收不到中间的移动消息，很多实现依据这些消息判断拖拽是否已开始。
const DRAG_STEPS: u32 = 12;
/// 拖拽相邻两段之间的间隔。总时长因此约为 `DRAG_STEPS * DRAG_STEP_MS`。
const DRAG_STEP_MS: u64 = 16;
/// 一次文字投递每批包含的 UTF-16 码元数。每两批之间重新核对前台窗口与接收窗口。
const TEXT_BATCH_UNITS: usize = 24;
/// 激活之后等待前台窗口完成切换的时长。前台切换需要目标窗口的线程处理激活消息，不是同步完成的。
const ACTIVATE_SETTLE: Duration = Duration::from_millis(400);
/// 读取窗口状态或矩形的等待上限。模式调用返回之后窗口还需重绘一次。
const WINDOW_SETTLE: Duration = Duration::from_millis(400);

/// 一次指针动作的落点。非指针动作三项均缺失。
#[derive(Debug, Clone, Copy, Default)]
pub struct Aim {
    /// 指针落点，屏幕物理像素。
    pub anchor: Option<ScreenPoint>,
    /// 拖拽终点。仅拖拽动作具有此项。
    pub destination: Option<ScreenPoint>,
    /// 按控件定位时，目标控件所在的 OS 窗口（控件自身或最近一个带窗口句柄的祖先）。
    /// 按图像坐标定位时缺失。
    pub host: Option<i64>,
}

/// 执行一个前台动作。
///
/// `element` 仅在按控件定位时存在。按屏幕坐标定位的指针动作没有控件；键盘输入可以
/// 不指定控件，此时目标是窗口本身；窗口动作必定有控件，准入判定已保证这一点。
pub fn perform(
    window: i64,
    element: Option<&IUIAutomationElement>,
    action: &ActionSpec,
    aim: Aim,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    let sink = SystemSink;
    if let ActionSpec::PressKey { key, modifiers } = action {
        if modifiers.contains(&Modifier::Meta) {
            return system_shortcut(&sink, key, modifiers);
        }
    }
    match action {
        ActionSpec::Click { button, count } => click(window, &sink, aim, *button, *count),
        ActionSpec::Hover => hover(window, &sink, aim),
        ActionSpec::Drag { .. } => drag(window, &sink, aim, stop),
        ActionSpec::Wheel { direction, amount } => {
            wheel(window, &sink, aim, wheel_of(*direction, *amount))
        }
        ActionSpec::TypeText { text } => match keyboard_target(window, element) {
            Err(reason) => Attempt::Refused(reason),
            Ok(()) => type_text(window, &SystemCharSink, text),
        },
        ActionSpec::PressKey { key, modifiers } => match keyboard_target(window, element) {
            Err(reason) => Attempt::Refused(reason),
            Ok(()) => press_key(&sink, key, modifiers),
        },
        ActionSpec::Activate => activate(window),
        ActionSpec::SetWindowState { state } => match element {
            None => Attempt::Refused(MISSING_ELEMENT.to_owned()),
            Some(element) => set_window_state(window, element, *state),
        },
        ActionSpec::MoveWindow { x, y } => match element {
            None => Attempt::Refused(MISSING_ELEMENT.to_owned()),
            Some(element) => transform(window, element, Placement::Move { x: *x, y: *y }),
        },
        ActionSpec::ResizeWindow { width, height } => match element {
            None => Attempt::Refused(MISSING_ELEMENT.to_owned()),
            Some(element) => transform(
                window,
                element,
                Placement::Resize {
                    width: *width,
                    height: *height,
                },
            ),
        },
        ActionSpec::CloseWindow => match element {
            None => Attempt::Refused(MISSING_ELEMENT.to_owned()),
            Some(element) => close_window(window, element),
        },
        // 后台动作不经由此处。逐项列出而不写 `_`：新增前台动作而未接入时，应在此处编译失败，
        // 而不是进入拒绝分支。
        ActionSpec::Invoke
        | ActionSpec::SetValue { .. }
        | ActionSpec::SetRangeValue { .. }
        | ActionSpec::Select
        | ActionSpec::AddToSelection
        | ActionSpec::RemoveFromSelection
        | ActionSpec::SetToggle { .. }
        | ActionSpec::Expand
        | ActionSpec::Collapse
        | ActionSpec::Scroll { .. }
        | ActionSpec::ScrollIntoView
        | ActionSpec::RealizeItem { .. }
        | ActionSpec::SelectText { .. } => {
            Attempt::Refused("not_foreground: 该动作不经由前台路径".to_owned())
        }
    }
}

const MISSING_ELEMENT: &str = "missing_target: 该动作只能按控件执行";

/// 核对本次请求携带的窗口几何代际是否仍然有效。
///
/// 按图定位的落点必须通过此项核对：窗口在采图与派发之间移动过时，该坐标指向的已不是
/// 同一块界面。
pub fn check_generation(window: i64, expected: &str) -> Result<(), String> {
    let hwnd = HWND(window as *mut c_void);
    let frame = super::capture::window_frame(hwnd)?;
    let actual = frame.generation();
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "geometry_changed: {expected} → {actual}"
    ))
}

// ── 指针 ──

fn click(window: i64, sink: &dyn Sink, aim: Aim, button: MouseButton, count: u32) -> Attempt {
    if count == 0 || count > 2 {
        return Attempt::Refused(format!("invalid_count: {count}，只接受 1 或 2"));
    }
    let anchor = match landing(window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let mut events = vec![Event::Move { to: anchor }];
    for _ in 0..count {
        events.push(Event::Button { button, down: true });
        events.push(Event::Button {
            button,
            down: false,
        });
    }
    // 双击的两次点击必须在系统双击间隔内：整批事件一次提交给系统，两次点击之间没有可测量的间隔。
    settle(sink.send(&events), &events)
}

fn hover(window: i64, sink: &dyn Sink, aim: Aim) -> Attempt {
    let anchor = match landing(window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let events = [Event::Move { to: anchor }];
    settle(sink.send(&events), &events)
}

fn wheel(window: i64, sink: &dyn Sink, aim: Aim, wheel: (i32, bool)) -> Attempt {
    let anchor = match landing(window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    // 滚轮事件发往指针下方的窗口，因此先将指针移到目标上。
    let events = [
        Event::Move { to: anchor },
        Event::Wheel {
            notches: wheel.0,
            horizontal: wheel.1,
        },
    ];
    settle(sink.send(&events), &events)
}

/// 按下 → 分段移动 → 抬起。
///
/// 取消、目标窗口消失与落点失效都从中途返回，`Hold` 在每一条路径上释放本次按下的左键。
fn drag(window: i64, sink: &dyn Sink, aim: Aim, stop: &dyn Fn() -> bool) -> Attempt {
    let anchor = match landing(window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let Some(destination) = aim.destination else {
        return Attempt::Refused("missing_target: 拖拽没有终点".to_owned());
    };
    // 终点同样必须位于目标窗口内：拖到其他窗口上等于把本次释放交给另一个应用。
    match window_rect(window) {
        Err(reason) => return Attempt::Refused(reason),
        Ok(rect) if !rect.contains(destination) => {
            return Attempt::Refused(format!(
                "drop_outside_window: {},{}",
                destination.x, destination.y
            ))
        }
        Ok(_) => {}
    }
    if sink.send(&[Event::Move { to: anchor }]) == 0 {
        return blocked(1);
    }
    // 在按下之前登记：worker 若在按下与登记之间被强制终止，任何一方都无法得知该键处于按下状态。
    let mut hold = Hold::record(sink, vec![MouseButton::Left], Vec::new());
    if sink.send(&[Event::Button {
        button: MouseButton::Left,
        down: true,
    }]) == 0
    {
        hold.release();
        // 指针已移到起点，因此不能报告为没有任何事件进入队列；未进入的是按下事件，
        // 而没有按下就不构成本次拖拽。
        return Attempt::Called(Outcome::returned(
            Dispatch::NotDispatched,
            Some(
                "input_blocked: 按下事件未进入输入队列，指针已位于起点".to_owned(),
            ),
        ));
    }
    let path = drag_path(anchor, destination, DRAG_STEPS);
    let mut moved = 0u32;
    for point in &path {
        if stop() {
            hold.release();
            return Attempt::Called(Outcome::returned(
                Dispatch::Unknown,
                Some(format!(
                    "cancelled: 拖拽第 {moved} 段 · 左键已释放"
                )),
            ));
        }
        if !alive(window) {
            hold.release();
            return Attempt::Called(Outcome::returned(
                Dispatch::Unknown,
                Some("target_lost: 拖拽途中窗口消失 · 左键已释放".to_owned()),
            ));
        }
        moved += sink.send(&[Event::Move { to: *point }]);
        std::thread::sleep(Duration::from_millis(DRAG_STEP_MS));
    }
    let released = hold.release();
    let requested = u32::try_from(path.len()).unwrap_or(u32::MAX) + 1;
    let (dispatch, reason) = classify_input(moved + released, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 计算本次指针动作的屏幕落点，并核对该位置属于本次动作，判据见 `lands_on_target`。
///
/// 目标窗口不在前台的情形由 `prepare` 在定位前处理；执行到此处仍被遮挡时，遮挡方是
/// 置顶窗口或其他窗口，如实拒绝。
fn landing(window: i64, aim: Aim) -> Result<ScreenPoint, String> {
    let anchor = aim
        .anchor
        .ok_or("missing_target: 指针动作没有落点")?;
    let rect = window_rect(window)?;
    if !rect.contains(anchor) {
        return Err(format!(
            "point_outside_window: {},{}",
            anchor.x, anchor.y
        ));
    }
    // 落在窗口矩形内不等于目标窗口可见：其他窗口覆盖在上方时，本次点击落在该窗口上。
    // SAFETY: 纯查询，参数是屏幕坐标。
    let hit = unsafe { WindowFromPoint(POINT {
        x: anchor.x,
        y: anchor.y,
    }) };
    if hit.0.is_null() {
        return Err(format!(
            "point_unowned: {},{}",
            anchor.x, anchor.y
        ));
    }
    // SAFETY: 句柄来自上一行的查询。
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    // SAFETY: 同上，求顶层窗口所有者链的顶端。
    let owner = unsafe { GetAncestor(root, GA_ROOTOWNER) };
    // SAFETY: 句柄来自本次定位，窗口已关闭时返回空句柄，与任何落点都不相等。
    let control_root = aim
        .host
        .map(|host| unsafe { GetAncestor(HWND(host as *mut c_void), GA_ROOT) }.0 as i64);
    if !lands_on_target(window, root.0 as i64, owner.0 as i64, control_root) {
        return Err(format!(
            "occluded: {},{}",
            anchor.x, anchor.y
        ));
    }
    Ok(anchor)
}

/// 一批事件发送完毕后的执行事实。
fn settle(sent: u32, events: &[Event]) -> Attempt {
    let requested = u32::try_from(events.len()).unwrap_or(u32::MAX);
    let (dispatch, reason) = classify_input(sent, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 没有任何事件进入输入队列时的终态。
fn blocked(requested: u32) -> Attempt {
    let (dispatch, reason) = classify_input(0, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

// ── 键盘 ──

/// 键盘输入的前置条件。目标窗口不在前台的情形由 `prepare` 在定位前处理。
///
/// 以下两项适用于所有键盘输入：目标窗口是系统前台窗口，且该窗口未被禁用。
/// **未指定控件时以窗口为目标**，判定到此结束：键盘输入发往系统焦点所在位置，
/// 前台窗口是目标窗口时焦点必然位于该窗口内；自绘界面不暴露业务控件，
/// 要求指定一个持有焦点的控件等于对这类界面关闭整条键盘路径。
///
/// 指定了控件时增加一项条件：该控件当前持有键盘焦点。焦点读取的是实时属性而不是观察时的缓存，
/// 焦点在观察与动作之间被用户更改时，按缓存判定会把输入发给另一个控件。
/// **焦点不在目标上即拒绝**，不替用户夺取焦点。
fn keyboard_target(window: i64, element: Option<&IUIAutomationElement>) -> Result<(), String> {
    foreground_ok(window)?;
    // SAFETY: 句柄由调用方核对过归属。
    if !unsafe { IsWindowEnabled(HWND(window as *mut c_void)) }.as_bool() {
        return Err("window_disabled: 目标窗口已禁用".to_owned());
    }
    let Some(element) = element else {
        return Ok(());
    };
    // SAFETY: 实时属性查询，跨进程调用的上界由 UIA 的连接超时保证。
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map_err(|e| format!("读取键盘焦点失败 {e}"))?
        .as_bool();
    if !focused {
        return Err(
            "not_focused: 该控件没有键盘焦点 · 请先对该控件执行 click".to_owned(),
        );
    }
    Ok(())
}

/// 系统前台窗口的句柄。
pub fn foreground_window() -> i64 {
    // SAFETY: 无参只读查询。
    unsafe { GetForegroundWindow() }.0 as i64
}

fn foreground_ok(window: i64) -> Result<(), String> {
    let at = foreground_window();
    if at == window {
        return Ok(());
    }
    Err(format!("not_foreground: {at}"))
}

/// 输入文字。所有字符的处理方式相同，投递方式只由接收窗口决定（`SystemCharSink`）。
///
/// 每一批之前重新确定接收窗口（`text_target`），前台或焦点发生变化时立即停止，并如实返回
/// 已发送的数量；不向其他窗口继续投递。
fn type_text(window: i64, chars: &dyn CharSink, text: &str) -> Attempt {
    if text.is_empty() {
        return Attempt::Refused("empty_text: 文字为空".to_owned());
    }
    let out = post_text(chars, text, TEXT_BATCH_UNITS, &|| text_target(window));
    let (dispatch, reason) = classify_input(out.sent, out.requested);
    // 中途停止时原因由 `text_target` 给出，不保留 `classify_input` 中关于 UIPI 的推测：
    // 本次停止的成因可以核实，无需推测。
    let reason = match out.interrupted {
        Some(note) => Some(format!("{note} · 已发送 {} / {} 个字符", out.sent, out.requested)),
        None => reason,
    };
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 确定本批文字的接收窗口。
///
/// 前台窗口必须仍是目标窗口，接收窗口取系统前台线程的焦点窗口；没有焦点控件时
/// 由目标窗口自身接收（自绘界面属于这种情形）。**焦点窗口必须属于目标窗口**：焦点在两批
/// 之间被用户移到其他应用上时，剩余字符不再投递，也不投递给该应用。
fn text_target(window: i64) -> Result<i64, String> {
    foreground_ok(window)?;
    let focus = gui_focus();
    if focus == 0 {
        return Ok(window);
    }
    // SAFETY: 句柄来自上一行的查询。
    let root = unsafe { GetAncestor(HWND(focus as *mut c_void), GA_ROOT) };
    if root.0 as i64 != window {
        return Err(format!("not_focused: 键盘焦点在窗口 {} 上", root.0 as i64));
    }
    Ok(focus)
}

/// 系统前台线程当前的焦点窗口。没有焦点控件时返回 0。
fn gui_focus() -> i64 {
    let mut info = GUITHREADINFO {
        cbSize: u32::try_from(std::mem::size_of::<GUITHREADINFO>()).unwrap_or(0),
        ..GUITHREADINFO::default()
    };
    // SAFETY: 出参是本栈帧上的结构体，线程号 0 表示前台线程。
    if unsafe { GetGUIThreadInfo(0, &mut info) }.is_err() {
        return 0;
    }
    info.hwndFocus.0 as i64
}

/// 一次组合键。整条序列一次提交给系统，其他输入无法插入其中。
fn press_key(sink: &dyn Sink, key: &str, modifiers: &[Modifier]) -> Attempt {
    let Some(main) = key_name(key) else {
        return Attempt::Refused(format!("unknown_key: {key}"));
    };
    let held: Vec<String> = modifiers.iter().map(|m| m.key_name().to_owned()).collect();
    let events = key_stroke(&main, &held);
    let requested = u32::try_from(events.len()).unwrap_or(u32::MAX);
    // 在派发之前登记：整条序列自带抬起事件，但只发出一部分时修饰键会停留在按下状态。
    let mut hold = Hold::record(sink, Vec::new(), {
        let mut keys = held.clone();
        keys.push(main);
        keys
    });
    let sent = sink.send(&events);
    if sent >= requested {
        // 序列自身已抬起每个键，此处只清除登记，不再重复发送抬起事件。
        hold.clear();
    } else {
        hold.release();
    }
    let (dispatch, reason) = classify_input(sent, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 带 `meta`（Windows 徽标键）的组合键发给系统，不经过任何应用窗口。
///
/// 先将任务栏提升到前台再按键：系统快捷键由外壳截获，与前台窗口无关；不属于系统快捷键的
/// 组合键落在任务栏上，不进入用户的窗口。不要改成先提升目标窗口：桌面（Progman）提升到前台后，
/// 前台落在同线程的另一个窗口（WorkerW），前台核对始终无法通过，模型只能改用用户正在使用的
/// 窗口按键，按键之前还会把该窗口提升到最前并更改其显示状态。
fn system_shortcut(sink: &dyn Sink, key: &str, modifiers: &[Modifier]) -> Attempt {
    // SAFETY: 只读查询，类名是常量。
    let Ok(tray) = (unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }) else {
        return Attempt::Refused("no_taskbar: 未找到任务栏".to_owned());
    };
    let target = tray.0 as i64;
    if !matches!(raise(target), Raised::Reached) {
        return Attempt::Refused(format!("not_foreground: {}", foreground_window()));
    }
    press_key(sink, key, modifiers)
}

// ── 窗口 ──

/// 定位前准备前台窗口。还原最小化窗口会改变控件位置，调用方必须在此后重新定位、
/// 读取包围盒并核对截图几何。失败也可能已经还原窗口，不能据此保留旧观察。
pub fn prepare(window: i64, action: &ActionSpec) -> Result<(), String> {
    if !action.takes_input()
        || matches!(action, ActionSpec::PressKey { modifiers, .. } if modifiers.contains(&Modifier::Meta))
    {
        return Ok(());
    }
    if foreground_window() == window {
        return Ok(());
    }
    match raise(window) {
        Raised::Reached => Ok(()),
        Raised::Accepted => Err("not_foreground: 激活调用已返回，目标窗口尚未到达前台".to_owned()),
        Raised::Refused => Err("foreground_lock: 前台锁拒绝了本次激活，前台窗口未改变".to_owned()),
    }
}

/// 一次前台提升的结果。
enum Raised {
    /// 前台窗口已经是目标窗口。
    Reached,
    /// 调用被接受，但前台窗口未变为目标窗口。
    Accepted,
    /// 三级均未被接受，前台窗口未改变。
    Refused,
}

/// 将目标窗口提升到前台。
///
/// 分三级，后一级只在前一级未生效时执行：直接调用 `SetForegroundWindow`；被系统前台锁拒绝之后
/// 挂接到当前前台窗口的线程上再调用一次：挂接期间两个线程共用输入状态，系统据此把调用方
/// 视为前台线程并放行，任何返回路径都解除挂接；仍被拒绝时在目标窗口未被遮挡的标题栏上
/// 单击一次（`caption_click`）。本进程无法取得前台权限时前两级都会被拒绝：宿主的转让只在宿主
/// 自身处于前台时成立，前台一旦转到其他进程（开始菜单、用户的应用），挂接也会失败。
///
/// **不要改成模拟 Alt 按键。** 该写法会向用户当前正在使用的应用发送一次真实按键，
/// 而本函数只应更改前台归属。标题栏点击落在目标窗口自身，不进入用户正在使用的应用。
///
/// 最小化的窗口先还原：最小化状态下前台切换只恢复任务栏按钮，窗口本身不会显示。
fn raise(window: i64) -> Raised {
    let hwnd = HWND(window as *mut c_void);
    // SAFETY: 句柄由调用方核对过归属，两项都只读写显示状态。
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
    }
    // SAFETY: 同上。
    let direct = unsafe { SetForegroundWindow(hwnd) }.as_bool();
    if settled(ACTIVATE_SETTLE, || foreground_window() == window) {
        return Raised::Reached;
    }
    let attached = attached_raise(hwnd);
    if settled(ACTIVATE_SETTLE, || foreground_window() == window) {
        return Raised::Reached;
    }
    let clicked = caption_click(hwnd, &SystemSink);
    if clicked && settled(ACTIVATE_SETTLE, || foreground_window() == window) {
        return Raised::Reached;
    }
    if direct || attached || clicked {
        Raised::Accepted
    } else {
        Raised::Refused
    }
}

/// 挂接到当前前台窗口的线程上再请求一次前台。返回真表示本次调用被接受。
///
/// 解除挂接不能省略，也不能只写在成功路径上：不解除时两个线程此后一直共用输入队列，
/// 目标应用无响应时本进程的输入一并阻塞。
fn attached_raise(hwnd: HWND) -> bool {
    // SAFETY: 无参只读查询。
    let front = unsafe { GetForegroundWindow() };
    if front.0.is_null() {
        return false;
    }
    // SAFETY: 句柄来自上一行，不需要进程号出参。
    let front_thread = unsafe { GetWindowThreadProcessId(front, None) };
    // SAFETY: 无参只读查询。
    let own_thread = unsafe { GetCurrentThreadId() };
    if front_thread == 0 || front_thread == own_thread {
        return false;
    }
    // SAFETY: 两个线程号都来自上面的查询。
    if !unsafe { AttachThreadInput(own_thread, front_thread, true) }.as_bool() {
        return false;
    }
    // SAFETY: 句柄由调用方核对过归属。
    unsafe {
        let _ = BringWindowToTop(hwnd);
    }
    // SAFETY: 同上。
    let accepted = unsafe { SetForegroundWindow(hwnd) }.as_bool();
    // SAFETY: 解除上方的挂接，两个线程号不变。
    unsafe {
        let _ = AttachThreadInput(own_thread, front_thread, false);
    }
    accepted
}

/// 在目标窗口的标题栏上单击一次。返回真表示点击已进入输入队列。
///
/// 点击由系统输入线程按落点激活窗口，不受前台锁约束。落点只取同时满足两项条件的位置：
/// 窗口自身返回 `HTCAPTION`（避开标题栏按钮、标签页与地址栏），`WindowFromPoint` 的根窗口
/// 就是目标（未被其他窗口遮挡）。没有这样的位置时不点击。
fn caption_click(hwnd: HWND, sink: &dyn Sink) -> bool {
    let Some(point) = caption_point(hwnd) else {
        return false;
    };
    let events = [
        Event::Move { to: point },
        Event::Button {
            button: MouseButton::Left,
            down: true,
        },
        Event::Button {
            button: MouseButton::Left,
            down: false,
        },
    ];
    sink.send(&events) == 3
}

/// 标题栏上一个未被遮挡的点。候选点沿窗口顶部选取，按顺序尝试。
fn caption_point(hwnd: HWND) -> Option<ScreenPoint> {
    let rect = window_rect(hwnd.0 as i64).ok()?;
    if rect.width < 40 || rect.height < 40 {
        return None;
    }
    for y in [12, 20, 6] {
        for fraction in [0.5, 0.35, 0.65, 0.2, 0.8] {
            let point = ScreenPoint {
                x: rect.x + (f64::from(rect.width) * fraction) as i32,
                y: rect.y + y,
            };
            if hits_caption(hwnd, point) && exposed(hwnd, point) {
                return Some(point);
            }
        }
    }
    None
}

/// 判断窗口对该屏幕坐标的命中测试是否返回标题栏。窗口无响应时 200 毫秒内未应答即按否处理。
fn hits_caption(hwnd: HWND, point: ScreenPoint) -> bool {
    let packed = ((point.y as u32 & 0xFFFF) << 16) | (point.x as u32 & 0xFFFF);
    let mut answer = 0usize;
    // SAFETY: 只发送一条命中测试消息，坐标打包在 lParam 中，结果写入本地变量。
    let replied = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_NCHITTEST,
            WPARAM(0),
            LPARAM(packed as i32 as isize),
            SMTO_ABORTIFHUNG,
            200,
            Some(&mut answer),
        )
    };
    replied.0 != 0 && answer as u32 == HTCAPTION
}

/// 判断该屏幕坐标上最顶层的窗口是否为目标窗口自身。
fn exposed(hwnd: HWND, point: ScreenPoint) -> bool {
    // SAFETY: 纯查询，参数是屏幕坐标。
    let hit = unsafe { WindowFromPoint(POINT { x: point.x, y: point.y }) };
    if hit.0.is_null() {
        return false;
    }
    // SAFETY: 句柄来自上一行的查询。
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    root == hwnd
}

/// 激活目标窗口。三种终态：到达前台记为已执行，调用被接受而前台未改变记为结果未知，
/// 三级均未被接受记为未派发。
fn activate(window: i64) -> Attempt {
    match raise(window) {
        Raised::Reached => Attempt::Called(Outcome::returned(Dispatch::Submitted, None)),
        Raised::Accepted => Attempt::Called(Outcome::returned(
            Dispatch::Unknown,
            Some("调用成功，前台窗口未变为目标窗口".to_owned()),
        )),
        Raised::Refused => Attempt::Refused(
            "foreground_lock: 前台锁拒绝了本次激活，前台窗口未改变".to_owned(),
        ),
    }
}

/// UIA 的 `WindowVisualState` 常量顺序：0 = Normal，1 = Maximized，2 = Minimized。
const fn visual_state(state: WindowState) -> i32 {
    match state {
        WindowState::Normal => 0,
        WindowState::Maximized => 1,
        WindowState::Minimized => 2,
    }
}

fn set_window_state(window: i64, element: &IUIAutomationElement, target: WindowState) -> Attempt {
    let pattern: IUIAutomationWindowPattern =
        match current_pattern(window, element, UIA_WindowPatternId, "WindowPattern") {
            Ok(p) => p,
            Err(reason) => return Attempt::Refused(reason),
        };
    let allowed = match target {
        // SAFETY: 实时属性查询。
        WindowState::Minimized => unsafe { pattern.CurrentCanMinimize() },
        WindowState::Maximized => unsafe { pattern.CurrentCanMaximize() },
        WindowState::Normal => Ok(::windows::core::BOOL(1)),
    };
    match allowed {
        Err(e) => return Attempt::Refused(format!("读取窗口能力失败 {e}")),
        Ok(flag) if !flag.as_bool() => {
            return Attempt::Refused(format!(
                "state_unsupported: {}",
                target.as_str()
            ))
        }
        Ok(_) => {}
    }
    if window_state(window) == Some(target) {
        return Attempt::Refused(format!(
            "already_in_state: {}",
            target.as_str()
        ));
    }
    let watch = StateWatch::new(
        window,
        ActionEvidence::WindowState,
        Box::new(move || window_state(window) == Some(target)),
    );
    let state = WindowVisualState(visual_state(target));
    let attempt = dispatch_call(&watch, defer(move || unsafe {
        pattern.SetWindowVisualState(state)
    }));
    confirm(attempt, WINDOW_SETTLE, || {
        window_state(window) == Some(target)
    })
}

/// 移动或缩放要写入的值。两者分开是因为对应的能力也分开：`CanMove` 与 `CanResize`。
enum Placement {
    Move { x: i32, y: i32 },
    Resize { width: i32, height: i32 },
}

fn transform(window: i64, element: &IUIAutomationElement, placement: Placement) -> Attempt {
    let pattern: IUIAutomationTransformPattern =
        match current_pattern(window, element, UIA_TransformPatternId, "TransformPattern") {
            Ok(p) => p,
            Err(reason) => return Attempt::Refused(reason),
        };
    let (allowed, name) = match placement {
        // SAFETY: 实时属性查询。
        Placement::Move { .. } => (unsafe { pattern.CurrentCanMove() }, "移动"),
        Placement::Resize { .. } => (unsafe { pattern.CurrentCanResize() }, "缩放"),
    };
    match allowed {
        Err(e) => return Attempt::Refused(format!("读取窗口能力失败 {e}")),
        Ok(flag) if !flag.as_bool() => {
            return Attempt::Refused(format!("transform_unsupported: {name}"))
        }
        Ok(_) => {}
    }
    let matches: Box<dyn Fn() -> bool> = match placement {
        Placement::Move { x, y } => Box::new(move || {
            window_rect(window).is_ok_and(|r| r.x == x && r.y == y)
        }),
        Placement::Resize { width, height } => Box::new(move || {
            window_rect(window).is_ok_and(|r| r.width == width && r.height == height)
        }),
    };
    let watch = StateWatch::new(window, ActionEvidence::WindowRect, matches);
    let call = match placement {
        Placement::Move { x, y } => defer(move || unsafe {
            pattern.Move(f64::from(x), f64::from(y))
        }),
        Placement::Resize { width, height } => defer(move || unsafe {
            pattern.Resize(f64::from(width), f64::from(height))
        }),
    };
    // 生效证据由读取的窗口矩形给出；此处不再判定读取的值是否正确，
    // 矩形的实际值随动作后的重读一起交给调用方：provider 会按自身的最小尺寸限制取值，
    // 限制后的值不算失败。
    dispatch_call(&watch, call)
}

/// 关闭窗口。发送的是关闭请求，不是强制终止进程。
///
/// 未保存提示会使本次调用阻塞在目标应用的嵌套消息循环中，此时使用与后台模式调用相同的
/// 可放弃等待路径：证据是目标窗口关闭、被禁用或同进程出现新的顶层窗口，回执携带该窗口
/// 清单，由调用方观察提示框。**不替用户选择**提示框上的按钮。
fn close_window(window: i64, element: &IUIAutomationElement) -> Attempt {
    let pattern: IUIAutomationWindowPattern =
        match current_pattern(window, element, UIA_WindowPatternId, "WindowPattern") {
            Ok(p) => p,
            Err(reason) => return Attempt::Refused(reason),
        };
    dispatch_call(&CallWatch::before(window), defer(move || unsafe {
        pattern.Close()
    }))
}

// ── Win32 查询 ──

fn alive(window: i64) -> bool {
    // SAFETY: 只读查询。
    unsafe { IsWindow(Some(HWND(window as *mut c_void))) }.as_bool()
}

fn window_rect(window: i64) -> Result<ScreenRect, String> {
    let mut rect = RECT::default();
    // SAFETY: 出参是本栈帧上的结构体。
    unsafe { GetWindowRect(HWND(window as *mut c_void), &mut rect) }
        .map_err(|e| format!("target_lost: 读取窗口矩形失败 {e}"))?;
    Ok(ScreenRect {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

/// 窗口当前的显示状态，仅经由 Win32 读取。窗口已不存在时为 `None`。
fn window_state(window: i64) -> Option<WindowState> {
    let hwnd = HWND(window as *mut c_void);
    // SAFETY: 三项都是只读查询。
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }
        if IsIconic(hwnd).as_bool() {
            return Some(WindowState::Minimized);
        }
        if IsZoomed(hwnd).as_bool() {
            return Some(WindowState::Maximized);
        }
    }
    Some(WindowState::Normal)
}

/// 虚拟桌面矩形。绝对指针坐标以它为范围，多显示器时原点可能为负。
pub fn virtual_desktop() -> ScreenRect {
    // SAFETY: 四项都是无参只读指标查询。
    unsafe {
        ScreenRect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
        }
    }
}
