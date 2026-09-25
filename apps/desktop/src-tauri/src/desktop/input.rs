//! worker 被强杀之后的输入清账。
//!
//! 三条边界：
//!
//! 1. **只发抬起，发不出按下。** 因此它不是第二个执行入口：输入的唯一权威仍是 worker，
//!    宿主这一侧只收拾 worker 已经来不及收拾的那一份。
//! 2. **只释放 worker 记录在案的那几个。** 不做「把常用修饰键都抬一遍」的全局清扫——
//!    那会把用户此刻正按着的键一起抬掉。
//! 3. **在确认 worker 进程退出之后调。** 它没退出时自己会释放，两边同时发抬起没有收益。

use super::frames::HeldInput;

/// 协议键名到虚拟键码的换算表，与 worker 派发按键用的是同一个文件。
#[cfg(windows)]
#[path = "../../../native/computer-host/src/windows/keys.rs"]
mod keys;

/// 释放这份账里的键与鼠标键。返回真的进了输入队列的事件数。
#[cfg(windows)]
pub fn release(held: &HeldInput) -> u32 {
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };

    let mut inputs: Vec<INPUT> = Vec::new();
    // 顺序与按下相反：修饰键要在主键之后抬起，鼠标键最后。
    for key in held.keys.iter().rev() {
        // 认不出的键名不猜一个键抬起来：抬错的那一个本来就没有按下。
        let Some((vk, extended)) = keys::virtual_key(key) else {
            continue;
        };
        let mut flags = KEYEVENTF_KEYUP;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        // SAFETY: 纯查询，参数是虚拟键码。
        let scan =
            u16::try_from(unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) }).unwrap_or(0);
        inputs.push(INPUT {
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
        });
    }
    for button in held.buttons.iter().rev() {
        let flags: MOUSE_EVENT_FLAGS = match button.as_str() {
            "left" => MOUSEEVENTF_LEFTUP,
            "right" => MOUSEEVENTF_RIGHTUP,
            "middle" => MOUSEEVENTF_MIDDLEUP,
            // 认不出的名字不猜一个键抬起来：抬错的那一个本来就没有按下。
            _ => continue,
        };
        inputs.push(INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }
    if inputs.is_empty() {
        return 0;
    }
    let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0);
    // SAFETY: 切片与结构体尺寸都由本函数构造，调用期间不会被改动。
    unsafe { SendInput(&inputs, size) }
}

/// 非 Windows 平台没有前台输入实现，账永远是空的。
#[cfg(not(windows))]
pub fn release(_held: &HeldInput) -> u32 {
    0
}
