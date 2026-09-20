//! 前台接管：指针、键盘与窗口操作。
//!
//! 七条边界：
//!
//! 1. **这里的每一个动作都会把前台从用户手上拿走**，因此只在用户显式启用前台模式时
//!    才走得到这里；关着时准入判定在 `protocol::admit` 就拒了，一条系统调用都不发。
//! 2. **落点在派发那一刻重新求。** 控件重新定位、读此刻的包围盒、核对落点确实属于
//!    目标窗口，三步缺一不可：观察时记下的包围盒在控件移动之后指向别处。
//! 3. **按住的键随按随记，任何中止路径都释放。** 记账与释放由 `input::Hold` 做，
//!    本模块不手写释放调用。
//! 4. **键盘输入前核对前台窗口就是目标窗口且窗口未被禁用**；点名了控件时再核对它
//!    持有键盘焦点，焦点不在它上面就拒绝，不替用户把焦点抢过来。不点名控件即以窗口
//!    为目标。
//! 5. **中途前台变了立即停止**，已发出多少如实带回，执行事实落 `unknown`，不向另一个
//!    窗口续输。
//! 6. **窗口动作的生效证据按动作各自读回**（前台窗口、显示状态、窗口矩形），
//!    不套后台那三条——激活本来就会改前台，「同进程多出一个顶层窗口」证明不了它。
//! 7. **文字只有一条投递路径**：按 UTF-16 码元投字符消息给焦点窗口。它不按键、不改
//!    剪贴板，对字符集也没有限制。

use std::ffi::c_void;
use std::time::{Duration, Instant};

use ::windows::Win32::Foundation::{HWND, POINT, RECT};
use ::windows::Win32::UI::Accessibility::{
    IUIAutomationElement, IUIAutomationTransformPattern, IUIAutomationWindowPattern,
    UIA_TransformPatternId, UIA_WindowPatternId, WindowVisualState,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetSystemMetrics, GetWindowRect, IsIconic,
    IsWindow, IsZoomed, SetForegroundWindow, WindowFromPoint, GA_ROOT, GUITHREADINFO,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::geometry::{to_absolute, ScreenPoint, ScreenRect};
use crate::input::{
    drag_path, key_code, key_stroke, modifier_code, post_text, wheel_of, CharSink, Event, Hold,
    Sink, SystemCharSink, SystemSink,
};
use crate::protocol::{
    classify_input, ActionEvidence, ActionSpec, Dispatch, Modifier, MouseButton, WindowState,
};
use crate::windows::{
    current_pattern, defer, dispatch_call, Attempt, CallWatch, Outcome, StateWatch,
};

/// 一次拖拽分几段移动。
///
/// 一次跳到终点的话，被拖的控件收不到中间的移动消息，很多实现据此判断拖动有没有开始。
const DRAG_STEPS: u32 = 12;
/// 拖拽两段之间隔多久。总时长因此约 `DRAG_STEPS * DRAG_STEP_MS`。
const DRAG_STEP_MS: u64 = 16;
/// 一次文字投递按多少个 UTF-16 码元分批。批与批之间重核前台窗口与收件窗口。
const TEXT_BATCH_UNITS: usize = 24;
/// 激活之后等前台窗口真的改过来多久。前台切换要目标窗口线程处理激活消息，不是同步的。
const ACTIVATE_SETTLE: Duration = Duration::from_millis(400);
/// 读回窗口状态或矩形的等待上限。模式调用返回之后窗口还要重绘一次。
const WINDOW_SETTLE: Duration = Duration::from_millis(400);
/// 读回时两次查询之间隔多久。查的全是 Win32 窗口属性，一次几微秒。
const SETTLE_POLL_MS: u64 = 20;

/// 一次指针动作的落点。非指针动作两项都缺席。
#[derive(Debug, Clone, Copy, Default)]
pub struct Aim {
    /// 指针落点，屏幕物理像素。
    pub anchor: Option<ScreenPoint>,
    /// 拖拽终点。只有拖拽有。
    pub destination: Option<ScreenPoint>,
}

/// 执行一个前台动作。
///
/// `element` 只有按控件定位时才有。按屏幕坐标定位的指针动作没有控件；键盘输入可以
/// 不给控件，那时目标是窗口本身；窗口动作一定有——准入判定已经保证了这一点。
pub fn perform(
    window: i64,
    element: Option<&IUIAutomationElement>,
    action: &ActionSpec,
    aim: Aim,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    let sink = SystemSink;
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
        // 后台动作不走这里。逐条列而不是写 `_`：新增一个前台动作忘了接进来时要在这里
        // 编译失败，不是落到一句拒绝上。
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
            Attempt::Refused("not_foreground: 这个动作不走前台路径".to_owned())
        }
    }
}

const MISSING_ELEMENT: &str = "missing_target: 这个动作只能按控件执行";

/// 这次请求带的窗口几何代际还成不成立。
///
/// 按图定位的落点必须过这一关：窗口在采图与派发之间移动过的话，那个坐标指的已经不是
/// 同一块界面。
pub fn check_generation(window: i64, expected: &str) -> Result<(), String> {
    let hwnd = HWND(window as *mut c_void);
    let frame = crate::capture::window_frame(hwnd)?;
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
    let mut events = vec![move_event(anchor)];
    for _ in 0..count {
        events.push(Event::Button { button, down: true });
        events.push(Event::Button {
            button,
            down: false,
        });
    }
    // 双击的两下要在系统双击间隔内：整批一次交给系统，两下之间没有可测的间隔。
    settle(sink.send(&events), &events)
}

fn hover(window: i64, sink: &dyn Sink, aim: Aim) -> Attempt {
    let anchor = match landing(window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let events = [move_event(anchor)];
    settle(sink.send(&events), &events)
}

fn wheel(window: i64, sink: &dyn Sink, aim: Aim, wheel: (i32, bool)) -> Attempt {
    let anchor = match landing(window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    // 滚轮事件去的是指针底下那个窗口，所以要先把指针移到目标上。
    let events = [
        move_event(anchor),
        Event::Wheel {
            delta: wheel.0,
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
    // 终点同样要落在目标窗口里：拖到别的窗口上等于把这次放手交给了另一个应用。
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
    if sink.send(&[move_event(anchor)]) == 0 {
        return blocked(1);
    }
    // 记账在按下之前：按下与记账之间 worker 被强杀的话，那个键就没有人知道它按住了。
    let mut hold = Hold::record(sink, vec![MouseButton::Left], Vec::new());
    if sink.send(&[Event::Button {
        button: MouseButton::Left,
        down: true,
    }]) == 0
    {
        hold.release();
        // 指针已经移到起点了，说「一个事件都没进」不对；没进去的是按下，
        // 而没有按下就没有这次拖拽。
        return Attempt::Called(Outcome::returned(
            Dispatch::NotDispatched,
            Some(
                "input_blocked: 按下没有进入输入队列，指针已在起点".to_owned(),
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
        moved += sink.send(&[move_event(*point)]);
        std::thread::sleep(Duration::from_millis(DRAG_STEP_MS));
    }
    let released = hold.release();
    let requested = u32::try_from(path.len()).unwrap_or(u32::MAX) + 1;
    let (dispatch, reason) = classify_input(moved + released, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 这次指针动作落在哪个屏幕坐标上，并核对那个位置确实属于目标窗口。
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
    // 窗口矩形里不等于目标窗口可见：别的窗口盖在上面时，这一下点的是那一个。
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
    if root.0 as i64 != window {
        return Err(format!(
            "occluded: {},{}",
            anchor.x, anchor.y
        ));
    }
    Ok(anchor)
}

fn move_event(point: ScreenPoint) -> Event {
    let (dx, dy) = to_absolute(point, virtual_desktop());
    Event::Move { dx, dy }
}

/// 一批事件发完之后的执行事实。
fn settle(sent: u32, events: &[Event]) -> Attempt {
    let requested = u32::try_from(events.len()).unwrap_or(u32::MAX);
    let (dispatch, reason) = classify_input(sent, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 一个事件都没进输入队列时的终态。
fn blocked(requested: u32) -> Attempt {
    let (dispatch, reason) = classify_input(0, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

// ── 键盘 ──

/// 键盘输入的前置条件。
///
/// 两条对所有键盘输入成立：目标窗口是系统前台窗口，且它没有被禁用。
/// **不给控件即以窗口为目标**，判定到此为止——键盘输入去的是系统焦点所在，
/// 前台窗口是目标窗口时焦点必然落在这个窗口里；自绘界面不暴露业务控件，
/// 要求点名一个持有焦点的控件等于对它们关掉整条键盘路径。
///
/// 给了控件再加一条：它此刻要持有键盘焦点。焦点读的是实时属性不是观察时的缓存，
/// 焦点在观察与动作之间被用户改过时，按缓存判会把输入发给另一个控件。
/// **焦点不在目标上就拒绝**，不替用户抢焦点。
fn keyboard_target(window: i64, element: Option<&IUIAutomationElement>) -> Result<(), String> {
    foreground_ok(window)?;
    // SAFETY: 句柄由调用方核对过归属。
    if !unsafe { IsWindowEnabled(HWND(window as *mut c_void)) }.as_bool() {
        return Err("window_disabled: 目标窗口已禁用".to_owned());
    }
    let Some(element) = element else {
        return Ok(());
    };
    // SAFETY: 实时属性查询，跨进程调用由 UIA 的连接超时兜底。
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map_err(|e| format!("读键盘焦点失败 {e}"))?
        .as_bool();
    if !focused {
        return Err(
            "not_focused: 这个控件没有键盘焦点 · 先 click 它".to_owned(),
        );
    }
    Ok(())
}

/// 系统前台窗口的句柄。窗口根节点的键盘动作表按它列。
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

/// 投进文字。一条路径，对任何字符都一样。
///
/// 每一批之前重求收件窗口（`text_target`），前台或焦点变了立即停下并如实带回已投出
/// 多少；不向别的窗口续投。
fn type_text(window: i64, chars: &dyn CharSink, text: &str) -> Attempt {
    if text.is_empty() {
        return Attempt::Refused("empty_text: 文字为空".to_owned());
    }
    let out = post_text(chars, text, TEXT_BATCH_UNITS, &|| text_target(window));
    let (dispatch, reason) = classify_input(out.sent, out.requested);
    // 中途停下来时原因由 `text_target` 说，不留 `classify_input` 那句关于 UIPI 的推测：
    // 这一次停下来的成因是可核实的，不是猜的。
    let reason = match out.interrupted {
        Some(note) => Some(format!("{note} · 已投出 {} / {} 个字符", out.sent, out.requested)),
        None => reason,
    };
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 这一批文字投给哪个窗口。
///
/// 前台窗口必须仍是目标窗口，收件窗口取系统前台线程的焦点窗口；没有焦点控件时
/// 目标窗口自己收（自绘界面就是这一支）。**焦点窗口必须属于目标窗口**：焦点在两批
/// 之间被用户移到别的应用上时，剩下的字符宁可不投也不投给那一个。
fn text_target(window: i64) -> Result<i64, String> {
    foreground_ok(window)?;
    let focus = gui_focus();
    if focus == 0 {
        return Ok(window);
    }
    // SAFETY: 句柄来自上一行的查询。
    let root = unsafe { GetAncestor(HWND(focus as *mut c_void), GA_ROOT) };
    if root.0 as i64 != window {
        return Err(format!("not_focused: 焦点在窗口 {} 上", root.0 as i64));
    }
    Ok(focus)
}

/// 系统前台线程此刻的焦点窗口。没有焦点控件时返回 0。
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

/// 一次组合键。整条序列一次交给系统，中间没有别的输入插得进来。
fn press_key(sink: &dyn Sink, key: &str, modifiers: &[Modifier]) -> Attempt {
    let Some(main) = key_code(key) else {
        return Attempt::Refused(format!("unknown_key: {key}"));
    };
    let held: Vec<(u16, bool)> = modifiers.iter().map(|m| modifier_code(*m)).collect();
    let events = key_stroke(main, &held);
    let requested = u32::try_from(events.len()).unwrap_or(u32::MAX);
    // 记账在派发之前：整条序列自带抬起，但只发出去一半时修饰键会停在按下状态。
    let mut hold = Hold::record(sink, Vec::new(), {
        let mut keys = held.clone();
        keys.push(main);
        keys
    });
    let sent = sink.send(&events);
    if sent >= requested {
        // 序列自己已经把每个键都抬起来了，这里只清账不再发一遍抬起。
        hold.clear();
    } else {
        hold.release();
    }
    let (dispatch, reason) = classify_input(sent, requested);
    Attempt::Called(Outcome::returned(dispatch, reason))
}

// ── 窗口 ──

/// 激活目标窗口。
///
/// 受系统前台锁限制：前台权不在本进程手上时 `SetForegroundWindow` 不改前台，只让目标的
/// 任务栏按钮闪烁。**那时如实报未派发**，不用 `AttachThreadInput`、模拟 Alt 键之类的
/// 旁门绕过它——绕过去的是用户的防打扰设定。
fn activate(window: i64) -> Attempt {
    let hwnd = HWND(window as *mut c_void);
    // SAFETY: 句柄由调用方核对过归属。
    let accepted = unsafe { SetForegroundWindow(hwnd) }.as_bool();
    let reached = settled(ACTIVATE_SETTLE, || foreground_window() == window);
    if reached {
        return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
    }
    if accepted {
        return Attempt::Called(Outcome::returned(
            Dispatch::Unknown,
            Some("调用成功，前台窗口没有变成目标窗口".to_owned()),
        ));
    }
    Attempt::Refused(
        "foreground_lock: 前台锁拒绝了这次激活，前台窗口没有变".to_owned(),
    )
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
        Err(e) => return Attempt::Refused(format!("读窗口能力失败 {e}")),
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
    let state = WindowVisualState(target.as_uia());
    let attempt = dispatch_call(&watch, defer(move || unsafe {
        pattern.SetWindowVisualState(state)
    }));
    confirm(attempt, WINDOW_SETTLE, || {
        window_state(window) == Some(target)
    })
}

/// 移动或缩放要写进去的那一项。两者分开是因为能力也分开：`CanMove` 与 `CanResize`。
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
        Err(e) => return Attempt::Refused(format!("读窗口能力失败 {e}")),
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
    // 生效证据由窗口矩形读回给出；这里不再判一次「读回的值对不对」，
    // 矩形的实际值随动作后的重读一起交给调用方——provider 会按自己的最小尺寸夹，
    // 夹出来的值不是失败。
    dispatch_call(&watch, call)
}

/// 关闭窗口。发的是关闭请求，不是强杀进程。
///
/// 未保存提示会让这次调用挂在目标应用的嵌套消息循环里，那时走的是与后台模式调用同一条
/// 可放弃等待路径：证据是目标窗口关闭/被禁用/同进程多出一个顶层窗口，回执带回那份窗口
/// 清单，由调用方观察提示框。**不替用户选**提示框上的按钮。
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

/// 调用返回成功之后再核一次读回值。
///
/// 模式调用返回成功只说明 provider 受理了，窗口状态要等它自己处理完才变。读不回目标值时
/// 落 `unknown`：状态可能仍在变化中，记成失败会让调用方重发一次。
fn confirm(attempt: Attempt, limit: Duration, reached: impl Fn() -> bool) -> Attempt {
    let Attempt::Called(outcome) = attempt else {
        return attempt;
    };
    if outcome.dispatch != Dispatch::Submitted || !outcome.returned {
        return Attempt::Called(outcome);
    }
    if settled(limit, reached) {
        return Attempt::Called(outcome);
    }
    Attempt::Called(Outcome::returned(
        Dispatch::Unknown,
        Some("调用成功，窗口没有变成请求的状态".to_owned()),
    ))
}

// ── Win32 读数 ──

fn alive(window: i64) -> bool {
    // SAFETY: 只读查询。
    unsafe { IsWindow(Some(HWND(window as *mut c_void))) }.as_bool()
}

fn window_rect(window: i64) -> Result<ScreenRect, String> {
    let mut rect = RECT::default();
    // SAFETY: 出参是本栈帧上的结构体。
    unsafe { GetWindowRect(HWND(window as *mut c_void), &mut rect) }
        .map_err(|e| format!("target_lost: 读窗口矩形失败 {e}"))?;
    Ok(ScreenRect {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

/// 窗口此刻的显示状态，纯 Win32 读出。窗口已经没了时缺席。
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

/// 虚拟桌面矩形。绝对指针坐标铺在它上面，多显示器时原点可能是负的。
fn virtual_desktop() -> ScreenRect {
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

/// 在期限内等一个 Win32 读数成立。
fn settled(limit: Duration, reached: impl Fn() -> bool) -> bool {
    let until = Instant::now() + limit;
    loop {
        if reached() {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(SETTLE_POLL_MS));
    }
}
