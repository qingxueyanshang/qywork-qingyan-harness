//! 平台无关的输入事件换成 CGEvent 的形状：事件类型、鼠标键、位置（点）、点击次数、键码、
//! 修饰键标志位与滚轮格数。
//!
//! 四条规则：
//!
//! 1. **按住鼠标键时的移动是拖动事件**（`LeftMouseDragged` 等），不是 `MouseMoved`：应用按拖动
//!    事件认拖拽。
//! 2. **每个键盘事件自带修饰键标志位**，按此刻已按下、尚未抬起的修饰键算：修饰键自己的按下事件
//!    含它自己，抬起事件不含。
//! 3. **同一处同一个键接连按下，点击次数递增**（1、2），双击由这一格表达，不靠两次按下的时间间隔；
//!    移到别处或换一个键即从 1 重新数。按下与抬起带同一个次数。
//! 4. **CG 的第二滚轮轴正值向左**，协议的水平格数正值向右，换算时取反。垂直轴两边都是正值向上。
//!
//! 状态跨批保留：一次动作分几批派发（拖拽逐段移动）时，按住的键与指针位置接着上一批算。
//! 本模块不调用任何接口。

use crate::geometry::ScreenPoint;
use crate::input::Event;
use crate::macos::keys::{key_code, modifier_flag};
use crate::protocol::MouseButton;

/// `CGEventType` 的取值。
pub mod kind {
    pub const LEFT_DOWN: u32 = 1;
    pub const LEFT_UP: u32 = 2;
    pub const RIGHT_DOWN: u32 = 3;
    pub const RIGHT_UP: u32 = 4;
    pub const MOVED: u32 = 5;
    pub const LEFT_DRAGGED: u32 = 6;
    pub const RIGHT_DRAGGED: u32 = 7;
    pub const OTHER_DOWN: u32 = 25;
    pub const OTHER_UP: u32 = 26;
    pub const OTHER_DRAGGED: u32 = 27;
}

/// 四个修饰键在 `CGEventFlags` 里的位。键盘事件建出来时已有的其余位（小键盘、Fn）不动。
pub const MODIFIER_MASK: u64 = 0x001E_0000;

/// 一个待建的 CGEvent。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cg {
    Mouse {
        kind: u32,
        /// `CGMouseButton`：0 左、1 右、2 中。移动事件填 0。
        button: u32,
        at: (f64, f64),
        /// `kCGMouseEventClickState`。移动事件为 0，不设这一格。
        clicks: i64,
    },
    Scroll {
        vertical: i32,
        horizontal: i32,
        at: (f64, f64),
    },
    Key {
        code: u16,
        down: bool,
        /// 此刻按住的修饰键，只含 `MODIFIER_MASK` 里的位。
        flags: u64,
    },
}

/// 一次动作里的输入状态。
#[derive(Debug, Clone, PartialEq)]
pub struct Tracker {
    at: (f64, f64),
    /// 左、右、中三个键此刻按没按住。
    pressed: [bool; 3],
    flags: u64,
    /// 最近一次按下：哪个键、在哪、第几下。
    last: Option<(MouseButton, (f64, f64), i64)>,
}

const fn slot(button: MouseButton) -> usize {
    match button {
        MouseButton::Left => 0,
        MouseButton::Right => 1,
        MouseButton::Middle => 2,
    }
}

const BUTTONS: [MouseButton; 3] = [MouseButton::Left, MouseButton::Right, MouseButton::Middle];

impl Tracker {
    /// `at` 是派发开始那一刻的指针位置，单位是点。
    pub fn new(at: (f64, f64)) -> Self {
        Self {
            at,
            pressed: [false; 3],
            flags: 0,
            last: None,
        }
    }

    /// 把一批事件换成 CGEvent 的形状。`to_points` 把屏幕物理像素点换成点。
    ///
    /// 批里有换算不了的键名时交回 `None`，状态不变：发一半会让组合键停在半按下的状态。
    pub fn plan(
        &mut self,
        events: &[Event],
        to_points: impl Fn(ScreenPoint) -> (f64, f64),
    ) -> Option<Vec<Cg>> {
        let mut next = self.clone();
        let planned = events
            .iter()
            .map(|e| next.one(e, &to_points))
            .collect::<Option<Vec<Cg>>>()?;
        *self = next;
        Some(planned)
    }

    fn one(&mut self, event: &Event, to_points: &impl Fn(ScreenPoint) -> (f64, f64)) -> Option<Cg> {
        Some(match event {
            Event::Move { to } => {
                let at = to_points(*to);
                if at != self.at {
                    self.last = None;
                }
                self.at = at;
                let held = BUTTONS.into_iter().find(|b| self.pressed[slot(*b)]);
                let (kind, button) = match held {
                    Some(MouseButton::Left) => (kind::LEFT_DRAGGED, 0),
                    Some(MouseButton::Right) => (kind::RIGHT_DRAGGED, 1),
                    Some(MouseButton::Middle) => (kind::OTHER_DRAGGED, 2),
                    None => (kind::MOVED, 0),
                };
                Cg::Mouse {
                    kind,
                    button,
                    at,
                    clicks: 0,
                }
            }
            Event::Button { button, down } => {
                let clicks = if *down {
                    let count = match self.last {
                        Some((b, at, n)) if b == *button && at == self.at => n + 1,
                        _ => 1,
                    };
                    self.last = Some((*button, self.at, count));
                    count
                } else {
                    match self.last {
                        Some((b, _, n)) if b == *button => n,
                        _ => 1,
                    }
                };
                self.pressed[slot(*button)] = *down;
                let (kind, number) = match (button, down) {
                    (MouseButton::Left, true) => (kind::LEFT_DOWN, 0),
                    (MouseButton::Left, false) => (kind::LEFT_UP, 0),
                    (MouseButton::Right, true) => (kind::RIGHT_DOWN, 1),
                    (MouseButton::Right, false) => (kind::RIGHT_UP, 1),
                    (MouseButton::Middle, true) => (kind::OTHER_DOWN, 2),
                    (MouseButton::Middle, false) => (kind::OTHER_UP, 2),
                };
                Cg::Mouse {
                    kind,
                    button: number,
                    at: self.at,
                    clicks,
                }
            }
            Event::Wheel {
                notches,
                horizontal,
            } => {
                let (vertical, horizontal) = if *horizontal {
                    (0, -notches)
                } else {
                    (*notches, 0)
                };
                Cg::Scroll {
                    vertical,
                    horizontal,
                    at: self.at,
                }
            }
            Event::Key { key, down } => {
                let code = key_code(key)?;
                if let Some(flag) = modifier_flag(key) {
                    if *down {
                        self.flags |= flag;
                    } else {
                        self.flags &= !flag;
                    }
                }
                Cg::Key {
                    code,
                    down: *down,
                    flags: self.flags,
                }
            }
        })
    }
}

/// 键盘事件最终的标志位：建事件时系统给的其余位保留，四个修饰键按 `held` 重设。
pub const fn flags_with(created: u64, held: u64) -> u64 {
    (created & !MODIFIER_MASK) | (held & MODIFIER_MASK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::key_stroke;
    use crate::protocol::{key_names, Modifier};

    /// 单测里像素与点一比一，只看事件形状。
    fn same(p: ScreenPoint) -> (f64, f64) {
        (f64::from(p.x), f64::from(p.y))
    }

    fn at(x: i32, y: i32) -> Event {
        Event::Move {
            to: ScreenPoint { x, y },
        }
    }

    fn button(button: MouseButton, down: bool) -> Event {
        Event::Button { button, down }
    }

    fn mouse(kind: u32, button: u32, x: f64, y: f64, clicks: i64) -> Cg {
        Cg::Mouse {
            kind,
            button,
            at: (x, y),
            clicks,
        }
    }

    /// 单击：移过去、按下、抬起，按下与抬起都是第 1 下，位置是移过去的那一点。
    #[test]
    fn a_click_moves_then_presses_once() {
        let mut t = Tracker::new((0.0, 0.0));
        let planned = t
            .plan(
                &[
                    at(10, 20),
                    button(MouseButton::Left, true),
                    button(MouseButton::Left, false),
                ],
                same,
            )
            .expect("换算得出");
        assert_eq!(
            planned,
            vec![
                mouse(kind::MOVED, 0, 10.0, 20.0, 0),
                mouse(kind::LEFT_DOWN, 0, 10.0, 20.0, 1),
                mouse(kind::LEFT_UP, 0, 10.0, 20.0, 1),
            ]
        );
    }

    /// 双击的第二下带点击次数 2；移到别处再按从 1 重新数。
    #[test]
    fn a_double_click_counts_its_second_press() {
        let mut t = Tracker::new((0.0, 0.0));
        let press = |t: &mut Tracker| {
            t.plan(
                &[
                    button(MouseButton::Left, true),
                    button(MouseButton::Left, false),
                ],
                same,
            )
            .expect("换算得出")
        };
        t.plan(&[at(5, 5)], same).expect("换算得出");
        let first = press(&mut t);
        let second = press(&mut t);
        assert_eq!(first[0], mouse(kind::LEFT_DOWN, 0, 5.0, 5.0, 1));
        assert_eq!(second[0], mouse(kind::LEFT_DOWN, 0, 5.0, 5.0, 2));
        assert_eq!(second[1], mouse(kind::LEFT_UP, 0, 5.0, 5.0, 2));
        t.plan(&[at(6, 5)], same).expect("换算得出");
        assert_eq!(press(&mut t)[0], mouse(kind::LEFT_DOWN, 0, 6.0, 5.0, 1));
        // 换一个键也从 1 数起。
        let right = t
            .plan(&[button(MouseButton::Right, true)], same)
            .expect("换算得出");
        assert_eq!(right[0], mouse(kind::RIGHT_DOWN, 1, 6.0, 5.0, 1));
    }

    /// 拖拽分几批派发：按住左键之后的移动是拖动事件，抬起之后恢复成普通移动。
    #[test]
    fn moves_while_a_button_is_held_are_drags_across_batches() {
        let mut t = Tracker::new((0.0, 0.0));
        t.plan(&[at(1, 1), button(MouseButton::Left, true)], same)
            .expect("换算得出");
        assert_eq!(
            t.plan(&[at(2, 2)], same).expect("换算得出"),
            vec![mouse(kind::LEFT_DRAGGED, 0, 2.0, 2.0, 0)]
        );
        assert_eq!(
            t.plan(&[button(MouseButton::Left, false)], same)
                .expect("换算得出"),
            vec![mouse(kind::LEFT_UP, 0, 2.0, 2.0, 1)]
        );
        assert_eq!(
            t.plan(&[at(3, 3)], same).expect("换算得出"),
            vec![mouse(kind::MOVED, 0, 3.0, 3.0, 0)]
        );
        t.plan(&[button(MouseButton::Middle, true)], same)
            .expect("换算得出");
        assert_eq!(
            t.plan(&[at(4, 4)], same).expect("换算得出"),
            vec![mouse(kind::OTHER_DRAGGED, 2, 4.0, 4.0, 0)]
        );
    }

    /// 组合键：每个键盘事件带此刻按住的修饰键，逆序抬起时逐个去掉。
    #[test]
    fn key_events_carry_the_modifiers_held_at_that_moment() {
        let mut t = Tracker::new((0.0, 0.0));
        let events = key_stroke("a", &["meta".to_owned(), "shift".to_owned()]);
        let flags: Vec<(u16, bool, u64)> = t
            .plan(&events, same)
            .expect("换算得出")
            .into_iter()
            .map(|e| match e {
                Cg::Key { code, down, flags } => (code, down, flags),
                other => panic!("不是按键：{other:?}"),
            })
            .collect();
        let (cmd, shift) = (0x0010_0000, 0x0002_0000);
        assert_eq!(
            flags,
            vec![
                (0x37, true, cmd),
                (0x38, true, cmd | shift),
                (0x00, true, cmd | shift),
                (0x00, false, cmd | shift),
                (0x38, false, cmd),
                (0x37, false, 0),
            ]
        );
    }

    /// 批里有换算不了的键名时整批不换，按住的修饰键也不记。
    #[test]
    fn an_unknown_key_rejects_the_whole_batch_and_leaves_the_state() {
        let mut t = Tracker::new((0.0, 0.0));
        let before = t.clone();
        let events = key_stroke("f21", &["ctrl".to_owned()]);
        assert!(t.plan(&events, same).is_none());
        assert_eq!(t, before);
    }

    /// 垂直格数原样给第一轴；水平格数取反给第二轴。
    #[test]
    fn wheel_notches_map_onto_the_cg_axes() {
        let mut t = Tracker::new((7.0, 8.0));
        let wheel = |notches, horizontal| Event::Wheel {
            notches,
            horizontal,
        };
        let planned = t
            .plan(
                &[
                    wheel(3, false),
                    wheel(-2, false),
                    wheel(2, true),
                    wheel(-1, true),
                ],
                same,
            )
            .expect("换算得出");
        assert_eq!(
            planned,
            vec![
                Cg::Scroll {
                    vertical: 3,
                    horizontal: 0,
                    at: (7.0, 8.0)
                },
                Cg::Scroll {
                    vertical: -2,
                    horizontal: 0,
                    at: (7.0, 8.0)
                },
                Cg::Scroll {
                    vertical: 0,
                    horizontal: -2,
                    at: (7.0, 8.0)
                },
                Cg::Scroll {
                    vertical: 0,
                    horizontal: 1,
                    at: (7.0, 8.0)
                },
            ]
        );
    }

    /// 移动按调用方给的换算落到点上。
    #[test]
    fn moves_are_converted_to_points() {
        let mut t = Tracker::new((0.0, 0.0));
        let half = |p: ScreenPoint| (f64::from(p.x) / 2.0, f64::from(p.y) / 2.0);
        assert_eq!(
            t.plan(&[at(301, 40)], half).expect("换算得出"),
            vec![mouse(kind::MOVED, 0, 150.5, 20.0, 0)]
        );
    }

    /// 词表里的主键除了 F21–F24 都有键码，四个修饰键都有键码与标志位：换算表必须覆盖整张词表，
    /// 缺的只能是 macOS 键盘本来就没有的键。
    #[test]
    fn every_protocol_key_has_a_key_code_except_f21_to_f24() {
        let missing: Vec<String> = key_names().filter(|k| key_code(k).is_none()).collect();
        assert_eq!(missing, ["f21", "f22", "f23", "f24"]);
        for m in [
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
            Modifier::Meta,
        ] {
            assert!(key_code(m.key_name()).is_some(), "{}", m.key_name());
            let flag = modifier_flag(m.key_name()).expect("修饰键有标志位");
            assert_eq!(flag & MODIFIER_MASK, flag);
        }
    }

    /// 重设修饰键只动四个修饰键位，建事件时系统给的小键盘与 Fn 位保留。
    #[test]
    fn flags_keep_the_bits_the_event_was_created_with() {
        let numeric_pad_and_fn = 0x0020_0000 | 0x0080_0000;
        let shift = 0x0002_0000;
        assert_eq!(
            flags_with(numeric_pad_and_fn | 0x0010_0000, shift),
            numeric_pad_and_fn | shift
        );
        assert_eq!(flags_with(0, 0), 0);
    }
}
