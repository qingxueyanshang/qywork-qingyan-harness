//! 前台原始输入的实际派发端：CGEvent 投递到 HID 事件流。整个进程只有此处向系统发送输入。
//!
//! 三条边界：
//!
//! 1. **事件的形状由 `events::Tracker` 确定**（类型、点击次数、修饰键标志位），此处只负责创建与
//!    投递事件。一个派发端对应一次动作，按下的键与指针位置在该动作的各批之间连续计算。
//! 2. **事件源使用私有状态表**：合成事件的修饰键标志位只由此处设置的标志位决定，不混入用户当前
//!    实际按下的键。
//! 3. **文字经由 `CGEventKeyboardSetUnicodeString` 投递**，每个按键事件携带一批 UTF-16 码元，代理对
//!    不跨批。应用可能不读取这段文字，而按键码翻译为其他字符，投递结果因此只记为「已发出」，
//!    实际写入的内容由动作之后的重读核对。

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

/// 一个按键事件携带的 UTF-16 码元数上限。单个事件携带的文字以 20 个码元为限，超出的部分不保证送达。
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
    /// 中途停止的原因。
    pub interrupted: Option<String>,
}

impl MacSink {
    /// `mapping` 是目标窗口的点与像素之间的换算：协议提供的屏幕物理像素落点按它换算为点。
    pub fn new(mapping: Mapping) -> Result<Self, String> {
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .ok_or_else(|| "input_unavailable: 无法创建事件源".to_owned())?;
        // 派发开始时的指针位置：按下与抬起事件必须携带位置，第一个事件可能不是移动。
        let at =
            CGEvent::new(None).map_or(CGPoint { x: 0.0, y: 0.0 }, |e| CGEvent::location(Some(&e)));
        Ok(Self {
            source,
            mapping,
            tracker: RefCell::new(Tracker::new((at.x, at.y))),
        })
    }

    /// 该协议键名在 macOS 键盘上是否有键码。
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

    /// 投递一段文字。`target` 在每一批之前核对前台窗口与焦点，返回 `Err` 即停止并返回原因。
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
                // 键码 0 只是载体：应用读取的是这段文字。修饰键位清零，按下的物理键不改写字符。
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
                typed.interrupted = Some("input_unavailable: 无法创建按键事件".to_owned());
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
        // 键名无法换算时整批不发送，状态也不改变：只发送一部分会使组合键停留在部分按下的状态。
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
