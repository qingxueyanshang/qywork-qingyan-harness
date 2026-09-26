//! 前台原始输入的真实派发口：`SendInput` 与 `WM_CHAR`。整个进程只有这里向系统发输入。
//!
//! 文字不走键盘事件：`post_text` 按 UTF-16 码元投字符消息。不要为文字新增键盘事件：
//! `KEYEVENTF_UNICODE` 注入时系统对 U+002D、U+2010–2015、U+3000–303F、U+FF00–FFDF
//! 只投递按下、不投递配对的抬起，自己记按键状态的应用把下一个按下当成自动重复，
//! 重复前字、吞掉后字。

use std::ffi::c_void;

use ::windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use ::windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CHAR};

use super::foreground::virtual_desktop;
use super::keys::virtual_key;
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::input::{Event, Sink};
use crate::protocol::MouseButton;

/// 一格滚动的轮值。系统按它换算成实际行数。
const WHEEL_DELTA: i32 = 120;

/// 绝对指针坐标的满量程。`SendInput` 把 0 到这个数铺在虚拟桌面的宽高上。
const ABSOLUTE_SPAN: i32 = 65_535;

/// 屏幕物理像素点 → `SendInput` 的绝对指针坐标。
///
/// 三条约束，换错任一条指针都会落在别处：
///
/// 1. **铺的是虚拟桌面矩形，不是主显示器矩形**，因此事件要带
///    `MOUSEEVENTF_VIRTUALDESK`；虚拟桌面原点在主显示器左侧或上方有显示器时是负数。
/// 2. **分母取宽高减一**：最后一个像素要落在满量程上，用宽高本身会整体差一格。
/// 3. 结果夹在 0 与满量程之间：桌面外的点没有对应的绝对坐标。
fn to_absolute(point: ScreenPoint, desktop: ScreenRect) -> (i32, i32) {
    let span = |value: i32, origin: i32, size: i32| -> i32 {
        let range = f64::from((size - 1).max(1));
        let scaled = (f64::from(value - origin) * f64::from(ABSOLUTE_SPAN) / range).round();
        (scaled as i32).clamp(0, ABSOLUTE_SPAN)
    };
    (
        span(point.x, desktop.x, desktop.width),
        span(point.y, desktop.y, desktop.height),
    )
}

/// 真实派发口。整个进程只有这一处调 `SendInput`。
pub struct SystemSink;

impl Sink for SystemSink {
    fn send(&self, events: &[Event]) -> u32 {
        if events.is_empty() {
            return 0;
        }
        // 键名换算不了时整批不发：发一半会让组合键停在半按下的状态。
        let Some(inputs) = events.iter().map(build).collect::<Option<Vec<INPUT>>>() else {
            return 0;
        };
        let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0);
        // SAFETY: 切片与结构体尺寸都由本函数构造，调用期间不会被改动。
        unsafe { SendInput(&inputs, size) }
    }
}

/// 真实文字投递口。整个进程只有这一处投 `WM_CHAR`。
pub struct SystemCharSink;

/// `WM_CHAR` 的 lParam：重复次数 1，扫描码 0，非扩展键。
///
/// 不要改成从虚拟键码算出来的扫描码：这一条消息不对应任何一次按键，编一个扫描码
/// 出来会让按扫描码分派的目标收到一个不存在的键。
const CHAR_LPARAM: isize = 1;

impl CharSink for SystemCharSink {
    fn post(&self, window: i64, units: &[u16]) -> u32 {
        let hwnd = HWND(window as *mut c_void);
        let mut sent = 0u32;
        for unit in units {
            // SAFETY: 句柄由调用方核对过归属，消息与参数都是常量形状。
            let ok = unsafe {
                PostMessageW(
                    Some(hwnd),
                    WM_CHAR,
                    WPARAM(*unit as usize),
                    LPARAM(CHAR_LPARAM),
                )
            }
            .is_ok();
            if !ok {
                break;
            }
            sent += 1;
        }
        sent
    }
}

/// 把一批 UTF-16 码元作为字符消息投给一个窗口。
///
/// 返回真的进了目标消息队列的码元数。逐条判，**不要改成只看最后一条的返回值**：
/// UIPI 拦截是逐条生效的。
pub trait CharSink {
    fn post(&self, window: i64, units: &[u16]) -> u32;
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

/// 一个事件对应的 `INPUT`。键名不在换算表里时返回 `None`。
fn build(event: &Event) -> Option<INPUT> {
    Some(match *event {
        Event::Move { to } => {
            let (dx, dy) = to_absolute(to, virtual_desktop());
            mouse(
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                dx,
                dy,
                0,
            )
        }
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
        Event::Wheel {
            notches,
            horizontal,
        } => mouse(
            if horizontal {
                MOUSEEVENTF_HWHEEL
            } else {
                MOUSEEVENTF_WHEEL
            },
            0,
            0,
            notches * WHEEL_DELTA,
        ),
        Event::Key { ref key, down } => {
            let (vk, extended) = virtual_key(key)?;
            let mut flags = KEYBD_EVENT_FLAGS(0);
            if extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            if !down {
                flags |= KEYEVENTF_KEYUP;
            }
            keyboard(vk, scan_of(vk), flags)
        }
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::protocol::{key_names, Modifier};

    fn rect(x: i32, y: i32, width: i32, height: i32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn point(x: i32, y: i32) -> ScreenPoint {
        ScreenPoint { x, y }
    }

    /// 单屏：左上角落在 0，右下角那个像素落在满量程上。
    #[test]
    fn absolute_coordinates_span_the_whole_desktop() {
        let desktop = rect(0, 0, 2560, 1440);
        assert_eq!(to_absolute(point(0, 0), desktop), (0, 0));
        assert_eq!(to_absolute(point(2559, 1439), desktop), (65_535, 65_535));
        assert_eq!(to_absolute(point(1280, 720), desktop), (32_780, 32_790));
    }

    /// 负原点：主显示器左上方还有一台时，虚拟桌面原点是负的，换算要从那里起算。
    #[test]
    fn a_negative_desktop_origin_is_the_zero_of_the_absolute_range() {
        let desktop = rect(-1920, -200, 4480, 1640);
        assert_eq!(to_absolute(point(-1920, -200), desktop), (0, 0));
        assert_eq!(to_absolute(point(2559, 1439), desktop), (65_535, 65_535));
        // 主显示器左上角落在虚拟桌面中间偏左：1920 / 4479 与 200 / 1639 的满量程比例。
        assert_eq!(to_absolute(point(0, 0), desktop), (28_093, 7_997));
    }

    /// 桌面外的点夹在量程两端，不绕回另一侧。
    #[test]
    fn a_point_outside_the_desktop_is_clamped_to_the_range() {
        let desktop = rect(0, 0, 2560, 1440);
        assert_eq!(to_absolute(point(-10, -10), desktop), (0, 0));
        assert_eq!(to_absolute(point(9999, 9999), desktop), (65_535, 65_535));
    }

    /// 单像素宽的桌面不会让分母变成 0。
    #[test]
    fn a_one_pixel_desktop_does_not_divide_by_zero() {
        assert_eq!(to_absolute(point(0, 0), rect(0, 0, 1, 1)), (0, 0));
    }

    /// 滚轮格数按 `WHEEL_DELTA` 换成轮值，符号与轴原样带过去。
    #[test]
    fn wheel_notches_become_multiples_of_the_wheel_delta() {
        let data = |notches: i32, horizontal: bool| {
            let input = build(&Event::Wheel {
                notches,
                horizontal,
            })
            .expect("滚轮事件一定换算得出");
            // SAFETY: `build` 对滚轮事件构造的是 `mi` 这一支。
            let mi = unsafe { input.Anonymous.mi };
            (mi.mouseData as i32, mi.dwFlags)
        };
        assert_eq!(data(1, false), (120, MOUSEEVENTF_WHEEL));
        assert_eq!(data(-3, false), (-360, MOUSEEVENTF_WHEEL));
        assert_eq!(data(2, true), (240, MOUSEEVENTF_HWHEEL));
        assert_eq!(data(-1, true), (-120, MOUSEEVENTF_HWHEEL));
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

    /// 词表里的每个键名、每个修饰键都换算得出虚拟键码：换算不了的键名会让整批输入不发。
    #[test]
    fn every_protocol_key_has_a_virtual_key() {
        let modifiers = [Modifier::Ctrl, Modifier::Alt, Modifier::Shift, Modifier::Meta];
        for name in key_names().chain(modifiers.map(|m| m.key_name().to_owned())) {
            assert!(virtual_key(&name).is_some(), "{name} 没有虚拟键码");
        }
    }

    fn key_flags(key: &str, down: bool) -> Option<KEYBD_EVENT_FLAGS> {
        let input = build(&Event::Key {
            key: key.to_owned(),
            down,
        })?;
        // SAFETY: `build` 对按键事件构造的是 `ki` 这一支。
        Some(unsafe { input.Anonymous.ki.dwFlags })
    }

    /// 扩展键标志跟着按下与抬起两个事件走：抬起少了它，按下的那个键停在按下状态。
    #[test]
    fn the_extended_flag_travels_with_both_halves_of_a_key_press() {
        for down in [true, false] {
            let flags = key_flags("up", down).expect("up 在词表里");
            assert_eq!(flags.0 & KEYEVENTF_EXTENDEDKEY.0, KEYEVENTF_EXTENDEDKEY.0);
            assert_eq!(flags.0 & KEYEVENTF_KEYUP.0 != 0, !down);
        }
        assert_eq!(key_flags("a", true).map(|f| f.0 & KEYEVENTF_EXTENDEDKEY.0), Some(0));
    }

    /// 换算不了的键名让整批一个事件都不发。
    #[test]
    fn a_batch_with_an_unknown_key_sends_nothing() {
        let events = [
            Event::Key {
                key: "ctrl".to_owned(),
                down: true,
            },
            Event::Key {
                key: "win".to_owned(),
                down: true,
            },
        ];
        assert!(key_flags("win", true).is_none());
        assert_eq!(SystemSink.send(&events), 0);
    }
}
