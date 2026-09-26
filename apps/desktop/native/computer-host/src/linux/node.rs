//! AT-SPI 对象的事实换算成协议节点：角色与状态进共用词表，可用动作按对象真实暴露的接口
//! 与动作列出。
//!
//! 本模块不调总线。动作那一刻按同一套判定挑动作下标（`claim`、`selectable_in`），
//! 列出的动作与派发的调用因此只有一处来源。

use atspi::{Interface, InterfaceSet, Role as AtspiRole, State, StateSet};

use crate::geometry::ScreenRect;
use crate::protocol::{range_state, Node, NodeAction, Role, ScrollState, ToggleState, REF_STALE};
use crate::tree::{encode_ref, fingerprint, Identity, RefParts};

/// 一个对象读到的原始事实。
#[derive(Debug, Clone)]
pub struct Facts {
    pub role: AtspiRole,
    pub name: String,
    pub accessible_id: String,
    pub states: StateSet,
    pub interfaces: InterfaceSet,
    /// 动作名，下标即 `DoAction` 的参数。
    ///
    /// 取的是 `GetName` 的非本地化名称。不要改用 `GetActions`：它交回本地化名称，
    /// 中文会话里 GTK 的 `click` 会变成「点击」，按名字挑动作的判定全部落空。
    pub actions: Vec<String>,
    pub extents: Option<ScreenRect>,
    pub value: Option<Numbers>,
    /// 文本内容。没有 Text 接口、这一次不取值或超过 `VALUE_TEXT_LIMIT` 时缺席。
    pub text: Option<String>,
}

/// Value 接口的四个数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Numbers {
    pub current: f64,
    pub min: f64,
    pub max: f64,
    /// `MinimumIncrement`。0 表示应用没给步长。
    pub increment: f64,
}

/// 父对象里与子节点可用动作有关的事实。
#[derive(Debug, Clone, Copy, Default)]
pub struct Context {
    /// 父对象实现了 Selection 接口，子节点的选择经它改。
    pub selection: bool,
    pub showing: bool,
    pub multiselectable: bool,
}

impl Context {
    pub fn of(parent: &Facts) -> Self {
        Self {
            selection: parent.interfaces.contains(Interface::Selection),
            showing: parent.states.contains(State::Showing),
            multiselectable: parent.states.contains(State::Multiselectable),
        }
    }
}

/// 节点值里最多带多少个字符的文本。超过即不带，调用方经 `read_text` 读全文。
///
/// 不要改成截一段前缀交出：终端与长文档的前缀是最早的内容，不是正在显示的内容，而节点值
/// 没有「已截断」标记。
pub const VALUE_TEXT_LIMIT: i32 = 4096;

/// 这一次读取要取哪些可选字段。含义同 Windows 后端：前两项不影响可用动作表。
///
/// 后四项由窗口能给出什么决定，见 `super::Reach`。
#[derive(Debug, Clone, Copy)]
pub struct Fields {
    pub value: bool,
    pub state: bool,
    /// 列键盘动作，报键盘焦点。
    pub foreground: bool,
    /// 前台动作里列按控件定位的指针动作。`foreground` 为假时不起作用。
    pub pointer: bool,
    /// 窗口根上列窗口动作。`foreground` 为假时不起作用。
    pub window: bool,
    /// 节点带包围盒。包围盒不是屏幕坐标的窗口不带：`rect` 与图像几何是同一套坐标。
    pub rect: bool,
}

/// 按钮类默认动作的动作名。按优先顺序排。
const INVOKE_NAMES: [&str; 4] = ["click", "press", "activate", "jump"];
/// 复选与单选控件切换状态的动作名。Qt 给 `Toggle`，GTK 给 `click`。
const TOGGLE_NAMES: [&str; 4] = ["toggle", "click", "press", "activate"];
/// 可展开控件切换展开状态的动作名。GTK 的树表格单元给 `expand or contract`，展开器给
/// `activate`，Qt 的组合框给 `Press`。不含 `toggle`：Qt 树表格单元的 `Toggle` 切换的是选中。
const EXPAND_NAMES: [&str; 4] = ["expand or contract", "activate", "click", "press"];

/// 一个对象的「点一下」动作承担的是哪一种语义，以及它的动作下标。
///
/// 一个对象只取一种：复选框的 `click` 是 `set_toggle`，不再同时列成 `invoke`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Click {
    Invoke(i32),
    Toggle(i32),
    /// 单选按钮：`select` 经它的动作发出。
    Radio(i32),
    Expand(i32),
}

fn action_index(facts: &Facts, names: &[&str]) -> Option<i32> {
    names.iter().find_map(|want| {
        facts
            .actions
            .iter()
            .position(|a| a.eq_ignore_ascii_case(want))
            .and_then(|i| i32::try_from(i).ok())
    })
}

fn radio(role: AtspiRole) -> bool {
    matches!(role, AtspiRole::RadioButton | AtspiRole::RadioMenuItem)
}

fn checkable(facts: &Facts) -> bool {
    facts.states.contains(State::Checkable)
        || matches!(
            facts.role,
            AtspiRole::CheckBox | AtspiRole::CheckMenuItem | AtspiRole::ToggleButton
        )
}

/// 这个对象的「点一下」归哪一种语义。顺序：单选 → 可展开 → 可复选 → 默认动作。
///
/// 可展开先于可复选：GTK 的展开器是一个带展开状态的切换按钮，它的动作展开内容。
pub fn claim(facts: &Facts) -> Option<Click> {
    if radio(facts.role) {
        return action_index(facts, &TOGGLE_NAMES).map(Click::Radio);
    }
    if facts.states.contains(State::Expandable) {
        return action_index(facts, &EXPAND_NAMES).map(Click::Expand);
    }
    if checkable(facts) {
        return action_index(facts, &TOGGLE_NAMES).map(Click::Toggle);
    }
    action_index(facts, &INVOKE_NAMES).map(Click::Invoke)
}

/// 这个对象能不能经父对象的 Selection 接口选中，能的话容器是否允许多选。
///
/// 父对象此刻不在屏幕上时不算：Qt 组合框收起时的下拉列表也实现 Selection，改它的选中项
/// 不会改组合框的当前值。
pub fn selectable_in(facts: &Facts, context: Context) -> Option<bool> {
    (facts.states.contains(State::Selectable)
        && context.selection
        && context.showing
        && !radio(facts.role))
    .then_some(context.multiselectable || facts.states.contains(State::Multiselectable))
}

/// 复选状态。Qt 的中间态同时带 `checked` 与 `indeterminate`，先判中间态。
pub fn toggle_state(states: StateSet) -> ToggleState {
    if states.contains(State::Indeterminate) {
        ToggleState::Indeterminate
    } else if states.contains(State::Checked) {
        ToggleState::On
    } else {
        ToggleState::Off
    }
}

/// 滚动条的方向。GTK 在状态里给，Qt 不给，按包围盒的长边判；两样都没有时判不出。
pub fn orientation(facts: &Facts) -> Option<Axis> {
    if facts.states.contains(State::Vertical) {
        return Some(Axis::Vertical);
    }
    if facts.states.contains(State::Horizontal) {
        return Some(Axis::Horizontal);
    }
    let rect = facts.extents?;
    match rect.height.cmp(&rect.width) {
        std::cmp::Ordering::Greater => Some(Axis::Vertical),
        std::cmp::Ordering::Less => Some(Axis::Horizontal),
        std::cmp::Ordering::Equal => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// 这个对象是可以按步滚动的滚动条：角色是滚动条、有 Value 接口、方向判得出。
pub fn scroll_bar(facts: &Facts) -> Option<(Axis, Numbers)> {
    if facts.role != AtspiRole::ScrollBar {
        return None;
    }
    Some((orientation(facts)?, facts.value?))
}

/// 可编辑文本：有 EditableText 接口、带 `editable` 状态且不带 `read-only`。
///
/// 只看接口不够：GTK 3 的只读输入框照样实现 EditableText，`SetTextContents` 返回真而内容
/// 不变；Qt 的只读输入框则真的被改掉。
pub fn editable(facts: &Facts) -> bool {
    facts.interfaces.contains(Interface::EditableText)
        && facts.states.contains(State::Editable)
        && !facts.states.contains(State::ReadOnly)
}

/// 数值只读：带 `read-only`，或角色本身只显示进度。
pub fn range_read_only(facts: &Facts) -> bool {
    facts.states.contains(State::ReadOnly)
        || matches!(facts.role, AtspiRole::ProgressBar | AtspiRole::LevelBar)
}

/// 能不能设文本选区：有 Text 接口，且是可编辑文本或带 `selectable-text`。
pub fn text_selectable(facts: &Facts) -> bool {
    facts.interfaces.contains(Interface::Text)
        && (facts.interfaces.contains(Interface::EditableText)
            || facts.states.contains(State::SelectableText))
}

/// 可用：`enabled` 或 `sensitive` 任一。GTK 3 给中间态复选框去掉 `enabled` 而留着 `sensitive`。
pub fn enabled(states: StateSet) -> bool {
    states.contains(State::Enabled) || states.contains(State::Sensitive)
}

/// 这个对象列出的后台动作。模式缺失的动作不列；前台动作由 `foreground_offers` 列。
pub fn offers(facts: &Facts, context: Context) -> Vec<NodeAction> {
    let mut out = Vec::new();
    let click = claim(facts);
    if facts.interfaces.contains(Interface::EditableText) {
        out.push(if editable(facts) {
            NodeAction::ready("set_value")
        } else {
            NodeAction::blocked("set_value", "read_only")
        });
    }
    if matches!(click, Some(Click::Invoke(_))) {
        out.push(NodeAction::ready("invoke"));
    }
    if facts.interfaces.contains(Interface::Value) {
        out.push(if range_read_only(facts) {
            NodeAction::blocked("set_range_value", "read_only")
        } else {
            NodeAction::ready("set_range_value")
        });
    }
    if matches!(click, Some(Click::Toggle(_))) {
        out.push(NodeAction::ready("set_toggle"));
    }
    if matches!(click, Some(Click::Expand(_))) {
        out.push(NodeAction::ready("expand"));
        out.push(NodeAction::ready("collapse"));
    }
    if matches!(click, Some(Click::Radio(_))) {
        out.push(NodeAction::ready("select"));
    } else if let Some(multiple) = selectable_in(facts, context) {
        out.push(NodeAction::ready("select"));
        if multiple {
            out.push(NodeAction::ready("add_to_selection"));
            out.push(NodeAction::ready("remove_from_selection"));
        }
    }
    if let Some((_, numbers)) = scroll_bar(facts) {
        out.push(if numbers.max > numbers.min {
            NodeAction::ready("scroll")
        } else {
            NodeAction::blocked("scroll", "not_scrollable")
        });
    }
    if text_selectable(facts) {
        out.push(NodeAction::ready("select_text"));
    }
    out
}

/// 这个对象列出的前台动作。调用方只在前台模式开着、且窗口收得到键盘输入时要；`pointer`
/// 为假时不列指针动作，`window` 为假时不列窗口动作。
///
/// 指针动作只列在有包围盒、此刻显示着的控件上：没有包围盒就指不出落点。键盘动作列在持有
/// 键盘焦点的控件与窗口根节点上：自绘界面给不出持有焦点的控件，只列前者等于对它关掉整条
/// 键盘路径。窗口动作只列在窗口根节点上。`path` 为空才是窗口根自己。
pub fn foreground_offers(
    facts: &Facts,
    path: &[usize],
    pointer: bool,
    window: bool,
) -> Vec<NodeAction> {
    let mut out = Vec::new();
    if pointer && facts.extents.is_some() && facts.states.contains(State::Showing) {
        for action in ["click", "hover", "drag", "wheel"] {
            out.push(NodeAction::foreground(action));
        }
    }
    if facts.states.contains(State::Focused) || path.is_empty() {
        out.push(NodeAction::foreground("type_text"));
        out.push(NodeAction::foreground("press_key"));
    }
    if window && path.is_empty() {
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

/// 身份段：总线唯一名接对象路径。段首不是 `~`，协调器按它给稳定短编号。
///
/// 不要把指纹或名称放进身份段：组合框、标签与列表行的名称随内容变，协调器会把改了内容的
/// 同一个控件当成删掉一个、新增一个，短编号与差异投递都随之失效。
pub fn identity(key: &str) -> Identity {
    Identity::Stable(key.to_owned())
}

/// 核对串：角色与稳定标识的指纹，写在 `ref` 的 `#` 之前，重新定位时与身份段一起核对。
///
/// 对象路径在对象销毁后可能再分配给别的对象，换成的对象通常换了角色。名称不进核对串：
/// 名称随内容变的控件改了内容仍是同一个控件。
pub fn check(facts: &Facts) -> String {
    fingerprint(&role_name(facts.role), "", &facts.accessible_id)
}

/// 按 `ref` 重新定位到的对象是不是 `ref` 记的那一个：身份段与核对串都要对上。
pub fn verify(expected: &RefParts, key: &str, facts: &Facts) -> Result<(), String> {
    let actual = check(facts);
    if expected.identity != identity(key) {
        return Err(format!(
            "{REF_STALE}: 该位置现在是对象 {key}，ref 里记的是 {}，请重新观察",
            describe(&expected.identity)
        ));
    }
    if expected.check.as_deref() != Some(actual.as_str()) {
        return Err(format!(
            "{REF_STALE}: 对象 {key} 的角色或稳定标识已经变了（核对串 {actual}，ref 里记的是 {}），这个对象路径已经给了别的控件，请重新观察",
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
pub fn node(facts: &Facts, context: Context, path: &[usize], key: &str, fields: Fields) -> Node {
    let states = facts.states;
    let click = claim(facts);
    let value = if !fields.value {
        None
    } else if facts.interfaces.contains(Interface::EditableText) {
        facts.text.clone()
    } else {
        // 标签的文本就是它的名称，不重复给一遍。
        facts
            .text
            .clone()
            .filter(|t| !t.trim().is_empty() && t.trim() != facts.name.trim())
    };
    let range = facts.value.filter(|_| fields.state).and_then(|n| {
        range_state(
            n.current,
            n.min,
            n.max,
            if n.increment > 0.0 {
                n.increment
            } else {
                f64::NAN
            },
            f64::NAN,
        )
    });
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
    let id = identity(key);
    Node {
        reference: encode_ref(path, Some(&check(facts)), &id),
        parent_ref: None,
        depth: 0,
        role: role_name(facts.role),
        name: facts.name.clone(),
        automation_id: facts.accessible_id.clone(),
        value,
        enabled: enabled(states),
        offscreen: !states.contains(State::Showing),
        focused: fields.foreground && states.contains(State::Focused),
        rect: facts.extents.filter(|_| fields.rect),
        actions: {
            let mut actions = offers(facts, context);
            if fields.foreground {
                actions.extend(foreground_offers(
                    facts,
                    path,
                    fields.pointer,
                    fields.window,
                ));
            }
            actions
        },
        range,
        toggle: matches!(click, Some(Click::Toggle(_)))
            .then(|| toggle_state(states).as_str())
            .filter(|_| fields.state),
        expand: states
            .contains(State::Expandable)
            .then(|| {
                if states.contains(State::Expanded) {
                    "expanded"
                } else {
                    "collapsed"
                }
            })
            .filter(|_| fields.state),
        selected: if radio(facts.role) {
            Some(states.contains(State::Checked))
        } else {
            states
                .contains(State::Selectable)
                .then(|| states.contains(State::Selected))
        }
        .filter(|_| fields.state),
        // AT-SPI 没有「容器要求始终选中一项」这一项，给不出完整的容器约束。
        selection: None,
        scroll,
        text: facts.interfaces.contains(Interface::Text),
        weak_identity: id.is_weak(),
    }
}

/// 包围盒换算。零尺寸与 `i32::MIN` 坐标按缺席算：GTK 3 对没有分配位置的控件交回
/// `(-2147483648, -2147483648, 1, 1)`，Qt 对收起的下拉列表交回全零。
pub fn extents(x: i32, y: i32, width: i32, height: i32) -> Option<ScreenRect> {
    (width > 0 && height > 0 && x != i32::MIN && y != i32::MIN).then_some(ScreenRect {
        x,
        y,
        width,
        height,
    })
}

/// AT-SPI 角色换算成协议角色名。词表里没有对应的角色交回 `atspi_<角色名>`，不猜一个相近的。
pub fn role_name(role: AtspiRole) -> String {
    vocabulary(role).map_or_else(
        || format!("atspi_{}", role.name().replace([' ', '-'], "_")),
        |r| r.as_str().to_owned(),
    )
}

fn vocabulary(role: AtspiRole) -> Option<Role> {
    use AtspiRole as A;
    Some(match role {
        A::Button | A::ToggleButton | A::PushButtonMenu => Role::Button,
        A::Calendar => Role::Calendar,
        A::CheckBox => Role::CheckBox,
        A::ComboBox | A::Autocomplete => Role::ComboBox,
        A::Entry | A::PasswordText | A::Text => Role::Edit,
        A::Link => Role::Hyperlink,
        A::Image | A::Icon | A::ImageMap => Role::Image,
        A::ListItem => Role::ListItem,
        A::List | A::ListBox => Role::List,
        A::Menu | A::PopupMenu => Role::Menu,
        A::MenuBar => Role::MenuBar,
        A::MenuItem | A::CheckMenuItem | A::RadioMenuItem | A::TearoffMenuItem => Role::MenuItem,
        A::ProgressBar | A::LevelBar => Role::ProgressBar,
        A::RadioButton => Role::RadioButton,
        A::ScrollBar => Role::ScrollBar,
        A::Slider | A::Dial => Role::Slider,
        A::SpinButton => Role::Spinner,
        A::StatusBar => Role::StatusBar,
        A::PageTabList => Role::Tab,
        A::PageTab => Role::TabItem,
        A::Label | A::Static | A::Caption | A::Heading | A::Paragraph => Role::Text,
        A::ToolBar | A::Editbar => Role::ToolBar,
        A::ToolTip => Role::ToolTip,
        A::Tree | A::TreeTable => Role::Tree,
        A::TreeItem => Role::TreeItem,
        A::Canvas | A::DrawingArea => Role::Custom,
        A::Filler
        | A::Grouping
        | A::Section
        | A::Form
        | A::Landmark
        | A::Article
        | A::BlockQuote
        | A::Embedded
        | A::Header
        | A::Footer => Role::Group,
        A::TableCell | A::TableRow => Role::DataItem,
        A::DocumentFrame
        | A::DocumentText
        | A::DocumentWeb
        | A::DocumentEmail
        | A::DocumentSpreadsheet
        | A::DocumentPresentation
        | A::HTMLContainer
        | A::Page
        | A::Terminal => Role::Document,
        A::Frame
        | A::Window
        | A::Dialog
        | A::Alert
        | A::FileChooser
        | A::ColorChooser
        | A::FontChooser
        | A::InternalFrame => Role::Window,
        A::Panel
        | A::ScrollPane
        | A::Viewport
        | A::LayeredPane
        | A::RootPane
        | A::GlassPane
        | A::SplitPane
        | A::OptionPane
        | A::DirectoryPane => Role::Pane,
        A::ColumnHeader | A::RowHeader | A::TableColumnHeader | A::TableRowHeader => {
            Role::HeaderItem
        }
        A::Table => Role::Table,
        A::TitleBar => Role::TitleBar,
        A::Separator => Role::Separator,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::DELIVERY_BACKGROUND;

    fn facts(
        role: AtspiRole,
        states: &[State],
        interfaces: &[Interface],
        actions: &[&str],
    ) -> Facts {
        let mut set = StateSet::empty();
        for s in states {
            set.insert(*s);
        }
        let mut ifaces = InterfaceSet::empty();
        for i in interfaces {
            ifaces.insert(*i);
        }
        Facts {
            role,
            name: "控件".to_owned(),
            accessible_id: String::new(),
            states: set,
            interfaces: ifaces,
            actions: actions.iter().map(|a| (*a).to_owned()).collect(),
            extents: extents(10, 20, 100, 30),
            value: None,
            text: None,
        }
    }

    fn names(actions: &[NodeAction]) -> Vec<&'static str> {
        actions.iter().map(|a| a.action).collect()
    }

    const SHOWN: &[State] = &[
        State::Enabled,
        State::Sensitive,
        State::Showing,
        State::Visible,
    ];
    const FIELDS: Fields = Fields {
        value: true,
        state: true,
        foreground: false,
        pointer: false,
        window: false,
        rect: true,
    };

    fn foreground_names(node: &Node) -> Vec<&'static str> {
        node.actions
            .iter()
            .filter(|a| a.delivery.contains(&crate::protocol::DELIVERY_FOREGROUND))
            .map(|a| a.action)
            .collect()
    }

    /// 前台模式关着时一个前台动作都不列；开着时指针动作列在显示着的控件上，键盘动作列在
    /// 持有焦点的控件与窗口根上，窗口动作只列在窗口根上。
    #[test]
    fn foreground_actions_follow_the_mode_the_focus_and_the_window_root() {
        let on = Fields {
            foreground: true,
            pointer: true,
            window: true,
            ..FIELDS
        };
        let button = facts(AtspiRole::Button, SHOWN, &[Interface::Action], &["click"]);
        assert!(
            foreground_names(&node(&button, Context::default(), &[0, 1], KEY, FIELDS)).is_empty()
        );
        assert_eq!(
            foreground_names(&node(&button, Context::default(), &[0, 1], KEY, on)),
            ["click", "hover", "drag", "wheel"]
        );
        let mut hidden = button.clone();
        hidden.states.remove(State::Showing);
        assert!(foreground_names(&node(&hidden, Context::default(), &[0, 1], KEY, on)).is_empty());
        let mut focused: Vec<State> = SHOWN.to_vec();
        focused.push(State::Focused);
        let entry = facts(AtspiRole::Entry, &focused, &[Interface::EditableText], &[]);
        assert_eq!(
            foreground_names(&node(&entry, Context::default(), &[0, 2], KEY, on)),
            ["click", "hover", "drag", "wheel", "type_text", "press_key"]
        );
        let frame = facts(AtspiRole::Frame, SHOWN, &[], &[]);
        assert_eq!(
            foreground_names(&node(&frame, Context::default(), &[], KEY, on)),
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
                "resize_window"
            ]
        );
    }

    /// Wayland 会话里的 X 窗口：键盘与窗口动作照列，指针动作一个都不列，哪怕控件有包围盒。
    #[test]
    fn a_window_without_pointer_reach_lists_keyboard_and_window_actions_only() {
        let keys_only = Fields {
            foreground: true,
            pointer: false,
            window: true,
            ..FIELDS
        };
        let frame = facts(AtspiRole::Frame, SHOWN, &[], &[]);
        assert_eq!(
            foreground_names(&node(&frame, Context::default(), &[], KEY, keys_only)),
            [
                "type_text",
                "press_key",
                "activate",
                "set_window_state",
                "close_window",
                "move_window",
                "resize_window"
            ]
        );
        let button = facts(AtspiRole::Button, SHOWN, &[Interface::Action], &["click"]);
        assert!(
            foreground_names(&node(&button, Context::default(), &[0], KEY, keys_only)).is_empty()
        );
    }

    /// 经 portal 共享的原生 Wayland 窗口：只列键盘动作。窗口动作合成器不允许，指针动作只按图
    /// 定位，控件上不列。
    #[test]
    fn a_shared_wayland_window_lists_keyboard_actions_only() {
        let keyboard = Fields {
            foreground: true,
            pointer: false,
            window: false,
            rect: false,
            ..FIELDS
        };
        let frame = facts(AtspiRole::Frame, SHOWN, &[], &[]);
        assert_eq!(
            foreground_names(&node(&frame, Context::default(), &[], KEY, keyboard)),
            ["type_text", "press_key"]
        );
    }

    /// 原始失败形状：原生 Wayland 窗口的包围盒以 surface 为原点，按屏幕坐标发布出去，调用方
    /// 会拿它取景、算拖拽偏移。不发布时节点照常列出，可用动作不变。
    #[test]
    fn a_rect_that_is_not_in_screen_coordinates_is_withheld() {
        let button = facts(AtspiRole::Button, SHOWN, &[Interface::Action], &["click"]);
        let shown = node(&button, Context::default(), &[0], KEY, FIELDS);
        assert_eq!(shown.rect, extents(10, 20, 100, 30));
        let withheld = node(
            &button,
            Context::default(),
            &[0],
            KEY,
            Fields {
                rect: false,
                ..FIELDS
            },
        );
        assert_eq!(withheld.rect, None);
        assert_eq!(names(&withheld.actions), ["invoke"]);
        assert!(!withheld.offscreen);
    }

    /// GTK 按钮给 `click`，Qt 按钮给 `Press` 与 `SetFocus`；两者都列成 `invoke`，
    /// `SetFocus` 会移走键盘焦点，不映射成任何动作。
    #[test]
    fn a_button_offers_invoke_through_its_default_action() {
        let gtk = facts(AtspiRole::Button, SHOWN, &[Interface::Action], &["click"]);
        assert_eq!(claim(&gtk), Some(Click::Invoke(0)));
        assert_eq!(names(&offers(&gtk, Context::default())), ["invoke"]);
        let qt = facts(
            AtspiRole::Button,
            SHOWN,
            &[Interface::Action],
            &["SetFocus", "Press"],
        );
        assert_eq!(claim(&qt), Some(Click::Invoke(1)));
        let focus_only = facts(
            AtspiRole::Button,
            SHOWN,
            &[Interface::Action],
            &["SetFocus"],
        );
        assert_eq!(claim(&focus_only), None);
        assert!(offers(&focus_only, Context::default()).is_empty());
    }

    /// 复选框的 `click` 只列成 `set_toggle`；Qt 的 `Toggle` 优先于 `Press`。
    #[test]
    fn a_check_box_offers_set_toggle_and_not_invoke() {
        let gtk = facts(AtspiRole::CheckBox, SHOWN, &[Interface::Action], &["click"]);
        assert_eq!(claim(&gtk), Some(Click::Toggle(0)));
        assert_eq!(names(&offers(&gtk, Context::default())), ["set_toggle"]);
        let qt = facts(
            AtspiRole::CheckBox,
            &[State::Checkable, State::Enabled],
            &[Interface::Action],
            &["Press", "Toggle", "SetFocus"],
        );
        assert_eq!(claim(&qt), Some(Click::Toggle(1)));
    }

    /// Qt 的中间态同时带 `checked` 与 `indeterminate`。
    #[test]
    fn the_indeterminate_state_wins_over_checked() {
        let mut both = StateSet::empty();
        both.insert(State::Checked);
        both.insert(State::Indeterminate);
        assert_eq!(toggle_state(both), ToggleState::Indeterminate);
        let mut on = StateSet::empty();
        on.insert(State::Checked);
        assert_eq!(toggle_state(on), ToggleState::On);
        assert_eq!(toggle_state(StateSet::empty()), ToggleState::Off);
    }

    /// GTK 3 的展开器是可展开的切换按钮，它的 `activate` 展开内容，不是复选。
    #[test]
    fn an_expander_offers_expand_and_collapse() {
        let expander = facts(
            AtspiRole::ToggleButton,
            &[State::Expandable, State::Enabled],
            &[Interface::Action],
            &["activate"],
        );
        assert_eq!(claim(&expander), Some(Click::Expand(0)));
        assert_eq!(
            names(&offers(&expander, Context::default())),
            ["expand", "collapse"]
        );
        let cell = facts(
            AtspiRole::TableCell,
            &[State::Expandable],
            &[Interface::Action],
            &["expand or contract", "edit", "activate"],
        );
        assert_eq!(claim(&cell), Some(Click::Expand(0)));
    }

    /// Qt 树表格单元只有切换选中的 `Toggle`：可展开状态照报，不列展开动作。
    #[test]
    fn an_expandable_cell_without_an_expand_action_offers_no_expansion() {
        let qt = facts(
            AtspiRole::TableCell,
            &[State::Expandable, State::Selectable, State::Showing],
            &[Interface::Action],
            &["Toggle"],
        );
        assert_eq!(claim(&qt), None);
        let node = node(&qt, Context::default(), &[0], ":1.2/x", FIELDS);
        assert_eq!(node.expand, Some("collapsed"));
        assert!(!names(&node.actions).contains(&"expand"));
    }

    /// 选择项经父对象的 Selection 接口改选中；容器或项带 `multiselectable` 才列增选与取消。
    #[test]
    fn a_selectable_item_offers_selection_through_its_container() {
        let item = facts(
            AtspiRole::ListItem,
            &[State::Selectable, State::Showing],
            &[],
            &[],
        );
        let single = Context {
            selection: true,
            showing: true,
            multiselectable: false,
        };
        assert_eq!(names(&offers(&item, single)), ["select"]);
        let multi = Context {
            multiselectable: true,
            ..single
        };
        assert_eq!(
            names(&offers(&item, multi)),
            ["select", "add_to_selection", "remove_from_selection"]
        );
        // Qt 把 multiselectable 放在项上而不是容器上。
        let qt = facts(
            AtspiRole::ListItem,
            &[State::Selectable, State::Multiselectable],
            &[Interface::Action],
            &["Toggle"],
        );
        assert_eq!(selectable_in(&qt, single), Some(true));
        // 容器不实现 Selection，或此刻不在屏幕上（收起的下拉列表），一条选择动作都不列。
        assert!(offers(
            &item,
            Context {
                selection: false,
                ..single
            }
        )
        .is_empty());
        assert!(offers(
            &item,
            Context {
                showing: false,
                ..single
            }
        )
        .is_empty());
    }

    /// 单选按钮的 `select` 经它自己的动作发出，选中状态取 `checked`。
    #[test]
    fn a_radio_button_offers_select_and_reports_checked_as_selected() {
        let radio = facts(
            AtspiRole::RadioButton,
            &[State::Checked, State::Showing],
            &[Interface::Action],
            &["click"],
        );
        assert_eq!(claim(&radio), Some(Click::Radio(0)));
        let node = node(&radio, Context::default(), &[1], ":1.2/x", FIELDS);
        assert_eq!(names(&node.actions), ["select"]);
        assert_eq!(node.selected, Some(true));
        assert_eq!(node.toggle, None);
    }

    /// 只读输入框照样列 `set_value`，但标成此刻不可用；GTK 3 靠缺 `editable`，Qt 靠 `read-only`。
    #[test]
    fn a_read_only_entry_offers_set_value_as_blocked() {
        let text = [Interface::EditableText, Interface::Text];
        let gtk = facts(AtspiRole::Text, &[State::Enabled], &text, &["activate"]);
        let qt = facts(
            AtspiRole::Text,
            &[State::Editable, State::ReadOnly],
            &text,
            &["SetFocus"],
        );
        let writable = facts(AtspiRole::Text, &[State::Editable], &text, &[]);
        for blocked in [&gtk, &qt] {
            let offer = &offers(blocked, Context::default())[0];
            assert_eq!(offer.action, "set_value");
            assert_eq!(offer.unavailable, Some("read_only"));
            assert!(offer.delivery.is_empty());
        }
        let offer = &offers(&writable, Context::default())[0];
        assert_eq!(offer.delivery, vec![DELIVERY_BACKGROUND]);
        assert!(names(&offers(&writable, Context::default())).contains(&"select_text"));
    }

    /// 滚动条按步滚动；滚不动的轴标成不可用。方向 GTK 给状态，Qt 按包围盒判。
    #[test]
    fn a_scroll_bar_offers_scroll_on_its_own_axis() {
        let mut bar = facts(
            AtspiRole::ScrollBar,
            &[State::Vertical],
            &[Interface::Value],
            &[],
        );
        bar.value = Some(Numbers {
            current: 0.0,
            min: 0.0,
            max: 1150.0,
            increment: 11.0,
        });
        assert_eq!(scroll_bar(&bar).map(|s| s.0), Some(Axis::Vertical));
        assert_eq!(
            names(&offers(&bar, Context::default())),
            ["set_range_value", "scroll"]
        );
        let node = node(&bar, Context::default(), &[2], ":1.2/x", FIELDS);
        assert_eq!(node.scroll.and_then(|s| s.vertical), Some(0.0));
        let mut qt = facts(
            AtspiRole::ScrollBar,
            &[],
            &[Interface::Value],
            &["Increase"],
        );
        qt.extents = extents(1195, 561, 14, 108);
        qt.value = Some(Numbers {
            current: 0.0,
            min: 0.0,
            max: 0.0,
            increment: 20.0,
        });
        assert_eq!(orientation(&qt), Some(Axis::Vertical));
        let offer = offers(&qt, Context::default());
        assert_eq!(offer[1].unavailable, Some("not_scrollable"));
    }

    /// 标签的文本等于名称时不重复给值；输入框的值就是文本，空串也给。
    #[test]
    fn a_label_does_not_repeat_its_name_as_value() {
        let mut label = facts(AtspiRole::Label, SHOWN, &[Interface::Text], &[]);
        label.text = Some("控件".to_owned());
        assert_eq!(
            node(&label, Context::default(), &[], ":1.2/x", FIELDS).value,
            None
        );
        let mut entry = facts(
            AtspiRole::Text,
            SHOWN,
            &[Interface::Text, Interface::EditableText],
            &[],
        );
        entry.text = Some(String::new());
        assert_eq!(
            node(&entry, Context::default(), &[], ":1.2/x", FIELDS)
                .value
                .as_deref(),
            Some("")
        );
        let skip = Fields {
            value: false,
            ..FIELDS
        };
        assert_eq!(
            node(&entry, Context::default(), &[], ":1.2/x", skip).value,
            None
        );
    }

    const KEY: &str = ":1.2/org/a11y/atspi/accessible/7";

    fn reference_of(facts: &Facts) -> String {
        node(facts, Context::default(), &[0, 3], KEY, FIELDS).reference
    }

    /// 身份段只有对象串，核对串在 `#` 之前：协调器按 `#` 之后给短编号。
    #[test]
    fn the_identity_segment_is_the_object_alone() {
        let combo = facts(AtspiRole::ComboBox, SHOWN, &[], &[]);
        let reference = reference_of(&combo);
        let (head, segment) = reference.split_once('#').expect("ref 带身份段");
        assert_eq!(segment, KEY);
        assert!(head.starts_with("w.0.3@"));
        assert!(!identity(KEY).is_weak());
    }

    /// 原始失败形状：组合框换了选中项、名称随之从 alpha 变成 beta，身份段与整条 ref 都不变，
    /// 旧 ref 照样重新定位得上。
    #[test]
    fn a_control_whose_name_follows_its_content_keeps_its_ref() {
        let alpha = Facts {
            name: "alpha".to_owned(),
            ..facts(AtspiRole::ComboBox, SHOWN, &[], &[])
        };
        let beta = Facts {
            name: "beta".to_owned(),
            ..alpha.clone()
        };
        assert_eq!(reference_of(&alpha), reference_of(&beta));
        let old = crate::tree::decode_ref(&reference_of(&alpha)).expect("解得开");
        assert_eq!(verify(&old, KEY, &beta), Ok(()));
    }

    /// 同一个对象路径上换成了别的角色或别的稳定标识：对象路径已经给了别的控件，`ref_stale`。
    #[test]
    fn a_different_role_or_id_at_the_same_object_is_stale() {
        let button = facts(AtspiRole::Button, SHOWN, &[], &[]);
        let old = crate::tree::decode_ref(&reference_of(&button)).expect("解得开");
        let label = Facts {
            role: AtspiRole::Label,
            ..button.clone()
        };
        let renamed_id = Facts {
            accessible_id: "other".to_owned(),
            ..button.clone()
        };
        for changed in [&label, &renamed_id] {
            let refused = verify(&old, KEY, changed).expect_err("应当拒绝");
            assert!(refused.starts_with("ref_stale: "), "{refused}");
        }
        // 另一个对象（应用重启后唯一名变了）同样拒绝。
        let restarted =
            verify(&old, ":1.9/org/a11y/atspi/accessible/7", &button).expect_err("应当拒绝");
        assert!(restarted.starts_with("ref_stale: "));
        // 不带核对串的 ref 不是这个后端交出的。
        let bare = crate::tree::decode_ref(&format!("w.0.3#{KEY}")).expect("解得开");
        assert!(verify(&bare, KEY, &button).is_err());
    }

    /// GTK 3 的中间态复选框去掉了 `enabled` 而留着 `sensitive`，仍然可用。
    #[test]
    fn sensitive_alone_counts_as_enabled() {
        let mut s = StateSet::empty();
        s.insert(State::Sensitive);
        assert!(enabled(s));
        assert!(!enabled(StateSet::empty()));
    }

    #[test]
    fn unplaced_extents_are_absent() {
        assert_eq!(extents(i32::MIN, i32::MIN, 1, 1), None);
        assert_eq!(extents(0, 0, 0, 0), None);
        assert!(extents(-5, 3, 10, 10).is_some());
    }

    /// 词表里有的角色交回协议名，没有的交回带前缀的原名，不落进词表。
    #[test]
    fn roles_map_into_the_vocabulary_or_keep_their_own_name() {
        assert_eq!(role_name(AtspiRole::Button), "button");
        assert_eq!(role_name(AtspiRole::Filler), "group");
        assert_eq!(role_name(AtspiRole::Frame), "window");
        assert_eq!(role_name(AtspiRole::Text), "edit");
        assert_eq!(role_name(AtspiRole::Label), "text");
        let raw = role_name(AtspiRole::AcceleratorLabel);
        assert_eq!(raw, "atspi_accelerator_label");
        assert!(Role::ALL.iter().all(|r| r.as_str() != raw));
    }
}
