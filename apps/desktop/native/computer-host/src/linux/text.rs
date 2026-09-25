//! 文本：读文档文本与选区，以及协议偏移与应用偏移之间的换算。
//!
//! 协议里的偏移与长度一律按 UTF-16 码元计。AT-SPI 规定 Text 接口按字符（Unicode 码位）计，
//! GTK 照此实现；Qt 按 UTF-16 码元计（交出的是 `QString` 的下标）。两种数法只在 BMP 之外的
//! 字符上不同，所以每次按 `GetText` 交回的文本判这个应用用的是哪一种，不按工具包名推断。

use atspi::proxy::text::TextProxyBlocking;
use zbus::blocking::Connection;

use super::bus::{dbus, Failure, Obj};
use crate::protocol::{now_ms, Observation, Text, TextSelection};

/// 一次选区起点查询最多读多少个字符。起点超过它时按它记。
const MAX_OFFSET_PROBE: i32 = 100_000;

/// 按 UTF-16 码元截断。截断点落在代理对中间时那一个字符换成替换字符。
pub fn clip_utf16(text: &str, max_units: u32) -> (String, bool) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let limit = max_units as usize;
    if units.len() <= limit {
        return (text.to_owned(), false);
    }
    (String::from_utf16_lossy(&units[..limit]), true)
}

/// UTF-16 码元偏移换成字符偏移。落在代理对中间或超出文本末尾时交回 `None`。
pub fn char_offset(text: &str, units: u32) -> Option<i32> {
    let mut at = 0u32;
    for (index, c) in text.chars().enumerate() {
        if at == units {
            return i32::try_from(index).ok();
        }
        at += u32::try_from(c.len_utf16()).unwrap_or(2);
        if at > units {
            return None;
        }
    }
    (at == units).then(|| i32::try_from(text.chars().count()).unwrap_or(i32::MAX))
}

/// 这段文本有多少个 UTF-16 码元。
pub fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

/// 应用的 Text 接口按什么数偏移。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Units {
    Chars,
    Utf16,
}

/// 按 `GetText(0, asked)` 交回的文本判数法：交回的字符数等于 `asked` 是按字符，UTF-16 码元数
/// 等于 `asked` 是按码元。文本不含 BMP 之外的字符时两者一致，按字符算，换算结果相同。
pub fn units_of(asked: i32, text: &str) -> Units {
    let chars = i32::try_from(text.chars().count()).unwrap_or(i32::MAX);
    let units = i32::try_from(utf16_len(text)).unwrap_or(i32::MAX);
    if chars != asked && units == asked {
        Units::Utf16
    } else {
        Units::Chars
    }
}

/// 这段文本按给定数法有多长。
fn measure(units: Units, text: &str) -> i32 {
    match units {
        Units::Chars => i32::try_from(text.chars().count()).unwrap_or(i32::MAX),
        Units::Utf16 => i32::try_from(utf16_len(text)).unwrap_or(i32::MAX),
    }
}

/// 读一个对象的文本与全部选区。
///
/// `selectable` 为真时报 `single`：AT-SPI 没有「支持哪种选区」这一项，可编辑文本与带
/// `selectable-text` 的文本能设选区，GTK 只支持一段。
pub fn read(
    conn: &Connection,
    window: i64,
    reference: &str,
    obj: &Obj,
    selectable: bool,
    max_chars: u32,
) -> Result<Observation, Failure> {
    let text: TextProxyBlocking = obj.proxy(conn)?;
    let count = text.character_count().map_err(dbus("读字符数"))?;
    // 多要一个字符：要回来的比上限长就说明后面还有内容。
    let want = count.min(
        i32::try_from(max_chars)
            .unwrap_or(i32::MAX)
            .saturating_add(1),
    );
    let head = text.get_text(0, want).map_err(dbus("读文本"))?;
    let (body, clipped) = clip_utf16(&head, max_chars);
    let fetched = measure(units_of(want, &head), &head);
    let mut selection = Vec::new();
    // GTK 3 的树表格单元对选区数交回 -1。
    let n = text.get_n_selections().map_err(dbus("读选区条数"))?.max(0);
    for index in 0..n {
        let (start, end) = text.get_selection(index).map_err(dbus("读选区"))?;
        let prefix = text
            .get_text(0, start.clamp(0, MAX_OFFSET_PROBE))
            .map_err(dbus("读选区之前的文本"))?;
        let limit = start.saturating_add(
            i32::try_from(max_chars)
                .unwrap_or(i32::MAX)
                .saturating_add(1),
        );
        let piece = text
            .get_text(start, end.min(limit))
            .map_err(dbus("读选区文本"))?;
        let (piece, truncated) = clip_utf16(&piece, max_chars);
        selection.push(TextSelection {
            start: utf16_len(&prefix),
            text: piece,
            truncated,
        });
    }
    Ok(Observation::Text(Text {
        window,
        captured_at: now_ms(),
        scope: reference.to_owned(),
        text: body,
        truncated: clipped || count > fetched,
        selection_support: if selectable { "single" } else { "none" },
        selection,
    }))
}

/// 把 UTF-16 码元的 `start` 与 `length` 换成应用数法下的偏移区间。偏移落在代理对中间或超出
/// 文本末尾即拒绝，不就近取整：取整之后选中的就不是调用方要的那一段。
pub fn char_range(
    conn: &Connection,
    obj: &Obj,
    start: u32,
    length: u32,
) -> Result<(i32, i32), String> {
    let text: TextProxyBlocking = obj.proxy(conn).map_err(Failure::into_reason)?;
    let count = text
        .character_count()
        .map_err(dbus("读字符数"))
        .map_err(Failure::into_reason)?;
    let end_units = start.saturating_add(length);
    // 一个字符至少一个码元，所以两种数法下前 `end_units` 个单位都盖得住这段区间。
    let want = count.min(i32::try_from(end_units).unwrap_or(i32::MAX));
    let head = text
        .get_text(0, want)
        .map_err(dbus("读文本"))
        .map_err(Failure::into_reason)?;
    let out_of_range = || {
        format!(
            "out_of_range: 起点 {start} 长度 {length} 不落在字符边界上，或超出文本的 {} 个码元",
            utf16_len(&head)
        )
    };
    let from = char_offset(&head, start).ok_or_else(out_of_range)?;
    let to = char_offset(&head, end_units).ok_or_else(out_of_range)?;
    Ok(match units_of(want, &head) {
        Units::Chars => (from, to),
        Units::Utf16 => (
            i32::try_from(start).unwrap_or(i32::MAX),
            i32::try_from(end_units).unwrap_or(i32::MAX),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_become_character_offsets() {
        let text = "a🙂b中";
        assert_eq!(char_offset(text, 0), Some(0));
        assert_eq!(char_offset(text, 1), Some(1));
        // 🙂 占两个码元，偏移 2 落在代理对中间。
        assert_eq!(char_offset(text, 2), None);
        assert_eq!(char_offset(text, 3), Some(2));
        assert_eq!(char_offset(text, 4), Some(3));
        assert_eq!(char_offset(text, 5), Some(4));
        assert_eq!(char_offset(text, 6), None);
        assert_eq!(utf16_len(text), 5);
    }

    /// GTK 按字符数，Qt 按 UTF-16 码元数：「world 中文🙂」GTK 报 9 个字符，Qt 报 10。
    #[test]
    fn the_counting_unit_is_read_off_the_returned_text() {
        let text = "world 中文🙂";
        assert_eq!(units_of(9, text), Units::Chars);
        assert_eq!(units_of(10, text), Units::Utf16);
        assert_eq!(measure(Units::Chars, text), 9);
        assert_eq!(measure(Units::Utf16, text), 10);
        // 不含 BMP 之外的字符时两种数法一致。
        assert_eq!(units_of(5, "hello"), Units::Chars);
    }

    /// 截断按 UTF-16 码元算：中文一个字一个码元，emoji 是一对代理。
    #[test]
    fn text_is_clipped_by_utf16_units_and_marked() {
        assert_eq!(clip_utf16("中文内容", 10), ("中文内容".to_owned(), false));
        assert_eq!(clip_utf16("中文内容", 2), ("中文".to_owned(), true));
        assert_eq!(clip_utf16("", 4), (String::new(), false));
        assert_eq!(clip_utf16("a🙂b", 2), ("a\u{fffd}".to_owned(), true));
    }
}
