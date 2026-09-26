//! 协议键名 → X11 keysym → 键码。键盘映射由各自的 X 连接读，换算规则只在这里写一次。
//!
//! worker 派发按键与外壳在 worker 退出后补发抬起要用同一张表与同一条换算规则，外壳经 `#[path]`
//! 引入本文件。不要在外壳里另写一份：两份一旦不一致，补发抬起的就不是 worker 按下的那个键。
//! 因此本文件只依赖标准库，不引用任何 crate 内的路径。

/// 键名 → keysym。键名是协议写法（全小写的主键名，或修饰键名 `ctrl` / `alt` / `shift` /
/// `meta`）；认不出的名字返回 `None`，不猜。
///
/// 字母取小写那一个 keysym：它在第一组第一级上，按下时不带 Shift。
pub fn keysym(name: &str) -> Option<u32> {
    match name.as_bytes() {
        [letter @ b'a'..=b'z'] => return Some(u32::from(*letter)),
        [digit @ b'0'..=b'9'] => return Some(u32::from(*digit)),
        _ => {}
    }
    if let Some(index) = name.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=24).contains(&index) && name == format!("f{index}") {
            // XK_F1 = 0xffbe，F1–F24 连续。
            return Some(0xffbd + index);
        }
    }
    let named = match name {
        "enter" => 0xff0d,
        "tab" => 0xff09,
        "escape" => 0xff1b,
        "space" => 0x0020,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "insert" => 0xff63,
        "home" => 0xff50,
        "end" => 0xff57,
        "page_up" => 0xff55,
        "page_down" => 0xff56,
        "up" => 0xff52,
        "down" => 0xff54,
        "left" => 0xff51,
        "right" => 0xff53,
        "semicolon" => 0x003b,
        "equal" => 0x003d,
        "comma" => 0x002c,
        "minus" => 0x002d,
        "period" => 0x002e,
        "slash" => 0x002f,
        "backquote" => 0x0060,
        "bracket_left" => 0x005b,
        "backslash" => 0x005c,
        "bracket_right" => 0x005d,
        "quote" => 0x0027,
        "shift" => 0xffe1,
        "ctrl" => 0xffe3,
        "alt" => 0xffe9,
        "meta" => 0xffeb,
        _ => return None,
    };
    Some(named)
}

/// 不带修饰就能按出 `sym` 的键码：键盘映射里第一组第一级上是它的那一个。
///
/// `syms` 是 `GetKeyboardMapping` 从 `min` 起逐键码排的 keysym 表，每个键码 `per` 个。
/// 只在更高一级上的 keysym 返回 `None`：按下那个键得到的是另一个字符。
pub fn keycode(min: u8, per: usize, syms: &[u32], sym: u32) -> Option<u8> {
    syms.chunks(per.max(1))
        .position(|levels| levels.first() == Some(&sym))
        .and_then(|i| min.checked_add(u8::try_from(i).ok()?))
}

#[cfg(test)]
mod tests {
    use super::{keycode, keysym};

    /// 键码 8 空，9 是 a/A，10 空，11 只在第二级上有分号，12 是 Return。
    const SYMS: [u32; 10] = [0, 0, 0x61, 0x41, 0, 0, 0x2c, 0x3b, 0xff0d, 0];

    #[test]
    fn a_keysym_resolves_only_on_the_first_level() {
        assert_eq!(keycode(8, 2, &SYMS, 0x61), Some(9));
        assert_eq!(keycode(8, 2, &SYMS, 0xff0d), Some(12));
        // 大写 A 与分号只在第二级：按下那个键得到的是别的字符。
        assert_eq!(keycode(8, 2, &SYMS, 0x41), None);
        assert_eq!(keycode(8, 2, &SYMS, 0x3b), None);
    }

    #[test]
    fn letters_digits_and_function_keys_map_to_their_keysyms() {
        assert_eq!(keysym("a"), Some(0x61));
        assert_eq!(keysym("z"), Some(0x7a));
        assert_eq!(keysym("0"), Some(0x30));
        assert_eq!(keysym("9"), Some(0x39));
        assert_eq!(keysym("f1"), Some(0xffbe));
        assert_eq!(keysym("f12"), Some(0xffc9));
        assert_eq!(keysym("f24"), Some(0xffd5));
        assert_eq!(keysym("enter"), Some(0xff0d));
        assert_eq!(keysym("backspace"), Some(0xff08));
        // 认不出的名字不猜：没有这个键就没有这次按键。键名是规范写法，大写不认。
        for unknown in ["f25", "f0", "f01", "f+1", "any", "", "A", "win"] {
            assert_eq!(keysym(unknown), None, "{unknown}");
        }
    }

    /// 修饰键取左侧那一个：`meta` 是 Super_L。
    #[test]
    fn modifiers_map_to_the_left_hand_keysyms() {
        assert_eq!(keysym("shift"), Some(0xffe1));
        assert_eq!(keysym("ctrl"), Some(0xffe3));
        assert_eq!(keysym("alt"), Some(0xffe9));
        assert_eq!(keysym("meta"), Some(0xffeb));
    }
}
