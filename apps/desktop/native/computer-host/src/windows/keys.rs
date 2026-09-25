//! 协议键名 → Windows 虚拟键码与扩展键标志。
//!
//! worker 派发按键与外壳在 worker 退出后补发抬起共用这一个文件，外壳经 `#[path]` 引入它。
//! 不要在外壳里另写一张表：两张表一旦不一致，补发抬起的就不是 worker 按下的那个键。
//! 因此本文件只依赖标准库，不引用任何 crate 内的路径。

/// 键名 → 虚拟键码与扩展键标志。键名是协议写法（全小写的主键名，或修饰键名
/// `ctrl` / `alt` / `shift` / `meta`）；认不出的名字返回 `None`，不猜。
///
/// 扩展键标志漏给的代价是真实的：方向键与小键盘的同名键共用虚拟键码，少了 `E0`
/// 前缀，目标应用收到的是小键盘那一个。
pub fn virtual_key(name: &str) -> Option<(u16, bool)> {
    match name.as_bytes() {
        [letter @ b'a'..=b'z'] => return Some((u16::from(letter.to_ascii_uppercase()), false)),
        [digit @ b'0'..=b'9'] => return Some((u16::from(*digit), false)),
        _ => {}
    }
    if let Some(index) = name.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&index) && name == format!("f{index}") {
            return Some((0x6F + index, false));
        }
    }
    let named = match name {
        "enter" => (0x0D, false),
        "tab" => (0x09, false),
        "escape" => (0x1B, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" => (0x2E, true),
        "insert" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "page_up" => (0x21, true),
        "page_down" => (0x22, true),
        "up" => (0x26, true),
        "down" => (0x28, true),
        "left" => (0x25, true),
        "right" => (0x27, true),
        "semicolon" => (0xBA, false),
        "equal" => (0xBB, false),
        "comma" => (0xBC, false),
        "minus" => (0xBD, false),
        "period" => (0xBE, false),
        "slash" => (0xBF, false),
        "backquote" => (0xC0, false),
        "bracket_left" => (0xDB, false),
        "backslash" => (0xDC, false),
        "bracket_right" => (0xDD, false),
        "quote" => (0xDE, false),
        "shift" => (0x10, false),
        "ctrl" => (0x11, false),
        "alt" => (0x12, false),
        // 左 Windows 徽标键的扫描码带 E0 前缀，少了它目标应用收不到这个键。
        "meta" => (0x5B, true),
        _ => return None,
    };
    Some(named)
}

#[cfg(test)]
mod tests {
    use super::virtual_key;

    #[test]
    fn letters_digits_and_function_keys_map_to_their_virtual_key_codes() {
        assert_eq!(virtual_key("a"), Some((0x41, false)));
        assert_eq!(virtual_key("z"), Some((0x5A, false)));
        assert_eq!(virtual_key("0"), Some((0x30, false)));
        assert_eq!(virtual_key("9"), Some((0x39, false)));
        assert_eq!(virtual_key("f1"), Some((0x70, false)));
        assert_eq!(virtual_key("f12"), Some((0x7B, false)));
        assert_eq!(virtual_key("f24"), Some((0x87, false)));
        assert_eq!(virtual_key("enter"), Some((0x0D, false)));
        assert_eq!(virtual_key("escape"), Some((0x1B, false)));
        // 认不出的名字不猜：没有这个键就没有这次按键。键名是规范写法，大写不认。
        for unknown in ["f25", "f0", "f01", "f+1", "any", "", "A", "win"] {
            assert_eq!(virtual_key(unknown), None, "{unknown}");
        }
    }

    /// 方向键与编辑键要带扩展键标志：少了它目标应用收到的是小键盘上的同码键。
    #[test]
    fn navigation_keys_carry_the_extended_flag() {
        for name in [
            "up", "down", "left", "right", "home", "end", "page_up", "page_down", "insert",
            "delete", "meta",
        ] {
            assert_eq!(virtual_key(name).map(|k| k.1), Some(true), "{name} 应当是扩展键");
        }
        for name in ["a", "enter", "tab", "space", "f5", "comma", "ctrl", "alt", "shift"] {
            assert_eq!(virtual_key(name).map(|k| k.1), Some(false), "{name} 不该是扩展键");
        }
        assert_eq!(virtual_key("ctrl"), Some((0x11, false)));
        assert_eq!(virtual_key("alt"), Some((0x12, false)));
        assert_eq!(virtual_key("shift"), Some((0x10, false)));
        assert_eq!(virtual_key("meta"), Some((0x5B, true)));
    }
}
