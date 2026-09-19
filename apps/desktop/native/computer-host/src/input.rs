//! 前台原始输入：事件序列的构造、派发与按下状态账。
//!
//! 五条边界：
//!
//! 1. **派发只经 `Sink`。** 真实实现调 `SendInput`，单测换成记录器，测试不向系统发出
//!    任何输入。
//! 2. **按下之前先记账，释放之后再清账。** 顺序不能反：反过来的话，按下与记账之间
//!    worker 被强杀，那个键就没有人知道它按住了。多记一次的代价是宿主补发一个多余的
//!    抬起事件，应用收到没有配对按下的抬起一律忽略。
//! 3. **持有用 `Hold`，不要手写释放调用。** 中途返回与取消都会跳过那一行。
//!    release 档位是 `panic = "abort"`，`Drop` 在 panic 时不运行，所以持有期间的代码
//!    不得 panic。
//! 4. **本模块不做目标核对。** 前台窗口、包围盒与遮挡由调用方在派发之前判定，
//!    这里只把已经定好的事件交给系统。
//! 5. **扫描码由派发端补。** 虚拟键码到扫描码的映射是一次 OS 查询，放进事件序列就
//!    测不了；事件序列里只有虚拟键码与扩展键标志。

use std::sync::{Mutex, OnceLock};

use crate::geometry::ScreenPoint;
use crate::protocol::{HeldInput, HeldKey, Modifier, MouseButton, ScrollDirection};

/// 一个待派发的输入事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// 指针移到绝对坐标。坐标已经换算成满量程值，见 `geometry::to_absolute`。
    Move { dx: i32, dy: i32 },
    /// 鼠标键按下或抬起。
    Button { button: MouseButton, down: bool },
    /// 滚轮。`delta` 是一格的整数倍，负值向下或向左。
    Wheel { delta: i32, horizontal: bool },
    /// 物理按键。
    Key { vk: u16, extended: bool, down: bool },
    /// 一个 UTF-16 码元的文字注入。
    Unicode { unit: u16, down: bool },
}

/// 一次滚动的格数对应的轮值。系统按它换算成实际行数。
pub const WHEEL_DELTA: i32 = 120;

/// 把一批事件交给系统。
///
/// 返回真的进了输入队列的事件数，**它可能小于请求数**：目标进程完整性比本进程高时
/// UIPI 会把这一批挡掉。调用方按这个数判执行事实，不按调用有没有报错判。
pub trait Sink {
    fn send(&self, events: &[Event]) -> u32;
}

// ── 按下状态账 ──

#[derive(Debug, Default)]
struct Ledger {
    buttons: Vec<MouseButton>,
    keys: Vec<HeldKey>,
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

/// 登记账目变化的通报口。`main` 启动时注册一次，此后每次账目变化都发一行。
///
/// 宿主按最后一次通报在确认 worker 退出之后补发释放；没有这个通报，被强杀的 worker
/// 按住的键会留在用户的桌面上。
pub fn on_change(notify: impl Fn(HeldInput) + Send + Sync + 'static) {
    let _ = NOTIFY.set(Box::new(notify));
}

/// 此刻按住的鼠标键与虚拟键码。
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
    keys: Vec<(u16, bool)>,
    released: bool,
}

impl<'a> Hold<'a> {
    /// 记下将要按住的鼠标键与物理键，**在派发按下事件之前调用**。
    pub fn record(sink: &'a dyn Sink, buttons: Vec<MouseButton>, keys: Vec<(u16, bool)>) -> Self {
        edit(|ledger| {
            for button in &buttons {
                if !ledger.buttons.contains(button) {
                    ledger.buttons.push(*button);
                }
            }
            for (vk, extended) in &keys {
                let key = HeldKey {
                    vk: *vk,
                    extended: *extended,
                };
                if !ledger.keys.contains(&key) {
                    ledger.keys.push(key);
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
        for (vk, extended) in self.keys.iter().rev() {
            events.push(Event::Key {
                vk: *vk,
                extended: *extended,
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

fn drop_from_ledger(buttons: &[MouseButton], keys: &[(u16, bool)]) {
    let buttons = buttons.to_vec();
    let keys = keys.to_vec();
    edit(|ledger| {
        ledger.buttons.retain(|b| !buttons.contains(b));
        ledger
            .keys
            .retain(|k| !keys.iter().any(|(vk, extended)| *vk == k.vk && *extended == k.extended));
    });
}

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

// ── 事件序列 ──

/// 键名 → 虚拟键码与扩展键标志。认不出的名字返回 `None`，不猜。
///
/// 扩展键标志漏给的代价是真实的：方向键与小键盘的同名键共用虚拟键码，少了 `E0`
/// 前缀，目标应用收到的是小键盘那一个。
pub fn key_code(name: &str) -> Option<(u16, bool)> {
    let lower = name.to_ascii_lowercase();
    if let Some(letter) = single_ascii(&lower, 'a'..='z') {
        return Some((u16::from(letter.to_ascii_uppercase() as u8), false));
    }
    if let Some(digit) = single_ascii(&lower, '0'..='9') {
        return Some((u16::from(digit as u8), false));
    }
    if let Some(rest) = lower.strip_prefix('f') {
        if let Ok(index) = rest.parse::<u16>() {
            if (1..=24).contains(&index) {
                return Some((0x6F + index, false));
            }
        }
    }
    let named = match lower.as_str() {
        "enter" => (0x0D, false),
        "tab" => (0x09, false),
        "escape" => (0x1B, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" => (0x2E, true),
        "insert" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "page_up" => (0x21, true),
        "page_down" => (0x22, true),
        "up" => (0x26, true),
        "down" => (0x28, true),
        "left" => (0x25, true),
        "right" => (0x27, true),
        "semicolon" => (0xBA, false),
        "equal" => (0xBB, false),
        "comma" => (0xBC, false),
        "minus" => (0xBD, false),
        "period" => (0xBE, false),
        "slash" => (0xBF, false),
        "backquote" => (0xC0, false),
        "bracket_left" => (0xDB, false),
        "backslash" => (0xDC, false),
        "bracket_right" => (0xDD, false),
        "quote" => (0xDE, false),
        _ => return None,
    };
    Some(named)
}

fn single_ascii(text: &str, range: std::ops::RangeInclusive<char>) -> Option<char> {
    let mut chars = text.chars();
    let first = chars.next()?;
    (chars.next().is_none() && range.contains(&first)).then_some(first)
}

/// 修饰键 → 虚拟键码与扩展键标志。
pub const fn modifier_code(modifier: Modifier) -> (u16, bool) {
    match modifier {
        Modifier::Shift => (0x10, false),
        Modifier::Ctrl => (0x11, false),
        Modifier::Alt => (0x12, false),
        // 左 Win 的扫描码带 E0 前缀，少了它目标应用收不到这个键。
        Modifier::Win => (0x5B, true),
    }
}

/// 组合键的事件序列：修饰键按给出的顺序按下，主键按下抬起，修饰键**逆序**释放。
///
/// 逆序释放是硬要求：按 Ctrl、Shift 的顺序按下却按同序释放，目标应用在中间那一刻
/// 收到的是一个只按着 Shift 的状态，而很多快捷键表按修饰键组合判。
pub fn key_stroke(key: (u16, bool), modifiers: &[(u16, bool)]) -> Vec<Event> {
    let mut events = Vec::with_capacity(modifiers.len() * 2 + 2);
    for (vk, extended) in modifiers {
        events.push(Event::Key {
            vk: *vk,
            extended: *extended,
            down: true,
        });
    }
    events.push(Event::Key {
        vk: key.0,
        extended: key.1,
        down: true,
    });
    events.push(Event::Key {
        vk: key.0,
        extended: key.1,
        down: false,
    });
    for (vk, extended) in modifiers.iter().rev() {
        events.push(Event::Key {
            vk: *vk,
            extended: *extended,
            down: false,
        });
    }
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

/// 注入这个码元时系统不投递配对的抬起事件。
///
/// 实测（Windows 10 19045，2026-09-19，键盘布局 0x0804 与 0x0409 结果相同）：这几段里的
/// 字符按 `KEYEVENTF_UNICODE` 注入时，目标窗口的消息循环只收到 `WM_KEYDOWN`，
/// 配对的 `WM_KEYUP` 一条都不到；下一个字符的按下因此落在「这个键还按着」的状态上。
/// `SendInput` 对这些事件全部返回已收下，发送侧看不出差别。
///
/// 改不掉：逐字符发、逐事件发、批间隔 1 ms 与 10 ms、抬起换扫描码、一个字符发两次三次
/// 抬起、抬起改成不带 `KEYEVENTF_UNICODE` 的普通 `VK_PACKET` 键事件，实测全都照丢。
/// 关掉输入法、把线程布局换成 0x0409 也照丢，所以它不是输入法在吃事件。
///
/// **按范围判，不按实测到的单字表**：范围里的 U+2012、U+3030、U+303D、实测是不丢的，
/// 多判几个字符只是多走一次粘贴，少判一个就是把字打错。
pub const fn keyup_dropped(unit: u16) -> bool {
    matches!(
        unit,
        0x002D | 0x2010..=0x2015 | 0x3000..=0x303F | 0xFF00..=0xFFDF
    )
}

/// 这段文字要不要改走剪贴板粘贴。
///
/// 一段里只要有一个码元的抬起会被吞掉就**整段**粘贴：按字符拆成注入与粘贴两截发，
/// 两截之间光标位置由目标决定，顺序不再受控。
pub fn needs_paste(text: &str) -> bool {
    text.encode_utf16().any(keyup_dropped)
}

/// 一批 UTF-16 码元的事件序列。每个码元一对按下抬起。
pub fn unit_events(units: &[u16]) -> Vec<Event> {
    let mut events = Vec::with_capacity(units.len() * 2);
    for unit in units {
        events.push(Event::Unicode {
            unit: *unit,
            down: true,
        });
        events.push(Event::Unicode {
            unit: *unit,
            down: false,
        });
    }
    events
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

// ── 真实派发 ──

#[cfg(windows)]
mod os {
    use super::{Event, Sink};
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
        KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
        MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };

    use crate::protocol::MouseButton;

    /// 真实派发口。整个进程只有这一处调 `SendInput`。
    pub struct SystemSink;

    impl Sink for SystemSink {
        fn send(&self, events: &[Event]) -> u32 {
            if events.is_empty() {
                return 0;
            }
            let inputs: Vec<INPUT> = events.iter().map(build).collect();
            let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0);
            // SAFETY: 切片与结构体尺寸都由本函数构造，调用期间不会被改动。
            unsafe { SendInput(&inputs, size) }
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// 虚拟键码对应的扫描码。取不到时交 0：部分应用只读虚拟键码，多一个 0 不会让它们
    /// 收不到按键。
    fn scan_of(vk: u16) -> u16 {
        // SAFETY: 纯查询，参数是键码常量。
        u16::try_from(unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) }).unwrap_or(0)
    }

    fn build(event: &Event) -> INPUT {
        match *event {
            Event::Move { dx, dy } => mouse(
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                dx,
                dy,
                0,
            ),
            Event::Button { button, down } => {
                let flags = match (button, down) {
                    (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
                    (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
                    (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
                    (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
                    (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
                    (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
                };
                mouse(flags, 0, 0, 0)
            }
            Event::Wheel { delta, horizontal } => mouse(
                if horizontal {
                    MOUSEEVENTF_HWHEEL
                } else {
                    MOUSEEVENTF_WHEEL
                },
                0,
                0,
                delta,
            ),
            Event::Key { vk, extended, down } => {
                let mut flags = KEYBD_EVENT_FLAGS(0);
                if extended {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                if !down {
                    flags |= KEYEVENTF_KEYUP;
                }
                keyboard(vk, scan_of(vk), flags)
            }
            Event::Unicode { unit, down } => {
                let mut flags = KEYEVENTF_UNICODE;
                if !down {
                    flags |= KEYEVENTF_KEYUP;
                }
                // 文字注入的虚拟键码必须是 0：给了键码系统就按那个键处理，注入的字符被丢掉。
                keyboard(0, unit, flags)
            }
        }
    }
}

#[cfg(windows)]
pub use os::SystemSink;

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

    fn key(vk: u16, down: bool) -> Event {
        Event::Key {
            vk,
            extended: false,
            down,
        }
    }

    #[test]
    fn letters_digits_and_function_keys_map_to_their_virtual_key_codes() {
        assert_eq!(key_code("a"), Some((0x41, false)));
        assert_eq!(key_code("Z"), Some((0x5A, false)));
        assert_eq!(key_code("0"), Some((0x30, false)));
        assert_eq!(key_code("9"), Some((0x39, false)));
        assert_eq!(key_code("f1"), Some((0x70, false)));
        assert_eq!(key_code("f12"), Some((0x7B, false)));
        assert_eq!(key_code("f24"), Some((0x87, false)));
        assert_eq!(key_code("enter"), Some((0x0D, false)));
        assert_eq!(key_code("escape"), Some((0x1B, false)));
        // 认不出的名字不猜：没有这个键就没有这次按键。
        assert_eq!(key_code("f25"), None);
        assert_eq!(key_code("f0"), None);
        assert_eq!(key_code("any"), None);
        assert_eq!(key_code(""), None);
        assert_eq!(key_code("ctrl"), None);
    }

    /// 方向键与编辑键要带扩展键标志：少了它目标应用收到的是小键盘上的同码键。
    #[test]
    fn navigation_keys_carry_the_extended_flag() {
        for name in [
            "up", "down", "left", "right", "home", "end", "page_up", "page_down", "insert",
            "delete",
        ] {
            assert_eq!(key_code(name).map(|k| k.1), Some(true), "{name} 应当是扩展键");
        }
        for name in ["a", "enter", "tab", "space", "f5", "comma"] {
            assert_eq!(key_code(name).map(|k| k.1), Some(false), "{name} 不该是扩展键");
        }
        assert!(modifier_code(Modifier::Win).1);
        assert_eq!(modifier_code(Modifier::Ctrl), (0x11, false));
        assert_eq!(modifier_code(Modifier::Alt), (0x12, false));
        assert_eq!(modifier_code(Modifier::Shift), (0x10, false));
    }

    /// 修饰键按给出的顺序按下，逆序释放。
    #[test]
    fn a_key_stroke_releases_its_modifiers_in_reverse_order() {
        let events = key_stroke((0x41, false), &[(0x11, false), (0x10, false)]);
        assert_eq!(
            events,
            vec![
                key(0x11, true),
                key(0x10, true),
                key(0x41, true),
                key(0x41, false),
                key(0x10, false),
                key(0x11, false),
            ]
        );
        // 没有修饰键时就是一对按下抬起。
        assert_eq!(
            key_stroke((0x0D, false), &[]),
            vec![key(0x0D, true), key(0x0D, false)]
        );
    }

    /// 扩展键标志跟着每一个事件走，按下与抬起都要带。
    #[test]
    fn the_extended_flag_travels_with_both_halves_of_a_key_press() {
        let events = key_stroke((0x26, true), &[(0x5B, true)]);
        assert!(events.iter().all(|e| matches!(
            e,
            Event::Key { extended: true, .. }
        )));
        assert_eq!(events.len(), 4);
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

    #[test]
    fn each_code_unit_becomes_a_press_and_a_release() {
        assert_eq!(
            unit_events(&[0x41, 0x42]),
            vec![
                Event::Unicode {
                    unit: 0x41,
                    down: true
                },
                Event::Unicode {
                    unit: 0x41,
                    down: false
                },
                Event::Unicode {
                    unit: 0x42,
                    down: true
                },
                Event::Unicode {
                    unit: 0x42,
                    down: false
                },
            ]
        );
    }

    /// 抬起会被吞掉的那几段按范围判，段外的字符不受影响。
    #[test]
    fn the_characters_whose_key_up_never_arrives_are_matched_by_range() {
        // 实测丢抬起的：半角连字符、破折号、CJK 标点、全角与半角形。
        for unit in [0x002D, 0x2010, 0x2014, 0x3000, 0x3001, 0x300C, 0xFF0C, 0xFF01, 0xFF9F] {
            assert!(keyup_dropped(unit), "U+{unit:04X} 应当判为丢抬起");
        }
        // 实测不丢的：ASCII 字母数字与其余标点、汉字、假名、U+FFE0 之后的那一段。
        for unit in [
            0x0020, 0x002C, 0x002E, 0x0041, 0x0061, 0x4E00, 0x54E6, 0x3042, 0x30A2, 0xAC00, 0x2026,
            0xFFE0, 0xFFE5, 0xFFEF,
        ] {
            assert!(!keyup_dropped(unit), "U+{unit:04X} 不该判为丢抬起");
        }
    }

    /// 一段里有一个码元丢抬起就整段粘贴，代理对按码元判。
    #[test]
    fn text_goes_to_the_clipboard_when_any_one_unit_loses_its_key_up() {
        assert!(!needs_paste("hello world"));
        assert!(!needs_paste("张三 abc"));
        assert!(!needs_paste(""));
        assert!(needs_paste("哦哦行，那你先用这个号跑吧"));
        // 半角连字符同样丢抬起，普通英文也可能走粘贴。
        assert!(needs_paste("hello-world"));
        // 代理对的两个码元都在补充平面，不在任何一段里。
        assert!(!needs_paste("好的👍"));
        assert!(needs_paste("好的👍。"));
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
            let _hold = Hold::record(&sink, vec![MouseButton::Left], vec![(0x11, false)]);
            assert_eq!(held().buttons, vec!["left"]);
            assert_eq!(
                held().keys,
                vec![HeldKey {
                    vk: 0x11,
                    extended: false
                }]
            );
        }
        assert_eq!(
            sink.events(),
            vec![
                key(0x11, false),
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
        assert_eq!(sink.send(&key_stroke((0x41, false), &[])), 0);
        assert!(sink.events().is_empty());
    }
}
