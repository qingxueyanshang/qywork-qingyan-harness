//! 前台原始输入的真实派发口：CGEvent 投到 HID 事件流。整个进程只有这里向系统发输入。
//!
//! 三条边界：
//!
//! 1. **事件的形状由 `events::Tracker` 定**（类型、点击次数、修饰键标志位），这里只建事件与投递。
//!    一个派发口对应一次动作，按住的键与指针位置在它的批与批之间接着算。
//! 2. **事件源用私有状态表**：合成事件的修饰键标志位只由这里设的那几位决定，不混入用户此刻
//!    实际按着的键。
//! 3. **文字经 `CGEventKeyboardSetUnicodeString` 投递**，每个按键事件带一批 UTF-16 码元，代理对
//!    不跨批。应用可能不读这段文字、改按键码翻译成别的字符，投递结果因此只算「已发出」，
//!    写进去的是什么由动作之后的重读核对。

use std::cell::RefCell;

use objc2_core_foundation::{CFRetained, CGPoint};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventType, CGMouseButton, CGScrollEventUnit,
};

use crate::input::{text_batches, Event, Sink};
use crate::macos::keys::keycode;
use crate::macos::pure::events::{flags_with, Cg, Tracker};
use crate::macos::pure::screen::Mapping;

/// 一个按键事件最多带多少个 UTF-16 码元。单个事件带的文字以 20 个码元为限，超出的部分不保证送达。
const TEXT_UNITS_PER_EVENT: usize = 20;

pub struct MacSink {
    source: CFRetained<CGEventSource>,
    mapping: Mapping,
    tracker: RefCell<Tracker>,
}

/// 一次文字投递的结果，按 UTF-16 码元计。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Typed {
    pub sent: u32,
    pub requested: u32,
    /// 中途停下来的原因。
    pub interrupted: Option<String>,
}

impl MacSink {
    /// `mapping` 是目标窗口的点到像素换算：协议给的屏幕物理像素落点按它换回点。
    pub fn new(mapping: Mapping) -> Result<Self, String> {
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .ok_or_else(|| "input_unavailable: 建不了事件源".to_owned())?;
        // 派发开始那一刻的指针位置：按下与抬起事件要带位置，第一个事件可能不是移动。
        let at =
            CGEvent::new(None).map_or(CGPoint { x: 0.0, y: 0.0 }, |e| CGEvent::location(Some(&e)));
        Ok(Self {
            source,
            mapping,
            tracker: RefCell::new(Tracker::new((at.x, at.y))),
        })
    }

    /// 这个协议键名在 macOS 键盘上有没有键码。
    pub fn resolves(&self, key: &str) -> bool {
        keycode(key).is_some()
    }

    fn build(&self, spec: Cg) -> Option<CFRetained<CGEvent>> {
        match spec {
            Cg::Mouse {
                kind,
                button,
                at,
                clicks,
            } => {
                let event = CGEvent::new_mouse_event(
                    Some(&self.source),
                    CGEventType(kind),
                    CGPoint { x: at.0, y: at.1 },
                    CGMouseButton(button),
                )?;
                if clicks > 0 {
                    CGEvent::set_integer_value_field(
                        Some(&event),
                        CGEventField::MouseEventClickState,
                        clicks,
                    );
                }
                Some(event)
            }
            Cg::Scroll {
                vertical,
                horizontal,
                at,
            } => {
                let event = CGEvent::new_scroll_wheel_event2(
                    Some(&self.source),
                    CGScrollEventUnit::Line,
                    2,
                    vertical,
                    horizontal,
                    0,
                )?;
                CGEvent::set_location(Some(&event), CGPoint { x: at.0, y: at.1 });
                Some(event)
            }
            Cg::Key { code, down, flags } => {
                let event = CGEvent::new_keyboard_event(Some(&self.source), code, down)?;
                let created = CGEvent::flags(Some(&event)).0;
                CGEvent::set_flags(Some(&event), CGEventFlags(flags_with(created, flags)));
                Some(event)
            }
        }
    }

    /// 投出一段文字。`target` 在每一批之前核对前台窗口与焦点，返回 `Err` 即停下并把原因带回。
    pub fn type_text(&self, text: &str, target: &dyn Fn() -> Result<(), String>) -> Typed {
        let batches = text_batches(text, TEXT_UNITS_PER_EVENT);
        let mut typed = Typed {
            sent: 0,
            requested: u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX),
            interrupted: None,
        };
        for batch in &batches {
            if let Err(reason) = target() {
                typed.interrupted = Some(reason);
                break;
            }
            let posted = [true, false].into_iter().all(|down| {
                // 键码 0 只是载体：应用读的是这段文字。修饰键位清零，按住的物理键不改写字符。
                let Some(event) = CGEvent::new_keyboard_event(Some(&self.source), 0, down) else {
                    return false;
                };
                // SAFETY: 指针与长度来自同一个切片，调用期间有效。
                unsafe {
                    CGEvent::keyboard_set_unicode_string(
                        Some(&event),
                        batch.len() as _,
                        batch.as_ptr(),
                    );
                }
                let created = CGEvent::flags(Some(&event)).0;
                CGEvent::set_flags(Some(&event), CGEventFlags(flags_with(created, 0)));
                CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
                true
            });
            if !posted {
                typed.interrupted = Some("input_unavailable: 建不了按键事件".to_owned());
                break;
            }
            typed.sent += u32::try_from(batch.len()).unwrap_or(u32::MAX);
        }
        typed
    }
}

impl Sink for MacSink {
    fn send(&self, events: &[Event]) -> u32 {
        if events.is_empty() {
            return 0;
        }
        let mapping = self.mapping;
        // 键名换算不了时整批不发，状态也不动：发一半会让组合键停在半按下的状态。
        let Some(planned) = self.tracker.borrow_mut().plan(events, |p| mapping.point(p)) else {
            return 0;
        };
        let mut sent = 0u32;
        for spec in planned {
            let Some(event) = self.build(spec) else {
                break;
            };
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
            sent += 1;
        }
        sent
    }
}
