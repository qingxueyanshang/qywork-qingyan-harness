//! worker 被强制终止后的输入状态清理。
//!
//! 三条边界：
//!
//! 1. **只发送抬起事件，不能发送按下事件。** 因此它不是第二个执行入口：输入的唯一权威仍是 worker，
//!    宿主一侧只清理 worker 未能清理的输入状态。
//! 2. **只释放 worker 记录的键。** 不对常用修饰键做全局抬起：
//!    那会同时抬起用户当前正按住的键。
//! 3. **在确认 worker 进程退出之后调用。** worker 未退出时会自行释放，两侧同时发送抬起事件没有收益。

use super::frames::HeldInput;

/// 协议键名到本平台键码的换算表，与 worker 派发按键时使用同一个文件。
#[cfg(windows)]
#[path = "../../../native/computer-host/src/windows/keys.rs"]
mod keys;
#[cfg(target_os = "linux")]
#[path = "../../../native/computer-host/src/linux/x11/keys.rs"]
mod keys;
/// 连接 X 服务器的代码，与 worker 使用同一个文件。
#[cfg(target_os = "linux")]
#[path = "../../../native/computer-host/src/linux/x11/connect.rs"]
mod connect;
#[cfg(target_os = "macos")]
#[path = "../../../native/computer-host/src/macos/keys.rs"]
mod keys;

/// 释放输入状态中记录的键与鼠标键。返回实际进入输入队列的事件数。
#[cfg(windows)]
pub fn release(held: &HeldInput) -> u32 {
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };

    let mut inputs: Vec<INPUT> = Vec::new();
    // 顺序与按下相反：修饰键必须在主键之后抬起，鼠标键最后抬起。
    for key in held.keys.iter().rev() {
        // 无法识别的键名不推测对应的键来抬起：推测错误的键并未被按下。
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
            // 无法识别的按钮名不推测对应的按钮来抬起：推测错误的按钮并未被按下。
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

/// 同上，经由 XTest。宿主自行连接一次 X 服务器（与 worker 使用同一条连接路径），按当前的键盘映射把
/// 键名转换为键码，换算规则与 worker 派发时相同（`keys::keycode`）。无法连接 X 服务器时不发送任何
/// 事件，返回 0。
#[cfg(target_os = "linux")]
pub fn release(held: &HeldInput) -> u32 {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::ConnectionExt as _;
    use x11rb::protocol::xtest::ConnectionExt as _;
    use x11rb::wrapper::ConnectionExt as _;

    // 核心协议的事件号。
    const KEY_RELEASE: u8 = 3;
    const BUTTON_RELEASE: u8 = 5;

    let (conn, screen) = match connect::open() {
        Ok(connected) => connected,
        Err(e) => {
            log::warn!("补发抬起事件时无法连接 X 服务器：{e}");
            return 0;
        }
    };
    let setup = conn.setup();
    let root = setup.roots[screen].root;
    let (min, max) = (setup.min_keycode, setup.max_keycode);
    let mapping = match conn
        .get_keyboard_mapping(min, max - min + 1)
        .map_err(|e| e.to_string())
        .and_then(|cookie| cookie.reply().map_err(|e| e.to_string()))
    {
        Ok(mapping) => mapping,
        Err(e) => {
            log::warn!("补发抬起时无法读取键盘映射：{e}");
            return 0;
        }
    };
    let per = usize::from(mapping.keysyms_per_keycode);
    let mut fakes: Vec<(u8, u8)> = Vec::new();
    // 顺序与按下相反：修饰键必须在主键之后抬起，鼠标键最后抬起。
    for key in held.keys.iter().rev() {
        // 无法识别的键名不推测对应的键来抬起：推测错误的键并未被按下。
        let Some(code) = keys::keysym(key).and_then(|sym| keys::keycode(min, per, &mapping.keysyms, sym))
        else {
            continue;
        };
        fakes.push((KEY_RELEASE, code));
    }
    for button in held.buttons.iter().rev() {
        let number = match button.as_str() {
            "left" => 1,
            "middle" => 2,
            "right" => 3,
            _ => continue,
        };
        fakes.push((BUTTON_RELEASE, number));
    }
    let queued = fakes
        .iter()
        .take_while(|(kind, detail)| {
            conn.xtest_fake_input(*kind, *detail, 0, root, 0, 0, 0).is_ok()
        })
        .count();
    // 等待服务器处理完成后再返回：进程退出时连接立即断开，未送达的请求随之丢失。
    if conn.sync().is_err() {
        return 0;
    }
    u32::try_from(queued).unwrap_or(u32::MAX)
}

/// 同上，经由 CGEvent 投递到 HID 事件流。鼠标抬起事件携带指针当前的位置，不移动指针。
///
/// 投递需要本进程具有辅助功能授权，否则系统静默丢弃：返回的是已投递的事件数，不是生效的事件数。
#[cfg(target_os = "macos")]
pub fn release(held: &HeldInput) -> u32 {
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    // `kCGHIDEventTap`。
    const HID_EVENT_TAP: u32 = 0;
    // `kCGEventLeftMouseUp` / `kCGEventRightMouseUp` / `kCGEventOtherMouseUp`。
    const LEFT_MOUSE_UP: u32 = 2;
    const RIGHT_MOUSE_UP: u32 = 4;
    const OTHER_MOUSE_UP: u32 = 26;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
        fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
        fn CGEventCreateMouseEvent(
            source: *const c_void,
            kind: u32,
            at: CGPoint,
            button: u32,
        ) -> *mut c_void;
        fn CGEventPost(tap: u32, event: *mut c_void);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(object: *const c_void);
    }

    /// 投递一个事件并释放它。无法创建事件时返回 0。
    fn post(event: *mut c_void) -> u32 {
        if event.is_null() {
            return 0;
        }
        // SAFETY: 事件是调用方刚创建、归本函数所有的 CGEvent，投递之后释放一次。
        unsafe {
            CGEventPost(HID_EVENT_TAP, event);
            CFRelease(event);
        }
        1
    }

    let mut sent = 0;
    // 顺序与按下相反：修饰键必须在主键之后抬起，鼠标键最后抬起。
    for key in held.keys.iter().rev() {
        // 无法识别的键名不推测对应的键来抬起：推测错误的键并未被按下。
        let Some(code) = keys::keycode(key) else {
            continue;
        };
        // SAFETY: 事件源传入空指针，由系统使用默认事件源。
        sent += post(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, false) });
    }
    if held.buttons.is_empty() {
        return sent;
    }
    // SAFETY: 空事件源；创建的事件只用于读取指针位置，读取后即释放。
    let here = unsafe { CGEventCreate(ptr::null()) };
    if here.is_null() {
        return sent;
    }
    // SAFETY: `here` 非空，是本函数刚创建的事件。
    let at = unsafe {
        let at = CGEventGetLocation(here);
        CFRelease(here);
        at
    };
    for button in held.buttons.iter().rev() {
        // 事件类型与按钮号：左 0、右 1、中 2。
        let (kind, number) = match button.as_str() {
            "left" => (LEFT_MOUSE_UP, 0),
            "right" => (RIGHT_MOUSE_UP, 1),
            "middle" => (OTHER_MOUSE_UP, 2),
            _ => continue,
        };
        // SAFETY: 空事件源；位置与按钮号都是本函数构造的合法值。
        sent += post(unsafe { CGEventCreateMouseEvent(ptr::null(), kind, at, number) });
    }
    sent
}
