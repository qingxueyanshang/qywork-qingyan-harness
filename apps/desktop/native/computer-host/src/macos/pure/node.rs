//! AX 元素的事实换算成协议节点：角色与状态进共用词表，可用动作按元素真实暴露的动作名与
//! 可写属性列出，身份段与核对串按身份表编出，包围盒按窗口的那一套换算成屏幕物理像素。
//!
//! 本模块不调用 AX。动作那一刻按同一套判定挑调用（`claim`、`select_route`、`expand_route`），
//! 列出的动作与派发的调用因此只有一处来源。

use super::facts::{action, attr, utf16_len, Facts, Frame, Value, VALUE_TEXT_LIMIT};
use super::screen::Mapping;
use crate::protocol::{range_state, Node, NodeAction, Role, ScrollState, ToggleState, REF_STALE};
use crate::tree::{encode_ref, fingerprint, Identity, RefParts};

/// 换算里要认的 AX 角色与子角色名。
pub mod kind {
    pub const RADIO_BUTTON: &str = "AXRadioButton";
    pub const CHECK_BOX: &str = "AXCheckBox";
    pub const DISCLOSURE_TRIANGLE: &str = "AXDisclosureTriangle";
    pub const TEXT_FIELD: &str = "AXTextField";
    pub const TEXT_AREA: &str = "AXTextArea";
    pub const COMBO_BOX: &str = "AXComboBox";
    pub const STATIC_TEXT: &str = "AXStaticText";
    pub const SCROLL_BAR: &str = "AXScrollBar";
    pub const ROW: &str = "AXRow";
    pub const WINDOW: &str = "AXWindow";
    pub const VERTICAL: &str = "AXVerticalOrientation";
    pub const HORIZONTAL: &str = "AXHorizontalOrientation";
    pub const TAB_BUTTON: &str = "AXTabButton";
    pub const OUTLINE_ROW: &str = "AXOutlineRow";
}

/// 这一次读取要取哪些可选字段。含义同其他后端：前两项不影响可用动作表。
#[derive(Debug, Clone, Copy)]
pub struct Fields {
    pub value: bool,
    pub state: bool,
    /// 报键盘焦点并列前台动作。调用方只在前台模式开着、且窗口对应上 CG 窗口时置真。
    pub foreground: bool,
}

/// 父元素里与子节点可用动作有关的事实。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Context {
    /// 父元素的 `AXSelectedRows` 可写：表格与大纲的行经它改选中。
    pub rows: bool,
    /// 父元素的 `AXSelectedChildren` 可写：列表类容器的项经它改选中。
    pub children: bool,
}

impl Context {
    pub fn of(parent: &Facts) -> Self {
        Self {
            rows: parent.settable.selected_rows,
            children: parent.settable.selected_children,
        }
    }
}

/// 一个元素的 `AXPress` 承担的是哪一种语义。一个元素只取一种：复选框的 `AXPress` 是
/// `set_toggle`，不再同时列成 `invoke`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Click {
    Invoke,
    Toggle,
    /// 单选按钮与标签页按钮：`select` 经它的 `AXPress` 发出。
    Radio,
    /// 展开三角：`expand` / `collapse` 经它的 `AXPress` 发出。
    Expand,
}

/// 这个元素的 `AXPress` 归哪一种语义。没有 `AXPress` 时缺席。
pub fn claim(facts: &Facts) -> Option<Click> {
    if !facts.has_action(action::PRESS) {
        return None;
    }
    Some(match facts.role.as_str() {
        kind::RADIO_BUTTON => Click::Radio,
        kind::DISCLOSURE_TRIANGLE => Click::Expand,
        kind::CHECK_BOX => Click::Toggle,
        _ => Click::Invoke,
    })
}

/// 复选状态：`AXValue` 0 未选中、1 选中、2 中间态。别的值判不出。
pub fn toggle_state(facts: &Facts) -> Option<ToggleState> {
    match facts.value.number()? {
        n if n == 0.0 => Some(ToggleState::Off),
        n if n == 1.0 => Some(ToggleState::On),
        n if n == 2.0 => Some(ToggleState::Indeterminate),
        _ => None,
    }
}

/// 展开状态：`AXExpanded`、大纲行的 `AXDisclosing`、展开三角的 `AXValue`，取先有的那一项。
pub fn expand_state(facts: &Facts) -> Option<bool> {
    facts.expanded.or(facts.disclosing).or_else(|| {
        (facts.role == kind::DISCLOSURE_TRIANGLE)
            .then(|| facts.value.number().map(|n| n != 0.0))
            .flatten()
    })
}

/// 展开与收起怎么发。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expander {
    /// 写这个布尔属性。
    Attribute(&'static str),
    /// 按一下展开三角。
    Press,
}

/// 展开与收起的发法。顺序：可写的 `AXExpanded` → 可写的 `AXDisclosing` → 展开三角。
pub fn expand_route(facts: &Facts) -> Option<Expander> {
    if facts.expanded.is_some() && facts.settable.expanded {
        return Some(Expander::Attribute(attr::EXPANDED));
    }
    if facts.disclosing.is_some() && facts.settable.disclosing {
        return Some(Expander::Attribute(attr::DISCLOSING));
    }
    (claim(facts) == Some(Click::Expand) && expand_state(facts).is_some())
        .then_some(Expander::Press)
}

/// `select` 怎么发。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Selector {
    /// 按一下单选按钮。
    Press,
    /// 把父元素这一项的选中集合换成只有这个元素。
    Parent(&'static str),
    /// 写这个元素自己的 `AXSelected`。
    Own,
}

/// `select` 的发法。顺序：单选按钮 → 父元素的 `AXSelectedRows`（行）→ 父元素的
/// `AXSelectedChildren`（带选中状态的项）→ 自己可写的 `AXSelected`。
///
/// 父元素那两项排在自己的 `AXSelected` 前面：写集合是「换成只有这一项」，语义确定；写自己的
/// `AXSelected` 是增选还是替换由应用决定。
pub fn select_route(facts: &Facts, context: Context) -> Option<Selector> {
    if claim(facts) == Some(Click::Radio) {
        return Some(Selector::Press);
    }
    if facts.role == kind::ROW && context.rows {
        return Some(Selector::Parent(attr::SELECTED_ROWS));
    }
    if facts.selected.is_some() && context.children {
        return Some(Selector::Parent(attr::SELECTED_CHILDREN));
    }
    (facts.selected.is_some() && facts.settable.selected).then_some(Selector::Own)
}

/// 选中状态。单选按钮的选中状态是它的 `AXValue`。
pub fn selected(facts: &Facts) -> Option<bool> {
    if facts.role == kind::RADIO_BUTTON {
        return facts.value.number().map(|n| n != 0.0);
    }
    facts.selected
}

/// 数值区间的三个数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Numbers {
    pub current: f64,
    pub min: f64,
    pub max: f64,
}

/// 这个元素的值是一个有上下界的数：数值是 `AXValue`，界是 `AXMinValue` / `AXMaxValue`。
///
/// 滚动条不给界时按 0 到 1 算：它的 `AXValue` 是滑块位置占可滚范围的比例。复选、单选与展开三角
/// 的数值是状态，不算区间。
pub fn numbers(facts: &Facts) -> Option<Numbers> {
    if matches!(
        facts.role.as_str(),
        kind::CHECK_BOX | kind::RADIO_BUTTON | kind::DISCLOSURE_TRIANGLE
    ) {
        return None;
    }
    let current = facts.value.number()?;
    let (min, max) = match (facts.min, facts.max) {
        (Some(min), Some(max)) => (min, max),
        (None, None) if facts.role == kind::SCROLL_BAR => (0.0, 1.0),
        _ => return None,
    };
    Some(Numbers { current, min, max })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// 滚动条的方向与数值。方向取 `AXOrientation`，没给时按矩形的长边判；两样都没有时判不出。
pub fn scroll_bar(facts: &Facts) -> Option<(Axis, Numbers)> {
    if facts.role != kind::SCROLL_BAR {
        return None;
    }
    let axis = match facts.orientation.as_str() {
        kind::VERTICAL => Axis::Vertical,
        kind::HORIZONTAL => Axis::Horizontal,
        _ => {
            let frame = facts.frame?;
            if frame.height > frame.width {
                Axis::Vertical
            } else if frame.width > frame.height {
                Axis::Horizontal
            } else {
                return None;
            }
        }
    };
    Some((axis, numbers(facts)?))
}

/// 可编辑文本：输入框、文本区与组合框，值是文本（或长到这一次没读值）。
pub fn text_editable(facts: &Facts) -> bool {
    matches!(
        facts.role.as_str(),
        kind::TEXT_FIELD | kind::TEXT_AREA | kind::COMBO_BOX
    ) && (matches!(facts.value, Value::Text(_)) || facts.characters.is_some())
}

/// 能不能设文本选区：有文本模型且 `AXSelectedTextRange` 可写。
pub fn text_selectable(facts: &Facts) -> bool {
    facts.characters.is_some() && facts.text_range.is_some() && facts.settable.text_range
}

/// 要问哪几项可写。只问与可用动作有关、且元素有这一项的属性：每问一项是一次跨进程调用。
///
/// 父元素已经能改选中时不问自己的 `AXSelected`：`select_route` 不会用到它。
pub fn settable_queries(facts: &Facts, context: Context) -> Vec<&'static str> {
    let mut out = Vec::new();
    if text_editable(facts) || numbers(facts).is_some() {
        out.push(attr::VALUE);
    }
    let parent_selects = (facts.role == kind::ROW && context.rows) || context.children;
    if facts.selected.is_some() && claim(facts) != Some(Click::Radio) && !parent_selects {
        out.push(attr::SELECTED);
    }
    if facts.expanded.is_some() {
        out.push(attr::EXPANDED);
    }
    if facts.disclosing.is_some() {
        out.push(attr::DISCLOSING);
    }
    if facts.text_range.is_some() {
        out.push(attr::SELECTED_TEXT_RANGE);
    }
    out.extend(container_queries(facts));
    out
}

/// 选择容器要问的那几项：子节点的 `Context` 只由它们定。重新定位时读父元素只问这几项。
pub fn container_queries(facts: &Facts) -> Vec<&'static str> {
    let mut out = Vec::new();
    if facts.selects_rows {
        out.push(attr::SELECTED_ROWS);
    }
    if facts.selects_children {
        out.push(attr::SELECTED_CHILDREN);
    }
    out
}

/// 这个元素列出的后台动作。缺了发法的动作不列；前台动作由 `foreground_offers` 列。
///
/// 增选与取消选中不列：AX 不报容器是否允许多选，写选中集合时单选容器会换掉已有的选中项。
pub fn offers(facts: &Facts, context: Context) -> Vec<NodeAction> {
    let mut out = Vec::new();
    let click = claim(facts);
    if text_editable(facts) {
        out.push(if facts.settable.value {
            NodeAction::ready("set_value")
        } else {
            NodeAction::blocked("set_value", "read_only")
        });
    }
    if click == Some(Click::Invoke) {
        out.push(NodeAction::ready("invoke"));
    }
    if numbers(facts).is_some() {
        out.push(if facts.settable.value {
            NodeAction::ready("set_range_value")
        } else {
            NodeAction::blocked("set_range_value", "read_only")
        });
    }
    if click == Some(Click::Toggle) && toggle_state(facts).is_some() {
        out.push(NodeAction::ready("set_toggle"));
    }
    if expand_route(facts).is_some() {
        out.push(NodeAction::ready("expand"));
        out.push(NodeAction::ready("collapse"));
    }
    if select_route(facts, context).is_some() {
        out.push(NodeAction::ready("select"));
    }
    if scroll_bar(facts).is_some()
        && (facts.has_action(action::INCREMENT) || facts.has_action(action::DECREMENT))
    {
        out.push(NodeAction::ready("scroll"));
    }
    if facts.has_action(action::SCROLL_TO_VISIBLE) {
        out.push(NodeAction::ready("scroll_into_view"));
    }
    if text_selectable(facts) {
        out.push(NodeAction::ready("select_text"));
    }
    out
}

/// 这个元素列出的前台动作。
///
/// 指针动作只列在有矩形、落在窗口可见范围里、窗口没有最小化的元素上：没有矩形就指不出落点。
/// 键盘动作列在持有键盘焦点的元素与窗口根上：自绘界面给不出持有焦点的控件，只列前者等于对它
/// 关掉整条键盘路径。窗口动作只列在窗口根上，这个窗口支不支持由派发那一刻判。`path` 为空才是
/// 窗口根自己。
pub fn foreground_offers(facts: &Facts, path: &[usize], offscreen: bool) -> Vec<NodeAction> {
    let mut out = Vec::new();
    if facts.frame.is_some() && !offscreen && facts.minimized != Some(true) {
        for action in ["click", "hover", "drag", "wheel"] {
            out.push(NodeAction::foreground(action));
        }
    }
    if facts.focused == Some(true) || path.is_empty() {
        out.push(NodeAction::foreground("type_text"));
        out.push(NodeAction::foreground("press_key"));
    }
    if path.is_empty() {
        for action in [
            "activate",
            "set_window_state",
            "close_window",
            "move_window",
            "resize_window",
        ] {
            out.push(NodeAction::foreground(action));
        }
    }
    out
}

/// 控件名称：`AXTitle`，没有时取 `AXDescription`；静态文本两者都没有时取它的文本。
pub fn name(facts: &Facts) -> String {
    if !facts.title.is_empty() {
        return facts.title.clone();
    }
    if !facts.description.is_empty() {
        return facts.description.clone();
    }
    match (&facts.value, facts.role.as_str()) {
        (Value::Text(text), kind::STATIC_TEXT) => text.clone(),
        _ => String::new(),
    }
}

/// 核对串：原始角色、子角色与稳定标识的指纹，写在 `ref` 的 `#` 之前，重新定位时与身份段一起核对。
///
/// 名称不进核对串：组合框、标签与列表行的名称随内容变，改了内容仍是同一个控件。
pub fn check(facts: &Facts) -> String {
    fingerprint(
        &format!("{}.{}", facts.role, facts.subrole),
        "",
        &facts.identifier,
    )
}

/// 身份段：身份表编号。段首不是 `~`，协调器按它给稳定短编号。
///
/// 不要把指纹或名称放进身份段：名称随内容变的控件会被协调器当成删掉一个、新增一个。
pub fn identity(id: u64) -> Identity {
    Identity::Stable(id.to_string())
}

/// 按 `ref` 重新定位到的元素是不是 `ref` 记的那一个：身份段与核对串都要对上。
pub fn verify(expected: &RefParts, id: u64, actual: &str) -> Result<(), String> {
    if expected.identity != identity(id) {
        return Err(format!(
            "{REF_STALE}: 该位置现在是控件 {id}，ref 里记的是 {}，请重新观察",
            describe(&expected.identity)
        ));
    }
    if expected.check.as_deref() != Some(actual) {
        return Err(format!(
            "{REF_STALE}: 控件 {id} 的角色或稳定标识已经变了（核对串 {actual}，ref 里记的是 {}），请重新观察",
            expected.check.as_deref().unwrap_or("缺席")
        ));
    }
    Ok(())
}

fn describe(identity: &Identity) -> String {
    match identity {
        Identity::Stable(id) => id.clone(),
        Identity::Attributes(print) => format!("~{print}"),
    }
}

/// 换算成协议节点。`parent_ref` 与 `depth` 由遍历填。
///
/// `window` 是元素所在窗口的 AX 矩形，判「在不在窗口可见范围里」用。`mapping` 是这个窗口的
/// 点到像素换算：窗口没有对应上 CG 窗口时缺席，节点就不带包围盒，与这种窗口不给图、不给坐标
/// 动作一致。
pub fn node(
    facts: &Facts,
    context: Context,
    path: &[usize],
    id: u64,
    window: Option<Frame>,
    mapping: Option<&Mapping>,
    fields: Fields,
) -> Node {
    let click = claim(facts);
    let name = name(facts);
    let value = match &facts.value {
        Value::Text(text) if fields.value => {
            let repeats_name = facts.role == kind::STATIC_TEXT && text.trim() == name.trim();
            (!repeats_name && utf16_len(text) <= VALUE_TEXT_LIMIT).then(|| text.clone())
        }
        _ => None,
    };
    let range = numbers(facts)
        .filter(|_| fields.state)
        .and_then(|n| range_state(n.current, n.min, n.max, f64::NAN, f64::NAN));
    let scroll = scroll_bar(facts).filter(|_| fields.state).map(|(axis, n)| {
        let percent = (n.max > n.min).then(|| (n.current - n.min) / (n.max - n.min) * 100.0);
        match axis {
            Axis::Horizontal => ScrollState {
                horizontal: percent,
                vertical: None,
            },
            Axis::Vertical => ScrollState {
                horizontal: None,
                vertical: percent,
            },
        }
    });
    let offscreen = match (facts.frame, window) {
        (Some(own), Some(window)) => own.rounded().intersect(&window.rounded()).is_none(),
        _ => false,
    };
    Node {
        reference: encode_ref(path, Some(&check(facts)), &identity(id)),
        parent_ref: None,
        depth: 0,
        role: role_name(&facts.role, &facts.subrole),
        name,
        automation_id: facts.identifier.clone(),
        value,
        enabled: facts.enabled.unwrap_or(true),
        offscreen,
        focused: fields.foreground && facts.focused == Some(true),
        rect: facts.frame.zip(mapping).map(|(own, m)| m.rect(own)),
        actions: {
            let mut actions = offers(facts, context);
            if fields.foreground {
                actions.extend(foreground_offers(facts, path, offscreen));
            }
            actions
        },
        range,
        toggle: (click == Some(Click::Toggle))
            .then(|| toggle_state(facts).map(ToggleState::as_str))
            .flatten()
            .filter(|_| fields.state),
        expand: expand_state(facts)
            .map(|open| if open { "expanded" } else { "collapsed" })
            .filter(|_| fields.state),
        selected: selected(facts).filter(|_| fields.state),
        // AX 不报容器是否允许多选、是否要求始终选中一项，给不出完整的容器约束。
        selection: None,
        scroll,
        text: facts.characters.is_some(),
        weak_identity: false,
    }
}

/// AX 角色换算成协议角色名。词表里没有对应的角色交回 `ax_<角色名>`，不猜一个相近的。
pub fn role_name(role: &str, subrole: &str) -> String {
    vocabulary(role, subrole).map_or_else(
        || format!("ax_{}", snake(role.strip_prefix("AX").unwrap_or(role))),
        |r| r.as_str().to_owned(),
    )
}

/// `DateField` → `date_field`，`URLField` → `url_field`。只留小写字母、数字与下划线；
/// 空串交回 `unknown`。
fn snake(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::new();
    let separate = |out: &mut String| {
        if !out.is_empty() && !out.ends_with('_') {
            out.push('_');
        }
    };
    for (i, c) in chars.iter().enumerate() {
        if !c.is_ascii_alphanumeric() {
            separate(&mut out);
            continue;
        }
        if c.is_ascii_uppercase() && i > 0 {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(char::is_ascii_lowercase);
            if prev.is_ascii_lowercase()
                || prev.is_ascii_digit()
                || (prev.is_ascii_uppercase() && next_lower)
            {
                separate(&mut out);
            }
        }
        out.push(c.to_ascii_lowercase());
    }
    let out = out.trim_matches('_');
    if out.is_empty() {
        "unknown".to_owned()
    } else {
        out.to_owned()
    }
}

fn vocabulary(role: &str, subrole: &str) -> Option<Role> {
    Some(match (role, subrole) {
        ("AXRadioButton", kind::TAB_BUTTON) => Role::TabItem,
        ("AXRow", kind::OUTLINE_ROW) => Role::TreeItem,
        ("AXButton" | "AXMenuButton" | "AXDisclosureTriangle", _) => Role::Button,
        ("AXCheckBox", _) => Role::CheckBox,
        ("AXRadioButton", _) => Role::RadioButton,
        ("AXPopUpButton" | "AXComboBox", _) => Role::ComboBox,
        ("AXTextField" | "AXTextArea", _) => Role::Edit,
        ("AXStaticText" | "AXHeading", _) => Role::Text,
        ("AXLink", _) => Role::Hyperlink,
        ("AXImage", _) => Role::Image,
        ("AXList", _) => Role::List,
        ("AXOutline", _) => Role::Tree,
        ("AXTable", _) => Role::Table,
        ("AXGrid", _) => Role::DataGrid,
        ("AXRow" | "AXCell", _) => Role::DataItem,
        ("AXTabGroup", _) => Role::Tab,
        ("AXMenuBar", _) => Role::MenuBar,
        ("AXMenu", _) => Role::Menu,
        ("AXMenuItem" | "AXMenuBarItem", _) => Role::MenuItem,
        ("AXToolbar", _) => Role::ToolBar,
        ("AXScrollBar", _) => Role::ScrollBar,
        ("AXSlider", _) => Role::Slider,
        ("AXIncrementor", _) => Role::Spinner,
        (
            "AXProgressIndicator" | "AXBusyIndicator" | "AXLevelIndicator" | "AXRelevanceIndicator",
            _,
        ) => Role::ProgressBar,
        ("AXValueIndicator", _) => Role::Thumb,
        ("AXSplitter", _) => Role::Separator,
        ("AXHelpTag", _) => Role::ToolTip,
        ("AXGroup" | "AXRadioGroup", _) => Role::Group,
        ("AXScrollArea" | "AXSplitGroup" | "AXDrawer", _) => Role::Pane,
        ("AXWebArea", _) => Role::Document,
        ("AXWindow" | "AXSheet" | "AXPopover", _) => Role::Window,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::DELIVERY_BACKGROUND;

    fn facts(role: &str, actions: &[&str]) -> Facts {
        Facts {
            role: role.to_owned(),
            title: "控件".to_owned(),
            actions: actions.iter().map(|a| (*a).to_owned()).collect(),
            ..Facts::default()
        }
    }

    fn names(actions: &[NodeAction]) -> Vec<&'static str> {
        actions.iter().map(|a| a.action).collect()
    }

    const FIELDS: Fields = Fields {
        value: true,
        state: true,
        foreground: false,
    };

    /// 按钮的 `AXPress` 列成 `invoke`；没有 `AXPress` 的按钮一条动作都不列。
    #[test]
    fn a_button_offers_invoke_through_press() {
        let button = facts("AXButton", &[action::PRESS, "AXShowMenu"]);
        assert_eq!(claim(&button), Some(Click::Invoke));
        assert_eq!(names(&offers(&button, Context::default())), ["invoke"]);
        assert!(offers(&facts("AXButton", &[]), Context::default()).is_empty());
    }

    /// 复选框的 `AXPress` 只列成 `set_toggle`，状态读 `AXValue` 的 0 / 1 / 2。
    #[test]
    fn a_check_box_offers_set_toggle_and_reports_its_state() {
        let mut check = facts(kind::CHECK_BOX, &[action::PRESS]);
        check.subrole = "AXSwitch".to_owned();
        check.value = Value::Number(2.0);
        assert_eq!(claim(&check), Some(Click::Toggle));
        let node = node(&check, Context::default(), &[0], 7, None, None, FIELDS);
        assert_eq!(names(&node.actions), ["set_toggle"]);
        assert_eq!(node.toggle, Some("indeterminate"));
        assert_eq!(node.role, "check_box");
        // 状态判不出时不列：切换要靠重读状态判断停在哪里。
        check.value = Value::Absent;
        assert!(offers(&check, Context::default()).is_empty());
    }

    /// 单选按钮与标签页按钮的 `select` 经 `AXPress` 发出，选中状态是它的 `AXValue`。
    #[test]
    fn a_radio_button_offers_select_and_reports_its_value_as_selected() {
        let mut tab = facts(kind::RADIO_BUTTON, &[action::PRESS]);
        tab.subrole = kind::TAB_BUTTON.to_owned();
        tab.value = Value::Number(1.0);
        assert_eq!(
            select_route(&tab, Context::default()),
            Some(Selector::Press)
        );
        let node = node(&tab, Context::default(), &[1], 7, None, None, FIELDS);
        assert_eq!(names(&node.actions), ["select"]);
        assert_eq!(node.selected, Some(true));
        assert_eq!(node.role, "tab_item");
        assert_eq!(role_name(kind::RADIO_BUTTON, ""), "radio_button");
    }

    /// 可写的输入框列 `set_value`；只读的照列，标成此刻不可用。静态文本不列。
    #[test]
    fn text_fields_offer_set_value_by_settability() {
        let mut field = facts(kind::TEXT_FIELD, &[]);
        field.value = Value::Text(String::new());
        field.characters = Some(0);
        field.text_range = Some((0, 0));
        assert_eq!(
            settable_queries(&field, Context::default()),
            [attr::VALUE, attr::SELECTED_TEXT_RANGE]
        );
        let offer = &offers(&field, Context::default())[0];
        assert_eq!(
            (offer.action, offer.unavailable),
            ("set_value", Some("read_only"))
        );
        assert!(offer.delivery.is_empty());
        field.settable.value = true;
        field.settable.text_range = true;
        let offered = offers(&field, Context::default());
        assert_eq!(offered[0].delivery, vec![DELIVERY_BACKGROUND]);
        assert_eq!(names(&offered), ["set_value", "select_text"]);
        let mut label = facts(kind::STATIC_TEXT, &[]);
        label.value = Value::Text("说明".to_owned());
        assert!(!text_editable(&label));
        assert!(settable_queries(&label, Context::default()).is_empty());
    }

    /// 静态文本没有标题时名称就是它的文本，值不再重复一遍；输入框的值是文本，空串也给。
    #[test]
    fn static_text_names_itself_by_its_text() {
        let mut label = facts(kind::STATIC_TEXT, &[]);
        label.title = String::new();
        label.value = Value::Text("已保存".to_owned());
        let node = node(&label, Context::default(), &[], 3, None, None, FIELDS);
        assert_eq!(node.name, "已保存");
        assert_eq!(node.value, None);
        let mut field = facts(kind::TEXT_FIELD, &[]);
        field.value = Value::Text(String::new());
        assert_eq!(
            super::node(&field, Context::default(), &[], 3, None, None, FIELDS)
                .value
                .as_deref(),
            Some("")
        );
        let skip = Fields {
            value: false,
            ..FIELDS
        };
        assert_eq!(
            super::node(&field, Context::default(), &[], 3, None, None, skip).value,
            None
        );
        // 超过上限的文本不进节点值。
        field.value = Value::Text("字".repeat(VALUE_TEXT_LIMIT as usize + 1));
        assert_eq!(
            super::node(&field, Context::default(), &[], 3, None, None, FIELDS).value,
            None
        );
    }

    /// 名称先取标题，再取描述：只有图标的按钮只给描述。
    #[test]
    fn the_name_falls_back_to_the_description() {
        let mut icon = facts("AXButton", &[action::PRESS]);
        icon.title = String::new();
        icon.description = "共享".to_owned();
        assert_eq!(name(&icon), "共享");
    }

    /// 滑块的数值带界；只读的列成此刻不可用。滚动条不给界时按 0 到 1。
    #[test]
    fn range_values_need_bounds_except_on_scroll_bars() {
        let mut slider = facts("AXSlider", &[action::INCREMENT, action::DECREMENT]);
        slider.value = Value::Number(30.0);
        slider.min = Some(0.0);
        slider.max = Some(100.0);
        slider.settable.value = true;
        let node = node(&slider, Context::default(), &[0], 5, None, None, FIELDS);
        assert_eq!(names(&node.actions), ["set_range_value"]);
        assert_eq!(
            node.range.map(|r| (r.value, r.min, r.max)),
            Some((30.0, 0.0, 100.0))
        );
        let mut unbounded = slider.clone();
        unbounded.max = None;
        assert_eq!(numbers(&unbounded), None);
        let mut progress = facts("AXProgressIndicator", &[]);
        progress.value = Value::Number(0.4);
        progress.min = Some(0.0);
        progress.max = Some(1.0);
        let offer = &offers(&progress, Context::default())[0];
        assert_eq!(offer.unavailable, Some("read_only"));
        let mut bar = facts(kind::SCROLL_BAR, &[]);
        bar.value = Value::Number(0.25);
        bar.orientation = kind::VERTICAL.to_owned();
        assert_eq!(scroll_bar(&bar).map(|s| s.0), Some(Axis::Vertical));
        let node = super::node(&bar, Context::default(), &[0], 6, None, None, FIELDS);
        assert_eq!(node.scroll.and_then(|s| s.vertical), Some(25.0));
    }

    /// 滚动条有增减动作才列 `scroll`；方向没给时按矩形长边判。
    #[test]
    fn a_scroll_bar_offers_scroll_only_with_step_actions() {
        let mut bar = facts(kind::SCROLL_BAR, &[]);
        bar.value = Value::Number(0.0);
        bar.frame = Some(Frame {
            x: 0.0,
            y: 0.0,
            width: 15.0,
            height: 400.0,
        });
        assert_eq!(scroll_bar(&bar).map(|s| s.0), Some(Axis::Vertical));
        assert!(!names(&offers(&bar, Context::default())).contains(&"scroll"));
        bar.actions = vec![action::INCREMENT.to_owned()];
        assert!(names(&offers(&bar, Context::default())).contains(&"scroll"));
    }

    /// 表格的行经父元素的 `AXSelectedRows` 选中；带选中状态的列表项经 `AXSelectedChildren`；
    /// 父元素都不能改时才用自己可写的 `AXSelected`，此时才问它可不可写。
    #[test]
    fn selection_prefers_the_parent_collection() {
        let mut row = facts(kind::ROW, &[]);
        row.subrole = kind::OUTLINE_ROW.to_owned();
        row.selected = Some(false);
        let rows = Context {
            rows: true,
            children: false,
        };
        assert_eq!(
            select_route(&row, rows),
            Some(Selector::Parent(attr::SELECTED_ROWS))
        );
        assert!(!settable_queries(&row, rows).contains(&attr::SELECTED));
        assert_eq!(role_name(&row.role, &row.subrole), "tree_item");
        let listed = Context {
            rows: false,
            children: true,
        };
        let mut item = facts("AXGroup", &[]);
        item.selected = Some(true);
        assert_eq!(
            select_route(&item, listed),
            Some(Selector::Parent(attr::SELECTED_CHILDREN))
        );
        // 没有选中状态的子元素不经父元素选中。
        assert_eq!(select_route(&facts("AXGroup", &[]), listed), None);
        assert!(settable_queries(&item, Context::default()).contains(&attr::SELECTED));
        assert_eq!(select_route(&item, Context::default()), None);
        item.settable.selected = true;
        assert_eq!(select_route(&item, Context::default()), Some(Selector::Own));
        // 增选与取消选中一律不列。
        let offered = names(&offers(&item, Context::default()));
        assert_eq!(offered, ["select"]);
    }

    /// 选择容器问两项集合的可写性，子元素的上下文按它来。
    #[test]
    fn a_container_asks_about_its_selection_collections() {
        let mut table = facts("AXOutline", &[]);
        table.selects_rows = true;
        table.selects_children = true;
        assert_eq!(
            settable_queries(&table, Context::default()),
            [attr::SELECTED_ROWS, attr::SELECTED_CHILDREN]
        );
        table.settable.selected_rows = true;
        assert_eq!(
            Context::of(&table),
            Context {
                rows: true,
                children: false
            }
        );
    }

    /// 展开的三种发法：可写的 `AXExpanded`、可写的 `AXDisclosing`、展开三角的 `AXPress`。
    #[test]
    fn expansion_uses_the_first_available_route() {
        let mut combo = facts(kind::COMBO_BOX, &[action::PRESS]);
        combo.expanded = Some(false);
        assert_eq!(expand_route(&combo), None);
        combo.settable.expanded = true;
        assert_eq!(
            expand_route(&combo),
            Some(Expander::Attribute(attr::EXPANDED))
        );
        let mut row = facts(kind::ROW, &[]);
        row.disclosing = Some(true);
        row.settable.disclosing = true;
        assert_eq!(
            expand_route(&row),
            Some(Expander::Attribute(attr::DISCLOSING))
        );
        assert_eq!(
            super::node(&row, Context::default(), &[], 2, None, None, FIELDS).expand,
            Some("expanded")
        );
        let mut triangle = facts(kind::DISCLOSURE_TRIANGLE, &[action::PRESS]);
        triangle.value = Value::Number(0.0);
        assert_eq!(claim(&triangle), Some(Click::Expand));
        assert_eq!(expand_route(&triangle), Some(Expander::Press));
        assert_eq!(
            names(&offers(&triangle, Context::default())),
            ["expand", "collapse"]
        );
        assert_eq!(role_name(&triangle.role, ""), "button");
    }

    /// 元素矩形与窗口矩形不相交即在可见范围之外；矩形读不出时按在屏幕上报。
    #[test]
    fn offscreen_is_judged_against_the_window() {
        let window = Frame {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        let mut row = facts(kind::ROW, &[]);
        row.frame = Some(Frame {
            x: 10.0,
            y: 900.0,
            width: 700.0,
            height: 20.0,
        });
        assert!(node(&row, Context::default(), &[], 1, Some(window), None, FIELDS).offscreen);
        row.frame = Some(Frame {
            y: 100.0,
            ..row.frame.expect("有矩形")
        });
        assert!(!node(&row, Context::default(), &[], 1, Some(window), None, FIELDS).offscreen);
        assert!(!node(&row, Context::default(), &[], 1, None, None, FIELDS).offscreen);
    }

    /// 焦点只在前台模式开着时报。
    #[test]
    fn focus_is_reported_only_in_foreground_mode() {
        let mut field = facts(kind::TEXT_FIELD, &[]);
        field.focused = Some(true);
        let background = node(&field, Context::default(), &[1], 1, None, None, FIELDS);
        assert!(!background.focused);
        assert!(!names(&background.actions).contains(&"type_text"));
        let foreground = Fields {
            foreground: true,
            ..FIELDS
        };
        let node = node(&field, Context::default(), &[1], 1, None, None, foreground);
        assert!(node.focused);
        assert!(names(&node.actions).contains(&"type_text"));
    }

    /// Retina 屏上的窗口：包围盒按窗口的那一套换算成像素；窗口没有换算时不带包围盒。
    #[test]
    fn the_bounding_box_is_reported_in_pixels_of_the_windows_display() {
        use super::super::screen::{place, Display};
        let window = Frame {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        let placed = place(
            &[Display {
                id: 1,
                bounds: Frame {
                    x: 0.0,
                    y: 0.0,
                    width: 1512.0,
                    height: 982.0,
                },
                scale: 2.0,
            }],
            window,
        )
        .expect("有显示器");
        let mut button = facts("AXButton", &[action::PRESS]);
        button.frame = Some(Frame {
            x: 120.0,
            y: 80.0,
            width: 60.0,
            height: 24.0,
        });
        let node = node(
            &button,
            Context::default(),
            &[0],
            4,
            Some(window),
            Some(&placed.mapping),
            FIELDS,
        );
        assert_eq!(
            node.rect,
            Some(crate::geometry::ScreenRect {
                x: 240,
                y: 160,
                width: 120,
                height: 48,
            })
        );
        assert!(super::node(
            &button,
            Context::default(),
            &[0],
            4,
            Some(window),
            None,
            FIELDS
        )
        .rect
        .is_none());
    }

    /// 前台模式开着时：有矩形且在窗口里的元素列指针动作；持有焦点的元素与窗口根列键盘动作；
    /// 窗口动作只在根上。前台模式关着时一条都不列。
    #[test]
    fn foreground_actions_follow_bounds_focus_and_the_window_root() {
        let foreground = Fields {
            foreground: true,
            ..FIELDS
        };
        let window = Frame {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        let mut button = facts("AXButton", &[action::PRESS]);
        button.frame = Some(Frame {
            x: 10.0,
            y: 10.0,
            width: 60.0,
            height: 24.0,
        });
        let offered = names(
            &node(
                &button,
                Context::default(),
                &[0],
                1,
                Some(window),
                None,
                foreground,
            )
            .actions,
        );
        assert_eq!(offered, ["invoke", "click", "hover", "drag", "wheel"]);
        let hidden = Facts {
            frame: Some(Frame {
                y: 900.0,
                ..button.frame.expect("有矩形")
            }),
            ..button.clone()
        };
        assert_eq!(
            names(
                &node(
                    &hidden,
                    Context::default(),
                    &[0],
                    1,
                    Some(window),
                    None,
                    foreground
                )
                .actions
            ),
            ["invoke"]
        );
        let mut root = facts(kind::WINDOW, &[]);
        root.frame = Some(window);
        let at_root = names(
            &node(
                &root,
                Context::default(),
                &[],
                1,
                Some(window),
                None,
                foreground,
            )
            .actions,
        );
        assert_eq!(
            at_root,
            [
                "click",
                "hover",
                "drag",
                "wheel",
                "type_text",
                "press_key",
                "activate",
                "set_window_state",
                "close_window",
                "move_window",
                "resize_window",
            ]
        );
        // 最小化的窗口不列指针动作，窗口动作照列：恢复它要靠它们。
        root.minimized = Some(true);
        let minimized = names(
            &node(
                &root,
                Context::default(),
                &[],
                1,
                Some(window),
                None,
                foreground,
            )
            .actions,
        );
        assert!(!minimized.contains(&"click"));
        assert!(minimized.contains(&"set_window_state"));
        assert!(node(
            &root,
            Context::default(),
            &[],
            1,
            Some(window),
            None,
            FIELDS
        )
        .actions
        .is_empty());
    }

    /// 身份段只有身份表编号，核对串在 `#` 之前。
    #[test]
    fn the_identity_segment_is_the_table_number() {
        let reference = node(
            &facts("AXButton", &[action::PRESS]),
            Context::default(),
            &[0, 3],
            42,
            None,
            None,
            FIELDS,
        )
        .reference;
        let (head, segment) = reference.split_once('#').expect("ref 带身份段");
        assert_eq!(segment, "42");
        assert!(head.starts_with("w.0.3@"));
        assert!(!identity(42).is_weak());
    }

    /// 原始失败形状：组合框换了选中项、名称随之改变，整条 ref 不变，旧 ref 照样核对得上。
    #[test]
    fn a_control_whose_name_follows_its_content_keeps_its_ref() {
        let mut combo = facts("AXPopUpButton", &[action::PRESS]);
        combo.value = Value::Text("alpha".to_owned());
        let before = node(&combo, Context::default(), &[1], 9, None, None, FIELDS).reference;
        combo.title = "beta".to_owned();
        combo.value = Value::Text("beta".to_owned());
        assert_eq!(
            node(&combo, Context::default(), &[1], 9, None, None, FIELDS).reference,
            before
        );
        let parts = crate::tree::decode_ref(&before).expect("解得开");
        assert_eq!(verify(&parts, 9, &check(&combo)), Ok(()));
    }

    /// 同一个位置换成了另一个身份表编号，或同一个元素换了角色、子角色、稳定标识：`ref_stale`。
    #[test]
    fn a_different_number_or_check_is_stale() {
        let button = facts("AXButton", &[action::PRESS]);
        let old = crate::tree::decode_ref(
            &node(&button, Context::default(), &[0], 9, None, None, FIELDS).reference,
        )
        .expect("解得开");
        let other = verify(&old, 10, &check(&button)).expect_err("应当拒绝");
        assert!(other.starts_with("ref_stale: "), "{other}");
        for changed in [
            Facts {
                role: kind::CHECK_BOX.to_owned(),
                ..button.clone()
            },
            Facts {
                subrole: "AXCloseButton".to_owned(),
                ..button.clone()
            },
            Facts {
                identifier: "save".to_owned(),
                ..button.clone()
            },
        ] {
            let refused = verify(&old, 9, &check(&changed)).expect_err("应当拒绝");
            assert!(refused.starts_with("ref_stale: "), "{refused}");
        }
        // 不带核对串的 ref 不是这个后端交出的。
        let bare = crate::tree::decode_ref("w.0#9").expect("解得开");
        assert!(verify(&bare, 9, &check(&button)).is_err());
    }

    /// 词表里有的角色交回协议名，没有的交回带前缀的原名，不落进词表。
    #[test]
    fn roles_map_into_the_vocabulary_or_keep_their_own_name() {
        assert_eq!(role_name("AXButton", "AXCloseButton"), "button");
        assert_eq!(role_name("AXWindow", "AXStandardWindow"), "window");
        assert_eq!(role_name("AXTextArea", ""), "edit");
        assert_eq!(role_name("AXPopUpButton", ""), "combo_box");
        assert_eq!(role_name("AXRow", "AXTableRow"), "data_item");
        assert_eq!(role_name("AXWebArea", ""), "document");
        for (raw, expected) in [
            ("AXDateField", "ax_date_field"),
            ("AXColorWell", "ax_color_well"),
            ("", "ax_unknown"),
            ("MyCustomRole", "ax_my_custom_role"),
            ("AXURLField", "ax_url_field"),
        ] {
            let name = role_name(raw, "");
            assert_eq!(name, expected);
            assert!(Role::ALL.iter().all(|r| r.as_str() != name));
        }
    }
}
