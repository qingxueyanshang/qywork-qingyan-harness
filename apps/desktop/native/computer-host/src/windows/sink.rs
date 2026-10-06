//! 前台原始输入的实际派发端：`SendInput` 与 `WM_CHAR`。整个进程只有此处向系统发送输入。
//!
//! 文字按接收窗口选择投递方式（`text_delivery`），每个码元只使用其中一种：
//!
//! - 一般窗口投递 `WM_CHAR`。不要改为注入 `KEYEVENTF_UNICODE` 键盘事件：系统对 U+002D、
//!   U+2010–2015、U+3000–303F、U+FF00–FFDF 只投递按下、不投递配对的抬起，自行记录按键
//!   状态的应用（微信）把下一个按下视为自动重复，重复输入前一个字符并丢弃后一个字符。
//! - UWP 的 `CoreWindow` 注入 `KEYEVENTF_UNICODE`。不要改为投递 `WM_CHAR`：其中的文本框
//!   （开始菜单搜索框）只从系统输入队列读取字符，投递的字符消息既不报错也不写入文字。在这类窗口上
//!   注入上述区间的码元与连续重复字符，实测逐字一致。

use std::ffi::c_void;

use ::windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use ::windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, PostMessageW, WM_CHAR};

use super::foreground::virtual_desktop;
use super::keys::virtual_key;
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::input::{text_batches, Event, Sink};
use crate::protocol::MouseButton;

/// 滚轮滚动一格的数值。系统按该值换算为实际行数。
const WHEEL_DELTA: i32 = 120;

/// 绝对指针坐标的满量程。`SendInput` 把 0 到该值映射到虚拟桌面的宽高上。
const ABSOLUTE_SPAN: i32 = 65_535;

/// 屏幕物理像素点 → `SendInput` 的绝对指针坐标。
///
/// 三项约束，任一项出错都会使指针落在其他位置：
///
/// 1. **映射范围是虚拟桌面矩形，不是主显示器矩形**，因此事件必须带
///    `MOUSEEVENTF_VIRTUALDESK`；主显示器左侧或上方有显示器时，虚拟桌面原点为负数。
/// 2. **分母取宽高减一**：最后一个像素必须对应满量程，使用宽高本身会整体偏差一个单位。
/// 3. 结果限制在 0 与满量程之间：桌面外的点没有对应的绝对坐标。
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

/// 按键与指针的实际派发端。
pub struct SystemSink;

impl Sink for SystemSink {
    fn send(&self, events: &[Event]) -> u32 {
        if events.is_empty() {
            return 0;
        }
        // 键名无法换算时整批不发送：只发送一部分会使组合键停留在部分按下的状态。
        let Some(inputs) = events.iter().map(build).collect::<Option<Vec<INPUT>>>() else {
            return 0;
        };
        let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0);
        // SAFETY: 切片与结构体尺寸都由本函数构造，调用期间不会被改动。
        unsafe { SendInput(&inputs, size) }
    }
}

/// 实际文字投递端。投递方式由接收窗口的类名决定（`text_delivery`）。
pub struct SystemCharSink;

/// `WM_CHAR` 的 lParam：重复次数 1，扫描码 0，非扩展键。
///
/// 不要改为从虚拟键码计算出的扫描码：该消息不对应任何一次按键，构造一个扫描码
/// 会使按扫描码分派的目标收到一个不存在的键。
const CHAR_LPARAM: isize = 1;

/// UWP 应用与系统界面（开始菜单、搜索面板）承载内容的窗口类。
const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

/// 一段文字投递到接收窗口的方式。理由见文件头。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextDelivery {
    /// `PostMessageW(WM_CHAR)` 投递给接收窗口。
    CharMessage,
    /// `SendInput` 注入 `KEYEVENTF_UNICODE` 键盘事件，进入系统输入队列。
    UnicodeInput,
}

fn text_delivery(class_name: &str) -> TextDelivery {
    if class_name == CORE_WINDOW_CLASS {
        TextDelivery::UnicodeInput
    } else {
        TextDelivery::CharMessage
    }
}

fn class_of(hwnd: HWND) -> String {
    let mut name = [0u16; 256];
    // SAFETY: 只读查询，出参是本栈帧上的缓冲区。
    let written = unsafe { GetClassNameW(hwnd, &mut name) };
    String::from_utf16_lossy(&name[..written.max(0) as usize])
}

impl CharSink for SystemCharSink {
    fn post(&self, window: i64, units: &[u16]) -> u32 {
        let hwnd = HWND(window as *mut c_void);
        match text_delivery(&class_of(hwnd)) {
            TextDelivery::CharMessage => post_char_messages(hwnd, units),
            TextDelivery::UnicodeInput => send_unicode_input(units),
        }
    }
}

fn post_char_messages(hwnd: HWND, units: &[u16]) -> u32 {
    let mut sent = 0u32;
    for unit in units {
        // SAFETY: 句柄的归属已由调用方核对，消息与参数的格式固定。
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

/// 注入系统输入队列，由前台线程的焦点接收；调用方已在本批之前核对前台与焦点归属。
fn send_unicode_input(units: &[u16]) -> u32 {
    let inputs = unicode_inputs(units);
    let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0);
    // SAFETY: 切片与结构体尺寸都由本函数构造，调用期间不会被改动。
    let inserted = unsafe { SendInput(&inputs, size) };
    inserted / 2
}

/// 每个码元对应一对按下与抬起事件，按原文顺序排列。
fn unicode_inputs(units: &[u16]) -> Vec<INPUT> {
    units
        .iter()
        .flat_map(|&unit| {
            [
                keyboard(0, unit, KEYEVENTF_UNICODE),
                keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ]
        })
        .collect()
}

/// 将一批 UTF-16 码元投递给一个窗口。
///
/// 返回实际进入目标消息队列或系统输入队列的码元数。逐条判定，**不要改为只检查最后一条的
/// 返回值**：UIPI 拦截逐条生效。
pub trait CharSink {
    fn post(&self, window: i64, units: &[u16]) -> u32;
}

/// 一次文字投递的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivered {
    /// 实际进入目标消息队列的码元数。
    pub sent: u32,
    /// 该段文字的码元总数。
    pub requested: u32,
    /// 中途停止的原因。停止时 `sent` 是已投递部分的码元数。
    pub interrupted: Option<String>,
}

/// 将文字逐码元投递给接收窗口。
///
/// `target` 在每一批之前重新确定接收窗口，返回 `Err` 即停止投递并返回原因；
/// 前台核对与焦点归属都由它判定。因此每两批之间至少重新核对一次，一批之内不重新核对：
/// 代理对的两个码元之间不能停止投递，单个代理码元不构成任何字符。
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

/// 虚拟键码对应的扫描码。无法取得时返回 0：部分应用只读取虚拟键码，扫描码为 0 不会使这些应用
/// 收不到按键。
fn scan_of(vk: u16) -> u16 {
    // SAFETY: 纯查询，参数是键码常量。
    u16::try_from(unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) }).unwrap_or(0)
}

/// 一个事件对应的 `INPUT`。键名不在换算表中时返回 `None`。
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

    /// 单屏：左上角对应 0，右下角的像素对应满量程。
    #[test]
    fn absolute_coordinates_span_the_whole_desktop() {
        let desktop = rect(0, 0, 2560, 1440);
        assert_eq!(to_absolute(point(0, 0), desktop), (0, 0));
        assert_eq!(to_absolute(point(2559, 1439), desktop), (65_535, 65_535));
        assert_eq!(to_absolute(point(1280, 720), desktop), (32_780, 32_790));
    }

    /// 负原点：主显示器左上方还有一台显示器时，虚拟桌面原点为负数，换算从该原点起算。
    #[test]
    fn a_negative_desktop_origin_is_the_zero_of_the_absolute_range() {
        let desktop = rect(-1920, -200, 4480, 1640);
        assert_eq!(to_absolute(point(-1920, -200), desktop), (0, 0));
        assert_eq!(to_absolute(point(2559, 1439), desktop), (65_535, 65_535));
        // 主显示器左上角位于虚拟桌面中部偏左：1920 / 4479 与 200 / 1639 的满量程比例。
        assert_eq!(to_absolute(point(0, 0), desktop), (28_093, 7_997));
    }

    /// 桌面外的点限制在量程两端，不回绕到另一侧。
    #[test]
    fn a_point_outside_the_desktop_is_clamped_to_the_range() {
        let desktop = rect(0, 0, 2560, 1440);
        assert_eq!(to_absolute(point(-10, -10), desktop), (0, 0));
        assert_eq!(to_absolute(point(9999, 9999), desktop), (65_535, 65_535));
    }

    /// 单像素宽的桌面不会使分母变为 0。
    #[test]
    fn a_one_pixel_desktop_does_not_divide_by_zero() {
        assert_eq!(to_absolute(point(0, 0), rect(0, 0, 1, 1)), (0, 0));
    }

    /// 滚轮格数按 `WHEEL_DELTA` 换算为滚轮数值，符号与轴保持不变。
    #[test]
    fn wheel_notches_become_multiples_of_the_wheel_delta() {
        let data = |notches: i32, horizontal: bool| {
            let input = build(&Event::Wheel {
                notches,
                horizontal,
            })
            .expect("滚轮事件必定换算成功");
            // SAFETY: `build` 对滚轮事件构造的是 `mi` 成员。
            let mi = unsafe { input.Anonymous.mi };
            (mi.mouseData as i32, mi.dwFlags)
        };
        assert_eq!(data(1, false), (120, MOUSEEVENTF_WHEEL));
        assert_eq!(data(-3, false), (-360, MOUSEEVENTF_WHEEL));
        assert_eq!(data(2, true), (240, MOUSEEVENTF_HWHEEL));
        assert_eq!(data(-1, true), (-120, MOUSEEVENTF_HWHEEL));
    }

    /// 单元测试使用的文字投递记录器。它不向任何窗口投递消息。
    #[derive(Default)]
    struct CharRecorder {
        posted: Mutex<Vec<(i64, Vec<u16>)>>,
        /// 每次调用接受的码元数上限。默认全部接受，用于模拟 UIPI 拦截。
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
        /// 已投递的全部码元，按投递顺序拼接。
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

    /// 文字按码元逐条投递给接收窗口，顺序与原文一致，每个码元一条消息。
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

    /// 代理对的两个码元在同一批中投递，批边界不会将其分开。
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

    /// 每一批之前重新确定接收窗口：焦点在两批之间移到其他控件时，后续码元随之投递到该控件。
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

    /// 无法确定接收窗口时停止投递，如实返回已投递的部分，不再投递后续码元。
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

    /// 消息被拦截时在该条停止，已投递数小于请求数。
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

    /// 只有 `CoreWindow` 使用注入；其余窗口（含 UWP 的外框 `ApplicationFrameWindow`）投递字符消息。
    #[test]
    fn only_core_windows_receive_injected_text() {
        assert_eq!(
            text_delivery("Windows.UI.Core.CoreWindow"),
            TextDelivery::UnicodeInput
        );
        for class in [
            "Edit",
            "RichEditD2DPT",
            "Chrome_RenderWidgetHostHWND",
            "ApplicationFrameWindow",
        ] {
            assert_eq!(text_delivery(class), TextDelivery::CharMessage, "{class}");
        }
    }

    /// 注入的每个码元是一对 Unicode 按下与抬起事件，扫描码字段存放码元本身，虚拟键码为 0。
    #[test]
    fn injected_text_is_one_down_up_pair_per_code_unit() {
        let units: Vec<u16> = "a，👍".encode_utf16().collect();
        let events: Vec<(u16, u16, u32)> = unicode_inputs(&units)
            .iter()
            .map(|input| {
                // SAFETY: `unicode_inputs` 只构造 `ki` 成员。
                let ki = unsafe { input.Anonymous.ki };
                (ki.wVk.0, ki.wScan, ki.dwFlags.0)
            })
            .collect();
        let down = KEYEVENTF_UNICODE.0;
        let up = KEYEVENTF_UNICODE.0 | KEYEVENTF_KEYUP.0;
        let expected: Vec<(u16, u16, u32)> = units
            .iter()
            .flat_map(|&u| [(0, u, down), (0, u, up)])
            .collect();
        assert_eq!(units.len(), 4);
        assert_eq!(events, expected);
    }

    /// 空文字不投递任何消息。
    #[test]
    fn empty_text_posts_nothing() {
        let chars = CharRecorder::default();
        let out = post_text(&chars, "", 24, &to(1));
        assert_eq!(out.sent, 0);
        assert_eq!(out.requested, 0);
        assert!(chars.units().is_empty());
    }

    /// 词表中的每个键名、每个修饰键都能成功换算为虚拟键码：无法换算的键名会使整批输入不发送。
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
        // SAFETY: `build` 对按键事件构造的是 `ki` 成员。
        Some(unsafe { input.Anonymous.ki.dwFlags })
    }

    /// 扩展键标志同时附加在按下与抬起两个事件上：抬起事件缺少该标志时，对应的键会停留在按下状态。
    #[test]
    fn the_extended_flag_travels_with_both_halves_of_a_key_press() {
        for down in [true, false] {
            let flags = key_flags("up", down).expect("up 在词表中");
            assert_eq!(flags.0 & KEYEVENTF_EXTENDEDKEY.0, KEYEVENTF_EXTENDEDKEY.0);
            assert_eq!(flags.0 & KEYEVENTF_KEYUP.0 != 0, !down);
        }
        assert_eq!(key_flags("a", true).map(|f| f.0 & KEYEVENTF_EXTENDEDKEY.0), Some(0));
    }

    /// 无法换算的键名使整批不发送任何事件。
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
