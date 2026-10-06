//! AX 元素属性到 `Facts` 的换算、AX 错误码的归类，以及 UTF-16 文本的截断与切片。
//!
//! 本模块不调用 AX。FFI 层把 CF 值转换为 `Raw` 后传入，换算规则因此可在任何目标上测试。

use crate::geometry::ScreenRect;
use crate::protocol::{ACCESSIBILITY_NOT_TRUSTED, REF_STALE, SCREEN_RECORDING_NOT_GRANTED};

/// AX 属性名。系统头文件将它们定义为 `CFSTR` 宏，绑定库中没有对应的常量。
pub mod attr {
    pub const ROLE: &str = "AXRole";
    pub const SUBROLE: &str = "AXSubrole";
    pub const TITLE: &str = "AXTitle";
    pub const DESCRIPTION: &str = "AXDescription";
    pub const IDENTIFIER: &str = "AXIdentifier";
    pub const VALUE: &str = "AXValue";
    pub const MIN_VALUE: &str = "AXMinValue";
    pub const MAX_VALUE: &str = "AXMaxValue";
    pub const ENABLED: &str = "AXEnabled";
    pub const FOCUSED: &str = "AXFocused";
    pub const SELECTED: &str = "AXSelected";
    pub const EXPANDED: &str = "AXExpanded";
    pub const DISCLOSING: &str = "AXDisclosing";
    pub const MINIMIZED: &str = "AXMinimized";
    pub const ORIENTATION: &str = "AXOrientation";
    pub const POSITION: &str = "AXPosition";
    pub const SIZE: &str = "AXSize";
    pub const CHARACTERS: &str = "AXNumberOfCharacters";
    pub const SELECTED_TEXT_RANGE: &str = "AXSelectedTextRange";
    pub const SELECTED_ROWS: &str = "AXSelectedRows";
    pub const SELECTED_CHILDREN: &str = "AXSelectedChildren";
    pub const CHILDREN: &str = "AXChildren";
    pub const WINDOWS: &str = "AXWindows";
    /// Electron 应用只在该属性为真时向 AX 提供网页内容。只写入应用元素，不写入窗口。
    pub const MANUAL_ACCESSIBILITY: &str = "AXManualAccessibility";
    /// 窗口是否全屏。协议的「最大化」对应该属性，见 `plan::window_steps`。
    pub const FULL_SCREEN: &str = "AXFullScreen";
    /// 窗口的关闭按钮元素。
    pub const CLOSE_BUTTON: &str = "AXCloseButton";
    /// 应用元素上：该应用是否为前台应用。写入真值即将其切换到前台。
    pub const FRONTMOST: &str = "AXFrontmost";
    /// 系统范围元素上：前台应用的应用元素。
    pub const FOCUSED_APPLICATION: &str = "AXFocusedApplication";
    /// 应用元素上：接收键盘输入的窗口。
    pub const FOCUSED_WINDOW: &str = "AXFocusedWindow";
}

/// AX 动作名。
pub mod action {
    pub const PRESS: &str = "AXPress";
    pub const INCREMENT: &str = "AXIncrement";
    pub const DECREMENT: &str = "AXDecrement";
    pub const SCROLL_TO_VISIBLE: &str = "AXScrollToVisible";
    /// 将窗口置于所在应用全部窗口的最上层。不改变前台应用。
    pub const RAISE: &str = "AXRaise";
}

/// 一次批量读取的属性，顺序即 `Facts::decode` 使用的下标。FFI 层在末尾追加 `AXChildren`，
/// 子节点与属性在同一次跨进程调用中取回。
///
/// 不含 `AXValue`：文本区的值是整篇文档，按 `AXNumberOfCharacters` 判定长度后才单独读取，
/// 见 `wants_value`。
pub const BATCH: [&str; 20] = [
    attr::ROLE,
    attr::SUBROLE,
    attr::TITLE,
    attr::DESCRIPTION,
    attr::IDENTIFIER,
    attr::MIN_VALUE,
    attr::MAX_VALUE,
    attr::ENABLED,
    attr::FOCUSED,
    attr::SELECTED,
    attr::EXPANDED,
    attr::DISCLOSING,
    attr::MINIMIZED,
    attr::ORIENTATION,
    attr::POSITION,
    attr::SIZE,
    attr::CHARACTERS,
    attr::SELECTED_TEXT_RANGE,
    attr::SELECTED_ROWS,
    attr::SELECTED_CHILDREN,
];

/// 节点值中文本的 UTF-16 码元数上限。超过即不携带文本，调用方经 `read_text` 读取全文。
///
/// 不要改为截取前缀后返回：终端与长文档的前缀是最早的内容，不是正在显示的内容，而节点值
/// 没有「已截断」标记。
pub const VALUE_TEXT_LIMIT: u32 = 4096;

/// 单个属性读取到的值，已从 CF 类型转换为与平台无关的形式。
#[derive(Debug, Clone, PartialEq)]
pub enum Raw {
    /// 元素不支持该属性、该属性没有值，或读取出错。批量读取把单项错误放在对应位置上，
    /// 不使整次读取失败。
    Missing,
    Text(String),
    Number(f64),
    Bool(bool),
    Point {
        x: f64,
        y: f64,
    },
    Size {
        width: f64,
        height: f64,
    },
    Range {
        location: i64,
        length: i64,
    },
    /// 元素、数组等换算中不使用的类型。
    Other,
}

impl Raw {
    fn text(&self) -> String {
        match self {
            Self::Text(s) => s.clone(),
            _ => String::new(),
        }
    }

    fn number(&self) -> Option<f64> {
        match self {
            Self::Number(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    /// 布尔属性。应用可能提供 `CFBoolean`，也可能提供取值 0 / 1 的 `CFNumber`。
    pub fn flag(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            Self::Number(n) => Some(*n != 0.0),
            _ => None,
        }
    }

    /// 非负计数。
    fn count(&self) -> Option<u32> {
        self.number()
            .filter(|n| *n >= 0.0)
            .map(|n| u32::try_from(n as u64).unwrap_or(u32::MAX))
    }

    fn range(&self) -> Option<(u32, u32)> {
        match self {
            Self::Range { location, length } => {
                Some((u32::try_from(*location).ok()?, u32::try_from(*length).ok()?))
            }
            _ => None,
        }
    }
}

/// `AXValue` 的三种取值形式。复选框与单选按钮的状态、滑块的数值均为 `Number`。
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Value {
    #[default]
    Absent,
    Text(String),
    Number(f64),
}

impl Value {
    pub fn of(raw: &Raw) -> Self {
        match raw {
            Raw::Text(s) => Self::Text(s.clone()),
            Raw::Bool(b) => Self::Number(if *b { 1.0 } else { 0.0 }),
            Raw::Number(n) if n.is_finite() => Self::Number(*n),
            _ => Self::Absent,
        }
    }

    pub fn number(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            _ => None,
        }
    }
}

/// 屏幕矩形，单位是点，原点是主显示器左上角。AX 的位置与尺寸、CGWindowList 的窗口矩形均使用该类型。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    /// 由 `AXPosition` 与 `AXSize` 组成。任一缺席、非有限或零尺寸即缺席。
    pub fn of(position: &Raw, size: &Raw) -> Option<Self> {
        let (Raw::Point { x, y }, Raw::Size { width, height }) = (position, size) else {
            return None;
        };
        let frame = Self {
            x: *x,
            y: *y,
            width: *width,
            height: *height,
        };
        ([frame.x, frame.y, frame.width, frame.height]
            .iter()
            .all(|v| v.is_finite())
            && frame.width > 0.0
            && frame.height > 0.0)
            .then_some(frame)
    }

    /// 取整到点。两种来源的矩形均为浮点数，比较与求交均按整点进行。
    pub fn rounded(&self) -> ScreenRect {
        let at = |v: f64| v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
        ScreenRect {
            x: at(self.x),
            y: at(self.y),
            width: at(self.width),
            height: at(self.height),
        }
    }
}

/// 属性表中哪些属性可写。只查询与可用动作有关的属性，见 `node::settable_queries`。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Settable {
    pub value: bool,
    pub selected: bool,
    pub expanded: bool,
    pub disclosing: bool,
    pub text_range: bool,
    pub selected_rows: bool,
    pub selected_children: bool,
}

impl Settable {
    /// 记录一项查询结果。不在上述字段中的属性名被忽略。
    pub fn record(&mut self, attribute: &str, settable: bool) {
        let slot = match attribute {
            attr::VALUE => &mut self.value,
            attr::SELECTED => &mut self.selected,
            attr::EXPANDED => &mut self.expanded,
            attr::DISCLOSING => &mut self.disclosing,
            attr::SELECTED_TEXT_RANGE => &mut self.text_range,
            attr::SELECTED_ROWS => &mut self.selected_rows,
            attr::SELECTED_CHILDREN => &mut self.selected_children,
            _ => return,
        };
        *slot = settable;
    }
}

/// 单个元素读取到的全部事实。
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub role: String,
    pub subrole: String,
    pub title: String,
    pub description: String,
    /// `AXIdentifier`：应用开发者可选设置，多数控件为空。
    pub identifier: String,
    pub value: Value,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub enabled: Option<bool>,
    pub focused: Option<bool>,
    pub selected: Option<bool>,
    pub expanded: Option<bool>,
    pub disclosing: Option<bool>,
    pub minimized: Option<bool>,
    pub orientation: String,
    pub frame: Option<Frame>,
    /// `AXNumberOfCharacters`，UTF-16 码元数。具有该属性的元素有文本模型。
    pub characters: Option<u32>,
    /// `AXSelectedTextRange`：起点与长度，UTF-16 码元。
    pub text_range: Option<(u32, u32)>,
    /// 元素具有 `AXSelectedRows`：表格与大纲的选中行经由该属性修改。
    pub selects_rows: bool,
    /// 元素具有 `AXSelectedChildren`：列表类容器的选中项经由该属性修改。
    pub selects_children: bool,
    /// `AXUIElementCopyActionNames` 的结果。
    pub actions: Vec<String>,
    pub settable: Settable,
}

impl Facts {
    /// 按 `BATCH` 的顺序解析一次批量读取。`values` 短于 `BATCH` 时，缺少的项按缺席处理。
    ///
    /// `AXValue`、动作表与可写性不在批量读取中，由调用方随后填入。
    pub fn decode(values: &[Raw]) -> Self {
        let at = |i: usize| values.get(i).unwrap_or(&Raw::Missing);
        let present = |i: usize| !matches!(at(i), Raw::Missing);
        Self {
            role: at(0).text(),
            subrole: at(1).text(),
            title: at(2).text(),
            description: at(3).text(),
            identifier: at(4).text(),
            value: Value::Absent,
            min: at(5).number(),
            max: at(6).number(),
            enabled: at(7).flag(),
            focused: at(8).flag(),
            selected: at(9).flag(),
            expanded: at(10).flag(),
            disclosing: at(11).flag(),
            minimized: at(12).flag(),
            orientation: at(13).text(),
            frame: Frame::of(at(14), at(15)),
            characters: at(16).count(),
            text_range: at(17).range(),
            selects_rows: present(18),
            selects_children: present(19),
            actions: Vec::new(),
            settable: Settable::default(),
        }
    }

    pub fn has_action(&self, name: &str) -> bool {
        self.actions.iter().any(|a| a == name)
    }
}

/// 是否单独读取一次 `AXValue`。
///
/// 有文本模型的元素先检查长度，超过 `VALUE_TEXT_LIMIT` 不读取：终端与文档的值是全文，每次观察都会
/// 跨进程传输一遍。`whole` 为真时不检查长度：动作与文本读取只针对单个元素，需要的就是全文。
pub fn wants_value(characters: Option<u32>, whole: bool) -> bool {
    whole || characters.map_or(true, |n| n <= VALUE_TEXT_LIMIT)
}

/// AXError 的取值。`AXError` 类型只存在于 macOS 绑定中，判定写成整数才能在其他目标上测试。
pub mod code {
    pub const SUCCESS: i32 = 0;
    pub const FAILURE: i32 = -25200;
    pub const ILLEGAL_ARGUMENT: i32 = -25201;
    pub const INVALID_UI_ELEMENT: i32 = -25202;
    pub const CANNOT_COMPLETE: i32 = -25204;
    pub const ATTRIBUTE_UNSUPPORTED: i32 = -25205;
    pub const ACTION_UNSUPPORTED: i32 = -25206;
    pub const NOT_IMPLEMENTED: i32 = -25208;
    pub const API_DISABLED: i32 = -25211;
    pub const NO_VALUE: i32 = -25212;
}

/// 错误码的名称，写入回执原文。
pub fn error_name(value: i32) -> String {
    match value {
        code::SUCCESS => "kAXErrorSuccess".to_owned(),
        code::FAILURE => "kAXErrorFailure".to_owned(),
        code::ILLEGAL_ARGUMENT => "kAXErrorIllegalArgument".to_owned(),
        code::INVALID_UI_ELEMENT => "kAXErrorInvalidUIElement".to_owned(),
        code::CANNOT_COMPLETE => "kAXErrorCannotComplete".to_owned(),
        code::ATTRIBUTE_UNSUPPORTED => "kAXErrorAttributeUnsupported".to_owned(),
        code::ACTION_UNSUPPORTED => "kAXErrorActionUnsupported".to_owned(),
        code::NOT_IMPLEMENTED => "kAXErrorNotImplemented".to_owned(),
        code::API_DISABLED => "kAXErrorAPIDisabled".to_owned(),
        code::NO_VALUE => "kAXErrorNoValue".to_owned(),
        other => format!("AXError {other}"),
    }
}

/// 辅助功能授权缺失时全部读取与动作的拒绝原因。原因码取 `ACCESSIBILITY_NOT_TRUSTED`：
/// 服务循环按该原因码即时查询授权事实，原因码写错会使运行中撤销的授权无法报告。
pub fn not_trusted() -> String {
    format!(
        "{ACCESSIBILITY_NOT_TRUSTED}: 系统设置的「隐私与安全性 › 辅助功能」中未允许 qywork，无法读取控件树，也无法执行控件动作"
    )
}

/// 屏幕录制授权缺失时截图的拒绝原因。原因码取 `SCREEN_RECORDING_NOT_GRANTED`，理由同上。
pub fn no_screen_recording() -> String {
    format!(
        "{SCREEN_RECORDING_NOT_GRANTED}: 系统设置的「隐私与安全性」中未授予 qywork 屏幕录制权限，无法截图"
    )
}

/// 目标窗口或其所在的应用已不存在时的原因码。
pub const TARGET_LOST: &str = "target_lost";

/// 一次 AX 调用失败的分类。
///
/// 超时与对象消失必须区分：应用不应答时对象仍存在，调用方应重试或放弃该步骤；报告为对象
/// 消失会使调用方转而重新发现目标。
#[derive(Debug)]
pub enum Failure {
    /// 调用在消息上界内未应答。
    Timeout(String),
    /// 元素已不存在，或其所在的应用已退出（`app` 为真）。
    Gone { app: bool, text: String },
    /// 其余 AX 错误，保留原文。
    Ax(String),
    /// worker 自行判定的拒绝，已附带原因码。
    Refused(String),
}

impl Failure {
    /// 按错误码归类。`alive` 表示元素所在进程当前是否仍存在。
    ///
    /// 进程退出之后 AX 对它的调用返回 `kAXErrorCannotComplete`，与应用不应答是同一个错误码，因此
    /// 该错误码须结合进程是否存在才能区分；不要只按错误码判定超时，否则已退出的应用会被报告为「不应答」。
    pub fn from_ax(step: &str, value: i32, alive: bool) -> Self {
        let text = format!("{step}失败：{}", error_name(value));
        match value {
            code::CANNOT_COMPLETE | code::INVALID_UI_ELEMENT if !alive => {
                Self::Gone { app: true, text }
            }
            code::CANNOT_COMPLETE => Self::Timeout(text),
            code::INVALID_UI_ELEMENT => Self::Gone { app: false, text },
            code::API_DISABLED => Self::Refused(not_trusted()),
            _ => Self::Ax(text),
        }
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Timeout(_))
    }

    /// 目标控件已不存在：元素消失、应用退出，或按 `ref` 定位时该位置已换成其他控件。
    pub fn is_gone(&self) -> bool {
        match self {
            Self::Gone { .. } => true,
            Self::Refused(text) => text.starts_with(REF_STALE) || text.starts_with(TARGET_LOST),
            Self::Timeout(_) | Self::Ax(_) => false,
        }
    }

    /// 转换为回执原文。
    pub fn into_reason(self) -> String {
        match self {
            Self::Timeout(text) => format!("provider_timeout: {text}"),
            Self::Gone { app: true, text } => format!("{TARGET_LOST}: {text}"),
            Self::Gone { app: false, text } => format!("{REF_STALE}: {text}"),
            Self::Ax(text) | Self::Refused(text) => text,
        }
    }
}

/// 已发出的动作调用失败时的原因原文。调用已送达应用，调用方一律记为结果未知。
///
/// `kAXErrorCannotComplete` 不等于动作失败：应用在动作回调中进行模态处理时，调用在消息上界内
/// 无法得到回复，动作本身可能已经生效。
pub fn action_error(step: &str, value: i32) -> String {
    if value == code::CANNOT_COMPLETE {
        format!(
            "call_unconfirmed: {step} 在消息上界内未得到应用确认（kAXErrorCannotComplete），动作可能已生效"
        )
    } else {
        format!("{step}失败：{}", error_name(value))
    }
}

/// 文本的 UTF-16 码元数。
pub fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

/// 按 UTF-16 码元截断。截断点落在代理对中间时，该字符以替换字符代替。
pub fn clip_utf16(text: &str, max_units: u32) -> (String, bool) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let limit = max_units as usize;
    if units.len() <= limit {
        return (text.to_owned(), false);
    }
    (String::from_utf16_lossy(&units[..limit]), true)
}

/// 从 UTF-16 偏移 `start` 起截取 `length` 个码元。超出末尾的部分忽略。
pub fn utf16_slice(text: &str, start: u32, length: u32) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let from = (start as usize).min(units.len());
    let to = from.saturating_add(length as usize).min(units.len());
    String::from_utf16_lossy(&units[from..to])
}

/// 该 UTF-16 偏移是否为字符边界：不超出末尾，也不落在代理对中间。
pub fn on_boundary(text: &str, offset: u32) -> bool {
    let mut at = 0u32;
    for c in text.chars() {
        if at == offset {
            return true;
        }
        at = at.saturating_add(u32::try_from(c.len_utf16()).unwrap_or(2));
        if at > offset {
            return false;
        }
    }
    at == offset
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(pairs: &[(&str, Raw)]) -> Vec<Raw> {
        BATCH
            .iter()
            .map(|name| {
                pairs
                    .iter()
                    .find(|(n, _)| n == name)
                    .map_or(Raw::Missing, |(_, v)| v.clone())
            })
            .collect()
    }

    /// 批量读取按属性表的下标解析；缺少的项按缺席处理，不使其他项错位。
    #[test]
    fn a_batch_decodes_by_position() {
        let facts = Facts::decode(&batch(&[
            (attr::ROLE, Raw::Text("AXCheckBox".to_owned())),
            (attr::SUBROLE, Raw::Text("AXSwitch".to_owned())),
            (attr::TITLE, Raw::Text("Wi-Fi".to_owned())),
            (attr::IDENTIFIER, Raw::Text("wifi".to_owned())),
            (attr::ENABLED, Raw::Bool(false)),
            (attr::FOCUSED, Raw::Number(1.0)),
            (attr::POSITION, Raw::Point { x: 10.4, y: 20.6 }),
            (
                attr::SIZE,
                Raw::Size {
                    width: 30.0,
                    height: 12.0,
                },
            ),
            (attr::SELECTED_ROWS, Raw::Other),
        ]));
        assert_eq!(facts.role, "AXCheckBox");
        assert_eq!(facts.subrole, "AXSwitch");
        assert_eq!(facts.title, "Wi-Fi");
        assert_eq!(facts.identifier, "wifi");
        assert_eq!(facts.enabled, Some(false));
        assert_eq!(facts.focused, Some(true));
        assert_eq!(facts.selected, None);
        assert!(facts.selects_rows && !facts.selects_children);
        assert_eq!(
            facts.frame.map(|f| f.rounded()),
            Some(ScreenRect {
                x: 10,
                y: 21,
                width: 30,
                height: 12
            })
        );
        // 长度不足时照常解析，缺少的项按缺席处理。
        let short = Facts::decode(&[Raw::Text("AXGroup".to_owned())]);
        assert_eq!(short.role, "AXGroup");
        assert_eq!(short.characters, None);
    }

    /// 复选框的值可能是 `CFBoolean`，也可能是取值 0 / 1 / 2 的 `CFNumber`。
    #[test]
    fn values_keep_numbers_and_text_apart() {
        assert_eq!(Value::of(&Raw::Bool(true)), Value::Number(1.0));
        assert_eq!(Value::of(&Raw::Number(2.0)), Value::Number(2.0));
        assert_eq!(
            Value::of(&Raw::Text(String::new())),
            Value::Text(String::new())
        );
        assert_eq!(Value::of(&Raw::Number(f64::NAN)), Value::Absent);
        assert_eq!(Value::of(&Raw::Other), Value::Absent);
    }

    #[test]
    fn a_frame_needs_both_halves_and_a_real_size() {
        let at = Raw::Point { x: 0.0, y: 0.0 };
        let size = |w, h| Raw::Size {
            width: w,
            height: h,
        };
        assert!(Frame::of(&at, &size(10.0, 10.0)).is_some());
        assert!(Frame::of(&at, &size(0.0, 10.0)).is_none());
        assert!(Frame::of(&at, &size(f64::INFINITY, 10.0)).is_none());
        assert!(Frame::of(&Raw::Missing, &size(10.0, 10.0)).is_none());
    }

    /// 文本元素先检查长度：长文档不读取值，除非调用方需要全文。没有文本模型的元素照常读取。
    #[test]
    fn long_text_is_not_fetched_during_a_walk() {
        assert!(wants_value(None, false));
        assert!(wants_value(Some(VALUE_TEXT_LIMIT), false));
        assert!(!wants_value(Some(VALUE_TEXT_LIMIT + 1), false));
        assert!(wants_value(Some(1_000_000), true));
    }

    /// 应用不应答与应用已退出是两种情况：错误码相同，按进程是否存在区分。
    #[test]
    fn cannot_complete_is_a_timeout_only_while_the_process_lives() {
        let silent = Failure::from_ax("读取子节点", code::CANNOT_COMPLETE, true);
        assert!(silent.is_timeout() && !silent.is_gone());
        assert!(silent.into_reason().starts_with("provider_timeout: "));
        let exited = Failure::from_ax("读取子节点", code::CANNOT_COMPLETE, false);
        assert!(exited.is_gone());
        assert!(exited.into_reason().starts_with("target_lost: "));
    }

    /// 元素失效记为 `ref_stale`；授权被关闭记为授权原因；其余保留错误码原文。
    #[test]
    fn other_codes_keep_their_meaning() {
        let gone = Failure::from_ax("读取角色", code::INVALID_UI_ELEMENT, true);
        assert!(gone.is_gone());
        assert!(gone.into_reason().starts_with("ref_stale: "));
        let off = Failure::from_ax("读取角色", code::API_DISABLED, true);
        assert_eq!(off.into_reason(), not_trusted());
        let other = Failure::from_ax("读取角色", code::FAILURE, true);
        assert!(!other.is_gone() && !other.is_timeout());
        assert_eq!(other.into_reason(), "读取角色失败：kAXErrorFailure");
        assert_eq!(error_name(-1), "AXError -1");
    }

    /// 动作调用返回 `kAXErrorCannotComplete` 时不记为失败：动作可能已经生效。
    #[test]
    fn an_unconfirmed_action_is_not_reported_as_failed() {
        assert!(action_error("AXPress", code::CANNOT_COMPLETE).starts_with("call_unconfirmed: "));
        assert_eq!(
            action_error("AXPress", code::ACTION_UNSUPPORTED),
            "AXPress失败：kAXErrorActionUnsupported"
        );
    }

    #[test]
    fn utf16_helpers_count_surrogate_pairs_as_two_units() {
        let text = "a🙂b中";
        assert_eq!(utf16_len(text), 5);
        assert_eq!(clip_utf16(text, 2), ("a\u{fffd}".to_owned(), true));
        assert_eq!(clip_utf16(text, 5), (text.to_owned(), false));
        assert_eq!(utf16_slice(text, 1, 2), "🙂");
        assert_eq!(utf16_slice(text, 4, 10), "中");
        assert_eq!(utf16_slice(text, 9, 1), "");
        for (offset, boundary) in [
            (0, true),
            (1, true),
            (2, false),
            (3, true),
            (5, true),
            (6, false),
        ] {
            assert_eq!(on_boundary(text, offset), boundary, "偏移 {offset}");
        }
    }

    /// 只记录与可用动作有关的属性。
    #[test]
    fn settable_records_only_known_attributes() {
        let mut s = Settable::default();
        s.record(attr::VALUE, true);
        s.record(attr::SELECTED_ROWS, true);
        s.record("AXSomethingElse", true);
        assert!(s.value && s.selected_rows);
        assert!(!s.selected && !s.expanded);
    }
}
