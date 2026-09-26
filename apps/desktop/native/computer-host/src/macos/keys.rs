//! 协议键名 → macOS 虚拟键码（`CGKeyCode`）。
//!
//! worker 派发按键与外壳在 worker 退出后补发抬起要用同一张表，外壳经 `#[path]` 引入本文件。
//! 不要在外壳里另写一张表：两张表一旦不一致，补发抬起的就不是 worker 按下的那个键。
//! 因此本文件只依赖标准库，不引用任何 crate 内的路径。

/// 键名 → 虚拟键码。键名是协议写法（全小写的主键名，或修饰键名 `ctrl` / `alt` / `shift` /
/// `meta`）；认不出的名字返回 `None`，不猜。
///
/// 两条边界：
///
/// 1. 虚拟键码按 ANSI 键盘上的键位编号，不随键盘布局换：非 QWERTY 布局下 `a` 那个键按出的
///    是该布局在这个键位上的字符。
/// 2. macOS 没有 F21–F24 的虚拟键码，这四个名字返回 `None`。
pub fn keycode(name: &str) -> Option<u16> {
    let code = match name {
        "a" => 0x00,
        "s" => 0x01,
        "d" => 0x02,
        "f" => 0x03,
        "h" => 0x04,
        "g" => 0x05,
        "z" => 0x06,
        "x" => 0x07,
        "c" => 0x08,
        "v" => 0x09,
        "b" => 0x0B,
        "q" => 0x0C,
        "w" => 0x0D,
        "e" => 0x0E,
        "r" => 0x0F,
        "y" => 0x10,
        "t" => 0x11,
        "1" => 0x12,
        "2" => 0x13,
        "3" => 0x14,
        "4" => 0x15,
        "6" => 0x16,
        "5" => 0x17,
        "equal" => 0x18,
        "9" => 0x19,
        "7" => 0x1A,
        "minus" => 0x1B,
        "8" => 0x1C,
        "0" => 0x1D,
        "bracket_right" => 0x1E,
        "o" => 0x1F,
        "u" => 0x20,
        "bracket_left" => 0x21,
        "i" => 0x22,
        "p" => 0x23,
        "enter" => 0x24,
        "l" => 0x25,
        "j" => 0x26,
        "quote" => 0x27,
        "k" => 0x28,
        "semicolon" => 0x29,
        "backslash" => 0x2A,
        "comma" => 0x2B,
        "slash" => 0x2C,
        "n" => 0x2D,
        "m" => 0x2E,
        "period" => 0x2F,
        "tab" => 0x30,
        "space" => 0x31,
        "backquote" => 0x32,
        // macOS 的 Delete 是向左删除的那个键。
        "backspace" => 0x33,
        "escape" => 0x35,
        "meta" => 0x37,
        "shift" => 0x38,
        "alt" => 0x3A,
        "ctrl" => 0x3B,
        "f17" => 0x40,
        "f18" => 0x4F,
        "f19" => 0x50,
        "f20" => 0x5A,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f3" => 0x63,
        "f8" => 0x64,
        "f9" => 0x65,
        "f11" => 0x67,
        "f13" => 0x69,
        "f16" => 0x6A,
        "f14" => 0x6B,
        "f10" => 0x6D,
        "f12" => 0x6F,
        "f15" => 0x71,
        // PC 键盘的 Insert 在 macOS 上报的是 Help 键码。
        "insert" => 0x72,
        "home" => 0x73,
        "page_up" => 0x74,
        // 向右删除。
        "delete" => 0x75,
        "f4" => 0x76,
        "end" => 0x77,
        "f2" => 0x78,
        "page_down" => 0x79,
        "f1" => 0x7A,
        "left" => 0x7B,
        "right" => 0x7C,
        "down" => 0x7D,
        "up" => 0x7E,
        _ => return None,
    };
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::keycode;

    #[test]
    fn keys_map_to_their_ansi_virtual_key_codes() {
        assert_eq!(keycode("a"), Some(0x00));
        assert_eq!(keycode("z"), Some(0x06));
        assert_eq!(keycode("0"), Some(0x1D));
        assert_eq!(keycode("9"), Some(0x19));
        assert_eq!(keycode("f1"), Some(0x7A));
        assert_eq!(keycode("f12"), Some(0x6F));
        assert_eq!(keycode("f20"), Some(0x5A));
        assert_eq!(keycode("enter"), Some(0x24));
        assert_eq!(keycode("backspace"), Some(0x33));
        assert_eq!(keycode("delete"), Some(0x75));
        // 认不出的名字不猜：没有这个键就没有这次按键。键名是规范写法，大写不认。
        for unknown in [
            "f21", "f24", "f25", "f0", "f01", "any", "", "A", "win", "cmd",
        ] {
            assert_eq!(keycode(unknown), None, "{unknown}");
        }
    }

    /// 修饰键取左侧那一个：`meta` 是 Command，`alt` 是 Option。
    #[test]
    fn modifiers_map_to_the_left_hand_keys() {
        assert_eq!(keycode("meta"), Some(0x37));
        assert_eq!(keycode("shift"), Some(0x38));
        assert_eq!(keycode("alt"), Some(0x3A));
        assert_eq!(keycode("ctrl"), Some(0x3B));
    }
}
