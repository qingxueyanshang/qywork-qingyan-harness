//! 前台原始输入里不分平台的那一部分：事件序列的构造与按下状态账。
//!
//! 六条边界：
//!
//! 1. **派发只经 `Sink` 与 `CharSink`。** 真实实现在平台后端里，单测换成记录器，
//!    测试不向系统发出任何输入。
//! 2. **按下之前先记账，释放之后再清账。** 顺序不能反：反过来的话，按下与记账之间
//!    worker 被强杀，那个键就没有人知道它按住了。多记一次的代价是宿主补发一个多余的
//!    抬起事件，应用收到没有配对按下的抬起一律忽略。
//! 3. **持有用 `Hold`，不要手写释放调用。** 中途返回与取消都会跳过那一行。
//!    release 档位是 `panic = "abort"`，`Drop` 在 panic 时不运行，所以持有期间的代码
//!    不得 panic。
//! 4. **本模块不做目标核对。** 前台窗口、包围盒与遮挡由调用方在派发之前判定，
//!    这里只把已经定好的事件交给系统。
//! 5. **平台键码由派发端换算。** 事件序列与按下状态账里只有协议键名，换成本平台键码
//!    （Windows 是虚拟键码、扩展键标志与扫描码）在平台的 `Sink` 里做。
//! 6. **文字不走键盘事件。** `Event` 里没有文字，文字由 `post_text` 按 UTF-16 码元
//!    投字符消息。不要为文字新增键盘事件：`KEYEVENTF_UNICODE` 注入时系统对
//!    U+002D、U+2010–2015、U+3000–303F、U+FF00–FFDF 只投递按下、不投递配对的抬起，
//!    自己记按键状态的应用把下一个按下当成自动重复，重复前字、吞掉后字。

use std::sync::{Mutex, OnceLock};

use crate::geometry::ScreenPoint;
use crate::protocol::{HeldInput, MouseButton, ScrollDirection};

/// 一个待派发的输入事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// 指针移到绝对坐标。坐标已经换算成满量程值，见 `geometry::to_absolute`。
    Move { dx: i32, dy: i32 },
    /// 鼠标键按下或抬起。
    Button { button: MouseButton, down: bool },
    /// 滚轮。`delta` 是一格的整数倍，负值向下或向左。
    Wheel { delta: i32, horizontal: bool },
    /// 物理按键。`key` 是协议键名：主键名或修饰键名。
    Key { key: String, down: bool },
}

/// 一次滚动的格数对应的轮值。系统按它换算成实际行数。
pub const WHEEL_DELTA: i32 = 120;

/// 把一批事件交给系统。
///
/// 返回真的进了输入队列的事件数，**它可能小于请求数**：目标进程完整性比本进程高时
/// UIPI 会把这一批挡掉。调用方按这个数判执行事实，不按调用有没有报错判。
/// 批里有本平台换算不了的键名时整批不发，返回 0。
pub trait Sink {
    fn send(&self, events: &[Event]) -> u32;
}

/// 把一批 UTF-16 码元作为字符消息投给一个窗口。
///
/// 返回真的进了目标消息队列的码元数。逐条判，**不要改成只看最后一条的返回值**：
/// UIPI 拦截是逐条生效的。
pub trait CharSink {
    fn post(&self, window: i64, units: &[u16]) -> u32;
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

/// 把文字按 UTF-16 码元切成批，**代理对不跨批**。
///
/// 一个补充平面字符占两个码元，两个码元分在两批发出去的话，目标应用先收到一个孤立的
/// 高位代理，那不是任何字符。
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

/// 一次文字投递的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivered {
    /// 真的进了目标消息队列的码元数。
    pub sent: u32,
    /// 这段文字一共有多少个码元。
    pub requested: u32,
    /// 中途停下来的原因。停下来时 `sent` 是已经投出去的那一段。
    pub interrupted: Option<String>,
}

/// 把文字逐码元投给收件窗口。
///
/// `target` 在每一批之前重新求收件窗口，返回 `Err` 即停止投递并把原因带回；
/// 前台核对与焦点归属都在它里面判。批与批之间因此至少重核一次，一批之内不重核：
/// 一个代理对的两个码元不能被中途停在中间，那不是任何字符。
pub fn post_text(
    chars: &dyn CharSink,
    text: &str,
    max_units: usize,
    target: &dyn Fn() -> Result<i64, String>,
) -> Delivered {
    let batches = text_batches(text, max_units);
    let requested = u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX);
    let mut sent = 0u32;
    let mut interrupted = None;
    for batch in &batches {
        let window = match target() {
            Ok(window) => window,
            Err(reason) => {
                interrupted = Some(reason);
                break;
            }
        };
        let got = chars.post(window, batch);
        sent += got;
        if got < u32::try_from(batch.len()).unwrap_or(u32::MAX) {
            break;
        }
    }
    Delivered {
        sent,
        requested,
        interrupted,
    }
}

/// 滚动方向与格数 → 轮值与轴。
///
/// 水平轴的正值向右、垂直轴的正值向上，与 `WM_MOUSEWHEEL` 的符号一致。
pub const fn wheel_of(direction: ScrollDirection, amount: u32) -> (i32, bool) {
    let notches = if amount == 0 { 1 } else { amount as i32 };
    match direction {
        ScrollDirection::Up => (notches * WHEEL_DELTA, false),
        ScrollDirection::Down => (-notches * WHEEL_DELTA, false),
        ScrollDirection::Right => (notches * WHEEL_DELTA, true),
        ScrollDirection::Left => (-notches * WHEEL_DELTA, true),
    }
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

    /// 单测用的文字投递记录器。它不向任何窗口投消息。
    #[derive(Default)]
    struct CharRecorder {
        posted: Mutex<Vec<(i64, Vec<u16>)>>,
        /// 每次调用只接受这么多个码元。默认全接受，用来构造 UIPI 拦截的形状。
        accept: Option<u32>,
    }

    impl CharSink for CharRecorder {
        fn post(&self, window: i64, units: &[u16]) -> u32 {
            let count = u32::try_from(units.len()).unwrap_or(u32::MAX);
            let taken = self.accept.map_or(count, |limit| limit.min(count));
            if let Ok(mut log) = self.posted.lock() {
                log.push((window, units[..taken as usize].to_vec()));
            }
            taken
        }
    }

    impl CharRecorder {
        /// 投出去的全部码元，按投递顺序接在一起。
        fn units(&self) -> Vec<u16> {
            self.posted
                .lock()
                .expect("记录器锁")
                .iter()
                .flat_map(|(_, units)| units.clone())
                .collect()
        }
        fn windows(&self) -> Vec<i64> {
            self.posted
                .lock()
                .expect("记录器锁")
                .iter()
                .map(|(window, _)| *window)
                .collect()
        }
    }

    fn to(window: i64) -> impl Fn() -> Result<i64, String> {
        move || Ok(window)
    }

    /// 文字按码元逐条投给收件窗口，顺序与原文一致，一个码元一条消息。
    #[test]
    fn text_is_delivered_one_code_unit_at_a_time_in_order() {
        let chars = CharRecorder::default();
        let out = post_text(&chars, "哦哦行，abc", 24, &to(77));
        assert_eq!(out.sent, 7);
        assert_eq!(out.requested, 7);
        assert_eq!(out.interrupted, None);
        assert_eq!(
            chars.units(),
            vec![0x54E6, 0x54E6, 0x884C, 0xFF0C, 0x0061, 0x0062, 0x0063]
        );
        assert_eq!(chars.windows(), vec![77]);
    }

    /// 代理对的两个码元在同一批里投出去，批边界不会把它们分开。
    #[test]
    fn a_surrogate_pair_is_delivered_inside_one_batch() {
        let chars = CharRecorder::default();
        let out = post_text(&chars, "👍👍", 3, &to(9));
        assert_eq!(out.sent, 4);
        assert_eq!(out.requested, 4);
        let log = chars.posted.lock().expect("记录器锁").clone();
        assert_eq!(log.len(), 2);
        for (_, units) in &log {
            assert_eq!(units.len(), 2);
            assert!((0xD800..0xDC00).contains(&units[0]));
            assert!((0xDC00..0xE000).contains(&units[1]));
        }
    }

    /// 收件窗口每一批之前重新求：焦点在批之间换到别的控件时，后面的码元跟着走。
    #[test]
    fn the_receiving_window_is_resolved_once_per_batch() {
        let chars = CharRecorder::default();
        let calls = Mutex::new(0);
        let out = post_text(&chars, "abcd", 2, &|| {
            let mut n = calls.lock().expect("计数锁");
            *n += 1;
            Ok(if *n == 1 { 11 } else { 22 })
        });
        assert_eq!(out.sent, 4);
        assert_eq!(chars.windows(), vec![11, 22]);
    }

    /// 收件窗口求不到时停下来，已经投出去的那一段如实带回，后面的不再投。
    #[test]
    fn delivery_stops_when_the_receiving_window_is_gone() {
        let chars = CharRecorder::default();
        let calls = Mutex::new(0);
        let out = post_text(&chars, "abcd", 2, &|| {
            let mut n = calls.lock().expect("计数锁");
            *n += 1;
            if *n == 1 {
                Ok(5)
            } else {
                Err("not_foreground: 3".to_owned())
            }
        });
        assert_eq!(out.sent, 2);
        assert_eq!(out.requested, 4);
        assert_eq!(out.interrupted.as_deref(), Some("not_foreground: 3"));
        assert_eq!(chars.units(), vec![0x0061, 0x0062]);
    }

    /// 消息被拦下时停在那一条，已投数小于请求数。
    #[test]
    fn a_blocked_message_stops_the_rest_of_the_text() {
        let chars = CharRecorder {
            accept: Some(1),
            ..CharRecorder::default()
        };
        let out = post_text(&chars, "abcd", 24, &to(1));
        assert_eq!(out.sent, 1);
        assert_eq!(out.requested, 4);
        assert_eq!(out.interrupted, None);
    }

    /// 空文字一条消息都不投。
    #[test]
    fn empty_text_posts_nothing() {
        let chars = CharRecorder::default();
        let out = post_text(&chars, "", 24, &to(1));
        assert_eq!(out.sent, 0);
        assert_eq!(out.requested, 0);
        assert!(chars.units().is_empty());
    }

    #[test]
    fn wheel_direction_picks_the_axis_and_the_sign() {
        assert_eq!(wheel_of(ScrollDirection::Up, 1), (120, false));
        assert_eq!(wheel_of(ScrollDirection::Down, 3), (-360, false));
        assert_eq!(wheel_of(ScrollDirection::Right, 2), (240, true));
        assert_eq!(wheel_of(ScrollDirection::Left, 1), (-120, true));
        // 0 格按 1 格算：一次不动的滚动没有意义。
        assert_eq!(wheel_of(ScrollDirection::Down, 0), (-120, false));
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
