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

use super::keys::virtual_key;
use crate::input::{CharSink, Event, Sink};
use crate::protocol::MouseButton;

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
    use super::*;
    use crate::protocol::{key_names, Modifier};

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
