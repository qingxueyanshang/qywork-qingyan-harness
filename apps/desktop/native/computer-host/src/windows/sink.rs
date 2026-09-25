//! 前台原始输入的真实派发口：`SendInput` 与 `WM_CHAR`。整个进程只有这里向系统发输入。

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

use crate::input::{CharSink, Event, Sink};
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
    }
}
