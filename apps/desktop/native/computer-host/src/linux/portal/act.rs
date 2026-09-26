//! 经 RemoteDesktop 向共享的窗口投递指针与键盘。
//!
//! 六条边界：
//!
//! 1. **只在目标窗口是活动窗口时投递。** Wayland 下客户端既不能把别的窗口激活到前台，也读不到
//!    窗口的层叠序：键盘去的是活动窗口，指针落点在不在目标窗口上核对不了。目标窗口是活动窗口
//!    时它在普通窗口之上；置顶窗口、弹出菜单与系统通知盖住的位置仍核对不了，这是这条路径的
//!    边界。
//! 2. **指针只接受按图定位的落点。** 落点是流的逻辑坐标，合成器按这条流把它换到窗口上；
//!    AT-SPI 在这类窗口上给的包围盒不是这套坐标，按控件定位的指针动作不提供。
//! 3. **字符按 keysym 投递，由合成器按当前键盘布局换成按键。** 布局里没有的字符合成器丢弃且
//!    不报错，因此含字符的输入一律记结果未知，以动作后的重读为准；Latin-1 以外的字符没有
//!    布局能按出来，派发前即拒绝。
//! 4. **按住的键随按随记**，任何中止路径都经 `input::Hold` 释放。worker 被强杀时会话随总线
//!    连接一起结束，合成器释放这个会话按住的键；宿主按账补发的 X11 抬起对原生 Wayland 窗口
//!    不起作用。
//! 5. **中途目标窗口不再是活动窗口即停止**，已发出多少如实带回。
//! 6. **一个会话的第一次指针动作先只移动、等一段再派发**：见 `Ledger::first_pointer`。

use std::time::Duration;

use super::super::x11::keys::keysym;
use super::Grant;
use crate::backend::{Attempt, Outcome};
use crate::geometry::ScreenPoint;
use crate::input::{drag_path, key_stroke, wheel_of, Event, Hold, Sink};
use crate::protocol::{key_name, ActionSpec, Dispatch, DragTarget, MouseButton};

/// 一次拖拽分几段移动、两段之间隔多久。与 X11 路径相同。
const DRAG_STEPS: u32 = 12;
const DRAG_STEP_MS: u64 = 16;
/// 文字每投多少个字符重核一次活动窗口。
const TEXT_BATCH: usize = 16;
/// 一个会话第一次投指针事件之前，先移动指针再等多久，见 `Ledger::first_pointer`。
/// 无头 GNOME Shell 50 上从建设备到应用收到第一个指针事件实测 100–200 ms。
const POINTER_ANNOUNCE: Duration = Duration::from_millis(400);

/// 按 Linux 输入事件码（`BTN_LEFT` 起）。
const fn button_code(button: MouseButton) -> i32 {
    match button {
        MouseButton::Left => 0x110,
        MouseButton::Right => 0x111,
        MouseButton::Middle => 0x112,
    }
}

/// 字符 keysym 与功能键 keysym 的分界：功能键、修饰键都在 `0xff00` 以上。
const FUNCTION_KEYSYMS: u32 = 0xff00;

const LAYOUT_NOTE: &str = "字符经合成器按当前键盘布局换成按键，布局里没有的字符不会送达；\
     以动作后的重读为准";

/// 投递目标：共享授权，以及动作前后要读的那两项实时状态。
pub struct Target<'a> {
    pub grant: &'a Grant,
    /// 目标窗口的逻辑尺寸（AT-SPI）。落点与拖拽终点都要在它里面。
    pub size: (i32, i32),
    /// 目标窗口此刻是不是活动窗口。
    pub active: &'a dyn Fn() -> Result<bool, String>,
    /// 点名了控件时：它此刻有没有键盘焦点。
    pub focus: Option<&'a dyn Fn() -> Result<bool, String>>,
}

struct PortalSink<'a> {
    grant: &'a Grant,
}

impl PortalSink<'_> {
    fn one(&self, event: &Event) -> Result<(), String> {
        let bus = self.grant.bus();
        let coverage = &self.grant.coverage;
        let session = coverage.session.as_str();
        match event {
            Event::Move { to } => {
                bus.pointer_to(session, coverage.node, f64::from(to.x), f64::from(to.y))
            }
            Event::Button { button, down } => {
                bus.pointer_button(session, button_code(*button), *down)
            }
            // 协议的正值向上或向右，portal 的正值向下或向右。
            Event::Wheel {
                notches,
                horizontal,
            } => {
                if *horizontal {
                    bus.pointer_axis(session, 1, *notches)
                } else {
                    bus.pointer_axis(session, 0, -notches)
                }
            }
            Event::Key { key, down } => {
                let sym = keysym(key).ok_or_else(|| format!("unknown_key: {key}"))?;
                bus.keysym(session, sym, *down)
            }
        }
    }

    fn keysyms(&self, syms: &[u32]) -> u32 {
        let bus = self.grant.bus();
        let session = self.grant.coverage.session.as_str();
        let mut sent = 0;
        for sym in syms {
            if bus.keysym(session, *sym, true).is_err() || bus.keysym(session, *sym, false).is_err()
            {
                break;
            }
            sent += 1;
        }
        sent
    }
}

impl Sink for PortalSink<'_> {
    fn send(&self, events: &[Event]) -> u32 {
        let mut sent = 0;
        for event in events {
            if let Err(reason) = self.one(event) {
                eprintln!("portal 输入中断：{reason}");
                break;
            }
            sent += 1;
        }
        sent
    }
}

/// 一批事件发完之后的执行事实。`note` 是全部发出时仍要附上的说明，见本模块第 3 条。
fn settle(sent: u32, requested: u32, note: Option<&str>) -> Attempt {
    let (dispatch, reason) = if requested == 0 || sent == 0 {
        (
            Dispatch::NotDispatched,
            Some(format!(
                "input_blocked: {requested} 个输入事件一个都没有交给合成器"
            )),
        )
    } else if sent < requested {
        (
            Dispatch::Unknown,
            Some(format!(
                "input_partial: {requested} 个输入事件只交给合成器 {sent} 个，已发出的部分可能已经生效"
            )),
        )
    } else if let Some(note) = note {
        (Dispatch::Unknown, Some(note.to_owned()))
    } else {
        (Dispatch::Submitted, None)
    };
    Attempt::Called(Outcome::returned(dispatch, reason))
}

fn count<T>(items: &[T]) -> u32 {
    u32::try_from(items.len()).unwrap_or(u32::MAX)
}

fn must_be_active(target: &Target<'_>) -> Result<(), String> {
    if (target.active)()? {
        return Ok(());
    }
    Err(
        "not_foreground: 目标窗口不是活动窗口；Wayland 下不能替用户切换窗口，请用户先切到这个窗口"
            .to_owned(),
    )
}

fn inside(target: &Target<'_>, point: ScreenPoint) -> bool {
    point.x >= 0 && point.y >= 0 && point.x < target.size.0 && point.y < target.size.1
}

/// 不看共享状态就判得出的拒绝：窗口动作、按控件定位的指针动作、按不出来的文字、认不出的键。
///
/// 调用方在要共享授权之前先过这一关：这些请求无论授权与否都执行不了，为它们弹出授权框没有意义。
pub fn screen(action: &ActionSpec, point: Option<ScreenPoint>) -> Result<(), String> {
    if !action.takes_input() {
        return Err(
            "window_action_unsupported: Wayland 下合成器不允许客户端激活、摆放或关闭别的窗口"
                .to_owned(),
        );
    }
    let by_image = "pointer_by_image_only: 原生 Wayland 窗口的指针动作只接受按图定位的落点";
    match action {
        _ if action.takes_point() && point.is_none() => Err(by_image.to_owned()),
        ActionSpec::Drag {
            to: DragTarget::Ref { .. },
        } => Err(by_image.to_owned()),
        ActionSpec::Click { count, .. } if *count == 0 || *count > 2 => {
            Err(format!("invalid_count: {count}，只接受 1 或 2"))
        }
        ActionSpec::TypeText { text } if text.is_empty() => Err("empty_text: 文字为空".to_owned()),
        ActionSpec::TypeText { text } => match text.chars().find(|c| char_keysym(*c).is_none()) {
            Some(c) => Err(format!(
                "text_unsupported: 「{c}」不在 Latin-1 里，Wayland 下没有键盘布局按得出它；可改用 set_value"
            )),
            None => Ok(()),
        },
        ActionSpec::PressKey { key, .. } => match key_name(key).and_then(|k| keysym(&k)) {
            Some(_) => Ok(()),
            None => Err(format!("unknown_key: {key}")),
        },
        _ => Ok(()),
    }
}

/// 执行一个前台输入动作。先过 `screen`。
pub fn perform(
    target: &Target<'_>,
    action: &ActionSpec,
    point: Option<ScreenPoint>,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    if let Err(reason) = screen(action, point) {
        return Attempt::Refused(reason);
    }
    let coverage = &target.grant.coverage;
    if action.takes_point() && !coverage.pointer {
        return Attempt::Refused(
            "input_not_allowed: 用户在系统授权框里没有允许指针控制".to_owned(),
        );
    }
    if action.targets_window() && !coverage.keyboard {
        return Attempt::Refused(
            "input_not_allowed: 用户在系统授权框里没有允许键盘控制".to_owned(),
        );
    }
    if let Err(reason) = must_be_active(target) {
        return Attempt::Refused(reason);
    }
    let sink = PortalSink {
        grant: target.grant,
    };
    let anchor = point.filter(|_| action.takes_point());
    if let Some(at) = anchor {
        if !inside(target, at) {
            return Attempt::Refused(format!("point_outside_window: {},{}", at.x, at.y));
        }
        if target.grant.first_pointer() {
            // 只移动、不按键：这次移动应用可能收不到，之后的那一组才算数。
            let _ = sink.send(&[Event::Move { to: at }]);
            std::thread::sleep(POINTER_ANNOUNCE);
        }
    }
    match (action, anchor) {
        (ActionSpec::Click { button, count: n }, Some(at)) => {
            let mut events = vec![Event::Move { to: at }];
            for _ in 0..*n {
                events.push(Event::Button {
                    button: *button,
                    down: true,
                });
                events.push(Event::Button {
                    button: *button,
                    down: false,
                });
            }
            settle(sink.send(&events), count(&events), None)
        }
        (ActionSpec::Hover, Some(at)) => {
            let events = [Event::Move { to: at }];
            settle(sink.send(&events), 1, None)
        }
        (ActionSpec::Wheel { direction, amount }, Some(at)) => {
            let (notches, horizontal) = wheel_of(*direction, *amount);
            let events = [
                Event::Move { to: at },
                Event::Wheel {
                    notches,
                    horizontal,
                },
            ];
            settle(sink.send(&events), 2, None)
        }
        (ActionSpec::Drag { to }, Some(at)) => drag(target, &sink, at, to, stop),
        (ActionSpec::TypeText { text }, _) => match keyboard(target) {
            Err(reason) => Attempt::Refused(reason),
            Ok(()) => type_text(target, &sink, text),
        },
        (ActionSpec::PressKey { key, modifiers }, _) => match keyboard(target) {
            Err(reason) => Attempt::Refused(reason),
            Ok(()) => press_key(
                &sink,
                key,
                &modifiers
                    .iter()
                    .map(|m| m.key_name().to_owned())
                    .collect::<Vec<_>>(),
            ),
        },
        // 窗口动作与没有落点的指针动作 `screen` 已经拒掉。
        _ => Attempt::Refused("not_foreground: 这个动作不走前台输入".to_owned()),
    }
}

/// 点名控件的键盘输入再核对它持有焦点；不点名即以窗口为目标。
fn keyboard(target: &Target<'_>) -> Result<(), String> {
    match target.focus {
        Some(focused) if !focused()? => {
            Err("not_focused: 这个控件没有键盘焦点 · 先 click 它".to_owned())
        }
        _ => Ok(()),
    }
}

fn drag(
    target: &Target<'_>,
    sink: &PortalSink<'_>,
    anchor: ScreenPoint,
    to: &DragTarget,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    // 按控件给的终点 `screen` 已经拒掉。
    let DragTarget::Offset { dx, dy } = to else {
        return Attempt::Refused("pointer_by_image_only: 拖拽终点只接受偏移".to_owned());
    };
    let destination = ScreenPoint {
        x: anchor.x + dx,
        y: anchor.y + dy,
    };
    if !inside(target, destination) {
        return Attempt::Refused(format!(
            "drop_outside_window: {},{}",
            destination.x, destination.y
        ));
    }
    if sink.send(&[Event::Move { to: anchor }]) == 0 {
        return settle(0, 1, None);
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
            Some("input_blocked: 按下没有交给合成器，指针已在起点".to_owned()),
        ));
    }
    let path = drag_path(anchor, destination, DRAG_STEPS);
    let mut moved = 0u32;
    for (i, point) in path.iter().enumerate() {
        if stop() {
            hold.release();
            return Attempt::Called(Outcome::returned(
                Dispatch::Unknown,
                Some(format!("cancelled: 拖拽第 {i} 段 · 左键已释放")),
            ));
        }
        moved += sink.send(&[Event::Move { to: *point }]);
        std::thread::sleep(Duration::from_millis(DRAG_STEP_MS));
    }
    let released = hold.release();
    let requested = count(&path) + 1;
    settle(moved + released, requested, None)
}

/// 一个字符的 keysym：换行与制表符是功能键，Latin-1 可打印字符的 keysym 就是它的码位。
fn char_keysym(c: char) -> Option<u32> {
    match c {
        '\n' => Some(0xff0d),
        '\t' => Some(0xff09),
        ' '..='~' | '\u{a0}'..='\u{ff}' => Some(u32::from(c)),
        _ => None,
    }
}

/// 投进文字。空文字与按不出来的字符 `screen` 已经拒掉。
fn type_text(target: &Target<'_>, sink: &PortalSink<'_>, text: &str) -> Attempt {
    let syms: Vec<u32> = text.chars().filter_map(char_keysym).collect();
    let requested = u32::try_from(syms.len()).unwrap_or(u32::MAX);
    let mut sent = 0u32;
    for batch in syms.chunks(TEXT_BATCH) {
        if sent > 0 && must_be_active(target).is_err() {
            return Attempt::Called(Outcome::returned(
                Dispatch::Unknown,
                Some(format!(
                    "not_foreground: 目标窗口中途不再是活动窗口 · 已投出 {sent} / {requested} 个字符"
                )),
            ));
        }
        let done = sink.keysyms(batch);
        sent += done;
        if (done as usize) < batch.len() {
            break;
        }
    }
    let note = syms
        .iter()
        .any(|s| *s < FUNCTION_KEYSYMS)
        .then_some(LAYOUT_NOTE);
    settle(sent, requested, note)
}

/// 一次组合键。修饰键按给出的顺序按下，逆序释放。认不出的键 `screen` 已经拒掉。
fn press_key(sink: &PortalSink<'_>, key: &str, held: &[String]) -> Attempt {
    let Some((main, main_sym)) = key_name(key).and_then(|k| keysym(&k).map(|s| (k, s))) else {
        return Attempt::Refused(format!("unknown_key: {key}"));
    };
    let events = key_stroke(&main, held);
    let requested = count(&events);
    // 记账在派发之前：整条序列自带抬起，但只发出去一半时修饰键会停在按下状态。
    let mut hold = Hold::record(sink, Vec::new(), {
        let mut keys = held.to_vec();
        keys.push(main);
        keys
    });
    let sent = sink.send(&events);
    if sent >= requested {
        hold.clear();
    } else {
        hold.release();
    }
    let note = (main_sym < FUNCTION_KEYSYMS).then_some(LAYOUT_NOTE);
    settle(sent, requested, note)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 换行、制表符与 Latin-1 可打印字符有 keysym；中文、emoji 与其他控制字符没有。
    #[test]
    fn only_latin1_and_line_breaks_have_a_keysym() {
        assert_eq!(char_keysym('a'), Some(0x61));
        assert_eq!(char_keysym('~'), Some(0x7e));
        assert_eq!(char_keysym('é'), Some(0xe9));
        assert_eq!(char_keysym('\n'), Some(0xff0d));
        assert_eq!(char_keysym('\t'), Some(0xff09));
        for c in ['你', '🙂', '\u{7f}', '\r', '—'] {
            assert_eq!(char_keysym(c), None, "{c:?}");
        }
    }

    /// 全部发出而含字符：结果未知；全部发出且只有功能键：已派发；一个没发出：未派发。
    #[test]
    fn character_input_is_never_reported_as_delivered() {
        let dispatch = |attempt: Attempt| match attempt {
            Attempt::Called(outcome) => outcome.dispatch,
            Attempt::Refused(_) => panic!("不是拒绝"),
        };
        assert_eq!(dispatch(settle(4, 4, Some(LAYOUT_NOTE))), Dispatch::Unknown);
        assert_eq!(dispatch(settle(4, 4, None)), Dispatch::Submitted);
        assert_eq!(dispatch(settle(2, 4, None)), Dispatch::Unknown);
        assert_eq!(dispatch(settle(0, 4, None)), Dispatch::NotDispatched);
    }

    /// 无论共享与否都执行不了的请求在要授权之前就拒掉：不为它们弹授权框。
    #[test]
    fn requests_that_can_never_run_are_refused_before_asking() {
        let point = Some(ScreenPoint { x: 10, y: 10 });
        let refused = |action: ActionSpec, point: Option<ScreenPoint>| {
            screen(&action, point)
                .expect_err("应当拒绝")
                .split(':')
                .next()
                .map(str::to_owned)
        };
        assert_eq!(
            refused(ActionSpec::Activate, None).as_deref(),
            Some("window_action_unsupported")
        );
        assert_eq!(
            refused(ActionSpec::CloseWindow, None).as_deref(),
            Some("window_action_unsupported")
        );
        let click = || ActionSpec::Click {
            button: MouseButton::Left,
            count: 1,
        };
        assert_eq!(
            refused(click(), None).as_deref(),
            Some("pointer_by_image_only")
        );
        assert_eq!(
            refused(
                ActionSpec::Drag {
                    to: DragTarget::Ref {
                        reference: "w.0#x".to_owned()
                    }
                },
                point
            )
            .as_deref(),
            Some("pointer_by_image_only")
        );
        assert_eq!(
            refused(
                ActionSpec::TypeText {
                    text: "ok 你好".to_owned()
                },
                None
            )
            .as_deref(),
            Some("text_unsupported")
        );
        assert_eq!(
            refused(
                ActionSpec::PressKey {
                    key: "win".to_owned(),
                    modifiers: Vec::new()
                },
                None
            )
            .as_deref(),
            Some("unknown_key")
        );
        assert!(screen(&click(), point).is_ok());
        assert!(screen(
            &ActionSpec::TypeText {
                text: "Hello\tb4\n".to_owned()
            },
            None
        )
        .is_ok());
        assert!(screen(
            &ActionSpec::PressKey {
                key: "enter".to_owned(),
                modifiers: Vec::new()
            },
            None
        )
        .is_ok());
    }

    #[test]
    fn mouse_buttons_map_to_linux_input_codes() {
        assert_eq!(button_code(MouseButton::Left), 272);
        assert_eq!(button_code(MouseButton::Right), 273);
        assert_eq!(button_code(MouseButton::Middle), 274);
    }
}
