//! 前台接管：指针、键盘与窗口动作，经由 XTest 与窗口管理器执行。
//!
//! 七条边界：
//!
//! 1. **本模块的每个动作都会占用用户的前台**，因此只在用户显式启用前台模式时执行；前台模式
//!    关闭时，准入判定在 `protocol::admit` 中拒绝请求，不向 X 服务器发送任何请求。
//! 2. **落点在派发时重新计算。** 重新定位控件、读取当前包围盒、核对落点处最上层的窗口是本次
//!    动作的接收方（目标窗口，或目标窗口拥有的、控件所在的弹出窗口），三步缺一不可。
//! 3. **按下的键在按下时登记，任何中止路径都释放。** 登记与释放由 `input::Hold` 负责，本模块
//!    不直接编写释放调用。
//! 4. **指针与键盘输入在派发前先将目标窗口激活到前台**（`ensure_foreground`），再分别核对：
//!    指针核对落点属于目标窗口，键盘核对前台窗口是目标窗口且键盘焦点在该窗口内。指定了
//!    控件时还核对该控件持有键盘焦点，焦点不在该控件上即拒绝，不替用户更改焦点。
//! 5. **中途前台或焦点改变时立即停止**，如实返回已发出的数量，执行事实记为 `unknown`，
//!    不向另一个窗口继续输入。
//! 6. **窗口动作的生效证据按动作分别读取**：前台窗口、显示状态、窗口矩形、窗口是否存在。
//!    请求由窗口管理器异步处理，请求已发出不等于已生效。
//! 7. **文字只有一条投递路径**：临时借用空闲键码，见 `x11::sink`。

use std::cell::Cell;
use std::time::Duration;

use x11rb::protocol::xproto::Window;

use super::x11::sink::XSink;
use super::x11::{Display, WmAction};
use super::CallWatch;
use crate::backend::{confirm, lands_on_target, settled, Attempt, Outcome, Watch};
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::input::{drag_path, key_stroke, wheel_of, Event, Hold, Sink};
use crate::protocol::{
    classify_action, classify_input, key_name, ActionSpec, Dispatch, Modifier, MouseButton,
    WindowState,
};

/// 一次拖拽分段移动的段数。一次移动到终点时，被拖拽的控件收不到中间的移动事件。
const DRAG_STEPS: u32 = 12;
/// 拖拽相邻两段之间的间隔。
const DRAG_STEP_MS: u64 = 16;
/// 激活之后等待前台窗口与键盘焦点完成切换的时长。窗口管理器异步处理激活请求。
const ACTIVATE_SETTLE: Duration = Duration::from_millis(400);
/// 读取窗口状态或矩形的等待上限。
const WINDOW_SETTLE: Duration = Duration::from_millis(400);
/// 请求关闭之后等待窗口消失或出现新顶层窗口（未保存提示）的时长。与后台调用查找生效证据的
/// 总时长相同。
const CLOSE_SETTLE: Duration = Duration::from_millis(1_800);

/// 一次指针动作的落点。非指针动作三项均缺失。
#[derive(Debug, Clone, Copy, Default)]
pub struct Aim {
    /// 指针落点，屏幕物理像素。
    pub anchor: Option<ScreenPoint>,
    /// 拖拽终点。仅拖拽动作具有此项。
    pub destination: Option<ScreenPoint>,
    /// 按控件定位时，控件所在的顶层窗口：目标窗口，或目标窗口拥有的、绘制该控件的弹出窗口；
    /// 按图像坐标定位时缺失。
    pub host: Option<i64>,
}

/// 指定控件的键盘输入需要核对的条件：控件当前是否持有键盘焦点。读取的是实时状态。
pub type Focus<'a> = Option<&'a dyn Fn() -> Result<bool, String>>;

/// 执行一个前台动作。`window` 是目标窗口的 X 窗口号。
pub fn perform(
    display: &Display,
    window: Window,
    focus: Focus<'_>,
    action: &ActionSpec,
    aim: Aim,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    let sink = match XSink::new(display) {
        Ok(sink) => sink,
        Err(reason) => return Attempt::Refused(reason),
    };
    let activated = action.takes_input() && ensure_foreground(display, window);
    match action {
        ActionSpec::Click { button, count } => click(display, window, &sink, aim, *button, *count),
        ActionSpec::Hover => hover(display, window, &sink, aim),
        ActionSpec::Drag { .. } => drag(display, window, &sink, aim, stop),
        ActionSpec::Wheel { direction, amount } => {
            wheel(display, window, &sink, aim, wheel_of(*direction, *amount))
        }
        ActionSpec::TypeText { text } => match keyboard_target(display, window, focus, activated) {
            Err(reason) => Attempt::Refused(reason),
            Ok(()) => type_text(display, window, &sink, text),
        },
        ActionSpec::PressKey { key, modifiers } => {
            match keyboard_target(display, window, focus, activated) {
                Err(reason) => Attempt::Refused(reason),
                Ok(()) => press_key(&sink, key, modifiers),
            }
        }
        ActionSpec::Activate => activate(display, window),
        ActionSpec::SetWindowState { state } => set_window_state(display, window, *state),
        ActionSpec::MoveWindow { x, y } => move_window(display, window, *x, *y),
        ActionSpec::ResizeWindow { width, height } => {
            resize_window(display, window, *width, *height)
        }
        ActionSpec::CloseWindow => close_window(display, window),
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

/// 核对本次请求携带的窗口几何代际是否仍然有效。按图定位的落点必须通过此项核对。
pub fn check_generation(display: &Display, window: Window, expected: &str) -> Result<(), String> {
    let client = display
        .client(window)
        .ok_or_else(|| "target_lost: 窗口已不存在".to_owned())?;
    let actual = display.frame(&client)?.generation();
    if actual == expected {
        return Ok(());
    }
    Err(format!("geometry_changed: {expected} → {actual}"))
}

// ── 指针 ──

fn click(
    display: &Display,
    window: Window,
    sink: &dyn Sink,
    aim: Aim,
    button: MouseButton,
    count: u32,
) -> Attempt {
    if count == 0 || count > 2 {
        return Attempt::Refused(format!("invalid_count: {count}，只接受 1 或 2"));
    }
    let anchor = match landing(display, window, aim) {
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
    // 双击的两次点击必须在应用的双击间隔内：整批事件一次提交给服务器，两次点击之间没有可测量的间隔。
    settle(sink.send(&events), &events)
}

fn hover(display: &Display, window: Window, sink: &dyn Sink, aim: Aim) -> Attempt {
    let anchor = match landing(display, window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let events = [Event::Move { to: anchor }];
    settle(sink.send(&events), &events)
}

fn wheel(
    display: &Display,
    window: Window,
    sink: &dyn Sink,
    aim: Aim,
    wheel: (i32, bool),
) -> Attempt {
    let anchor = match landing(display, window, aim) {
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
fn drag(
    display: &Display,
    window: Window,
    sink: &dyn Sink,
    aim: Aim,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    let anchor = match landing(display, window, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let Some(destination) = aim.destination else {
        return Attempt::Refused("missing_target: 拖拽没有终点".to_owned());
    };
    // 终点同样必须位于目标窗口内：拖到其他窗口上等于把本次释放交给另一个应用。
    match window_rect(display, window) {
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
        return Attempt::Called(Outcome::returned(
            Dispatch::NotDispatched,
            Some("input_blocked: 按下事件未进入输入队列，指针已位于起点".to_owned()),
        ));
    }
    let path = drag_path(anchor, destination, DRAG_STEPS);
    let mut moved = 0u32;
    for point in &path {
        if stop() {
            hold.release();
            return Attempt::Called(Outcome::returned(
                Dispatch::Unknown,
                Some(format!("cancelled: 拖拽第 {moved} 段 · 左键已释放")),
            ));
        }
        if !display.managed(window) {
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
/// 目标窗口不在前台的情形由 `ensure_foreground` 在派发前处理；执行到此处仍被遮挡时，遮挡方是
/// 置顶窗口、覆盖控件的弹出窗口或其他窗口，如实拒绝。
fn landing(display: &Display, window: Window, aim: Aim) -> Result<ScreenPoint, String> {
    let anchor = aim.anchor.ok_or("missing_target: 指针动作没有落点")?;
    let rect = window_rect(display, window)?;
    if !rect.contains(anchor) {
        return Err(format!("point_outside_window: {},{}", anchor.x, anchor.y));
    }
    let (hit_root, hit_owner) = display.hit(anchor)?;
    if !lands_on_target(i64::from(window), hit_root, hit_owner, aim.host) {
        return Err(format!("occluded: {},{}", anchor.x, anchor.y));
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

/// 键盘输入的前置条件：目标窗口是前台窗口，且键盘焦点在该窗口内。
///
/// **未指定控件时以窗口为目标**，判定到此结束：自绘界面不暴露业务控件，要求指定一个持有焦点的
/// 控件等于对这类界面关闭整条键盘路径。指定了控件时增加一项条件：该控件当前持有键盘焦点。
/// 刚激活的窗口中，工具包处理完焦点事件后才更新控件的焦点状态，因此此时在激活的等待上限内重读。
fn keyboard_target(
    display: &Display,
    window: Window,
    focus: Focus<'_>,
    activated: bool,
) -> Result<(), String> {
    foreground_ok(display, window)?;
    display.focus_within(window)?;
    let Some(focused) = focus else {
        return Ok(());
    };
    let limit = if activated {
        ACTIVATE_SETTLE
    } else {
        Duration::ZERO
    };
    let failure: Cell<Option<String>> = Cell::new(None);
    let holds = settled(limit, || match focused() {
        Ok(held) => held,
        Err(reason) => {
            failure.set(Some(reason));
            true
        }
    });
    if let Some(reason) = failure.take() {
        return Err(reason);
    }
    if !holds {
        return Err("not_focused: 该控件没有键盘焦点 · 请先对该控件执行 click".to_owned());
    }
    Ok(())
}

fn foreground_ok(display: &Display, window: Window) -> Result<(), String> {
    let at = display.active_window();
    if at == window {
        return Ok(());
    }
    Err(format!("not_foreground: {at}"))
}

/// 输入文字。每一批之前重新核对前台与焦点，发生变化时立即停止，并如实返回已发送的数量。
fn type_text(display: &Display, window: Window, sink: &XSink<'_>, text: &str) -> Attempt {
    if text.is_empty() {
        return Attempt::Refused("empty_text: 文字为空".to_owned());
    }
    let target = || {
        foreground_ok(display, window)?;
        display.focus_within(window)
    };
    let typed = match sink.type_text(window, text, &target) {
        Ok(typed) => typed,
        Err(reason) => return Attempt::Refused(reason),
    };
    let (dispatch, reason) = classify_input(typed.sent, typed.requested);
    // 中途停止时，原因由触发停止的步骤给出。按键全部送达之后才停止（应用无应答）时，
    // 最后几个字符可能按恢复后的映射换算，只能记为 `unknown`。
    let (dispatch, reason) = match typed.interrupted {
        Some(note) => (
            if typed.sent == 0 {
                Dispatch::NotDispatched
            } else {
                Dispatch::Unknown
            },
            Some(format!(
                "{note} · 已发送 {} / {} 个字符",
                typed.sent, typed.requested
            )),
        ),
        None => (dispatch, reason),
    };
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 一次组合键。整条序列一次提交给服务器，其他输入无法插入其中。
fn press_key(sink: &XSink<'_>, key: &str, modifiers: &[Modifier]) -> Attempt {
    let Some(main) = key_name(key) else {
        return Attempt::Refused(format!("unknown_key: {key}"));
    };
    let held: Vec<String> = modifiers.iter().map(|m| m.key_name().to_owned()).collect();
    if let Some(missing) = held.iter().chain([&main]).find(|k| !sink.resolves(k)) {
        return Attempt::Refused(format!(
            "key_unmapped: 当前键盘映射中没有无需修饰键即可输入 {missing} 的键"
        ));
    }
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

// ── 窗口 ──

/// 派发前将目标窗口激活到前台。已在前台且键盘焦点在该窗口内时不发送请求。返回是否发出了激活请求。
///
/// 激活失败不在此处裁决：随后的核对会给出原因码。
fn ensure_foreground(display: &Display, window: Window) -> bool {
    let ready = || display.active_window() == window && display.focus_within(window).is_ok();
    if ready() {
        return false;
    }
    if display.request_activate(window).is_err() {
        return false;
    }
    let _ = settled(ACTIVATE_SETTLE, ready);
    true
}

/// 激活目标窗口。到达前台记为已执行，请求已发出而前台未变化记为结果未知。
fn activate(display: &Display, window: Window) -> Attempt {
    if let Err(reason) = display.request_activate(window) {
        return Attempt::Refused(reason);
    }
    if settled(ACTIVATE_SETTLE, || display.active_window() == window) {
        return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
    }
    Attempt::Called(Outcome::returned(
        Dispatch::Unknown,
        Some("调用成功，前台窗口未变为目标窗口".to_owned()),
    ))
}

fn set_window_state(display: &Display, window: Window, target: WindowState) -> Attempt {
    let allowed = match target {
        WindowState::Minimized => display.allows(window, WmAction::Minimize),
        WindowState::Maximized => display.allows(window, WmAction::Maximize),
        WindowState::Normal => true,
    };
    if !allowed {
        return Attempt::Refused(format!("state_unsupported: {}", target.as_str()));
    }
    if display.window_state(window) == Some(target) {
        return Attempt::Refused(format!("already_in_state: {}", target.as_str()));
    }
    let attempt = match display.request_state(window, target) {
        Ok(()) => Attempt::Called(Outcome::returned(Dispatch::Submitted, None)),
        Err(reason) => Attempt::Refused(reason),
    };
    confirm(attempt, WINDOW_SETTLE, || {
        display.window_state(window) == Some(target)
    })
}

/// 移动外框左上角。
///
/// 窗口管理器会按自身规则限制位置，被限制后的值不视为失败：矩形的实际值随动作后的重读
/// 一并返回调用方。读取只用于等待请求生效，等待超时也不改变执行事实。
fn move_window(display: &Display, window: Window, x: i32, y: i32) -> Attempt {
    if !display.allows(window, WmAction::Move) {
        return Attempt::Refused("transform_unsupported: 移动".to_owned());
    }
    if let Err(reason) = display.request_move(window, x, y) {
        return Attempt::Refused(reason);
    }
    let _ = settled(WINDOW_SETTLE, || {
        window_rect(display, window).is_ok_and(|r| r.x == x && r.y == y)
    });
    Attempt::Called(Outcome::returned(Dispatch::Submitted, None))
}

/// 缩放到外框尺寸 `width × height`。EWMH 请求的是客户区尺寸，差值取当前外框与客户区之差。
/// 被限制后的值的处理同 `move_window`。
fn resize_window(display: &Display, window: Window, width: i32, height: i32) -> Attempt {
    if !display.allows(window, WmAction::Resize) {
        return Attempt::Refused("transform_unsupported: 缩放".to_owned());
    }
    let Some(client) = display.client(window) else {
        return Attempt::Refused("target_lost: 窗口已不存在".to_owned());
    };
    let (Some(outer), Some(area)) = (client.outer(), client.client) else {
        return Attempt::Refused("target_lost: 无法读取窗口几何".to_owned());
    };
    let inner = (
        width - (outer.width - area.width),
        height - (outer.height - area.height),
    );
    if inner.0 < 1 || inner.1 < 1 {
        return Attempt::Refused(format!(
            "invalid_size: {width}×{height} 无法容纳窗口边框（{}×{}）",
            outer.width - area.width,
            outer.height - area.height
        ));
    }
    if let Err(reason) = display.request_client_size(window, inner.0, inner.1) {
        return Attempt::Refused(reason);
    }
    let _ = settled(WINDOW_SETTLE, || {
        window_rect(display, window).is_ok_and(|r| r.width == width && r.height == height)
    });
    Attempt::Called(Outcome::returned(Dispatch::Submitted, None))
}

/// 关闭窗口。发送的是关闭请求，不是强制终止进程。
///
/// 生效证据与后台调用相同：目标窗口已关闭，或同一进程新增一个顶层窗口（未保存提示）。
/// **不替用户选择**提示框上的按钮。
fn close_window(display: &Display, window: Window) -> Attempt {
    if !display.allows(window, WmAction::Close) {
        return Attempt::Refused("close_unsupported: 窗口管理器不允许关闭该窗口".to_owned());
    }
    let pid = display.client(window).map_or(0, |c| c.pid);
    let watch = CallWatch::before(Some(display), Some(window), pid);
    if let Err(reason) = display.request_close(window) {
        return Attempt::Refused(reason);
    }
    let evidence = Cell::new(None);
    let _ = settled(CLOSE_SETTLE, || {
        evidence.set(watch.evidence());
        evidence.get().is_some()
    });
    match classify_action(None, evidence.get(), false) {
        Some((dispatch, reason)) => Attempt::Called(Outcome::returned(dispatch, reason)),
        None => Attempt::Called(Outcome::returned(
            Dispatch::Unknown,
            Some("调用成功，目标窗口未关闭，也未出现新的顶层窗口".to_owned()),
        )),
    }
}

/// 窗口的外框矩形。
fn window_rect(display: &Display, window: Window) -> Result<ScreenRect, String> {
    display
        .client(window)
        .and_then(|c| c.outer())
        .ok_or_else(|| "target_lost: 读取窗口矩形失败".to_owned())
}
