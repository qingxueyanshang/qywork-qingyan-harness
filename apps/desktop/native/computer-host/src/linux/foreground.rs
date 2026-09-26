//! 前台接管：指针、键盘与窗口动作，经 XTest 与窗口管理器。
//!
//! 七条边界：
//!
//! 1. **这里的每一个动作都会把前台从用户手上拿走**，因此只在用户显式启用前台模式时才走得到
//!    这里；关着时准入判定在 `protocol::admit` 就拒了，一个请求都不发给 X 服务器。
//! 2. **落点在派发那一刻重新求。** 控件重新定位、读此刻的包围盒、核对落点处最上面的窗口
//!    收这次动作（目标窗口，或控件所在的、目标窗口拥有的弹出窗口），三步缺一不可。
//! 3. **按住的键随按随记，任何中止路径都释放。** 记账与释放由 `input::Hold` 做，本模块不手写
//!    释放调用。
//! 4. **指针与键盘输入在派发前先把目标窗口激活到前台**（`ensure_foreground`），再做各自的
//!    核对：指针核对落点归目标窗口，键盘核对前台窗口是目标窗口且键盘焦点在它里面。点名了
//!    控件时再核对它持有键盘焦点，焦点不在它上面就拒绝，不替用户改焦点。
//! 5. **中途前台或焦点变了立即停止**，已发出多少如实带回，执行事实落 `unknown`，不向另一个
//!    窗口续输。
//! 6. **窗口动作的生效证据按动作各自读回**：前台窗口、显示状态、窗口矩形、窗口是否还在。
//!    请求由窗口管理器异步处理，发出去不等于生效。
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

/// 一次拖拽分几段移动。一次跳到终点的话，被拖的控件收不到中间的移动事件。
const DRAG_STEPS: u32 = 12;
/// 拖拽两段之间隔多久。
const DRAG_STEP_MS: u64 = 16;
/// 激活之后等前台窗口与键盘焦点真的改过来多久。窗口管理器异步处理激活请求。
const ACTIVATE_SETTLE: Duration = Duration::from_millis(400);
/// 读回窗口状态或矩形的等待上限。
const WINDOW_SETTLE: Duration = Duration::from_millis(400);
/// 请求关闭之后等窗口消失或冒出新顶层窗口（未保存提示）多久。与后台调用找生效证据的
/// 总时长相同。
const CLOSE_SETTLE: Duration = Duration::from_millis(1_800);

/// 一次指针动作的落点。非指针动作三项都缺席。
#[derive(Debug, Clone, Copy, Default)]
pub struct Aim {
    /// 指针落点，屏幕物理像素。
    pub anchor: Option<ScreenPoint>,
    /// 拖拽终点。只有拖拽有。
    pub destination: Option<ScreenPoint>,
    /// 按控件定位时，控件自报的所在顶层窗口的客户区原点，见 `walk::toplevel_origin`；按图像
    /// 坐标定位、或读不到控件的窗口坐标时缺席。
    pub origin: Option<ScreenPoint>,
}

/// 点名控件的键盘输入要核对的那一项：控件此刻有没有键盘焦点。读的是实时状态。
pub type Focus<'a> = Option<&'a dyn Fn() -> Result<bool, String>>;

/// 执行一个前台动作。`window` 是目标的 X 窗口号。
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

/// 这次请求带的窗口几何代际还成不成立。按图定位的落点必须过这一关。
pub fn check_generation(display: &Display, window: Window, expected: &str) -> Result<(), String> {
    let client = display
        .client(window)
        .ok_or_else(|| "target_lost: 窗口已经不在".to_owned())?;
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
    // 双击的两下要在应用的双击间隔内：整批一次交给服务器，两下之间没有可测的间隔。
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
    // 滚轮事件去的是指针底下那个窗口，所以要先把指针移到目标上。
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
    // 终点同样要落在目标窗口里：拖到别的窗口上等于把这次放手交给了另一个应用。
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
    // 记账在按下之前：按下与记账之间 worker 被强杀的话，那个键就没有人知道它按住了。
    let mut hold = Hold::record(sink, vec![MouseButton::Left], Vec::new());
    if sink.send(&[Event::Button {
        button: MouseButton::Left,
        down: true,
    }]) == 0
    {
        hold.release();
        return Attempt::Called(Outcome::returned(
            Dispatch::NotDispatched,
            Some("input_blocked: 按下没有进入输入队列，指针已在起点".to_owned()),
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

/// 这次指针动作落在哪个屏幕坐标上，并核对那个位置确实属于这次动作，判据见 `lands_on_target`。
///
/// 目标窗口不在前台那一种由 `ensure_foreground` 在派发前处理完；走到这里仍被盖住的是
/// 置顶窗口、盖在控件上的弹出窗口或别的窗口，如实拒绝。
fn landing(display: &Display, window: Window, aim: Aim) -> Result<ScreenPoint, String> {
    let anchor = aim.anchor.ok_or("missing_target: 指针动作没有落点")?;
    let rect = window_rect(display, window)?;
    if !rect.contains(anchor) {
        return Err(format!("point_outside_window: {},{}", anchor.x, anchor.y));
    }
    let (hit_root, hit_owner) = display.hit(anchor)?;
    let origin_of = |w: i64| Window::try_from(w).ok().and_then(|w| display.origin(w));
    let target = i64::from(window);
    let root = control_root(
        aim.origin,
        (target, origin_of(target)),
        (hit_root, origin_of(hit_root)),
    );
    if !lands_on_target(target, hit_root, hit_owner, root) {
        return Err(format!("occluded: {},{}", anchor.x, anchor.y));
    }
    Ok(anchor)
}

/// 控件所在的顶层窗口，交给 `lands_on_target`。`target` 与 `hit` 是目标窗口、落点处的顶层窗口
/// 与各自的客户区原点。
///
/// X 服务器与 AT-SPI 都不给控件所在的 X 窗口，只能按控件自报的原点对：只认目标窗口与落点处
/// 的窗口两个候选，都对不上时缺席，与按图像坐标定位一样只认目标窗口本身。先认目标窗口：弹出
/// 窗口恰好与目标窗口客户区同一原点时，先认落点处的窗口会把盖在控件上的弹出窗口当成控件所在
/// 的窗口。
///
/// 这个原点取自工具包：GTK 3 对下拉菜单里的控件报弹出窗口的原点；Qt 对组合框下拉列表里的
/// 控件报主窗口的原点，那些控件按 ref 点击因此判 `occluded`。
fn control_root(
    origin: Option<ScreenPoint>,
    target: (i64, Option<ScreenPoint>),
    hit: (i64, Option<ScreenPoint>),
) -> Option<i64> {
    let origin = origin?;
    [target, hit]
        .into_iter()
        .find(|(_, at)| *at == Some(origin))
        .map(|(window, _)| window)
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

/// 键盘输入的前置条件：目标窗口是前台窗口，键盘焦点在它里面。
///
/// **不给控件即以窗口为目标**，判定到此为止：自绘界面不暴露业务控件，要求点名一个持有焦点的
/// 控件等于对它们关掉整条键盘路径。给了控件再加一条：它此刻持有键盘焦点。刚激活的窗口里
/// 工具包要处理完焦点事件才更新控件的焦点状态，所以这时在激活的等待上限内重读。
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
        return Err("not_focused: 这个控件没有键盘焦点 · 先 click 它".to_owned());
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

/// 投进文字。每一批之前重核前台与焦点，变了立即停下并如实带回已投出多少。
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
    // 中途停下来时原因由停下来的那一步说。按键全部送达之后才停下（应用没有应答）的那一次，
    // 最后几个字符可能按改回之后的映射换算，只能记 `unknown`。
    let (dispatch, reason) = match typed.interrupted {
        Some(note) => (
            if typed.sent == 0 {
                Dispatch::NotDispatched
            } else {
                Dispatch::Unknown
            },
            Some(format!(
                "{note} · 已投出 {} / {} 个字符",
                typed.sent, typed.requested
            )),
        ),
        None => (dispatch, reason),
    };
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 一次组合键。整条序列一次刷给服务器，中间没有别的输入插得进来。
fn press_key(sink: &XSink<'_>, key: &str, modifiers: &[Modifier]) -> Attempt {
    let Some(main) = key_name(key) else {
        return Attempt::Refused(format!("unknown_key: {key}"));
    };
    let held: Vec<String> = modifiers.iter().map(|m| m.key_name().to_owned()).collect();
    if let Some(missing) = held.iter().chain([&main]).find(|k| !sink.resolves(k)) {
        return Attempt::Refused(format!(
            "key_unmapped: 当前键盘映射里没有不带修饰就能按出 {missing} 的键"
        ));
    }
    let events = key_stroke(&main, &held);
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

/// 派发前把目标窗口激活到前台。已经在前台且键盘焦点在它里面时不发请求。返回有没有发出激活。
///
/// 提不上来不在这里裁决：随后那次核对照原样给原因码。
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

/// 激活目标窗口。到达前台记已执行，请求发出而前台没变记结果未知。
fn activate(display: &Display, window: Window) -> Attempt {
    if let Err(reason) = display.request_activate(window) {
        return Attempt::Refused(reason);
    }
    if settled(ACTIVATE_SETTLE, || display.active_window() == window) {
        return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
    }
    Attempt::Called(Outcome::returned(
        Dispatch::Unknown,
        Some("调用成功，前台窗口没有变成目标窗口".to_owned()),
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
/// 窗口管理器会按自己的规则夹住位置，夹出来的值不是失败：矩形的实际值随动作后的重读一起
/// 交给调用方。读回只用来等请求生效，等不到也不改执行事实。
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

/// 缩放到外框尺寸 `width × height`。EWMH 请求的是客户区尺寸，差值取此刻外框与客户区之差。
/// 夹住的值同 `move_window`。
fn resize_window(display: &Display, window: Window, width: i32, height: i32) -> Attempt {
    if !display.allows(window, WmAction::Resize) {
        return Attempt::Refused("transform_unsupported: 缩放".to_owned());
    }
    let Some(client) = display.client(window) else {
        return Attempt::Refused("target_lost: 窗口已经不在".to_owned());
    };
    let (Some(outer), Some(area)) = (client.outer(), client.client) else {
        return Attempt::Refused("target_lost: 读不出窗口几何".to_owned());
    };
    let inner = (
        width - (outer.width - area.width),
        height - (outer.height - area.height),
    );
    if inner.0 < 1 || inner.1 < 1 {
        return Attempt::Refused(format!(
            "invalid_size: {width}×{height} 放不下窗口边框（{}×{}）",
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

/// 关闭窗口。发的是关闭请求，不是强杀进程。
///
/// 生效证据与后台调用同一套：目标窗口已关闭，或同进程多出一个顶层窗口（未保存提示）。
/// **不替用户选**提示框上的按钮。
fn close_window(display: &Display, window: Window) -> Attempt {
    if !display.allows(window, WmAction::Close) {
        return Attempt::Refused("close_unsupported: 窗口管理器不允许关闭这个窗口".to_owned());
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
            Some("调用成功，目标窗口没有关闭，也没有出现新的顶层窗口".to_owned()),
        )),
    }
}

/// 窗口的外框矩形。
fn window_rect(display: &Display, window: Window) -> Result<ScreenRect, String> {
    display
        .client(window)
        .and_then(|c| c.outer())
        .ok_or_else(|| "target_lost: 读窗口矩形失败".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 目标窗口、它弹出的下拉菜单、它的模态对话框、别的应用的置顶窗口，与各自的客户区原点。
    const TARGET: i64 = 0x40_0004;
    const POPUP: i64 = 0x40_005f;
    const DIALOG: i64 = 0x40_0090;
    const OTHER: i64 = 0x60_0004;
    const AT_TARGET: ScreenPoint = ScreenPoint { x: 161, y: 160 };
    const AT_POPUP: ScreenPoint = ScreenPoint { x: 173, y: 173 };

    /// `control_root` 与 `lands_on_target` 合起来的裁决。`hit` 是落点处的窗口、它的所有者与原点。
    fn lands(origin: Option<ScreenPoint>, hit: (i64, i64, ScreenPoint)) -> bool {
        let root = control_root(origin, (TARGET, Some(AT_TARGET)), (hit.0, Some(hit.2)));
        lands_on_target(TARGET, hit.0, hit.1, root)
    }

    /// 原始失败形状：GTK 组合框的下拉菜单是目标窗口拥有的另一个顶层窗口，点里面的菜单项被判
    /// 遮挡。菜单项自报的原点就是弹出窗口的原点。
    #[test]
    fn a_control_in_the_popup_the_target_owns_lands() {
        assert_eq!(
            control_root(
                Some(AT_POPUP),
                (TARGET, Some(AT_TARGET)),
                (POPUP, Some(AT_POPUP))
            ),
            Some(POPUP)
        );
        assert!(lands(Some(AT_POPUP), (POPUP, TARGET, AT_POPUP)));
    }

    /// 目标窗口里的控件被它自己的下拉菜单或模态对话框盖住：点下去的是盖在上面的那个窗口。
    #[test]
    fn a_control_of_the_target_covered_by_its_own_window_is_refused() {
        assert!(!lands(Some(AT_TARGET), (POPUP, TARGET, AT_POPUP)));
        assert!(!lands(
            Some(AT_TARGET),
            (DIALOG, TARGET, ScreenPoint { x: 300, y: 250 })
        ));
        // 盖在上面的弹出窗口恰好与目标窗口客户区同一原点：先认目标窗口，照旧拒绝。
        assert!(!lands(Some(AT_TARGET), (POPUP, TARGET, AT_TARGET)));
    }

    /// 别的应用的置顶窗口盖在控件上，哪怕与控件自报的原点相同，也不归目标窗口所有。
    #[test]
    fn an_unrelated_window_on_top_is_refused() {
        assert!(!lands(Some(AT_TARGET), (OTHER, OTHER, AT_POPUP)));
        assert!(!lands(Some(AT_POPUP), (OTHER, OTHER, AT_POPUP)));
    }

    /// 按图像坐标定位，或控件自报的原点哪个候选都对不上：只认目标窗口本身。
    #[test]
    fn without_a_known_origin_only_the_target_itself_lands() {
        assert!(!lands(None, (POPUP, TARGET, AT_POPUP)));
        assert!(!lands(
            Some(ScreenPoint { x: 0, y: 0 }),
            (POPUP, TARGET, AT_POPUP)
        ));
        assert!(lands(None, (TARGET, TARGET, AT_TARGET)));
        assert!(lands(Some(AT_TARGET), (TARGET, TARGET, AT_TARGET)));
    }
}
