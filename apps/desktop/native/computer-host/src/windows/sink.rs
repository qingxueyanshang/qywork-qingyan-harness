//! 指针、按键与文字的实际派发端：窗口消息与 `SendInput`。整个进程只有此处向其他窗口发送输入。
//!
//! 投递方式按目标窗口选择（`delivery`），同一个窗口的指针、按键与文字只使用其中一种：
//!
//! - 一般窗口：同步发送窗口消息给接收窗口（`MessageSink`、`MessageCharSink`）。消息不经过系统
//!   输入队列，目标窗口不需要位于前台，用户的指针位置与键盘焦点不变。
//! - 承载 UWP 或 XAML 内容的窗口：`SendInput` 进入系统输入队列（`SystemSink`、`SystemCharSink`），
//!   要求目标窗口位于前台。这类窗口只从系统输入队列读取输入，窗口消息既不报错也不生效
//!   （开始菜单搜索框与 Windows Terminal 实测如此）。
//!
//! 窗口消息的三项约束：
//!
//! 1. **一律同步发送（`SendMessageTimeoutW`），不要改为 `PostMessageW`。** 投递的按键由目标线程的
//!    `TranslateMessage` 生成字符，该字符排在之后投递的消息后面，「输入文字后按 Enter」的顺序会
//!    颠倒。同步发送返回时目标已处理完该消息，前后两次动作的顺序因此确定。
//! 2. **发送带修饰键的按键期间，目标线程的键盘状态必须显示修饰键已按下**（`with_key_state`）。
//!    目标按 `GetKeyState` 读取修饰键，修饰键的按键消息不改变该状态，只发送消息时 ctrl+a 被当作
//!    a 处理。
//! 3. **一般窗口的文字不要改为注入 `KEYEVENTF_UNICODE`**：系统对 U+002D、U+2010–2015、
//!    U+3000–303F、U+FF00–FFDF 只投递按下、不投递配对的抬起，自行记录按键状态的应用（微信）把
//!    下一个按下视为自动重复，重复输入前一个字符并丢弃后一个字符。系统输入窗口只能注入，
//!    在这类窗口上注入上述区间的码元与连续重复字符，实测逐字一致。

use std::cell::RefCell;
use std::ffi::c_void;
use std::time::{Duration, Instant};

use ::windows::core::BOOL;
use ::windows::Win32::Foundation::{
    GetLastError, ERROR_TIMEOUT, HWND, LPARAM, POINT, TRUE, WPARAM,
};
use ::windows::Win32::Graphics::Gdi::ScreenToClient;
use ::windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, GetKeyboardLayout, GetKeyboardState, MapVirtualKeyW, SendInput,
    SetKeyboardState, ToUnicodeEx, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, EnumChildWindows, GetAncestor, GetClassLongW, GetClassNameW,
    GetGUIThreadInfo, GetSystemMetrics, GetWindow, GetWindowThreadProcessId, IsGUIThread,
    SendMessageTimeoutW, CS_DBLCLKS, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT,
    GA_ROOT, GCL_STYLE, GUITHREADINFO, GW_OWNER, SMTO_ABORTIFHUNG, SMTO_ERRORONEXIT,
    SM_CXDOUBLECLK, SM_CYDOUBLECLK, WM_CHAR, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSCHAR,
    WM_SYSKEYDOWN, WM_SYSKEYUP, WindowFromPoint,
};

use super::foreground::virtual_desktop;
use super::keys::virtual_key;
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::input::{text_batches, Event, Sink};
use crate::protocol::MouseButton;

// ── 投递方式 ──

/// 一个窗口接受输入的方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// 同步发送窗口消息，不需要前台。
    Messages,
    /// `SendInput` 进入系统输入队列，要求目标窗口位于前台。
    SystemInput,
}

/// UWP 应用与系统界面（开始菜单、搜索面板）承载内容的窗口类。
const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";
/// XAML 内容（Windows Terminal、XAML Islands）接收输入的窗口类。
const INPUT_SITE_CLASS: &str = "Windows.UI.Input.InputSite.WindowClass";

/// 按顶层窗口及其全部子窗口的类名选择投递方式。
///
/// 按整个窗口判定，不按落点判定：Windows Terminal 不在前台时其线程没有焦点窗口，键盘的接收窗口
/// 无法确定；同一窗口的指针与键盘分别使用两种方式时，前台要求只对其中一种成立。
fn delivery_of<'a>(classes: impl IntoIterator<Item = &'a str>) -> Delivery {
    if classes
        .into_iter()
        .any(|class| class == CORE_WINDOW_CLASS || class == INPUT_SITE_CLASS)
    {
        Delivery::SystemInput
    } else {
        Delivery::Messages
    }
}

/// 目标窗口的投递方式。只读取窗口类名，不经过 UIA。
pub fn delivery(window: i64) -> Delivery {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let classes = &mut *(lparam.0 as *mut Vec<String>);
        classes.push(class_of(hwnd));
        TRUE
    }
    let hwnd = HWND(window as *mut c_void);
    let mut classes = vec![class_of(hwnd)];
    // SAFETY: 回调只在本次调用期间运行，lparam 指向本栈帧上的 classes。
    let _ = unsafe {
        EnumChildWindows(
            Some(hwnd),
            Some(collect),
            LPARAM(std::ptr::addr_of_mut!(classes) as isize),
        )
    };
    delivery_of(classes.iter().map(String::as_str))
}

fn class_of(hwnd: HWND) -> String {
    let mut name = [0u16; 256];
    // SAFETY: 只读查询，出参是本栈帧上的缓冲区。
    let written = unsafe { GetClassNameW(hwnd, &mut name) };
    String::from_utf16_lossy(&name[..written.max(0) as usize])
}

/// 窗口位于 `top` 之内，或位于 `top` 拥有的弹出窗口（下拉框、菜单、对话框）之内。
pub fn belongs_to(hwnd: HWND, top: HWND) -> bool {
    // SAFETY: 只读查询，句柄失效时返回空句柄，与 `top` 不相等。
    let mut root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    for _ in 0..MAX_OWNER_DEPTH {
        if root == top {
            return true;
        }
        // SAFETY: 同上；没有所有者时返回错误。
        match unsafe { GetWindow(root, GW_OWNER) } {
            Ok(owner) if !owner.is_invalid() => root = owner,
            _ => return false,
        }
    }
    false
}

/// 所有者链的查找上限。所有者链不会成环，该上限只防止读取期间窗口被销毁、句柄被复用。
const MAX_OWNER_DEPTH: usize = 16;

/// `top` 所属线程的焦点窗口，限于 `top` 及其拥有的弹出窗口之内；没有时为 `None`。
///
/// 读取的是目标线程自身的焦点，不是系统前台线程的焦点：目标窗口不在前台时，其线程仍保留
/// 最后一次的焦点窗口。
pub fn thread_focus(top: HWND) -> Option<HWND> {
    // SAFETY: 只读查询，不需要进程号出参。
    let thread = unsafe { GetWindowThreadProcessId(top, None) };
    let mut info = GUITHREADINFO {
        cbSize: u32::try_from(std::mem::size_of::<GUITHREADINFO>()).unwrap_or(0),
        ..GUITHREADINFO::default()
    };
    // SAFETY: 出参是本栈帧上的结构体。
    if thread == 0 || unsafe { GetGUIThreadInfo(thread, &mut info) }.is_err() {
        return None;
    }
    let focus = info.hwndFocus;
    (!focus.is_invalid() && belongs_to(focus, top)).then_some(focus)
}

/// 按键的接收窗口：`top` 所属线程的焦点窗口（`thread_focus`），没有时为 `top`：自绘界面没有
/// 焦点子窗口，由顶层窗口自身接收按键。
pub fn focus_of(top: HWND) -> HWND {
    thread_focus(top).unwrap_or(top)
}

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

/// 系统输入窗口的文字投递端：注入 `KEYEVENTF_UNICODE` 键盘事件，由前台线程的焦点接收。
/// 调用方已在本批之前核对前台与焦点归属。
pub struct SystemCharSink;

impl CharSink for SystemCharSink {
    fn post(&self, _window: i64, units: &[u16]) -> u32 {
        let inputs = unicode_inputs(units);
        let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0);
        // SAFETY: 切片与结构体尺寸都由本函数构造，调用期间不会被改动。
        let inserted = unsafe { SendInput(&inputs, size) };
        inserted / 2
    }
}

// ── 窗口消息 ──

/// 单条消息的发送上界。
///
/// 目标在处理函数中打开菜单或对话框时，该消息要等菜单或对话框关闭才返回。到达上界即视为已送达、
/// 仍在处理，不再发送后续事件。
const MESSAGE_TIMEOUT_MS: u32 = 1_000;

/// 一条消息的发送结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sent {
    /// 目标已处理完该消息。
    Done,
    /// 已送达，到达上界时目标仍在处理。
    Pending,
    /// 未送达：窗口已销毁，或被 UIPI 拒绝（目标进程完整性高于本进程）。
    Refused,
}

/// 同步发送一条消息。
///
/// 无响应的窗口在 `SMTO_ABORTIFHUNG` 下同样以超时返回，与「仍在处理」无法区分，因此调用方必须在
/// 发送之前排除无响应的窗口（`foreground::message_target`）。
fn send_message(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> Sent {
    // SAFETY: 参数按值传递，不含指针；不读取返回值。
    let replied = unsafe {
        SendMessageTimeoutW(
            hwnd,
            msg,
            WPARAM(wparam),
            LPARAM(lparam),
            SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
            MESSAGE_TIMEOUT_MS,
            None,
        )
    };
    if replied.0 != 0 {
        return Sent::Done;
    }
    // SAFETY: 读取本线程上一次调用的错误码。
    if unsafe { GetLastError() } == ERROR_TIMEOUT {
        Sent::Pending
    } else {
        Sent::Refused
    }
}

/// 按发送结果累计已送达的事件数。`Pending` 计入已送达并停止：目标仍在处理时继续发送，
/// 后续事件会在它打开的菜单或对话框中被处理。
fn tally(results: impl IntoIterator<Item = Sent>) -> u32 {
    let mut sent = 0u32;
    for result in results {
        match result {
            Sent::Done => sent += 1,
            Sent::Pending => return sent + 1,
            Sent::Refused => return sent,
        }
    }
    sent
}

/// 一般窗口的文字投递端：逐个码元同步发送 `WM_CHAR`。
pub struct MessageCharSink;

/// `WM_CHAR` 的 lParam：重复次数 1，扫描码 0，非扩展键。
///
/// 不要改为从虚拟键码计算出的扫描码：该消息不对应任何一次按键，构造一个扫描码
/// 会使按扫描码分派的目标收到一个不存在的键。
const CHAR_LPARAM: isize = 1;

impl CharSink for MessageCharSink {
    fn post(&self, window: i64, units: &[u16]) -> u32 {
        let hwnd = HWND(window as *mut c_void);
        // `map` 是惰性的：`tally` 停止时不再发送后续码元。
        tally(
            units
                .iter()
                .map(|unit| send_message(hwnd, WM_CHAR, usize::from(*unit), CHAR_LPARAM)),
        )
    }
}

/// `wParam` 中的鼠标键标志。
const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;
const MK_MBUTTON: usize = 0x0010;

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_F10: u16 = 0x79;
const VK_LWIN: u16 = 0x5B;

/// 子窗口的查找层数上限。窗口层级不会成环，该上限只防止读取期间句柄被复用。
const MAX_CHILD_DEPTH: usize = 32;

/// 指针移动之后到按下之前的停顿。
///
/// 同步发送的移动、按下与抬起之间没有间隔，而系统输入经过输入队列时有。模拟触摸的界面（微信开发者
/// 工具的模拟器）按事件时间识别点击：实测移动后停顿 50 ms 再按下、按住 80 ms 再抬起时识别为点击，
/// 只按住而移动后不停顿时不识别。
const PRESS_DELAY: Duration = Duration::from_millis(50);
/// 按下到抬起的最短间隔，来源同 `PRESS_DELAY`。拖拽的分段移动已超过该时长，不再额外等待。
const HOLD_TIME: Duration = Duration::from_millis(80);

/// 一次鼠标键按下，用于把第二次按下换算为双击消息。
#[derive(Debug, Clone, Copy)]
struct Down {
    button: MouseButton,
    at: ScreenPoint,
    when: Instant,
}

/// 指针与按键的窗口消息投递端。一次动作构造一个，按下状态只在本次动作内有效。
///
/// 指针消息发给 `top` 中位于落点的最深一层子窗口，坐标换算为该窗口的客户区坐标；按键发给
/// `top` 所属线程的焦点窗口（`focus_of`）。鼠标键按下之后到全部抬起之前，指针消息一律发给按下时的
/// 接收窗口，与系统的鼠标捕获一致：拖出控件范围时控件仍需收到移动与抬起。
pub struct MessageSink {
    top: HWND,
    state: RefCell<Pressed>,
}

#[derive(Debug, Default)]
struct Pressed {
    /// 最近一次指针移动的落点。
    at: Option<ScreenPoint>,
    buttons: Vec<MouseButton>,
    /// 鼠标键按下期间的接收窗口。
    capture: Option<HWND>,
    /// 按住的虚拟键码。
    keys: Vec<u16>,
    last_down: Option<Down>,
    /// 最近一次指针移动的时刻，按下之前据此停顿（`PRESS_DELAY`）。
    moved_at: Option<Instant>,
    /// 最近一次按下的时刻，抬起之前据此等待（`HOLD_TIME`）。不用 `last_down`：双击之后它被清空。
    pressed_at: Option<Instant>,
}

/// 等待到 `since + gap`。`since` 缺失或已过该时刻时立即返回。
fn wait_after(since: Option<Instant>, gap: Duration) {
    if let Some(remaining) = since.and_then(|t| (t + gap).checked_duration_since(Instant::now())) {
        std::thread::sleep(remaining);
    }
}

impl MessageSink {
    /// `top` 是接收指针与按键的顶层窗口：目标窗口，或按控件定位时控件所在的、目标窗口拥有的弹出窗口。
    pub fn new(top: i64) -> Self {
        Self {
            top: HWND(top as *mut c_void),
            state: RefCell::new(Pressed::default()),
        }
    }

    fn deliver(&self, event: &Event) -> Sent {
        match event {
            Event::Move { to } => self.pointer_move(*to),
            Event::Button { button, down } => self.button(*button, *down),
            Event::Wheel {
                notches,
                horizontal,
            } => self.wheel(*notches, *horizontal),
            Event::Key { key, down } => self.key(key, *down),
        }
    }

    fn pointer_move(&self, to: ScreenPoint) -> Sent {
        let (receiver, flags) = {
            let mut state = self.state.borrow_mut();
            state.at = Some(to);
            let receiver = state.capture.unwrap_or_else(|| child_at(self.top, to));
            (receiver, button_flags(&state.buttons))
        };
        let sent = send_message(receiver, WM_MOUSEMOVE, flags, client_lparam(receiver, to));
        self.state.borrow_mut().moved_at = Some(Instant::now());
        sent
    }

    fn button(&self, button: MouseButton, down: bool) -> Sent {
        {
            let state = self.state.borrow();
            if down {
                wait_after(state.moved_at, PRESS_DELAY);
            } else {
                wait_after(state.pressed_at, HOLD_TIME);
            }
        }
        let (receiver, msg, flags, at) = {
            let mut state = self.state.borrow_mut();
            let Some(at) = state.at else {
                return Sent::Refused;
            };
            let receiver = state.capture.unwrap_or_else(|| child_at(self.top, at));
            let msg = if down {
                let now = Instant::now();
                let double = accepts_double_clicks(receiver)
                    && is_double(state.last_down, button, at, now, double_click_limit());
                // 双击之后的下一次按下重新计为单击，与系统一致。
                state.last_down = (!double).then_some(Down {
                    button,
                    at,
                    when: now,
                });
                state.pressed_at = Some(now);
                if !state.buttons.contains(&button) {
                    state.buttons.push(button);
                }
                state.capture = Some(receiver);
                button_message(button, true, double)
            } else {
                state.buttons.retain(|b| *b != button);
                if state.buttons.is_empty() {
                    state.capture = None;
                }
                button_message(button, false, false)
            };
            (receiver, msg, button_flags(&state.buttons), at)
        };
        send_message(receiver, msg, flags, client_lparam(receiver, at))
    }

    fn wheel(&self, notches: i32, horizontal: bool) -> Sent {
        let (receiver, flags, at) = {
            let state = self.state.borrow();
            let Some(at) = state.at else {
                return Sent::Refused;
            };
            let receiver = state.capture.unwrap_or_else(|| child_at(self.top, at));
            (receiver, button_flags(&state.buttons), at)
        };
        let msg = if horizontal {
            WM_MOUSEHWHEEL
        } else {
            WM_MOUSEWHEEL
        };
        // 滚轮消息的坐标是屏幕坐标，不是客户区坐标。
        send_message(
            receiver,
            msg,
            wheel_wparam(notches * WHEEL_DELTA, flags),
            point_lparam(at.x, at.y),
        )
    }

    fn key(&self, name: &str, down: bool) -> Sent {
        let Some((vk, extended)) = virtual_key(name) else {
            return Sent::Refused;
        };
        // 按下时该键计入按住的键，抬起时先移除：目标处理抬起消息时读取到的是已抬起的状态。
        let held = {
            let mut state = self.state.borrow_mut();
            if down {
                if !state.keys.contains(&vk) {
                    state.keys.push(vk);
                }
            } else {
                state.keys.retain(|k| *k != vk);
            }
            state.keys.clone()
        };
        let receiver = focus_of(self.top);
        let msg = key_message(vk, &held, down);
        let scan = scan_of(vk);
        let lparam = key_lparam(scan, extended, held.contains(&VK_MENU), down);
        let chars_msg = if msg == WM_SYSKEYDOWN {
            WM_SYSCHAR
        } else {
            WM_CHAR
        };
        let send = |state: &[u8; 256]| -> Sent {
            let first = send_message(receiver, msg, usize::from(vk), lparam);
            if !down || first != Sent::Done {
                return first;
            }
            // 字符消息与目标的 `TranslateMessage` 生成的一致：同一个键、同一组修饰键得到同样的字符。
            for unit in chars_of(vk, scan, state, receiver) {
                if send_message(receiver, chars_msg, usize::from(unit), lparam) != Sent::Done {
                    // 按下消息已送达而字符未全部处理完：按已送达、结果未定计。
                    return Sent::Pending;
                }
            }
            Sent::Done
        };
        if held.iter().any(|k| is_modifier(*k)) {
            with_key_state(receiver, &held, send).unwrap_or(Sent::Refused)
        } else {
            // 不带修饰键时不挂接：目标读取到的键盘状态与真实按键只差本键自身的按下位，
            // 应用不依据它处理单键。
            send(&pressed_state(&[0u8; 256], &held))
        }
    }
}

impl Sink for MessageSink {
    fn send(&self, events: &[Event]) -> u32 {
        // 键名无法换算时整批不发送：只发送一部分会使组合键停留在部分按下的状态。
        if events
            .iter()
            .any(|e| matches!(e, Event::Key { key, .. } if virtual_key(key).is_none()))
        {
            return 0;
        }
        tally(events.iter().map(|event| self.deliver(event)))
    }
}

/// Chromium 内核的窗口类前缀。Chrome、Edge、Electron、NW.js 的顶层窗口与内嵌的 Chromium 子窗口都使用它。
const CHROMIUM_CLASS_PREFIX: &str = "Chrome_WidgetWin_";

/// 滚轮消息能否使落点所在的控件滚动。`top` 是接收指针的顶层窗口。
///
/// Chromium 内核收到滚轮消息后按屏幕坐标重新查找窗口：该位置在屏幕上被其他应用的窗口覆盖时丢弃消息，
/// 被同一进程的另一个窗口覆盖时转交给那个窗口。两种情形下目标都不滚动，而消息本身已送达，回执只能
/// 记为已提交，因此在派发前判定。其他界面库按消息自身处理滚轮，覆盖不影响（剪映实测）。
pub fn wheel_reaches(top: i64, at: ScreenPoint) -> bool {
    let top = HWND(top as *mut c_void);
    if !class_of(child_at(top, at)).starts_with(CHROMIUM_CLASS_PREFIX) {
        return true;
    }
    // SAFETY: 纯查询，参数是屏幕坐标。
    let hit = unsafe { WindowFromPoint(POINT { x: at.x, y: at.y }) };
    !hit.is_invalid() && belongs_to(hit, top)
}

/// `top` 中位于屏幕点的最深一层可见、可用、不透明的子窗口；点不在任何子窗口内时为 `top` 本身。
///
/// 与系统按落点选择接收窗口的规则一致，但只在 `top` 之内查找：覆盖在其上方的其他应用窗口不参与。
fn child_at(top: HWND, at: ScreenPoint) -> HWND {
    let mut current = top;
    for _ in 0..MAX_CHILD_DEPTH {
        let client = to_client(current, at);
        // SAFETY: 只读查询，坐标为 `current` 的客户区坐标。
        let child = unsafe {
            ChildWindowFromPointEx(
                current,
                client,
                CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
            )
        };
        if child.is_invalid() || child == current {
            break;
        }
        current = child;
    }
    current
}

fn to_client(hwnd: HWND, at: ScreenPoint) -> POINT {
    let mut point = POINT { x: at.x, y: at.y };
    // SAFETY: 出参是本栈帧上的结构体。
    let _ = unsafe { ScreenToClient(hwnd, &mut point) };
    point
}

fn client_lparam(hwnd: HWND, at: ScreenPoint) -> isize {
    let point = to_client(hwnd, at);
    point_lparam(point.x, point.y)
}

/// 坐标打包为鼠标消息的 lParam：低 16 位 x、高 16 位 y，均按有符号数截取。
/// 拖出窗口左侧或上方时客户区坐标为负数，接收方按有符号数解出。
fn point_lparam(x: i32, y: i32) -> isize {
    ((u32::from(y as u16) << 16) | u32::from(x as u16)) as i32 as isize
}

/// 滚轮消息的 wParam：高 16 位是带符号的滚动量，低 16 位是鼠标键标志。
fn wheel_wparam(delta: i32, flags: usize) -> usize {
    (usize::from(delta as i16 as u16) << 16) | (flags & 0xFFFF)
}

fn button_flags(buttons: &[MouseButton]) -> usize {
    buttons.iter().fold(0, |flags, button| {
        flags
            | match button {
                MouseButton::Left => MK_LBUTTON,
                MouseButton::Right => MK_RBUTTON,
                MouseButton::Middle => MK_MBUTTON,
            }
    })
}

fn button_message(button: MouseButton, down: bool, double: bool) -> u32 {
    match (button, down, double) {
        (MouseButton::Left, true, false) => WM_LBUTTONDOWN,
        (MouseButton::Left, true, true) => WM_LBUTTONDBLCLK,
        (MouseButton::Left, false, _) => WM_LBUTTONUP,
        (MouseButton::Right, true, false) => WM_RBUTTONDOWN,
        (MouseButton::Right, true, true) => WM_RBUTTONDBLCLK,
        (MouseButton::Right, false, _) => WM_RBUTTONUP,
        (MouseButton::Middle, true, false) => WM_MBUTTONDOWN,
        (MouseButton::Middle, true, true) => WM_MBUTTONDBLCLK,
        (MouseButton::Middle, false, _) => WM_MBUTTONUP,
    }
}

/// 双击判定的时间与位移上限，取自系统设置。位移上限是双击矩形宽高的一半。
#[derive(Debug, Clone, Copy)]
struct DoubleClick {
    time: Duration,
    dx: i32,
    dy: i32,
}

fn double_click_limit() -> DoubleClick {
    // SAFETY: 三项都是无参只读查询。
    unsafe {
        DoubleClick {
            time: Duration::from_millis(u64::from(GetDoubleClickTime())),
            dx: GetSystemMetrics(SM_CXDOUBLECLK) / 2,
            dy: GetSystemMetrics(SM_CYDOUBLECLK) / 2,
        }
    }
}

/// 系统把第二次按下换算为双击消息的条件：同一个键、间隔不超过双击时间、位移不超过双击矩形。
/// 接收窗口的类是否声明 `CS_DBLCLKS` 由调用方另行判定。
fn is_double(
    prev: Option<Down>,
    button: MouseButton,
    at: ScreenPoint,
    now: Instant,
    limit: DoubleClick,
) -> bool {
    prev.is_some_and(|prev| {
        prev.button == button
            && now.saturating_duration_since(prev.when) <= limit.time
            && (at.x - prev.at.x).abs() <= limit.dx
            && (at.y - prev.at.y).abs() <= limit.dy
    })
}

/// 窗口类声明了 `CS_DBLCLKS`。未声明时系统不发双击消息，第二次按下仍是按下消息。
fn accepts_double_clicks(hwnd: HWND) -> bool {
    // SAFETY: 只读查询。
    let style = unsafe { GetClassLongW(hwnd, GCL_STYLE) };
    style & CS_DBLCLKS.0 != 0
}

const fn is_modifier(vk: u16) -> bool {
    matches!(vk, VK_SHIFT | VK_CONTROL | VK_MENU | VK_LWIN)
}

/// 系统选择按键消息的规则：Alt 按住且 Ctrl 未按住时、以及 F10，为 `WM_SYSKEY*`；Ctrl+Alt 是
/// AltGr 组合，仍为 `WM_KEY*`。`held` 已包含按下中的本键，不含抬起中的本键。
fn key_message(vk: u16, held: &[u16], down: bool) -> u32 {
    let alt = vk == VK_MENU || held.contains(&VK_MENU);
    let ctrl = held.contains(&VK_CONTROL);
    let system = (alt && !ctrl) || vk == VK_F10;
    match (system, down) {
        (true, true) => WM_SYSKEYDOWN,
        (true, false) => WM_SYSKEYUP,
        (false, true) => WM_KEYDOWN,
        (false, false) => WM_KEYUP,
    }
}

/// 按键消息的 lParam：重复次数 1、扫描码与扩展键标志；Alt 按住时置上下文位；抬起时置
/// 「之前已按下」与「正在抬起」两位。
fn key_lparam(scan: u16, extended: bool, alt: bool, down: bool) -> isize {
    let mut value: u32 = 1 | (u32::from(scan) << 16);
    if extended {
        value |= 1 << 24;
    }
    if alt {
        value |= 1 << 29;
    }
    if !down {
        value |= (1 << 30) | (1 << 31);
    }
    value as i32 as isize
}

/// 在 `base` 上把按住的键标记为按下。修饰键同时标记左侧键码：应用分别读取通用键码与左右键码。
fn pressed_state(base: &[u8; 256], held: &[u16]) -> [u8; 256] {
    let mut state = *base;
    for &vk in held {
        state[usize::from(vk) & 0xFF] |= 0x80;
        let left = match vk {
            VK_SHIFT => Some(0xA0usize),
            VK_CONTROL => Some(0xA2),
            VK_MENU => Some(0xA4),
            _ => None,
        };
        if let Some(left) = left {
            state[left] |= 0x80;
        }
    }
    state
}

/// 该键在给定键盘状态下产生的字符，按接收窗口所属线程的键盘布局换算。死键与不产生字符的键返回空。
fn chars_of(vk: u16, scan: u16, state: &[u8; 256], receiver: HWND) -> Vec<u16> {
    // SAFETY: 只读查询，不需要进程号出参。
    let thread = unsafe { GetWindowThreadProcessId(receiver, None) };
    // SAFETY: 只读查询。
    let layout = unsafe { GetKeyboardLayout(thread) };
    let mut buf = [0u16; 8];
    // 标志位 4：不改变本线程的键盘状态（死键缓冲）。
    // SAFETY: 状态与缓冲区都位于本栈帧，长度由切片给出。
    let written = unsafe {
        ToUnicodeEx(
            u32::from(vk),
            u32::from(scan),
            state,
            &mut buf,
            4,
            Some(layout),
        )
    };
    usize::try_from(written).map_or_else(|_| Vec::new(), |n| buf[..n.min(buf.len())].to_vec())
}

/// 挂接到接收窗口的线程，在 `send` 期间使其键盘状态显示 `held` 中的键已按下，分离前恢复原状态。
///
/// 挂接期间两个线程共用一份键盘状态，`SetKeyboardState` 因此改变的是目标线程读取到的状态。
/// 无法挂接（目标进程完整性高于本进程）或无法设置状态时返回 `None`，不发送：没有修饰键状态的
/// 组合键会被目标当作单键处理。
fn with_key_state(
    receiver: HWND,
    held: &[u16],
    send: impl FnOnce(&[u8; 256]) -> Sent,
) -> Option<Sent> {
    // SAFETY: 只读查询，不需要进程号出参。
    let target = unsafe { GetWindowThreadProcessId(receiver, None) };
    // SAFETY: 无参只读查询。
    let own = unsafe { GetCurrentThreadId() };
    if target == 0 || target == own {
        return None;
    }
    // 没有消息队列的线程无法挂接，此调用为本线程创建消息队列。
    // SAFETY: 只影响本线程。
    let _ = unsafe { IsGUIThread(true) };
    // SAFETY: 两个线程号都来自上面的查询；任何返回路径都在下方解除挂接。
    if !unsafe { AttachThreadInput(own, target, true) }.as_bool() {
        return None;
    }
    let mut saved = [0u8; 256];
    // SAFETY: 出参是本栈帧上的数组。
    let result = if unsafe { GetKeyboardState(&mut saved) }.is_ok() {
        let state = pressed_state(&saved, held);
        // SAFETY: 参数是本栈帧上的数组。
        if unsafe { SetKeyboardState(&state) }.is_ok() {
            let sent = send(&state);
            // SAFETY: 同上，恢复挂接前的状态。
            let _ = unsafe { SetKeyboardState(&saved) };
            Some(sent)
        } else {
            None
        }
    } else {
        None
    };
    // SAFETY: 解除上方的挂接。
    let _ = unsafe { AttachThreadInput(own, target, false) };
    result
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
/// 返回实际送达目标窗口或进入系统输入队列的码元数。逐条判定，**不要改为只检查最后一条的
/// 返回值**：UIPI 拦截逐条生效。
pub trait CharSink {
    fn post(&self, window: i64, units: &[u16]) -> u32;
}

/// 一次文字投递的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivered {
    /// 实际送达的码元数。
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

    /// 承载 UWP 或 XAML 输入的窗口整窗使用系统输入；其余窗口（Chromium、Qt、经典控件、控制台）使用窗口消息。
    #[test]
    fn only_windows_hosting_uwp_or_xaml_input_need_system_input() {
        for classes in [
            vec!["Windows.UI.Core.CoreWindow"],
            vec!["ApplicationFrameWindow", "Windows.UI.Core.CoreWindow"],
            vec![
                "CASCADIA_HOSTING_WINDOW_CLASS",
                "DRAG_BAR_WINDOW_CLASS",
                "Windows.UI.Composition.DesktopWindowContentBridge",
                "Windows.UI.Input.InputSite.WindowClass",
            ],
        ] {
            assert_eq!(delivery_of(classes.clone()), Delivery::SystemInput, "{classes:?}");
        }
        for classes in [
            vec!["Chrome_WidgetWin_1", "Chrome_RenderWidgetHostHWND", "Intermediate D3D Window"],
            vec!["Qt622QWindowIcon"],
            vec!["Notepad", "Edit", "msctls_statusbar32"],
            vec!["ConsoleWindowClass"],
        ] {
            assert_eq!(delivery_of(classes.clone()), Delivery::Messages, "{classes:?}");
        }
    }

    /// 鼠标消息的坐标按有符号 16 位打包：拖出窗口左上方时的负坐标原样解出。
    #[test]
    fn pointer_coordinates_pack_as_signed_words() {
        let unpack = |lparam: isize| {
            let raw = lparam as u32;
            (i32::from(raw as u16 as i16), i32::from((raw >> 16) as u16 as i16))
        };
        assert_eq!(unpack(point_lparam(20, 10)), (20, 10));
        assert_eq!(unpack(point_lparam(-15, -3)), (-15, -3));
        assert_eq!(unpack(point_lparam(-29_990, 1_200)), (-29_990, 1_200));
    }

    /// 滚轮量写入 wParam 的高 16 位并保留符号，鼠标键标志在低 16 位。
    #[test]
    fn the_wheel_delta_keeps_its_sign_in_the_high_word() {
        let delta = |wparam: usize| i32::from((wparam >> 16) as u16 as i16);
        assert_eq!(delta(wheel_wparam(-240, 0)), -240);
        assert_eq!(delta(wheel_wparam(360, MK_LBUTTON)), 360);
        assert_eq!(wheel_wparam(-120, MK_LBUTTON) & 0xFFFF, MK_LBUTTON);
    }

    /// 第二次按下只在同一个键、双击时间与双击矩形之内时换算为双击。
    #[test]
    fn a_second_press_is_a_double_click_only_inside_the_system_limits() {
        let limit = DoubleClick {
            time: Duration::from_millis(500),
            dx: 2,
            dy: 2,
        };
        let t0 = Instant::now();
        let first = Some(Down {
            button: MouseButton::Left,
            at: point(100, 100),
            when: t0,
        });
        let later = |ms: u64| t0 + Duration::from_millis(ms);
        assert!(is_double(first, MouseButton::Left, point(101, 99), later(100), limit));
        assert!(!is_double(None, MouseButton::Left, point(100, 100), later(100), limit));
        assert!(!is_double(first, MouseButton::Right, point(100, 100), later(100), limit));
        assert!(!is_double(first, MouseButton::Left, point(100, 100), later(600), limit));
        assert!(!is_double(first, MouseButton::Left, point(103, 100), later(100), limit));
    }

    /// Alt 按住时为系统按键消息；Ctrl+Alt（AltGr）与 Ctrl 组合为普通按键消息；F10 单独为系统按键消息。
    #[test]
    fn alt_combinations_use_system_key_messages() {
        assert_eq!(key_message(0x46, &[VK_MENU, 0x46], true), WM_SYSKEYDOWN);
        assert_eq!(key_message(VK_MENU, &[VK_MENU], true), WM_SYSKEYDOWN);
        assert_eq!(key_message(VK_MENU, &[], false), WM_SYSKEYUP);
        assert_eq!(key_message(0x41, &[VK_CONTROL, VK_MENU, 0x41], true), WM_KEYDOWN);
        assert_eq!(key_message(0x41, &[VK_CONTROL, 0x41], true), WM_KEYDOWN);
        assert_eq!(key_message(VK_F10, &[VK_F10], true), WM_SYSKEYDOWN);
        assert_eq!(key_message(0x0D, &[], false), WM_KEYUP);
    }

    /// 按键 lParam：按下与抬起只差最高两位；扩展键与 Alt 上下文位按需置位。
    #[test]
    fn key_lparam_marks_release_extension_and_alt_context() {
        let down = key_lparam(0x1E, false, false, true) as u32;
        assert_eq!(down, 0x001E_0001);
        let up = key_lparam(0x1E, false, false, false) as u32;
        assert_eq!(up, 0xC01E_0001);
        assert_eq!(key_lparam(0x48, true, false, true) as u32 & (1 << 24), 1 << 24);
        assert_eq!(key_lparam(0x21, false, true, true) as u32 & (1 << 29), 1 << 29);
    }

    /// 修饰键同时标记通用键码与左侧键码，其余键位保留原值。
    #[test]
    fn pressed_state_marks_modifiers_under_both_codes() {
        let mut base = [0u8; 256];
        base[0x14] = 0x01;
        let state = pressed_state(&base, &[VK_CONTROL, 0x41]);
        assert_eq!(state[usize::from(VK_CONTROL)] & 0x80, 0x80);
        assert_eq!(state[0xA2] & 0x80, 0x80);
        assert_eq!(state[0x41] & 0x80, 0x80);
        assert_eq!(state[0x10], 0);
        assert_eq!(state[0x14], 0x01, "切换键的锁定位不应被改写");
    }

    /// 已送达而仍在处理的事件计入已发送并停止；未送达的事件不计入。
    #[test]
    fn a_pending_message_counts_and_stops_the_batch() {
        assert_eq!(tally([Sent::Done, Sent::Done, Sent::Done]), 3);
        assert_eq!(tally([Sent::Done, Sent::Pending, Sent::Done]), 2);
        assert_eq!(tally([Sent::Done, Sent::Refused, Sent::Done]), 1);
        assert_eq!(tally([Sent::Refused]), 0);
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

    // ── 真实窗口 ──

    use ::windows::core::{w, PCWSTR};
    use ::windows::Win32::Foundation::LRESULT;
    use ::windows::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
    use ::windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow,
        GetMessageW, PostThreadMessageW, RegisterClassExW, ShowWindow, MSG, SW_SHOWNOACTIVATE,
        WINDOW_EX_STYLE, WM_QUIT, WNDCLASSEXW, WS_CHILD, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_POPUP, WS_VISIBLE,
    };

    use crate::input::key_stroke;

    /// 测试窗口收到的一条输入消息、窗口过程处理它时读取到的 Ctrl 状态，以及收到的时刻。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Seen {
        window: isize,
        msg: u32,
        wparam: usize,
        lparam: isize,
        ctrl: bool,
        at: Instant,
    }

    static SEEN: Mutex<Vec<Seen>> = Mutex::new(Vec::new());
    /// 测试窗口共用一份记录，用例须串行执行。
    static WINDOW_TESTS: Mutex<()> = Mutex::new(());

    const RECORDED: &[u32] = &[
        WM_MOUSEMOVE,
        WM_LBUTTONDOWN,
        WM_LBUTTONUP,
        WM_LBUTTONDBLCLK,
        WM_RBUTTONDOWN,
        WM_RBUTTONUP,
        WM_MOUSEWHEEL,
        WM_KEYDOWN,
        WM_KEYUP,
        WM_CHAR,
        WM_SYSKEYDOWN,
        WM_SYSKEYUP,
        WM_SYSCHAR,
    ];

    unsafe extern "system" fn record(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if RECORDED.contains(&msg) {
            let ctrl = GetKeyState(i32::from(VK_CONTROL)) < 0;
            if let Ok(mut seen) = SEEN.lock() {
                seen.push(Seen {
                    window: hwnd.0 as isize,
                    msg,
                    wparam: wparam.0,
                    lparam: lparam.0,
                    ctrl,
                    at: Instant::now(),
                });
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// 测试窗口左上角的屏幕坐标，位于任何显示器之外。
    const ORIGIN: (i32, i32) = (-30_000, -30_000);
    /// 子窗口在测试窗口客户区中的位置与尺寸。
    const CHILD: (i32, i32, i32, i32) = (100, 50, 80, 60);

    /// 在另一条线程上创建并运行消息循环的测试窗口：位于屏幕之外、显示时不激活，内含一个子窗口。
    ///
    /// 必须在另一条线程上运行：同步发送给本线程的窗口时，系统直接调用窗口过程，无法检验挂接与键盘状态。
    struct TestWindow {
        top: HWND,
        child: HWND,
        thread: u32,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl TestWindow {
        fn open() -> Self {
            Self::open_class("qy-message-sink-test")
        }

        /// 以给定窗口类名创建。类名决定按窗口类判定的分支（Chromium 内核等）。
        fn open_class(name: &'static str) -> Self {
            let (tx, rx) = std::sync::mpsc::channel();
            let handle = std::thread::spawn(move || {
                let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
                // SAFETY: 窗口类与窗口都只在本线程上创建和使用，退出消息循环后销毁；
                // 类名缓冲区在整个线程期间有效。
                unsafe {
                    let class = PCWSTR(wide.as_ptr());
                    let wc = WNDCLASSEXW {
                        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
                        style: CS_DBLCLKS,
                        lpfnWndProc: Some(record),
                        lpszClassName: class,
                        ..WNDCLASSEXW::default()
                    };
                    // 同一进程中重复注册返回 0，窗口类已存在，不影响创建窗口。
                    RegisterClassExW(&wc);
                    let top = CreateWindowExW(
                        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                        class,
                        w!("message sink test"),
                        WS_POPUP,
                        ORIGIN.0,
                        ORIGIN.1,
                        300,
                        200,
                        None,
                        None,
                        None,
                        None,
                    )
                    .expect("创建测试窗口");
                    let child = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        class,
                        PCWSTR::null(),
                        WS_CHILD | WS_VISIBLE,
                        CHILD.0,
                        CHILD.1,
                        CHILD.2,
                        CHILD.3,
                        Some(top),
                        None,
                        None,
                        None,
                    )
                    .expect("创建子窗口");
                    let _ = ShowWindow(top, SW_SHOWNOACTIVATE);
                    let _ = tx.send((top.0 as isize, child.0 as isize, GetCurrentThreadId()));
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        DispatchMessageW(&msg);
                    }
                    let _ = DestroyWindow(top);
                }
            });
            let (top, child, thread) = rx.recv().expect("测试窗口线程启动");
            Self {
                top: HWND(top as *mut c_void),
                child: HWND(child as *mut c_void),
                thread,
                handle: Some(handle),
            }
        }

        /// 测试窗口客户区坐标对应的屏幕坐标。弹出窗口没有边框，客户区原点即窗口原点。
        fn screen(&self, x: i32, y: i32) -> ScreenPoint {
            point(ORIGIN.0 + x, ORIGIN.1 + y)
        }
    }

    impl Drop for TestWindow {
        fn drop(&mut self) {
            // SAFETY: 线程号来自窗口线程自身。
            let _ = unsafe { PostThreadMessageW(self.thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn take_seen() -> Vec<Seen> {
        std::mem::take(&mut *SEEN.lock().expect("记录锁"))
    }

    fn left(down: bool) -> Event {
        Event::Button {
            button: MouseButton::Left,
            down,
        }
    }

    /// 原始失败形状：指针动作只能经系统输入队列送达前台窗口。改为窗口消息后，不在前台、位于屏幕之外的
    /// 窗口按落点收到点击、双击、右键与滚轮，坐标是接收窗口的客户区坐标，窗口始终没有成为前台。
    #[test]
    fn pointer_messages_reach_the_window_under_the_point_without_activating_it() {
        let _guard = WINDOW_TESTS.lock().expect("用例锁");
        take_seen();
        let window = TestWindow::open();
        let sink = MessageSink::new(window.top.0 as i64);
        let in_child = window.screen(CHILD.0 + 20, CHILD.1 + 10);
        let in_top = window.screen(10, 10);
        let events = [
            Event::Move { to: in_child },
            left(true),
            left(false),
            left(true),
            left(false),
            Event::Move { to: in_top },
            Event::Button {
                button: MouseButton::Right,
                down: true,
            },
            Event::Button {
                button: MouseButton::Right,
                down: false,
            },
            Event::Wheel {
                notches: -2,
                horizontal: false,
            },
        ];
        assert_eq!(sink.send(&events), 9);
        let child = window.child.0 as isize;
        let top = window.top.0 as isize;
        let at_child = point_lparam(20, 10);
        let at_top = point_lparam(10, 10);
        let recorded = take_seen();
        // 移动之后停顿再按下，按住一段时间再抬起：模拟触摸的界面不把零间隔的按下与抬起识别为点击。
        let gap = |a: usize, b: usize| recorded[b].at.duration_since(recorded[a].at);
        assert!(gap(0, 1) >= PRESS_DELAY, "移动到按下 {:?}", gap(0, 1));
        assert!(gap(1, 2) >= HOLD_TIME, "按下到抬起 {:?}", gap(1, 2));
        assert!(gap(3, 4) >= HOLD_TIME, "双击的第二次按住 {:?}", gap(3, 4));
        let seen: Vec<(isize, u32, usize, isize)> = recorded
            .iter()
            .map(|s| (s.window, s.msg, s.wparam, s.lparam))
            .collect();
        assert_eq!(
            seen,
            vec![
                (child, WM_MOUSEMOVE, 0, at_child),
                (child, WM_LBUTTONDOWN, MK_LBUTTON, at_child),
                (child, WM_LBUTTONUP, 0, at_child),
                (child, WM_LBUTTONDBLCLK, MK_LBUTTON, at_child),
                (child, WM_LBUTTONUP, 0, at_child),
                (top, WM_MOUSEMOVE, 0, at_top),
                (top, WM_RBUTTONDOWN, MK_RBUTTON, at_top),
                (top, WM_RBUTTONUP, 0, at_top),
                (top, WM_MOUSEWHEEL, wheel_wparam(-240, 0), point_lparam(in_top.x, in_top.y)),
            ]
        );
        // SAFETY: 无参只读查询。
        assert_ne!(unsafe { GetForegroundWindow() }, window.top);
    }

    /// 按下之后拖出子窗口，移动与抬起仍发给按下时的子窗口，坐标相对该子窗口，可以为负数。
    #[test]
    fn a_drag_stays_with_the_window_that_received_the_press() {
        let _guard = WINDOW_TESTS.lock().expect("用例锁");
        take_seen();
        let window = TestWindow::open();
        let sink = MessageSink::new(window.top.0 as i64);
        let events = [
            Event::Move {
                to: window.screen(CHILD.0 + 20, CHILD.1 + 10),
            },
            left(true),
            Event::Move {
                to: window.screen(10, 10),
            },
            left(false),
        ];
        assert_eq!(sink.send(&events), 4);
        let child = window.child.0 as isize;
        let outside = point_lparam(10 - CHILD.0, 10 - CHILD.1);
        let seen: Vec<(isize, u32, usize, isize)> = take_seen()
            .iter()
            .map(|s| (s.window, s.msg, s.wparam, s.lparam))
            .collect();
        assert_eq!(
            seen,
            vec![
                (child, WM_MOUSEMOVE, 0, point_lparam(20, 10)),
                (child, WM_LBUTTONDOWN, MK_LBUTTON, point_lparam(20, 10)),
                (child, WM_MOUSEMOVE, MK_LBUTTON, outside),
                (child, WM_LBUTTONUP, 0, outside),
            ]
        );
    }

    /// 屏幕上该点最上层的顶层窗口。
    fn top_at(at: ScreenPoint) -> HWND {
        // SAFETY: 纯查询，参数是屏幕坐标。
        let hit = unsafe { WindowFromPoint(POINT { x: at.x, y: at.y }) };
        // SAFETY: 句柄来自上一行的查询。
        unsafe { GetAncestor(hit, GA_ROOT) }
    }

    /// Chromium 内核的窗口在该点未被覆盖时滚轮可达，被另一个窗口覆盖时不可达；
    /// 其他窗口被覆盖时仍视为可达（剪映实测被覆盖时照常滚动）。
    /// 后创建的测试窗口位于 z 序上方，三个窗口位置相同，依次覆盖前一个。
    #[test]
    fn wheel_reachability_depends_on_coverage_only_for_chromium_windows() {
        let _guard = WINDOW_TESTS.lock().expect("用例锁");
        let chromium = TestWindow::open_class("Chrome_WidgetWin_qy_test");
        let at = chromium.screen(10, 10);
        assert_eq!(top_at(at), chromium.top, "前置条件：Chromium 窗口位于最上层");
        assert!(wheel_reaches(chromium.top.0 as i64, at));
        let plain = TestWindow::open();
        assert_eq!(top_at(at), plain.top, "前置条件：普通窗口覆盖 Chromium 窗口");
        assert!(!wheel_reaches(chromium.top.0 as i64, at));
        let cover = TestWindow::open();
        assert_eq!(top_at(at), cover.top, "前置条件：第三个窗口覆盖普通窗口");
        assert!(wheel_reaches(plain.top.0 as i64, at));
    }

    /// 原始失败形状：只发送按键消息时 ctrl+a 被当作 a，且投递的按键与随后的文字顺序颠倒。
    /// 组合键处理期间目标线程读取到 Ctrl 已按下，抬起 Ctrl 后恢复；按键与文字按发出顺序到达。
    #[test]
    fn keys_carry_the_modifier_state_and_arrive_in_order_with_text() {
        let _guard = WINDOW_TESTS.lock().expect("用例锁");
        take_seen();
        let window = TestWindow::open();
        let sink = MessageSink::new(window.top.0 as i64);
        let mut events = key_stroke("a", &["ctrl".to_owned()]);
        events.extend(key_stroke("enter", &[]));
        assert_eq!(sink.send(&events), 6);
        let text: Vec<u16> = "x中".encode_utf16().collect();
        assert_eq!(MessageCharSink.post(window.top.0 as i64, &text), 2);
        let top = window.top.0 as isize;
        let seen: Vec<(isize, u32, usize, bool)> = take_seen()
            .iter()
            .map(|s| (s.window, s.msg, s.wparam, s.ctrl))
            .collect();
        assert_eq!(
            seen,
            vec![
                (top, WM_KEYDOWN, 0x11, true),
                (top, WM_KEYDOWN, 0x41, true),
                (top, WM_CHAR, 0x01, true),
                (top, WM_KEYUP, 0x41, true),
                (top, WM_KEYUP, 0x11, false),
                (top, WM_KEYDOWN, 0x0D, false),
                (top, WM_CHAR, 0x0D, false),
                (top, WM_KEYUP, 0x0D, false),
                (top, WM_CHAR, usize::from(b'x'), false),
                (top, WM_CHAR, 0x4E2D, false),
            ]
        );
        // SAFETY: 无参只读查询。
        assert_ne!(unsafe { GetForegroundWindow() }, window.top);
    }
}
