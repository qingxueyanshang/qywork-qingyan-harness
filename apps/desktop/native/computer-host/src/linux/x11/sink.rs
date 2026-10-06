//! 前台原始输入的实际派发端：XTest 的指针、滚轮与按键，以及临时借用空闲键码的文字输入。
//! 整个进程只有此处向 X 服务器发送输入。
//!
//! 四条边界：
//!
//! 1. **键名按当前键盘映射换算为键码，只接受第一组第一级。** keysym 只位于 Shift 级时，
//!    按下该键得到的是另一个字符，这类键名无法换算，整批不发送。
//! 2. **文字只有一条路径：把空闲键码临时映射为字符的 keysym 再按下抬起**，对字符集没有限制，
//!    使用后将映射改回空。应用按处理按键时的键盘映射换算字符，因此每次更改映射之前都必须等待
//!    应用处理完上一批按键（`Display::ping`）；不等待时，排在后面的按键会按新映射或已改回空的
//!    映射换算。
//! 3. **没有空闲键码时不借用正在使用的键**：那会使用户按该键时输入其他字符。如实拒绝。
//! 4. **借用键码的按下与抬起在同一次刷新中送出**，因此不计入按下状态账：账中只有协议键名，
//!    宿主无法补发临时键码。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{ConnectionExt as _, Keycode, Keysym, Window};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::wrapper::ConnectionExt as _;

use super::keys::{keycode, keysym};
use super::Display;
use crate::input::{Event, Sink};
use crate::protocol::MouseButton;

/// XTest 伪造事件的类型，取核心协议的事件号。
const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;
/// 等待应用处理完一批按键或一次映射变化的时间上限。
const PROCESS_LIMIT: Duration = Duration::from_millis(1_000);
/// 一批文字的字符数上限。批与批之间重新核对前台与焦点；每个伪造事件 12 字节，一批的请求量
/// 因此可在一次刷新中送出。
const MAX_BATCH_CHARS: usize = 48;

/// 键盘映射的一份快照。
pub struct Keymap {
    min: Keycode,
    per: usize,
    syms: Vec<Keysym>,
}

impl Keymap {
    pub fn read(display: &Display) -> Result<Self, String> {
        let setup = display.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = display
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(|e| e.to_string())
            .and_then(|c| c.reply().map_err(|e| e.to_string()))
            .map_err(|e| format!("读取键盘映射失败 {e}"))?;
        Ok(Self {
            min,
            per: usize::from(reply.keysyms_per_keycode).max(1),
            syms: reply.keysyms,
        })
    }

    fn keycodes(&self) -> impl Iterator<Item = (Keycode, &[Keysym])> {
        self.syms
            .chunks(self.per)
            .enumerate()
            .filter_map(|(i, syms)| Some((self.min.checked_add(u8::try_from(i).ok()?)?, syms)))
    }

    /// 无需修饰键即可输入该 keysym 的键码，规则见 `keys::keycode`。
    pub fn keycode(&self, sym: Keysym) -> Option<Keycode> {
        keycode(self.min, self.per, &self.syms, sym)
    }

    /// 未映射任何 keysym 的键码。
    pub fn spare(&self) -> Vec<Keycode> {
        self.keycodes()
            .filter(|(_, syms)| syms.iter().all(|s| *s == 0))
            .map(|(code, _)| code)
            .collect()
    }
}

/// 实际派发端。键盘映射在构造时读取一次，同一次动作使用同一份。
pub struct XSink<'a> {
    display: &'a Display,
    keymap: Keymap,
}

/// 一次伪造事件：类型、键码或按钮号、根窗口坐标。
type Fake = (u8, u8, i16, i16);

impl<'a> XSink<'a> {
    pub fn new(display: &'a Display) -> Result<Self, String> {
        Ok(Self {
            display,
            keymap: Keymap::read(display)?,
        })
    }

    /// 该协议键名能否在当前键盘映射中输入。
    pub fn resolves(&self, name: &str) -> bool {
        keysym(name).and_then(|s| self.keymap.keycode(s)).is_some()
    }

    /// 一个事件转换成的伪造事件序列。键名无法换算时返回 `None`。
    fn fakes(&self, event: &Event) -> Option<Vec<Fake>> {
        Some(match *event {
            Event::Move { to } => vec![(
                MOTION_NOTIFY,
                0,
                i16::try_from(to.x).unwrap_or(if to.x < 0 { i16::MIN } else { i16::MAX }),
                i16::try_from(to.y).unwrap_or(if to.y < 0 { i16::MIN } else { i16::MAX }),
            )],
            Event::Button { button, down } => vec![(
                if down { BUTTON_PRESS } else { BUTTON_RELEASE },
                button_number(button),
                0,
                0,
            )],
            // 滚轮在 X11 中是按钮：4 上、5 下、6 左、7 右，每一格对应一次按下与抬起。
            Event::Wheel {
                notches,
                horizontal,
            } => {
                let button = match (horizontal, notches > 0) {
                    (false, true) => 4,
                    (false, false) => 5,
                    (true, false) => 6,
                    (true, true) => 7,
                };
                (0..notches.unsigned_abs())
                    .flat_map(|_| [(BUTTON_PRESS, button, 0, 0), (BUTTON_RELEASE, button, 0, 0)])
                    .collect()
            }
            Event::Key { ref key, down } => {
                let code = self.keymap.keycode(keysym(key)?)?;
                vec![(if down { KEY_PRESS } else { KEY_RELEASE }, code, 0, 0)]
            }
        })
    }

    /// 将伪造事件放入请求缓冲区。返回已放入的个数。
    fn queue(&self, fakes: &[Fake]) -> usize {
        fakes
            .iter()
            .take_while(|&&(kind, detail, x, y)| {
                self.display
                    .conn
                    .xtest_fake_input(kind, detail, 0, self.display.root, x, y, 0)
                    .is_ok()
            })
            .count()
    }

    /// 刷新请求并等待服务器处理完毕：回执之后的读取必须能观察到这些输入的效果。
    fn deliver(&self) -> bool {
        self.display.conn.flush().is_ok() && self.display.conn.sync().is_ok()
    }
}

const fn button_number(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 1,
        MouseButton::Middle => 2,
        MouseButton::Right => 3,
    }
}

impl Sink for XSink<'_> {
    fn send(&self, events: &[Event]) -> u32 {
        if events.is_empty() {
            return 0;
        }
        // 键名无法换算时整批不发送：只发送一部分会使组合键停留在部分按下的状态。
        let Some(batches) = events
            .iter()
            .map(|e| self.fakes(e))
            .collect::<Option<Vec<_>>>()
        else {
            return 0;
        };
        let mut sent = 0u32;
        for fakes in &batches {
            if self.queue(fakes) < fakes.len() {
                break;
            }
            sent += 1;
        }
        if !self.deliver() {
            return 0;
        }
        sent
    }
}

/// 一次文字输入的结果。字数按 Unicode 字符计。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Typed {
    /// 已按下并抬起的字符数。
    pub sent: u32,
    pub requested: u32,
    /// 中途停止的原因。
    pub interrupted: Option<String>,
}

impl XSink<'_> {
    /// 按空闲键码分批输入文字，见本模块第 2 条。
    ///
    /// `target` 在每一批之前核对前台与焦点，返回 `Err` 即停止并返回原因。借用的键码在任何
    /// 返回路径上都改回空映射。
    pub fn type_text(
        &self,
        window: Window,
        text: &str,
        target: &dyn Fn() -> Result<(), String>,
    ) -> Result<Typed, String> {
        let spare = self.keymap.spare();
        if spare.is_empty() {
            return Err("no_spare_keycode: 键盘映射中没有空闲键码，无法输入文字".to_owned());
        }
        let chars: Vec<char> = text.chars().collect();
        let mut typed = Typed {
            sent: 0,
            requested: u32::try_from(chars.len()).unwrap_or(u32::MAX),
            interrupted: None,
        };
        let mut borrowed: HashSet<Keycode> = HashSet::new();
        for batch in batches(&chars, spare.len()) {
            if let Err(reason) = target() {
                typed.interrupted = Some(reason);
                break;
            }
            let mut codes: HashMap<char, Keycode> = HashMap::new();
            for ch in batch {
                if !codes.contains_key(ch) {
                    // `batches` 保证一批中不同字符的数量不超过空闲键码数。
                    codes.insert(*ch, spare[codes.len()]);
                }
            }
            for (ch, code) in &codes {
                let sym = char_keysym(*ch);
                borrowed.insert(*code);
                if self.remap(*code, sym).is_err() {
                    typed.interrupted = Some("x11_failed: 更改键盘映射失败".to_owned());
                    break;
                }
            }
            if typed.interrupted.is_some() {
                break;
            }
            if let Err(reason) = self.settle(window) {
                typed.interrupted = Some(reason);
                break;
            }
            let fakes: Vec<Fake> = batch
                .iter()
                .flat_map(|ch| {
                    let code = codes[ch];
                    [(KEY_PRESS, code, 0, 0), (KEY_RELEASE, code, 0, 0)]
                })
                .collect();
            let queued = self.queue(&fakes);
            if !self.deliver() {
                typed.interrupted = Some("x11_failed: 按键未送达 X 服务器".to_owned());
                break;
            }
            typed.sent += u32::try_from(queued / 2).unwrap_or(u32::MAX);
            if queued < fakes.len() {
                break;
            }
            if let Err(reason) = self.settle(window) {
                typed.interrupted = Some(reason);
                break;
            }
        }
        for code in borrowed {
            let _ = self.remap(code, 0);
        }
        let _ = self.deliver();
        Ok(typed)
    }

    /// 把键码第一组的两级都映射为 `sym`；0 即改回空映射。两级相同，因此无论按下时是否带 Shift，
    /// 得到的都是该字符。
    fn remap(&self, code: Keycode, sym: Keysym) -> Result<(), String> {
        self.display
            .conn
            .change_keyboard_mapping(1, code, 2, &[sym, sym])
            .map_err(|e| e.to_string())
            .and_then(|_| self.display.conn.flush().map_err(|e| e.to_string()))
    }

    /// 等待目标应用处理完此前送达的映射变化与按键。
    fn settle(&self, window: Window) -> Result<(), String> {
        self.display.ping(window, PROCESS_LIMIT)
    }
}

/// 一个字符对应的 keysym。换行与回车按回车键，制表符按制表键；Latin-1 的可见字符是码位
/// 本身，其余字符是 0x0100_0000 加码位。
pub fn char_keysym(ch: char) -> Keysym {
    match ch {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        ' '..='~' | '\u{a0}'..='\u{ff}' => u32::from(ch),
        _ => 0x0100_0000 | u32::from(ch),
    }
}

/// 将字符切分成批：每批中不同的字符不超过 `width` 个（每个不同的字符占用一个空闲键码），
/// 总数不超过 `MAX_BATCH_CHARS`。
fn batches(chars: &[char], width: usize) -> Vec<&[char]> {
    let width = width.max(1);
    let mut out = Vec::new();
    let mut start = 0;
    let mut seen: HashSet<char> = HashSet::new();
    for (i, ch) in chars.iter().enumerate() {
        if (!seen.contains(ch) && seen.len() == width) || i - start == MAX_BATCH_CHARS {
            out.push(&chars[start..i]);
            start = i;
            seen.clear();
        }
        seen.insert(*ch);
    }
    if start < chars.len() {
        out.push(&chars[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{key_names, Modifier};

    /// 词表中的每个键名、每个修饰键都有 keysym：没有 keysym 的键名在任何键盘映射下都无法输入。
    #[test]
    fn every_protocol_key_has_a_keysym() {
        let modifiers = [
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
            Modifier::Meta,
        ];
        for name in key_names().chain(modifiers.map(|m| m.key_name().to_owned())) {
            assert!(keysym(&name).is_some(), "{name} 没有 keysym");
        }
    }

    fn keymap() -> Keymap {
        // 键码 8 为空，9 为 a/A，10 为空，11 只在第二级上有分号，12 为 Return。
        Keymap {
            min: 8,
            per: 2,
            syms: vec![0, 0, 0x61, 0x41, 0, 0, 0x2c, 0x3b, 0xff0d, 0],
        }
    }

    #[test]
    fn a_keysym_resolves_only_on_the_first_level() {
        let map = keymap();
        assert_eq!(map.keycode(0x61), Some(9));
        assert_eq!(map.keycode(0xff0d), Some(12));
        // 大写 A 与分号只位于第二级：按下该键得到的是其他字符。
        assert_eq!(map.keycode(0x41), None);
        assert_eq!(map.keycode(0x3b), None);
    }

    #[test]
    fn spare_keycodes_have_no_keysym_at_all() {
        assert_eq!(keymap().spare(), vec![8, 10]);
    }

    #[test]
    fn characters_map_to_latin1_or_unicode_keysyms() {
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym(' '), 0x20);
        assert_eq!(char_keysym('é'), 0xe9);
        assert_eq!(char_keysym('你'), 0x0100_4f60);
        assert_eq!(char_keysym('—'), 0x0100_2014);
        assert_eq!(char_keysym('🙂'), 0x0101_f642);
        assert_eq!(char_keysym('\n'), 0xff0d);
        assert_eq!(char_keysym('\t'), 0xff09);
    }

    /// 每批中不同的字符不超过空闲键码数，重复的字符不另外占用键码，各批按顺序拼接即为原文。
    #[test]
    fn text_is_cut_into_batches_of_distinct_characters() {
        let chars: Vec<char> = "hello 你好你好".chars().collect();
        let cut = batches(&chars, 3);
        let joined: String = cut.iter().flat_map(|b| b.iter()).collect();
        assert_eq!(joined, "hello 你好你好");
        for batch in &cut {
            let distinct: HashSet<&char> = batch.iter().collect();
            assert!(distinct.len() <= 3, "{batch:?}");
        }
        assert_eq!(cut.len(), 3);
        assert!(batches(&[], 3).is_empty());
        // 宽度为 1 时每批只有一种字符，连续重复的字符留在同一批。
        let chars: Vec<char> = "aab".chars().collect();
        assert_eq!(batches(&chars, 1), vec![&['a', 'a'][..], &['b'][..]]);
        // 无论重复的字符有多少，一批都不超过字符数上限。
        let chars = vec!['x'; MAX_BATCH_CHARS * 2 + 1];
        let lengths: Vec<usize> = batches(&chars, 18).iter().map(|b| b.len()).collect();
        assert_eq!(lengths, vec![MAX_BATCH_CHARS, MAX_BATCH_CHARS, 1]);
    }
}
