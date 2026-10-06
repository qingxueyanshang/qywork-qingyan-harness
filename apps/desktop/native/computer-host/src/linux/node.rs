//! 将 AT-SPI 对象的事实换算为协议节点：角色与状态映射到共用词表，可用动作按对象实际暴露的
//! 接口与动作列出。
//!
//! 本模块不调用总线。执行动作时按同一套判定选择动作下标（`claim`、`selectable_in`），
//! 因此列出的动作与派发的调用只有一处来源。

use atspi::{Interface, InterfaceSet, Role as AtspiRole, State, StateSet};

use crate::geometry::ScreenRect;
use crate::protocol::{range_state, Node, NodeAction, Role, ScrollState, ToggleState, REF_STALE};
use crate::tree::{encode_ref, fingerprint, Identity, RefParts};

/// 读取一个对象得到的原始事实。
#[derive(Debug, Clone)]
pub struct Facts {
    pub role: AtspiRole,
    pub name: String,
    pub accessible_id: String,
    pub states: StateSet,
    pub interfaces: InterfaceSet,
    /// 动作名，下标即 `DoAction` 的参数。
    ///
    /// 取自 `GetName` 的非本地化名称。不要改用 `GetActions`：它返回本地化名称，
    /// 中文会话中 GTK 的 `click` 会变为「点击」，按名称选择动作的判定全部失效。
    pub actions: Vec<String>,
    pub extents: Option<ScreenRect>,
    pub value: Option<Numbers>,
    /// 文本内容。没有 Text 接口、本次不取值或超过 `VALUE_TEXT_LIMIT` 时缺失。
    pub text: Option<String>,
}

/// Value 接口的四个数值。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Numbers {
    pub current: f64,
    pub min: f64,
    pub max: f64,
    /// `MinimumIncrement`。0 表示应用未提供步长。
    pub increment: f64,
}

/// 父对象中与子节点可用动作有关的事实。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Context {
    /// 子节点的选中状态经父对象的 Selection 修改：父对象实现了该接口，且不是菜单或组合框的下拉列表。
    pub selection: bool,
    pub multiselectable: bool,
    /// 父对象是组合框的下拉列表，即组合框的子节点中实现 Selection 的节点。下拉列表绘制在组合框
    /// 所在窗口拥有的弹出窗口中。
    pub dropdown: bool,
    /// 父对象是组合框。只用于推导子节点的 `dropdown`。
    pub combo: bool,
}

impl Context {
    /// 父对象的角色、状态与接口，`above` 是父对象自身的上下文。
    ///
    /// 菜单与组合框下拉列表的 Selection 只移动高亮：在 GTK 的菜单、GTK 与 Qt 组合框的下拉列表上，
    /// `SelectChild` 返回真，而菜单项不激活、组合框的值不变。不要按父对象当前是否显示在屏幕上判定：
    /// 下拉列表展开时同样只移动高亮。
    pub fn of(role: AtspiRole, states: StateSet, interfaces: InterfaceSet, above: Context) -> Self {
        let selection = interfaces.contains(Interface::Selection);
        let dropdown = above.combo && selection;
        Self {
            selection: selection && !dropdown && role != AtspiRole::Menu,
            multiselectable: states.contains(State::Multiselectable),
            dropdown,
            combo: role == AtspiRole::ComboBox,
        }
    }
}

/// 节点值中文本的字符数上限。超过上限即不附带文本，调用方经 `read_text` 读取全文。
///
/// 不要改为截取前缀返回：终端与长文档的前缀是最早的内容，不是正在显示的内容，而节点值
/// 没有「已截断」标记。
pub const VALUE_TEXT_LIMIT: i32 = 4096;

/// 本次读取需要获取的可选字段。含义同 Windows 后端：前两项不影响可用动作表。
///
/// 后四项由窗口可提供的能力决定，见 `super::Reach`。
#[derive(Debug, Clone, Copy)]
pub struct Fields {
    pub value: bool,
    pub state: bool,
    /// 列出键盘动作，报告键盘焦点。
    pub foreground: bool,
    /// 在前台动作中列出按控件定位的指针动作。`foreground` 为假时不起作用。
    pub pointer: bool,
    /// 在窗口根上列出窗口动作。`foreground` 为假时不起作用。
    pub window: bool,
    /// 节点附带包围盒。包围盒不是屏幕坐标的窗口不附带：`rect` 与图像几何是同一套坐标。
    pub rect: bool,
}

/// 按钮类默认动作的动作名，按优先顺序排列。
///
/// 不要加入 `select`：WebKit 下拉框的 `select` 打开或收起弹出列表，而下拉框不报告展开状态，
/// 调用方无法读取本次动作的结果。
const INVOKE_NAMES: [&str; 4] = ["click", "press", "activate", "jump"];
/// 复选控件切换状态的动作名。Qt 提供 `Toggle`，GTK 提供 `click`，WebKit 按当前状态提供 `check` 或
/// `uncheck`，动作下标不变。
const TOGGLE_NAMES: [&str; 6] = ["toggle", "click", "press", "activate", "check", "uncheck"];
/// 单选按钮选中自身的动作名。Qt 提供 `Toggle`，GTK 提供 `click`，WebKit 提供 `select`。
const RADIO_NAMES: [&str; 5] = ["toggle", "click", "press", "activate", "select"];
/// 可选项选中自身的动作名：WebKit 网页中对象的默认动作没有名称，可选项的默认动作按用户选择
/// 的方式选中该项。
///
/// 不要改为经父对象的 Selection 选中 WebKit 下拉框的选项：这样会修改值但不触发 `change`，
/// 页面脚本收不到本次选择。
const ITEM_SELECT_NAMES: [&str; 1] = [""];
/// 可展开控件切换展开状态的动作名。GTK 的树表格单元提供 `expand or contract`，展开器提供
/// `activate`，Qt 的组合框提供 `Press`。不含 `toggle`：Qt 树表格单元的 `Toggle` 切换的是选中状态。
const EXPAND_NAMES: [&str; 4] = ["expand or contract", "activate", "click", "press"];

/// 一个对象的单击动作承担的语义，以及该动作的下标。
///
/// 一个对象只取一种语义：复选框的 `click` 是 `set_toggle`，不再同时列为 `invoke`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Click {
    Invoke(i32),
    Toggle(i32),
    /// `select` 经对象自身的动作发出：单选按钮，以及默认动作没有名称的可选项。
    Select(i32),
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

/// 判定该对象的单击动作属于哪一种语义。顺序：单选 → 可展开 → 可复选 → 可选项 → 默认动作。
///
/// 可展开先于可复选：GTK 的展开器是带展开状态的切换按钮，其动作用于展开内容。
/// 可选项只接受没有名称的动作：GTK 下拉菜单的菜单项带 `selectable`，其 `click` 仍是 `invoke`。
pub fn claim(facts: &Facts) -> Option<Click> {
    if radio(facts.role) {
        return action_index(facts, &RADIO_NAMES).map(Click::Select);
    }
    if facts.states.contains(State::Expandable) {
        return action_index(facts, &EXPAND_NAMES).map(Click::Expand);
    }
    if checkable(facts) {
        return action_index(facts, &TOGGLE_NAMES).map(Click::Toggle);
    }
    if facts.states.contains(State::Selectable) {
        if let Some(index) = action_index(facts, &ITEM_SELECT_NAMES) {
            return Some(Click::Select(index));
        }
    }
    action_index(facts, &INVOKE_NAMES).map(Click::Invoke)
}

/// 该对象能否经父对象的 Selection 接口选中；能选中时返回容器是否允许多选。不计入的父对象见
/// `Context::of`。
pub fn selectable_in(facts: &Facts, context: Context) -> Option<bool> {
    (facts.states.contains(State::Selectable) && context.selection && !radio(facts.role))
        .then_some(context.multiselectable || facts.states.contains(State::Multiselectable))
}

/// 复选状态。Qt 的中间态同时带 `checked` 与 `indeterminate`，先判定中间态。
pub fn toggle_state(states: StateSet) -> ToggleState {
    if states.contains(State::Indeterminate) {
        ToggleState::Indeterminate
    } else if states.contains(State::Checked) {
        ToggleState::On
    } else {
        ToggleState::Off
    }
}

/// 滚动条的方向。GTK 在状态中提供，Qt 不提供，按包围盒的长边判定；两者都没有时无法判定。
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

/// 该对象是可按步滚动的滚动条：角色是滚动条、有 Value 接口、方向可以判定。
pub fn scroll_bar(facts: &Facts) -> Option<(Axis, Numbers)> {
    if facts.role != AtspiRole::ScrollBar {
        return None;
    }
    Some((orientation(facts)?, facts.value?))
}

/// 可编辑文本：有 EditableText 接口、带 `editable` 状态且不带 `read-only`。
///
/// 仅检查接口不足以判定：GTK 3 的只读输入框同样实现 EditableText，`SetTextContents` 返回真而内容
/// 不变；Qt 的只读输入框则会被实际修改。
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

/// 能否设置文本选区：有 Text 接口，且是可编辑文本或带 `selectable-text`。
pub fn text_selectable(facts: &Facts) -> bool {
    facts.interfaces.contains(Interface::Text)
        && (facts.interfaces.contains(Interface::EditableText)
            || facts.states.contains(State::SelectableText))
}

/// 可用：带 `enabled` 或 `sensitive` 之一。GTK 3 的中间态复选框去掉 `enabled` 而保留 `sensitive`。
pub fn enabled(states: StateSet) -> bool {
    states.contains(State::Enabled) || states.contains(State::Sensitive)
}

/// 该对象列出的后台动作。模式缺失的动作不列出；前台动作由 `foreground_offers` 列出。
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
    let container = selectable_in(facts, context);
    if matches!(click, Some(Click::Select(_))) || container.is_some() {
        out.push(NodeAction::ready("select"));
    }
    if container == Some(true) {
        out.push(NodeAction::ready("add_to_selection"));
        out.push(NodeAction::ready("remove_from_selection"));
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

/// 该对象列出的前台动作。调用方只在前台模式开启且窗口能接收键盘输入时调用；`pointer`
/// 为假时不列出指针动作，`window` 为假时不列出窗口动作。
///
/// 指针动作只列在有包围盒且当前显示的控件上：没有包围盒时无法确定落点。键盘动作列在持有
/// 键盘焦点的控件与窗口根节点上：自绘界面无法提供持有焦点的控件，只列在前者上等于对这类界面
/// 关闭整条键盘路径。窗口动作只列在窗口根节点上。`path` 为空时即为窗口根本身。
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

/// 身份段：总线唯一名加对象路径。段首不是 `~`，协调器据此分配稳定短编号。
///
/// 不要把指纹或名称放入身份段：组合框、标签与列表行的名称随内容变化，协调器会把内容改变的
/// 同一个控件视为删除一个、新增一个，短编号与差异投递随之失效。
pub fn identity(key: &str) -> Identity {
    Identity::Stable(key.to_owned())
}

/// 核对串：角色与稳定标识的指纹，写在 `ref` 的 `#` 之前，重新定位时与身份段一起核对。
///
/// 对象路径在对象销毁后可能重新分配给其他对象，新对象的角色通常不同。名称不进入核对串：
/// 名称随内容变化的控件在内容改变后仍是同一个控件。
pub fn check(facts: &Facts) -> String {
    fingerprint(&role_name(facts.role), "", &facts.accessible_id)
}

/// 核对按 `ref` 重新定位到的对象是否为 `ref` 记录的对象：身份段与核对串都必须一致。
pub fn verify(expected: &RefParts, key: &str, facts: &Facts) -> Result<(), String> {
    let actual = check(facts);
    if expected.identity != identity(key) {
        return Err(format!(
            "{REF_STALE}: 该位置当前是对象 {key}，ref 中记录的是 {}，请重新观察",
            describe(&expected.identity)
        ));
    }
    if expected.check.as_deref() != Some(actual.as_str()) {
        return Err(format!(
            "{REF_STALE}: 对象 {key} 的角色或稳定标识已改变（核对串 {actual}，ref 中记录的是 {}），该对象路径已分配给其他控件，请重新观察",
            expected.check.as_deref().unwrap_or("缺失")
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

/// 换算为协议节点。`parent_ref` 与 `depth` 由遍历填写。
pub fn node(facts: &Facts, context: Context, path: &[usize], key: &str, fields: Fields) -> Node {
    let states = facts.states;
    let click = claim(facts);
    let value = if !fields.value {
        None
    } else if facts.interfaces.contains(Interface::EditableText) {
        facts.text.clone()
    } else {
        // 标签的文本即其名称，不重复提供。
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
        // AT-SPI 没有「容器要求始终选中一项」这一属性，无法提供完整的容器约束。
        selection: None,
        scroll,
        text: facts.interfaces.contains(Interface::Text),
        weak_identity: id.is_weak(),
    }
}

/// 包围盒换算。零尺寸与 `i32::MIN` 坐标视为缺失：GTK 3 对未分配位置的控件返回
/// `(-2147483648, -2147483648, 1, 1)`，Qt 对收起的下拉列表返回全零。
pub fn extents(x: i32, y: i32, width: i32, height: i32) -> Option<ScreenRect> {
    (width > 0 && height > 0 && x != i32::MIN && y != i32::MIN).then_some(ScreenRect {
        x,
        y,
        width,
        height,
    })
}

/// 将 AT-SPI 角色换算为协议角色名。词表中没有对应的角色返回 `atspi_<角色名>`，不推测相近的角色。
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

    /// 前台模式关闭时不列出任何前台动作；开启时指针动作列在显示中的控件上，键盘动作列在
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

    /// Wayland 会话中的 X 窗口：照常列出键盘与窗口动作，不列出任何指针动作，即使控件有包围盒。
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

    /// 经 portal 共享的原生 Wayland 窗口：只列出键盘动作。合成器不允许窗口动作，指针动作只按图
    /// 定位，不列在控件上。
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

    /// 原始失败形状：原生 Wayland 窗口的包围盒以 surface 为原点，却按屏幕坐标发布，调用方
    /// 会用它确定采图区域、计算拖拽偏移。不发布时节点照常列出，可用动作不变。
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

    /// GTK 按钮提供 `click`，Qt 按钮提供 `Press` 与 `SetFocus`；两者都列为 `invoke`，
    /// `SetFocus` 会移走键盘焦点，不映射为任何动作。
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

    /// 复选框的 `click` 只列为 `set_toggle`；Qt 的 `Toggle` 优先于 `Press`。
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

    /// 原始失败形状：WebKit 的复选框只有一个动作，未选中时名为 `check`、选中后名为 `uncheck`。
    /// 两种状态下都列出 `set_toggle` 并报告复选状态。
    #[test]
    fn a_web_check_box_offers_set_toggle_under_either_action_name() {
        let web = [
            State::Checkable,
            State::Enabled,
            State::Focusable,
            State::Sensitive,
            State::Showing,
            State::Visible,
        ];
        let ifaces = [Interface::Action, Interface::Text, Interface::Hyperlink];
        let off = facts(AtspiRole::CheckBox, &web, &ifaces, &["check"]);
        let mut on = facts(AtspiRole::CheckBox, &web, &ifaces, &["uncheck"]);
        on.states.insert(State::Checked);
        for (facts, state) in [(&off, "off"), (&on, "on")] {
            assert_eq!(claim(facts), Some(Click::Toggle(0)));
            let node = node(facts, Context::default(), &[0], KEY, FIELDS);
            assert_eq!(names(&node.actions), ["set_toggle"]);
            assert_eq!(node.toggle, Some(state));
        }
    }

    /// WebKit 的输入框带 `editable` 状态而不实现 EditableText：不列出 `set_value`。
    #[test]
    fn a_web_text_input_without_editable_text_offers_no_set_value() {
        let input = facts(
            AtspiRole::Entry,
            &[
                State::Editable,
                State::Enabled,
                State::Focusable,
                State::SelectableText,
                State::Showing,
                State::SingleLine,
            ],
            &[Interface::Action, Interface::Text],
            &["activate"],
        );
        assert!(!names(&offers(&input, Context::default())).contains(&"set_value"));
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

    /// GTK 3 的展开器是可展开的切换按钮，其 `activate` 用于展开内容，不是复选。
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

    /// Qt 树表格单元只有切换选中状态的 `Toggle`：照常报告可展开状态，不列出展开动作。
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

    /// 可选项经父对象的 Selection 接口修改选中状态；容器或项带 `multiselectable` 时才列出增选与取消选择。
    #[test]
    fn a_selectable_item_offers_selection_through_its_container() {
        let item = facts(
            AtspiRole::ListItem,
            &[State::Selectable, State::Showing],
            &[],
            &[],
        );
        let single = list(&[State::Showing], Context::default());
        assert_eq!(names(&offers(&item, single)), ["select"]);
        let multi = list(
            &[State::Showing, State::Multiselectable],
            Context::default(),
        );
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
        // 容器不实现 Selection 时，不列出任何选择动作。
        let plain = Context::of(
            AtspiRole::List,
            states(&[State::Showing]),
            InterfaceSet::empty(),
            Context::default(),
        );
        assert!(offers(&item, plain).is_empty());
    }

    fn states(list: &[State]) -> StateSet {
        let mut set = StateSet::empty();
        for s in list {
            set.insert(*s);
        }
        set
    }

    /// 实现 Selection 的列表作为父对象时的上下文，`above` 是列表自身的上下文。
    fn list(list_states: &[State], above: Context) -> Context {
        let mut selection = InterfaceSet::empty();
        selection.insert(Interface::Selection);
        Context::of(AtspiRole::List, states(list_states), selection, above)
    }

    /// 组合框作为父对象时的上下文：组合框自身不实现 Selection。
    fn combo_box() -> Context {
        Context::of(
            AtspiRole::ComboBox,
            states(&[State::Showing, State::Expandable]),
            InterfaceSet::empty(),
            Context::default(),
        )
    }

    /// 原始失败形状：Qt 组合框展开后，下拉列表中的项列出 `select`，经列表的 Selection 发出后
    /// 返回已执行，而组合框的值不变。组合框的下拉列表与菜单一律不经 Selection 列出选中动作；
    /// GTK 的菜单项保留用于改值的 `invoke`，Qt 的下拉项没有后台动作。
    #[test]
    fn a_dropdown_list_or_a_menu_offers_no_selection() {
        let dropdown = list(&[State::Showing, State::Focused], combo_box());
        assert!(dropdown.dropdown && !dropdown.selection);
        let qt_item = facts(
            AtspiRole::ListItem,
            &[State::Selectable, State::Showing, State::Transient],
            &[Interface::Action],
            &["Toggle"],
        );
        assert!(offers(&qt_item, dropdown).is_empty());
        // 同一个列表不在组合框下时照常经 Selection 选中。
        assert_eq!(
            names(&offers(
                &qt_item,
                list(&[State::Showing], Context::default())
            )),
            ["select"]
        );
        let mut selection = InterfaceSet::empty();
        selection.insert(Interface::Selection);
        let gtk_item = facts(
            AtspiRole::MenuItem,
            &[State::Selectable, State::Showing],
            &[Interface::Action],
            &["click"],
        );
        let combo_menu = Context::of(
            AtspiRole::Menu,
            states(&[State::Showing]),
            selection,
            combo_box(),
        );
        let context_menu = Context::of(
            AtspiRole::Menu,
            states(&[State::Showing]),
            selection,
            Context::default(),
        );
        assert!(combo_menu.dropdown && !context_menu.dropdown);
        for context in [combo_menu, context_menu] {
            assert_eq!(names(&offers(&gtk_item, context)), ["invoke"]);
        }
    }

    /// 单选按钮的 `select` 经其自身的动作发出，选中状态取 `checked`。
    #[test]
    fn a_radio_button_offers_select_and_reports_checked_as_selected() {
        let radio = facts(
            AtspiRole::RadioButton,
            &[State::Checked, State::Showing],
            &[Interface::Action],
            &["click"],
        );
        assert_eq!(claim(&radio), Some(Click::Select(0)));
        let node = node(&radio, Context::default(), &[1], ":1.2/x", FIELDS);
        assert_eq!(names(&node.actions), ["select"]);
        assert_eq!(node.selected, Some(true));
        assert_eq!(node.toggle, None);
    }

    /// WebKit 网页控件共有的状态。
    const WEB: &[State] = &[
        State::Enabled,
        State::Focusable,
        State::Sensitive,
        State::Showing,
        State::Visible,
    ];

    /// 原始失败形状：WebKit 的单选按钮只有一个名为 `select` 的动作，结果未列出任何动作。
    /// 应列出 `select` 并经其自身的动作发出，选中状态取 `checked`。
    #[test]
    fn a_web_radio_button_selects_through_its_select_action() {
        let mut states = WEB.to_vec();
        states.push(State::Checkable);
        let ifaces = [Interface::Action, Interface::Text, Interface::Hyperlink];
        let off = facts(AtspiRole::RadioButton, &states, &ifaces, &["select"]);
        let mut on = off.clone();
        on.states.insert(State::Checked);
        for (facts, selected) in [(&off, false), (&on, true)] {
            assert_eq!(claim(facts), Some(Click::Select(0)));
            let node = node(facts, Context::default(), &[0], KEY, FIELDS);
            assert_eq!(names(&node.actions), ["select"]);
            assert_eq!(node.selected, Some(selected));
            assert_eq!(node.toggle, None);
        }
    }

    /// 原始失败形状：WebKit 下拉框的选项位于组合框的弹出列表（菜单）下，列表的 Selection
    /// 不可用，选项未列出任何动作。选项自身唯一的动作没有名称，`select` 经该动作发出。
    #[test]
    fn a_web_option_selects_itself_through_its_unnamed_action() {
        let mut option_states = WEB.to_vec();
        option_states.push(State::Selectable);
        let option = facts(
            AtspiRole::MenuItem,
            &option_states,
            &[Interface::Action],
            &[""],
        );
        let mut selection = InterfaceSet::empty();
        selection.insert(Interface::Selection);
        let popup = Context::of(
            AtspiRole::Menu,
            states(&[State::Enabled]),
            selection,
            combo_box(),
        );
        assert_eq!(claim(&option), Some(Click::Select(0)));
        assert_eq!(selectable_in(&option, popup), None);
        let node = node(&option, popup, &[0, 0], KEY, FIELDS);
        assert_eq!(names(&node.actions), ["select"]);
        assert_eq!(node.selected, Some(false));
        // 列表框可多选时，增选与取消选择仍经由列表框的 Selection。
        let multi = list(
            &[State::Showing, State::Multiselectable],
            Context::default(),
        );
        assert_eq!(
            names(&offers(&option, multi)),
            ["select", "add_to_selection", "remove_from_selection"]
        );
    }

    /// GTK 下拉菜单的菜单项带 `selectable`，其 `click` 仍列为 `invoke`，不视为选中自身的动作。
    #[test]
    fn a_selectable_menu_item_with_a_named_click_stays_invoke() {
        let item = facts(
            AtspiRole::MenuItem,
            &[State::Enabled, State::Selectable, State::Visible],
            &[Interface::Action],
            &["click"],
        );
        assert_eq!(claim(&item), Some(Click::Invoke(0)));
        assert_eq!(names(&offers(&item, Context::default())), ["invoke"]);
    }

    /// WebKit 下拉框的 `select` 打开或收起弹出列表而不报告展开状态，弹出列表的 `select` 同样如此；
    /// `<details>` 可展开，而它与 `<summary>` 的无名动作都返回 false、不改变展开状态。三者都不列出动作。
    #[test]
    fn web_controls_without_a_readable_result_offer_nothing() {
        let combo = facts(AtspiRole::ComboBox, WEB, &[Interface::Action], &["select"]);
        let popup = facts(
            AtspiRole::Menu,
            &[State::Enabled, State::Sensitive],
            &[Interface::Action, Interface::Selection],
            &["select"],
        );
        let mut expandable = WEB.to_vec();
        expandable.push(State::Expandable);
        let details = facts(AtspiRole::Unknown, &expandable, &[Interface::Action], &[""]);
        let summary = facts(AtspiRole::Unknown, WEB, &[Interface::Action], &[""]);
        for facts in [&combo, &popup, &details, &summary] {
            assert_eq!(claim(facts), None, "{:?}", facts.role);
            assert!(offers(facts, Context::default()).is_empty());
        }
    }

    /// 只读输入框仍列出 `set_value`，但标为当前不可用；GTK 3 依据缺少 `editable` 判定，Qt 依据 `read-only` 判定。
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

    /// 滚动条按步滚动；无法滚动的轴标为不可用。方向在 GTK 中取自状态，在 Qt 中按包围盒判定。
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

    /// 标签的文本等于名称时不重复提供值；输入框的值即文本，空字符串同样提供。
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

    /// 身份段只含对象串，核对串位于 `#` 之前：协调器按 `#` 之后的部分分配短编号。
    #[test]
    fn the_identity_segment_is_the_object_alone() {
        let combo = facts(AtspiRole::ComboBox, SHOWN, &[], &[]);
        let reference = reference_of(&combo);
        let (head, segment) = reference.split_once('#').expect("ref 必须带身份段");
        assert_eq!(segment, KEY);
        assert!(head.starts_with("w.0.3@"));
        assert!(!identity(KEY).is_weak());
    }

    /// 原始失败形状：组合框更换选中项、名称随之从 alpha 变为 beta，身份段与整条 ref 均不变，
    /// 旧 ref 仍能重新定位。
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
        let old = crate::tree::decode_ref(&reference_of(&alpha)).expect("必须能解码");
        assert_eq!(verify(&old, KEY, &beta), Ok(()));
    }

    /// 同一对象路径上的角色或稳定标识已改变：该对象路径已分配给其他控件，返回 `ref_stale`。
    #[test]
    fn a_different_role_or_id_at_the_same_object_is_stale() {
        let button = facts(AtspiRole::Button, SHOWN, &[], &[]);
        let old = crate::tree::decode_ref(&reference_of(&button)).expect("必须能解码");
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
        // 另一个对象（应用重启后唯一名已改变）同样拒绝。
        let restarted =
            verify(&old, ":1.9/org/a11y/atspi/accessible/7", &button).expect_err("应当拒绝");
        assert!(restarted.starts_with("ref_stale: "));
        // 不带核对串的 ref 不是本后端生成的。
        let bare = crate::tree::decode_ref(&format!("w.0.3#{KEY}")).expect("必须能解码");
        assert!(verify(&bare, KEY, &button).is_err());
    }

    /// GTK 3 的中间态复选框去掉 `enabled` 而保留 `sensitive`，仍视为可用。
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

    /// 词表中已有的角色返回协议名，没有的返回带前缀的原名，不归入词表。
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
