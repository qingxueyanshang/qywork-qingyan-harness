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

/// 协议键名到本平台键码的换算表，与 worker 派发按键用的是同一个文件。
#[cfg(windows)]
#[path = "../../../native/computer-host/src/windows/keys.rs"]
mod keys;
#[cfg(target_os = "linux")]
#[path = "../../../native/computer-host/src/linux/x11/keys.rs"]
mod keys;
#[cfg(target_os = "macos")]
#[path = "../../../native/computer-host/src/macos/keys.rs"]
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

/// 同上，经 XTest。宿主自己连一次 X 服务器，按此刻的键盘映射把键名换成键码：映射与换算规则
/// 都与 worker 派发时相同（`keys::keycode`）。连不上 X 服务器时一个都发不出，返回 0。
#[cfg(target_os = "linux")]
pub fn release(held: &HeldInput) -> u32 {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::ConnectionExt as _;
    use x11rb::protocol::xtest::ConnectionExt as _;
    use x11rb::wrapper::ConnectionExt as _;

    // 核心协议的事件号。
    const KEY_RELEASE: u8 = 3;
    const BUTTON_RELEASE: u8 = 5;

    let (conn, screen) = match x11rb::connect(None) {
        Ok(connected) => connected,
        Err(e) => {
            log::warn!("补发抬起连不上 X 服务器：{e}");
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
            log::warn!("补发抬起读不到键盘映射：{e}");
            return 0;
        }
    };
    let per = usize::from(mapping.keysyms_per_keycode);
    let mut fakes: Vec<(u8, u8)> = Vec::new();
    // 顺序与按下相反：修饰键要在主键之后抬起，鼠标键最后。
    for key in held.keys.iter().rev() {
        // 认不出的键名不猜一个键抬起来：抬错的那一个本来就没有按下。
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
    // 等服务器处理完再返回：进程一退出连接就断，没送到的请求随之丢掉。
    if conn.sync().is_err() {
        return 0;
    }
    u32::try_from(queued).unwrap_or(u32::MAX)
}

/// 同上，经 CGEvent 投到 HID 事件流。鼠标抬起事件带指针此刻的位置，不移动指针。
///
/// 投递要本进程有辅助功能授权，没有时系统静默丢弃：返回的是投出去的事件数，不是生效数。
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

    /// 投出一个事件并释放它。建不出事件时交回 0。
    fn post(event: *mut c_void) -> u32 {
        if event.is_null() {
            return 0;
        }
        // SAFETY: 事件是本函数的调用方刚建出、归本函数所有的 CGEvent，投出之后释放一次。
        unsafe {
            CGEventPost(HID_EVENT_TAP, event);
            CFRelease(event);
        }
        1
    }

    let mut sent = 0;
    // 顺序与按下相反：修饰键要在主键之后抬起，鼠标键最后。
    for key in held.keys.iter().rev() {
        // 认不出的键名不猜一个键抬起来：抬错的那一个本来就没有按下。
        let Some(code) = keys::keycode(key) else {
            continue;
        };
        // SAFETY: 事件源传空指针，由系统用默认的事件源。
        sent += post(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, false) });
    }
    if held.buttons.is_empty() {
        return sent;
    }
    // SAFETY: 空事件源；建出的事件只用来读指针位置，读完即释放。
    let here = unsafe { CGEventCreate(ptr::null()) };
    if here.is_null() {
        return sent;
    }
    // SAFETY: `here` 非空，是本函数刚建出的事件。
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
