//! 前台接管：指针、键盘与窗口动作，经由 CGEvent 与 AX 执行。
//!
//! 七条边界：
//!
//! 1. **本模块的每个动作都会占用用户的前台**，因此只在用户显式启用前台模式时执行；前台模式
//!    关闭时，准入判定在 `protocol::admit` 中拒绝请求，不发送任何事件。
//! 2. **落点在派发时重新计算。** 重新定位控件、读取当前矩形、核对落点处接收指针的窗口是
//!    目标窗口，三步缺一不可。
//! 3. **按下的键在按下时登记，任何中止路径都释放。** 登记与释放由 `input::Hold` 负责，本模块
//!    不直接编写释放调用。
//! 4. **指针与键盘输入在派发前先将目标窗口提到前台**（`ensure_foreground`：窗口的 `AXRaise` 加
//!    应用的 `AXFrontmost`），再分别核对：指针核对落点属于目标窗口，键盘核对前台应用是目标进程、
//!    且其焦点窗口是目标窗口。指定了控件时还核对该控件持有键盘焦点，焦点不在该控件上即拒绝。
//! 5. **中途前台或焦点改变时立即停止**，如实返回已发出的数量，执行事实记为 `unknown`，
//!    不向另一个窗口继续输入。
//! 6. **窗口动作的生效证据按动作分别读取**：前台与焦点窗口、最小化与全屏属性、CG 窗口矩形、
//!    窗口是否存在。AX 的写调用返回成功只说明应用已受理。
//! 7. **协议的坐标与尺寸是屏幕物理像素**，按目标窗口的换算关系换算为点（`screen::Mapping`）；
//!    事件位置与 `AXPosition` / `AXSize` 均以点为单位。

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

/// 一次拖拽分段移动的段数。一次移动到终点时，被拖拽的控件收不到中间的移动事件。
const DRAG_STEPS: u32 = 12;
/// 拖拽相邻两段之间的间隔。
const DRAG_STEP_MS: u64 = 16;
/// 激活之后等待前台应用与焦点窗口完成切换的时长。应用异步处理激活。
const ACTIVATE_SETTLE: Duration = Duration::from_millis(400);
/// 读取窗口矩形的等待上限。
const WINDOW_SETTLE: Duration = Duration::from_millis(400);
/// 读取显示状态的等待上限。最小化与进入、退出全屏都有系统动画，全屏的过渡动画约一秒。
const STATE_SETTLE: Duration = Duration::from_millis(1_500);

/// 一次指针动作的落点。非指针动作三项均缺失。
#[derive(Debug, Clone, Copy, Default)]
pub struct Aim {
    /// 指针落点，屏幕物理像素。
    pub anchor: Option<ScreenPoint>,
    /// 拖拽终点。仅拖拽动作具有此项。
    pub destination: Option<ScreenPoint>,
    /// 按控件定位时，控件所在的顶层窗口；按图像坐标定位时缺失。
    pub host: Option<i64>,
}

/// 指定控件的键盘输入需要核对的条件：控件当前是否持有键盘焦点。读取的是实时状态。
pub type Focus<'a> = Option<&'a dyn Fn() -> Result<bool, String>>;

/// 一次前台动作的目标：窗口根、其对应的 CG 窗口号，以及派发前读取的几何。
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
    // 第二次点击的点击次数由事件自身携带，见 `events` 第 3 条：两次点击之间的时间间隔不起作用。
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
fn drag(target: &Target<'_>, sink: &dyn Sink, aim: Aim, stop: &dyn Fn() -> bool) -> Attempt {
    let anchor = match landing(target, aim) {
        Ok(point) => point,
        Err(reason) => return Attempt::Refused(reason),
    };
    let Some(destination) = aim.destination else {
        return Attempt::Refused("missing_target: 拖拽没有终点".to_owned());
    };
    // 终点同样必须位于目标窗口内：拖到其他窗口上等于把本次释放交给另一个应用。
    match walk::placed(target.number) {
        None => return Attempt::Refused("target_lost: 窗口已不存在".to_owned()),
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

/// 计算本次指针动作的屏幕落点，并核对该位置属于本次动作，判据见 `lands_on_target`。
///
/// 目标窗口不在前台的情形由 `ensure_foreground` 在派发前处理；执行到此处仍被遮挡时，遮挡方是
/// 浮动面板、其他应用的置顶窗口或菜单，如实拒绝。
fn landing(target: &Target<'_>, aim: Aim) -> Result<ScreenPoint, String> {
    let anchor = aim.anchor.ok_or("missing_target: 指针动作没有落点")?;
    let placed =
        walk::placed(target.number).ok_or_else(|| "target_lost: 窗口已不存在".to_owned())?;
    if !placed.frame.window.contains(anchor) {
        return Err(format!("point_outside_window: {},{}", anchor.x, anchor.y));
    }
    let (hit_root, hit_owner) = hit(&target.placed, anchor)?;
    if !lands_on_target(i64::from(target.number), hit_root, hit_owner, aim.host) {
        return Err(format!("occluded: {},{}", anchor.x, anchor.y));
    }
    Ok(anchor)
}

/// 落点处接收指针的窗口及其所有者，供 `lands_on_target` 判定。
///
/// 应用由系统范围元素的命中测试确定，窗口由该应用的 CG 窗口按层叠序确定，见 `associate::hit`。
/// macOS 不报告窗口之间的所有关系，所有者即窗口自身。
fn hit(placed: &Placed, at: ScreenPoint) -> Result<(i64, i64), String> {
    let point = placed.mapping.point(at);
    let unowned = |why: &str| format!("point_unowned: {},{}{why}", at.x, at.y);
    let element = Element::system_wide()
        .element_at(point.0 as f32, point.1 as f32)
        .map_err(|code| unowned(&format!("，命中测试返回 {}", error_name(code))))?;
    let pid = element
        .pid()
        .map_err(|code| unowned(&format!("，读取命中元素的进程失败：{}", error_name(code))))?;
    let number = associate::hit(point, &ax::cg_windows(), pid).ok_or_else(|| unowned(""))?;
    Ok((i64::from(number), i64::from(number)))
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

/// 键盘输入的前置条件：前台应用是目标进程，且其焦点窗口是目标窗口。
///
/// **未指定控件时以窗口为目标**，判定到此结束：自绘界面不暴露业务控件，要求指定一个持有焦点的
/// 控件等于对这类界面关闭整条键盘路径。指定了控件时增加一项条件：该控件当前持有键盘焦点。
/// 刚激活的窗口处理完激活后才更新控件的焦点状态，因此此时在激活的等待上限内重读。
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
        return Err("not_focused: 该控件没有键盘焦点 · 请先对该控件执行 click".to_owned());
    }
    Ok(())
}

/// 核对前台应用是目标进程，且其接收键盘输入的窗口是目标窗口。
fn foreground_ok(root: &Root) -> Result<(), String> {
    let failed = |step: &str| {
        let step = step.to_owned();
        move |code: i32| format!("{step}失败：{}", error_name(code))
    };
    let app = Element::system_wide()
        .element(attr::FOCUSED_APPLICATION)
        .map_err(failed("读取前台应用"))?
        .ok_or_else(|| "not_foreground: 无法读取前台应用".to_owned())?;
    let pid = app.pid().map_err(failed("读取前台应用的进程"))?;
    if pid != root.pid {
        return Err(format!("not_foreground: 前台应用是进程 {pid}"));
    }
    let window = app
        .element(attr::FOCUSED_WINDOW)
        .map_err(failed("读取焦点窗口"))?;
    if window.is_some_and(|w| w.same(&root.element)) {
        Ok(())
    } else {
        Err("not_foreground: 前台应用的焦点窗口不是目标窗口".to_owned())
    }
}

/// 输入文字。每一批之前重新核对前台与焦点窗口，发生变化时立即停止，并如实返回已发送的数量。
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
                "{note} · 已发送 {} / {} 个码元",
                typed.sent, typed.requested
            )),
        ),
        None => classify_input(typed.sent, typed.requested),
    };
    Attempt::Called(Outcome::returned(dispatch, reason))
}

/// 一次组合键。整条序列一次投递，其他输入无法插入其中。
fn press_key(sink: &MacSink, key: &str, modifiers: &[Modifier]) -> Attempt {
    let Some(main) = key_name(key) else {
        return Attempt::Refused(format!("unknown_key: {key}"));
    };
    let held: Vec<String> = modifiers.iter().map(|m| m.key_name().to_owned()).collect();
    if let Some(missing) = held.iter().chain([&main]).find(|k| !sink.resolves(k)) {
        return Attempt::Refused(format!("key_unmapped: macOS 键盘上没有 {missing} 键"));
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

/// 将目标窗口提到所在应用的最上层，再将应用提到前台。返回各次调用的失败原文。
///
/// 最小化的窗口先写入 `AXMinimized = false` 恢复，再提到前台：不依赖 `AXRaise` 同时恢复窗口。
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

/// 派发前将目标窗口提到前台。已在前台时不发起调用。返回是否发出了激活调用。
///
/// 激活失败不在此处裁决：随后的核对会给出原因码。
fn ensure_foreground(root: &Root) -> bool {
    let ready = || foreground_ok(root).is_ok();
    if ready() {
        return false;
    }
    let _ = raise(root);
    let _ = settled(ACTIVATE_SETTLE, ready);
    true
}

/// 激活目标窗口。到达前台记为已执行，调用已发出而前台未变化记为结果未知。
fn activate(root: &Root) -> Attempt {
    let errors = raise(root);
    if settled(ACTIVATE_SETTLE, || foreground_ok(root).is_ok()) {
        return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
    }
    let reason = if errors.is_empty() {
        "调用成功，前台窗口未变为目标窗口".to_owned()
    } else {
        errors.join("；")
    };
    Attempt::Called(Outcome::returned(Dispatch::Unknown, Some(reason)))
}

/// 窗口某个布尔属性的当前值。无法读取时缺失。
fn flag(root: &Root, attribute: &str) -> Option<bool> {
    root.element.raw(attribute).ok().and_then(|raw| raw.flag())
}

/// 窗口当前的显示状态，见 `plan::window_state`。
fn state_of(root: &Root) -> Result<WindowState, String> {
    let read = |attribute: &str| {
        root.element
            .raw(attribute)
            .map(|raw| raw.flag())
            .map_err(|code| format!("读取窗口状态失败：{}", error_name(code)))
    };
    Ok(plan::window_state(
        read(attr::MINIMIZED)?,
        read(attr::FULL_SCREEN)?,
    ))
}

/// 更改显示状态：按 `plan::window_steps` 依次写入属性。中间步骤读取确认到位后才写入下一步，
/// 最后一步由 `confirm` 按整体状态读取确认。
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
            Err(code) => return Attempt::Refused(format!("读取窗口能力失败：{}", error_name(code))),
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
                Some("调用成功，窗口未离开原有的显示状态".to_owned()),
            ));
        }
    }
    confirm(
        Attempt::Called(Outcome::returned(Dispatch::Submitted, None)),
        STATE_SETTLE,
        || state_of(root) == Ok(desired),
    )
}

/// 属性可写时才继续执行，否则按 `refusal` 拒绝。
fn require_settable(root: &Root, attribute: &str, refusal: &str) -> Result<(), String> {
    match root.element.settable(attribute) {
        Ok(true) => Ok(()),
        Ok(false) => Err(refusal.to_owned()),
        Err(code) => Err(format!("读取窗口能力失败：{}", error_name(code))),
    }
}

/// 两个点坐标在取整误差范围内相等。应用会把位置与尺寸取整到点。
fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1.0
}

/// 把窗口左上角移到屏幕物理像素 `(x, y)`。
///
/// 系统会按自身规则限制位置（不允许标题栏离开屏幕），被限制后的值不视为失败：矩形的实际值随动作后
/// 的重读一并返回调用方。读取只用于等待请求生效，等待超时也不改变执行事实。
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

/// 把窗口缩放到 `width × height` 屏幕物理像素，含标题栏。被限制后的值的处理同 `move_window`。
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

/// 关闭窗口：按下窗口的关闭按钮，不是强制终止进程。
///
/// 未保存提示可能使本次调用阻塞在应用中，因此使用与后台调用相同的可放弃等待路径：证据是目标窗口
/// 已关闭或同一进程新增一个窗口（提示框）。**不替用户选择**提示框上的按钮。
fn close_window(target: &Target<'_>) -> Attempt {
    let button = match target.root.element.element(attr::CLOSE_BUTTON) {
        Ok(Some(button)) => button,
        Ok(None) => return Attempt::Refused("close_unsupported: 该窗口没有关闭按钮".to_owned()),
        Err(code) => return Attempt::Refused(format!("读取关闭按钮失败：{}", error_name(code))),
    };
    match button.action_names() {
        Ok(names) if names.iter().any(|n| n == action::PRESS) => {}
        Ok(_) => return Attempt::Refused("close_unsupported: 关闭按钮不接受 AXPress".to_owned()),
        Err(code) => {
            return Attempt::Refused(format!("读取关闭按钮的动作失败：{}", error_name(code)))
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
