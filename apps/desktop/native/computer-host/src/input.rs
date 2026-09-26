//! 前台原始输入里不分平台的那一部分：事件序列的构造与按下状态账。
//!
//! 六条边界：
//!
//! 1. **派发只经 `Sink`。** 真实实现在平台后端里，单测换成记录器，
//!    测试不向系统发出任何输入。
//! 2. **按下之前先记账，释放之后再清账。** 顺序不能反：反过来的话，按下与记账之间
//!    worker 被强杀，那个键就没有人知道它按住了。多记一次的代价是宿主补发一个多余的
//!    抬起事件，应用收到没有配对按下的抬起一律忽略。
//! 3. **持有用 `Hold`，不要手写释放调用。** 中途返回与取消都会跳过那一行。
//!    release 档位是 `panic = "abort"`，`Drop` 在 panic 时不运行，所以持有期间的代码
//!    不得 panic。
//! 4. **本模块不做目标核对。** 前台窗口、包围盒与遮挡由调用方在派发之前判定，
//!    这里只把已经定好的事件交给系统。
//! 5. **事件里只有平台无关的量。** 坐标是屏幕物理像素，滚轮是格数，键是协议键名；
//!    换成本平台的形状（Windows 是绝对坐标满量程、轮值与虚拟键码，X11 是根窗口坐标、
//!    滚轮按钮与当前键盘映射里的键码）在平台的 `Sink` 里做。
//! 6. **文字不经 `Event`。** 各平台的文字投递方式不同，由平台后端自己实现；按 UTF-16 码元
//!    切批（`text_batches`）是按码元投递的平台共用的一步。

use std::sync::{Mutex, OnceLock};

use crate::geometry::ScreenPoint;
use crate::protocol::{HeldInput, MouseButton, ScrollDirection};

/// 一个待派发的输入事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// 指针移到这个屏幕物理像素点。
    Move { to: ScreenPoint },
    /// 鼠标键按下或抬起。
    Button { button: MouseButton, down: bool },
    /// 滚轮。`notches` 是格数，正值向上或向右。
    Wheel { notches: i32, horizontal: bool },
    /// 物理按键。`key` 是协议键名：主键名或修饰键名。
    Key { key: String, down: bool },
}

/// 把一批事件交给系统。
///
/// 返回真的进了输入队列的事件数，**它可能小于请求数**（Windows 上目标进程完整性比本进程
/// 高时 UIPI 会把这一批挡掉）。调用方按这个数判执行事实，不按调用有没有报错判。
/// 批里有本平台换算不了的键名时整批不发，返回 0。
pub trait Sink {
    fn send(&self, events: &[Event]) -> u32;
}

// ── 按下状态账 ──

#[derive(Debug, Default)]
struct Ledger {
    buttons: Vec<MouseButton>,
    keys: Vec<String>,
}

impl Ledger {
    fn snapshot(&self) -> HeldInput {
        HeldInput {
            buttons: self.buttons.iter().map(|b| button_name(*b)).collect(),
            keys: self.keys.clone(),
        }
    }
}

static LEDGER: Mutex<Option<Ledger>> = Mutex::new(None);
type Notify = Box<dyn Fn(HeldInput) + Send + Sync>;
static NOTIFY: OnceLock<Notify> = OnceLock::new();

/// 登记账目变化的通报口。服务循环启动时注册一次，此后每次账目变化都发一行。
///
/// 宿主按最后一次通报在确认 worker 退出之后补发释放；没有这个通报，被强杀的 worker
/// 按住的键会留在用户的桌面上。
pub fn on_change(notify: impl Fn(HeldInput) + Send + Sync + 'static) {
    let _ = NOTIFY.set(Box::new(notify));
}

/// 此刻按住的鼠标键与键名。
pub fn held() -> HeldInput {
    LEDGER
        .lock()
        .map_or_else(|_| HeldInput::default(), |g| {
            g.as_ref().map_or_else(HeldInput::default, Ledger::snapshot)
        })
}

fn edit(change: impl FnOnce(&mut Ledger)) {
    let snapshot = {
        let Ok(mut guard) = LEDGER.lock() else { return };
        let ledger = guard.get_or_insert_with(Ledger::default);
        change(ledger);
        ledger.snapshot()
    };
    if let Some(notify) = NOTIFY.get() {
        notify(snapshot);
    }
}

pub const fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// 一次「按下之后必须释放」的持有。
///
/// 按下的账在构造时就记上，释放在 `release` 或 `Drop` 里做。**不要换成手写的释放
/// 调用**：取消、目标失效与提前返回都会跳过那一行，而按住不放的鼠标键会留在用户的
/// 桌面上。
pub struct Hold<'a> {
    sink: &'a dyn Sink,
    buttons: Vec<MouseButton>,
    keys: Vec<String>,
    released: bool,
}

impl<'a> Hold<'a> {
    /// 记下将要按住的鼠标键与键名，**在派发按下事件之前调用**。
    pub fn record(sink: &'a dyn Sink, buttons: Vec<MouseButton>, keys: Vec<String>) -> Self {
        edit(|ledger| {
            for button in &buttons {
                if !ledger.buttons.contains(button) {
                    ledger.buttons.push(*button);
                }
            }
            for key in &keys {
                if !ledger.keys.contains(key) {
                    ledger.keys.push(key.clone());
                }
            }
        });
        Self {
            sink,
            buttons,
            keys,
            released: false,
        }
    }

    /// 只清账，不发释放事件。
    ///
    /// **只在本次按下的键已经由别的事件抬起来时用**：组合键的整条序列自带抬起，
    /// 那时再发一遍抬起会让目标应用收到没有配对按下的第二个抬起事件。
    pub fn clear(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        drop_from_ledger(&self.buttons, &self.keys);
    }

    /// 释放本次记下的那一份并清账。重复调用是空操作。
    pub fn release(&mut self) -> u32 {
        if self.released {
            return 0;
        }
        self.released = true;
        let mut events: Vec<Event> = Vec::new();
        for key in self.keys.iter().rev() {
            events.push(Event::Key {
                key: key.clone(),
                down: false,
            });
        }
        for button in self.buttons.iter().rev() {
            events.push(Event::Button {
                button: *button,
                down: false,
            });
        }
        let sent = if events.is_empty() {
            0
        } else {
            self.sink.send(&events)
        };
        drop_from_ledger(&self.buttons, &self.keys);
        sent
    }
}

fn drop_from_ledger(buttons: &[MouseButton], keys: &[String]) {
    edit(|ledger| {
        ledger.buttons.retain(|b| !buttons.contains(b));
        ledger.keys.retain(|k| !keys.contains(k));
    });
}

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

// ── 事件序列 ──

/// 组合键的事件序列：修饰键按给出的顺序按下，主键按下抬起，修饰键**逆序**释放。
///
/// 逆序释放是硬要求：按 Ctrl、Shift 的顺序按下却按同序释放，目标应用在中间那一刻
/// 收到的是一个只按着 Shift 的状态，而很多快捷键表按修饰键组合判。
pub fn key_stroke(key: &str, modifiers: &[String]) -> Vec<Event> {
    let press = |key: &str, down: bool| Event::Key {
        key: key.to_owned(),
        down,
    };
    let mut events = Vec::with_capacity(modifiers.len() * 2 + 2);
    events.extend(modifiers.iter().map(|m| press(m, true)));
    events.push(press(key, true));
    events.push(press(key, false));
    events.extend(modifiers.iter().rev().map(|m| press(m, false)));
    events
}

/// 滚动方向与格数 → 带符号的格数与轴。
///
/// 水平轴的正值向右、垂直轴的正值向上。
pub const fn wheel_of(direction: ScrollDirection, amount: u32) -> (i32, bool) {
    let notches = if amount == 0 { 1 } else { amount as i32 };
    match direction {
        ScrollDirection::Up => (notches, false),
        ScrollDirection::Down => (-notches, false),
        ScrollDirection::Right => (notches, true),
        ScrollDirection::Left => (-notches, true),
    }
}

/// 把文字按 UTF-16 码元切成批，**代理对不跨批**。
///
/// 一个补充平面字符占两个码元，两个码元分在两批发出去的话，目标应用先收到一个孤立的
/// 高位代理，那不是任何字符。
///
/// X11 按字符借用键码，不按码元投递，Linux 不编译它。
#[cfg(any(windows, target_os = "macos", test))]
pub fn text_batches(text: &str, max_units: usize) -> Vec<Vec<u16>> {
    let limit = max_units.max(2);
    let mut out: Vec<Vec<u16>> = Vec::new();
    let mut batch: Vec<u16> = Vec::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if !batch.is_empty() && batch.len() + width > limit {
            out.push(std::mem::take(&mut batch));
        }
        let mut buf = [0u16; 2];
        batch.extend_from_slice(ch.encode_utf16(&mut buf));
    }
    if !batch.is_empty() {
        out.push(batch);
    }
    out
}

/// 拖拽途中的落点序列，**不含起点，末尾恰好是终点**。
///
/// 分段发是必要的：一次跳到终点的话，按住拖动的控件收不到中间的移动消息，
/// 很多实现据此判断拖动有没有开始。
pub fn drag_path(from: ScreenPoint, to: ScreenPoint, steps: u32) -> Vec<ScreenPoint> {
    let count = steps.max(1);
    (1..=count)
        .map(|i| {
            let ratio = f64::from(i) / f64::from(count);
            ScreenPoint {
                x: from.x + (f64::from(to.x - from.x) * ratio).round() as i32,
                y: from.y + (f64::from(to.y - from.y) * ratio).round() as i32,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 账目是进程级的，读写它的用例要排队跑：测试线程默认并行，两条用例同时改同一本账
    /// 会互相看到对方的按下记录。
    static LEDGER_TESTS: Mutex<()> = Mutex::new(());

    /// 单测用的派发记录器。它不向系统发任何输入。
    #[derive(Default)]
    struct Recorder {
        sent: Mutex<Vec<Event>>,
        /// 每次调用只接受这么多个事件。默认全接受，用来构造 UIPI 拦截的形状。
        accept: Option<u32>,
    }

    impl Sink for Recorder {
        fn send(&self, events: &[Event]) -> u32 {
            let count = u32::try_from(events.len()).unwrap_or(u32::MAX);
            let taken = self.accept.map_or(count, |limit| limit.min(count));
            if let Ok(mut log) = self.sent.lock() {
                log.extend_from_slice(&events[..taken as usize]);
            }
            taken
        }
    }

    impl Recorder {
        fn events(&self) -> Vec<Event> {
            self.sent.lock().expect("记录器锁").clone()
        }
    }

    fn key(name: &str, down: bool) -> Event {
        Event::Key {
            key: name.to_owned(),
            down,
        }
    }

    fn names(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|k| (*k).to_owned()).collect()
    }

    /// 修饰键按给出的顺序按下，逆序释放。
    #[test]
    fn a_key_stroke_releases_its_modifiers_in_reverse_order() {
        let events = key_stroke("a", &names(&["ctrl", "shift"]));
        assert_eq!(
            events,
            vec![
                key("ctrl", true),
                key("shift", true),
                key("a", true),
                key("a", false),
                key("shift", false),
                key("ctrl", false),
            ]
        );
        // 没有修饰键时就是一对按下抬起。
        assert_eq!(key_stroke("enter", &[]), vec![key("enter", true), key("enter", false)]);
    }

    #[test]
    fn wheel_direction_picks_the_axis_and_the_sign() {
        assert_eq!(wheel_of(ScrollDirection::Up, 1), (1, false));
        assert_eq!(wheel_of(ScrollDirection::Down, 3), (-3, false));
        assert_eq!(wheel_of(ScrollDirection::Right, 2), (2, true));
        assert_eq!(wheel_of(ScrollDirection::Left, 1), (-1, true));
        // 0 格按 1 格算：一次不动的滚动没有意义。
        assert_eq!(wheel_of(ScrollDirection::Down, 0), (-1, false));
    }

    /// 拖拽路径不含起点，末尾恰好是终点。
    #[test]
    fn a_drag_path_ends_exactly_on_the_target() {
        let from = ScreenPoint { x: 100, y: 200 };
        let to = ScreenPoint { x: 160, y: 200 };
        let path = drag_path(from, to, 4);
        assert_eq!(path.len(), 4);
        assert_ne!(path[0], from);
        assert_eq!(path[3], to);
        assert_eq!(path, vec![
            ScreenPoint { x: 115, y: 200 },
            ScreenPoint { x: 130, y: 200 },
            ScreenPoint { x: 145, y: 200 },
            to,
        ]);
        // 段数为 0 时仍然至少走一步，落在终点上。
        assert_eq!(drag_path(from, to, 0), vec![to]);
    }

    /// 代理对的两个码元在同一批里。分批发会让目标应用先收到一个孤立的高位代理。
    #[test]
    fn a_surrogate_pair_is_never_split_across_batches() {
        // 每个字符两个码元，上限 3 只装得下一个字符。
        let batches = text_batches("𠮷𠮷", 3);
        assert_eq!(batches.len(), 2);
        assert!(batches.iter().all(|b| b.len() == 2));
        for batch in &batches {
            assert!((0xD800..0xDC00).contains(&batch[0]));
            assert!((0xDC00..0xE000).contains(&batch[1]));
        }
        // 上限装得下时不拆。
        assert_eq!(text_batches("𠮷", 4), vec![vec![0xD842, 0xDFB7]]);
        // 上限比一个代理对还小时仍然不拆：拆出来的半个码元不是任何字符。
        assert_eq!(text_batches("𠮷", 1), vec![vec![0xD842, 0xDFB7]]);
    }

    /// 中文按码元切批，批的长度不超过上限。
    #[test]
    fn text_is_batched_by_utf16_units() {
        let batches = text_batches("张三李四王五", 4);
        assert_eq!(batches, vec![vec![0x5F20, 0x4E09, 0x674E, 0x56DB], vec![0x738B, 0x4E94]]);
        assert!(text_batches("", 4).is_empty());
    }

    /// 持有在 `Drop` 时释放，且释放事件是抬起、顺序与按下相反。
    #[test]
    fn a_hold_releases_what_it_recorded_when_it_goes_out_of_scope() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let sink = Recorder::default();
        {
            let _hold = Hold::record(&sink, vec![MouseButton::Left], names(&["ctrl", "a"]));
            assert_eq!(held().buttons, vec!["left"]);
            assert_eq!(held().keys, names(&["ctrl", "a"]));
        }
        assert_eq!(
            sink.events(),
            vec![
                key("a", false),
                key("ctrl", false),
                Event::Button {
                    button: MouseButton::Left,
                    down: false
                },
            ]
        );
        assert_eq!(held(), HeldInput::default());
    }

    /// 显式释放之后 `Drop` 不再发第二遍。
    #[test]
    fn releasing_twice_sends_the_release_once() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let sink = Recorder::default();
        {
            let mut hold = Hold::record(&sink, vec![MouseButton::Left], Vec::new());
            assert_eq!(hold.release(), 1);
            assert_eq!(hold.release(), 0);
        }
        assert_eq!(sink.events().len(), 1);
        assert_eq!(held(), HeldInput::default());
    }

    /// UIPI 把整批挡掉时记录器一个事件都不收，返回 0。
    #[test]
    fn a_blocked_batch_reports_zero_sent() {
        let sink = Recorder {
            accept: Some(0),
            ..Recorder::default()
        };
        assert_eq!(sink.send(&key_stroke("a", &[])), 0);
        assert!(sink.events().is_empty());
    }
}
