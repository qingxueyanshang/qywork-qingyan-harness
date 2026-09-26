//! 协议键名 → macOS 虚拟键码（`CGKeyCode`，ANSI 键位）与修饰键的事件标志位。
//!
//! worker 派发按键与外壳在 worker 退出后补发抬起要用同一张表：外壳经 `#[path]` 引入本文件，
//! 不要在外壳里另写一张表，两张表一旦不一致，补发抬起的就不是 worker 按下的那个键。
//! 因此本文件只依赖标准库，不引用任何 crate 内的路径。
//!
//! 虚拟键码是物理键位，与当前键盘布局无关：`a` 按下的是 ANSI 键盘上 A 所在的那个键。

/// 键名 → 虚拟键码。键名是协议写法（全小写的主键名，或修饰键名 `ctrl` / `alt` / `shift` /
/// `meta`）；认不出的名字返回 `None`，不猜。
///
/// macOS 的功能键只到 F20，`f21`–`f24` 没有键码，返回 `None`。
pub fn key_code(name: &str) -> Option<u16> {
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
        // macOS 的 Delete 键是向后删除，对应协议的 backspace；向前删除是 forward delete。
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
        // PC 键盘的 Insert 键在 macOS 上报 Help 键的键码。
        "insert" => 0x72,
        "home" => 0x73,
        "page_up" => 0x74,
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

/// 修饰键名 → `CGEventFlags` 里对应的那一位。不是修饰键的名字返回 `None`。
///
/// 派发端在每个键盘事件上按此刻按住的修饰键设标志位，不靠系统从修饰键事件推算。
pub fn modifier_flag(name: &str) -> Option<u64> {
    Some(match name {
        "shift" => 0x0002_0000,
        "ctrl" => 0x0004_0000,
        "alt" => 0x0008_0000,
        "meta" => 0x0010_0000,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::{key_code, modifier_flag};

    #[test]
    fn letters_digits_and_named_keys_map_to_ansi_key_codes() {
        assert_eq!(key_code("a"), Some(0x00));
        assert_eq!(key_code("z"), Some(0x06));
        assert_eq!(key_code("0"), Some(0x1D));
        assert_eq!(key_code("9"), Some(0x19));
        assert_eq!(key_code("f1"), Some(0x7A));
        assert_eq!(key_code("f12"), Some(0x6F));
        assert_eq!(key_code("f20"), Some(0x5A));
        assert_eq!(key_code("enter"), Some(0x24));
        assert_eq!(key_code("backspace"), Some(0x33));
        assert_eq!(key_code("delete"), Some(0x75));
        assert_eq!(key_code("up"), Some(0x7E));
        // 认不出的名字不猜：没有这个键就没有这次按键。键名是规范写法，大写不认。
        for unknown in [
            "f25", "f0", "f01", "f+1", "any", "", "A", "win", "cmd", "option",
        ] {
            assert_eq!(key_code(unknown), None, "{unknown}");
        }
    }

    /// 修饰键取左侧那一个：`meta` 是 Command，`alt` 是 Option。
    #[test]
    fn modifiers_map_to_the_left_hand_key_codes_and_their_flags() {
        assert_eq!(key_code("meta"), Some(0x37));
        assert_eq!(key_code("shift"), Some(0x38));
        assert_eq!(key_code("alt"), Some(0x3A));
        assert_eq!(key_code("ctrl"), Some(0x3B));
        assert_eq!(modifier_flag("shift"), Some(0x0002_0000));
        assert_eq!(modifier_flag("ctrl"), Some(0x0004_0000));
        assert_eq!(modifier_flag("alt"), Some(0x0008_0000));
        assert_eq!(modifier_flag("meta"), Some(0x0010_0000));
        assert_eq!(modifier_flag("a"), None);
        assert_eq!(modifier_flag("enter"), None);
    }

    /// 同一个键码不对应两个键名：对应了的话，补发抬起时认不出按下的是哪一个。
    #[test]
    fn no_two_names_share_a_key_code() {
        let names: Vec<String> = (b'a'..=b'z')
            .map(|c| char::from(c).to_string())
            .chain((b'0'..=b'9').map(|c| char::from(c).to_string()))
            .chain((1..=20).map(|n| format!("f{n}")))
            .collect();
        let mut seen = std::collections::HashMap::new();
        for name in names.iter().map(String::as_str).chain([
            "enter",
            "tab",
            "escape",
            "space",
            "backspace",
            "delete",
            "insert",
            "home",
            "end",
            "page_up",
            "page_down",
            "up",
            "down",
            "left",
            "right",
            "semicolon",
            "equal",
            "comma",
            "minus",
            "period",
            "slash",
            "backquote",
            "bracket_left",
            "backslash",
            "bracket_right",
            "quote",
            "shift",
            "ctrl",
            "alt",
            "meta",
        ]) {
            let code = key_code(name).unwrap_or_else(|| panic!("{name} 没有键码"));
            if let Some(other) = seen.insert(code, name) {
                panic!("{name} 与 {other} 共用键码 {code:#x}");
            }
        }
    }
}
