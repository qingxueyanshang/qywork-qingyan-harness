//! 前台接管：指针、键盘与窗口动作，经 CGEvent 与 AX。
//!
//! 七条边界：
//!
//! 1. **这里的每一个动作都会把前台从用户手上拿走**，因此只在用户显式启用前台模式时才走得到
//!    这里；关着时准入判定在 `protocol::admit` 就拒了，一个事件都不发。
//! 2. **落点在派发那一刻重新求。** 控件重新定位、读此刻的矩形、核对落点处接住指针的窗口确实是
//!    目标窗口，三步缺一不可。
//! 3. **按住的键随按随记，任何中止路径都释放。** 记账与释放由 `input::Hold` 做，本模块不手写
//!    释放调用。
//! 4. **指针与键盘输入在派发前先把目标窗口提到前台**（`ensure_foreground`：窗口的 `AXRaise` 加应用
//!    的 `AXFrontmost`），再做各自的核对：指针核对落点归目标窗口，键盘核对前台应用是目标进程、
//!    它的焦点窗口是目标窗口。点名了控件时再核对它持有键盘焦点，焦点不在它上面就拒绝。
//! 5. **中途前台或焦点变了立即停止**，已发出多少如实带回，执行事实落 `unknown`，不向另一个
//!    窗口续输。
//! 6. **窗口动作的生效证据按动作各自读回**：前台与焦点窗口、最小化与全屏属性、CG 窗口矩形、
//!    窗口是否还在。AX 的写调用返回成功只说明应用受理了。
//! 7. **协议的坐标与尺寸是屏幕物理像素**，按目标窗口的那一套换算换回点（`screen::Mapping`）；
//!    事件位置与 `AXPosition` / `AXSize` 都是点。

use std::cell::Cell;
use std::time::Duration;

use super::ax::{self, Element};
use super::backend::CallWatch;
use super::sink::MacSink;
use super::walk::{self, Root};
use crate::backend::{confirm, dispatch_call, lands_on_target, settled, Attempt, Outcome};
use crate::geometry::ScreenPoint;
use crate::input::{drag_path, key_stroke, wheel_of, Event, Hold, Sink};
use crate::macos::pure::associate;
use crate::macos::pure::facts::{action, action_error, attr, error_name};
use crate::macos::pure::identity::Handle;
use crate::macos::pure::plan::{self, Setting};
use crate::macos::pure::screen::Placed;
use crate::protocol::{
    classify_input, key_name, ActionSpec, Dispatch, Modifier, MouseButton, WindowState,
};

/// 一次拖拽分几段移动。一次跳到终点的话，被拖的控件收不到中间的移动事件。
const DRAG_STEPS: u32 = 12;
/// 拖拽两段之间隔多久。
const DRAG_STEP_MS: u64 = 16;
/// 激活之后等前台应用与焦点窗口真的改过来多久。应用异步处理激活。
const ACTIVATE_SETTLE: Duration = Duration::from_millis(400);
/// 读回窗口矩形的等待上限。
const WINDOW_SETTLE: Duration = Duration::from_millis(400);
/// 读回显示状态的等待上限。最小化与进出全屏都有系统动画，全屏的过场约一秒。
const STATE_SETTLE: Duration = Duration::from_millis(1_500);

/// 一次指针动作的落点。非指针动作三项都缺席。
#[derive(Debug, Clone, Copy, Default)]
pub struct Aim {
    /// 指针落点，屏幕物理像素。
    pub anchor: Option<ScreenPoint>,
    /// 拖拽终点。只有拖拽有。
    pub destination: Option<ScreenPoint>,
    /// 按控件定位时，控件所在的顶层窗口；按图像坐标定位时缺席。
    pub host: Option<i64>,
}

/// 点名控件的键盘输入要核对的那一项：控件此刻有没有键盘焦点。读的是实时状态。
pub type Focus<'a> = Option<&'a dyn Fn() -> Result<bool, String>>;

/// 一次前台动作的目标：窗口根、它对应的 CG 窗口号，以及派发前读到的几何。
pub struct Target<'a> {
    pub root: &'a Root,
    pub number: u32,
    pub placed: Placed,
}

/// 执行一个前台动作。
pub fn perform(
    target: &Target<'_>,
    focus: Focus<'_>,
    action: &ActionSpec,
    aim: Aim,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    let sink = match MacSink::new(target.placed.mapping) {
        Ok(sink) => sink,
        Err(reason) => return Attempt::Refused(reason),
    };
    let activated = action.takes_input() && ensure_foreground(target.root);
    match action {
        ActionSpec::Click { button, count } => click(target, &sink, aim, *button, *count),
        ActionSpec::Hover => hover(target, &sink, aim),
        ActionSpec::Drag { .. } => drag(target, &sink, aim, stop),
        ActionSpec::Wheel { direction, amount } => {
            wheel(target, &sink, aim, wheel_of(*direction, *amount))
        }
        ActionSpec::TypeText { text } => match keyboard_target(target.root, focus, activated) {
            Err(reason) => Attempt::Refused(reason),
            Ok(()) => type_text(target.root, &sink, text),
        },
        ActionSpec::PressKey { key, modifiers } => {
            match keyboard_target(target.root, focus, activated) {
                Err(reason) => Attempt::Refused(reason),
                Ok(()) => press_key(&sink, key, modifiers),
            }
        }
        ActionSpec::Activate => activate(target.root),
        ActionSpec::SetWindowState { state } => set_window_state(target.root, *state),
        ActionSpec::MoveWindow { x, y } => move_window(target, *x, *y),
        ActionSpec::ResizeWindow { width, height } => resize_window(target, *width, *height),
        ActionSpec::CloseWindow => close_window(target),
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

// ── 指针 ──

fn click(
    target: &Target<'_>,
    sink: &dyn Sink,
    aim: Aim,
    button: MouseButton,
    count: u32,
) -> Attempt {
    if count == 0 || count > 2 {
        return Attempt::Refused(format!("invalid_count: {count}，只接受 1 或 2"));
    }
    let anchor = match landing(target, aim) {
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
    // 第二下的点击次数由事件自己带，见 `events` 第 3 条：两下之间的时间间隔不作数。
    settle(sink.send(&events), &events)
}

fn hover(target: &Target<'_>, sink: &dyn Sink, aim: Aim) -> Attempt {
    let anchor = match landing(target, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let events = [Event::Move { to: anchor }];
    settle(sink.send(&events), &events)
}

fn wheel(target: &Target<'_>, sink: &dyn Sink, aim: Aim, wheel: (i32, bool)) -> Attempt {
    let anchor = match landing(target, aim) {
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
fn drag(target: &Target<'_>, sink: &dyn Sink, aim: Aim, stop: &dyn Fn() -> bool) -> Attempt {
    let anchor = match landing(target, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let Some(destination) = aim.destination else {
        return Attempt::Refused("missing_target: 拖拽没有终点".to_owned());
    };
    // 终点同样要落在目标窗口里：拖到别的窗口上等于把这次放手交给了另一个应用。
    match walk::placed(target.number) {
        None => return Attempt::Refused("target_lost: 窗口已经不在".to_owned()),
        Some(placed) if !placed.frame.window.contains(destination) => {
            return Attempt::Refused(format!(
                "drop_outside_window: {},{}",
                destination.x, destination.y
            ))
        }
        Some(_) => {}
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
        if !ax::cg_windows().iter().any(|w| w.number == target.number) {
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
/// 浮动面板、别的应用的置顶窗口或菜单，如实拒绝。
fn landing(target: &Target<'_>, aim: Aim) -> Result<ScreenPoint, String> {
    let anchor = aim.anchor.ok_or("missing_target: 指针动作没有落点")?;
    let placed =
        walk::placed(target.number).ok_or_else(|| "target_lost: 窗口已经不在".to_owned())?;
    if !placed.frame.window.contains(anchor) {
        return Err(format!("point_outside_window: {},{}", anchor.x, anchor.y));
    }
    let (hit_root, hit_owner) = hit(&target.placed, anchor)?;
    if !lands_on_target(i64::from(target.number), hit_root, hit_owner, aim.host) {
        return Err(format!("occluded: {},{}", anchor.x, anchor.y));
    }
    Ok(anchor)
}

/// 落点处接住指针的窗口与它的所有者，给 `lands_on_target` 判。
///
/// 应用由系统范围元素的命中测试认，窗口由这个应用的 CG 窗口按层叠序认，见 `associate::hit`。
/// macOS 不报窗口之间的所有关系，所有者就是窗口自己。
fn hit(placed: &Placed, at: ScreenPoint) -> Result<(i64, i64), String> {
    let point = placed.mapping.point(at);
    let unowned = |why: &str| format!("point_unowned: {},{}{why}", at.x, at.y);
    let element = Element::system_wide()
        .element_at(point.0 as f32, point.1 as f32)
        .map_err(|code| unowned(&format!("，命中测试回 {}", error_name(code))))?;
    let pid = element
        .pid()
        .map_err(|code| unowned(&format!("，读命中元素的进程失败：{}", error_name(code))))?;
    let number = associate::hit(point, &ax::cg_windows(), pid).ok_or_else(|| unowned(""))?;
    Ok((i64::from(number), i64::from(number)))
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

/// 键盘输入的前置条件：前台应用是目标进程，它的焦点窗口是目标窗口。
///
/// **不给控件即以窗口为目标**，判定到此为止：自绘界面不暴露业务控件，要求点名一个持有焦点的
/// 控件等于对它们关掉整条键盘路径。给了控件再加一条：它此刻持有键盘焦点。刚激活的窗口要处理完
/// 激活才更新控件的焦点状态，所以这时在激活的等待上限内重读。
fn keyboard_target(root: &Root, focus: Focus<'_>, activated: bool) -> Result<(), String> {
    foreground_ok(root)?;
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

/// 前台应用是目标进程，且它接收键盘输入的窗口是目标窗口。
fn foreground_ok(root: &Root) -> Result<(), String> {
    let failed = |step: &str| {
        let step = step.to_owned();
        move |code: i32| format!("{step}失败：{}", error_name(code))
    };
    let app = Element::system_wide()
        .element(attr::FOCUSED_APPLICATION)
        .map_err(failed("读前台应用"))?
        .ok_or_else(|| "not_foreground: 读不出前台应用".to_owned())?;
    let pid = app.pid().map_err(failed("读前台应用的进程"))?;
    if pid != root.pid {
        return Err(format!("not_foreground: 前台应用是进程 {pid}"));
    }
    let window = app
        .element(attr::FOCUSED_WINDOW)
        .map_err(failed("读焦点窗口"))?;
    if window.is_some_and(|w| w.same(&root.element)) {
        Ok(())
    } else {
        Err("not_foreground: 前台应用的焦点窗口不是目标窗口".to_owned())
    }
}

/// 投进文字。每一批之前重核前台与焦点窗口，变了立即停下并如实带回已投出多少。
fn type_text(root: &Root, sink: &MacSink, text: &str) -> Attempt {
    if text.is_empty() {
        return Attempt::Refused("empty_text: 文字为空".to_owned());
    }
    let typed = sink.type_text(text, &|| foreground_ok(root));
    let (dispatch, reason) = match typed.interrupted {
        Some(note) => (
            if typed.sent == 0 {
                Dispatch::NotDispatched
            } else {
                Dispatch::Unknown
            },
            Some(format!(
                "{note} · 已投出 {} / {} 个码元",
                typed.sent, typed.requested
            )),
        ),
        None => classify_input(typed.sent, typed.requested),
    };
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 一次组合键。整条序列一次投出，中间没有别的输入插得进来。
fn press_key(sink: &MacSink, key: &str, modifiers: &[Modifier]) -> Attempt {
    let Some(main) = key_name(key) else {
        return Attempt::Refused(format!("unknown_key: {key}"));
    };
    let held: Vec<String> = modifiers.iter().map(|m| m.key_name().to_owned()).collect();
    if let Some(missing) = held.iter().chain([&main]).find(|k| !sink.resolves(k)) {
        return Attempt::Refused(format!("key_unmapped: macOS 键盘上没有 {missing} 这个键"));
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

/// 把目标窗口提到它所在应用的最上面，再把应用提到前台。交回各次调用的失败原文。
///
/// 最小化的窗口先写 `AXMinimized = false` 恢复，再提：不依赖 `AXRaise` 一并恢复它。
fn raise(root: &Root) -> Vec<String> {
    let mut errors = Vec::new();
    if flag(root, attr::MINIMIZED) == Some(true) {
        if let Err(code) = root.element.set(attr::MINIMIZED, &Setting::Bool(false)) {
            errors.push(action_error(attr::MINIMIZED, code));
        }
    }
    if let Err(code) = root.element.perform(action::RAISE) {
        errors.push(action_error(action::RAISE, code));
    }
    if let Err(code) = Element::application(root.pid).set(attr::FRONTMOST, &Setting::Bool(true)) {
        errors.push(action_error(attr::FRONTMOST, code));
    }
    errors
}

/// 派发前把目标窗口提到前台。已经在前台时不发调用。返回有没有发出激活。
///
/// 提不上来不在这里裁决：随后那次核对照原样给原因码。
fn ensure_foreground(root: &Root) -> bool {
    let ready = || foreground_ok(root).is_ok();
    if ready() {
        return false;
    }
    let _ = raise(root);
    let _ = settled(ACTIVATE_SETTLE, ready);
    true
}

/// 激活目标窗口。到达前台记已执行，调用发出而前台没变记结果未知。
fn activate(root: &Root) -> Attempt {
    let errors = raise(root);
    if settled(ACTIVATE_SETTLE, || foreground_ok(root).is_ok()) {
        return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
    }
    let reason = if errors.is_empty() {
        "调用成功，前台窗口没有变成目标窗口".to_owned()
    } else {
        errors.join("；")
    };
    Attempt::Called(Outcome::returned(Dispatch::Unknown, Some(reason)))
}

/// 窗口的一个布尔属性此刻的值。读不出时缺席。
fn flag(root: &Root, attribute: &str) -> Option<bool> {
    root.element.raw(attribute).ok().and_then(|raw| raw.flag())
}

/// 窗口此刻的显示状态，见 `plan::window_state`。
fn state_of(root: &Root) -> Result<WindowState, String> {
    let read = |attribute: &str| {
        root.element
            .raw(attribute)
            .map(|raw| raw.flag())
            .map_err(|code| format!("读窗口状态失败：{}", error_name(code)))
    };
    Ok(plan::window_state(
        read(attr::MINIMIZED)?,
        read(attr::FULL_SCREEN)?,
    ))
}

/// 改显示状态：按 `plan::window_steps` 依次写属性。中间那一步读回到位才写下一步，最后一步
/// 由 `confirm` 按整体状态读回。
fn set_window_state(root: &Root, desired: WindowState) -> Attempt {
    let current = match state_of(root) {
        Ok(state) => state,
        Err(reason) => return Attempt::Refused(reason),
    };
    let steps = match plan::window_steps(current, desired) {
        Ok(steps) => steps,
        Err(reason) => return Attempt::Refused(reason),
    };
    for (attribute, _) in &steps {
        match root.element.settable(attribute) {
            Ok(true) => {}
            Ok(false) => {
                return Attempt::Refused(format!("state_unsupported: {}", desired.as_str()))
            }
            Err(code) => return Attempt::Refused(format!("读窗口能力失败：{}", error_name(code))),
        }
    }
    let last = steps.len() - 1;
    for (i, (attribute, value)) in steps.into_iter().enumerate() {
        if let Err(code) = root.element.set(attribute, &Setting::Bool(value)) {
            return Attempt::Called(Outcome::returned(
                Dispatch::Unknown,
                Some(action_error(attribute, code)),
            ));
        }
        if i == last {
            break;
        }
        if !settled(STATE_SETTLE, || flag(root, attribute) == Some(value)) {
            return Attempt::Called(Outcome::returned(
                Dispatch::Unknown,
                Some("调用成功，窗口没有离开原来的显示状态".to_owned()),
            ));
        }
    }
    confirm(
        Attempt::Called(Outcome::returned(Dispatch::Submitted, None)),
        STATE_SETTLE,
        || state_of(root) == Ok(desired),
    )
}

/// 一个属性可写才往下走，否则按 `refusal` 拒绝。
fn require_settable(root: &Root, attribute: &str, refusal: &str) -> Result<(), String> {
    match root.element.settable(attribute) {
        Ok(true) => Ok(()),
        Ok(false) => Err(refusal.to_owned()),
        Err(code) => Err(format!("读窗口能力失败：{}", error_name(code))),
    }
}

/// 两个点坐标在取整误差以内相等。应用会把位置尺寸取整到点。
fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1.0
}

/// 把窗口左上角移到屏幕物理像素 `(x, y)`。
///
/// 系统会按自己的规则夹住位置（不让标题栏离开屏幕），夹出来的值不是失败：矩形的实际值随动作后
/// 的重读一起交给调用方。读回只用来等请求生效，等不到也不改执行事实。
fn move_window(target: &Target<'_>, x: i32, y: i32) -> Attempt {
    if let Err(reason) =
        require_settable(target.root, attr::POSITION, "transform_unsupported: 移动")
    {
        return Attempt::Refused(reason);
    }
    let (px, py) = target.placed.mapping.point(ScreenPoint { x, y });
    if let Err(code) = target
        .root
        .element
        .set(attr::POSITION, &Setting::Point { x: px, y: py })
    {
        return Attempt::Called(Outcome::returned(
            Dispatch::Unknown,
            Some(action_error(attr::POSITION, code)),
        ));
    }
    let _ = settled(WINDOW_SETTLE, || {
        walk::placed(target.number).is_some_and(|p| near(p.bounds.x, px) && near(p.bounds.y, py))
    });
    Attempt::Called(Outcome::returned(Dispatch::Submitted, None))
}

/// 把窗口缩放到 `width × height` 屏幕物理像素，含标题栏。夹住的值同 `move_window`。
fn resize_window(target: &Target<'_>, width: i32, height: i32) -> Attempt {
    let mapping = target.placed.mapping;
    let (w, h) = (mapping.points(width), mapping.points(height));
    if w < 1.0 || h < 1.0 {
        return Attempt::Refused(format!("invalid_size: {width}×{height}"));
    }
    if let Err(reason) = require_settable(target.root, attr::SIZE, "transform_unsupported: 缩放")
    {
        return Attempt::Refused(reason);
    }
    if let Err(code) = target.root.element.set(
        attr::SIZE,
        &Setting::Size {
            width: w,
            height: h,
        },
    ) {
        return Attempt::Called(Outcome::returned(
            Dispatch::Unknown,
            Some(action_error(attr::SIZE, code)),
        ));
    }
    let _ = settled(WINDOW_SETTLE, || {
        walk::placed(target.number)
            .is_some_and(|p| near(p.bounds.width, w) && near(p.bounds.height, h))
    });
    Attempt::Called(Outcome::returned(Dispatch::Submitted, None))
}

/// 关闭窗口：按它的关闭按钮，不是强杀进程。
///
/// 未保存提示可能让这次调用挂在应用里，走的是与后台调用同一条可放弃等待的路径：证据是目标窗口
/// 已关闭或同进程多出一个窗口（提示框）。**不替用户选**提示框上的按钮。
fn close_window(target: &Target<'_>) -> Attempt {
    let button = match target.root.element.element(attr::CLOSE_BUTTON) {
        Ok(Some(button)) => button,
        Ok(None) => return Attempt::Refused("close_unsupported: 这个窗口没有关闭按钮".to_owned()),
        Err(code) => return Attempt::Refused(format!("读关闭按钮失败：{}", error_name(code))),
    };
    match button.action_names() {
        Ok(names) if names.iter().any(|n| n == action::PRESS) => {}
        Ok(_) => return Attempt::Refused("close_unsupported: 关闭按钮不接受 AXPress".to_owned()),
        Err(code) => {
            return Attempt::Refused(format!("读关闭按钮的动作失败：{}", error_name(code)))
        }
    }
    let watch = CallWatch::before(target.root.pid, Some(target.number));
    dispatch_call(
        &watch,
        Box::new(move || {
            button
                .perform(action::PRESS)
                .map_err(|code| action_error(action::PRESS, code))
        }),
    )
}
