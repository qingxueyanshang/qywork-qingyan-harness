//! 协议键名 → X11 keysym → 键码。键盘映射由各自的 X 连接读取，换算规则只在此处定义一次。
//!
//! worker 派发按键与外壳在 worker 退出后补发抬起事件必须使用同一张表与同一条换算规则，外壳经由
//! `#[path]` 引入本文件。不要在外壳中另写一份：两份一旦不一致，补发抬起的就不是 worker 按下的键。
//! 因此本文件只依赖标准库，不引用任何 crate 内的路径。

/// 键名 → keysym。键名是协议写法（全小写的主键名，或修饰键名 `ctrl` / `alt` / `shift` /
/// `meta`）；无法识别的名称返回 `None`，不推测。
///
/// 字母取小写的 keysym：它位于第一组第一级，按下时不带 Shift。
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

/// 无需修饰键即可输入 `sym` 的键码：键盘映射中第一组第一级为 `sym` 的键码。
///
/// `syms` 是 `GetKeyboardMapping` 从 `min` 起按键码排列的 keysym 表，每个键码 `per` 个。
/// 只位于更高级别的 keysym 返回 `None`：按下该键得到的是另一个字符。
pub fn keycode(min: u8, per: usize, syms: &[u32], sym: u32) -> Option<u8> {
    syms.chunks(per.max(1))
        .position(|levels| levels.first() == Some(&sym))
        .and_then(|i| min.checked_add(u8::try_from(i).ok()?))
}

#[cfg(test)]
mod tests {
    use super::{keycode, keysym};

    /// 键码 8 为空，9 为 a/A，10 为空，11 只在第二级上有分号，12 为 Return。
    const SYMS: [u32; 10] = [0, 0, 0x61, 0x41, 0, 0, 0x2c, 0x3b, 0xff0d, 0];

    #[test]
    fn a_keysym_resolves_only_on_the_first_level() {
        assert_eq!(keycode(8, 2, &SYMS, 0x61), Some(9));
        assert_eq!(keycode(8, 2, &SYMS, 0xff0d), Some(12));
        // 大写 A 与分号只位于第二级：按下该键得到的是其他字符。
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
        // 无法识别的名称不推测：不存在该键即不执行此次按键。键名使用规范写法，不接受大写。
        for unknown in ["f25", "f0", "f01", "f+1", "any", "", "A", "win"] {
            assert_eq!(keysym(unknown), None, "{unknown}");
        }
    }

    /// 修饰键取左侧键：`meta` 对应 Super_L。
    #[test]
    fn modifiers_map_to_the_left_hand_keysyms() {
        assert_eq!(keysym("shift"), Some(0xffe1));
        assert_eq!(keysym("ctrl"), Some(0xffe3));
        assert_eq!(keysym("alt"), Some(0xffe9));
        assert_eq!(keysym("meta"), Some(0xffeb));
    }
}
