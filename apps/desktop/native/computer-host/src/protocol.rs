//! 宿主与 worker 之间的行分隔 JSON 协议：请求、回执、执行事实三态与派发前的准入判定。
//!
//! 本模块不调用任何 OS 接口，全部判定都能在没有图形会话的环境里测试。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::geometry::{Geometry, ScreenPoint, ScreenRect};

/// Unix 纪元毫秒。请求的 deadline 与观察的 capturedAt 用同一个时基。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// 执行实例身份，由宿主在握手时交给 worker。
///
/// worker 不自行生成，也不沿用旧值：更换 worker 进程后，旧的观察、ref 与排队请求全部作废。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub host_id: String,
    pub host_epoch: u64,
}

/// 握手之后 worker 采用的绑定：执行实例身份 + 当前连接代际。
///
/// 两者生命周期不同，不能合并为一个结构：身份在 worker 进程内固定不变，连接代际随宿主 WS
/// 重连增大。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub host: HostIdentity,
    pub connection_epoch: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// requestId。解析失败的请求同样必须带着它回执，否则调用方的 pending 没有终态。
    pub id: String,
    /// Unix 纪元毫秒的绝对时刻；缺省表示不设截止。
    ///
    /// 必须是绝对时刻而不是相对毫秒：请求在队列中等待的时间必须计入预算，否则排在一次长
    /// 调用之后的请求会在预算已耗尽时被派发。
    #[serde(default)]
    pub deadline: Option<i64>,
    /// 执行实例身份，每条请求都必须携带。缺少字段的请求解析失败，按 `bad_request` 回执。
    pub host_id: String,
    pub host_epoch: u64,
    /// 宿主 WS 的连接代际，每条请求都必须携带。
    ///
    /// 服务端在重连时丢弃旧 pending，但 worker 的执行队列中仍有旧连接的动作请求；缺少
    /// 该字段时，这些动作会照常派发，而回执没有任何接收方。
    pub connection_epoch: u64,
    /// 用户是否启用了前台接管。
    ///
    /// 前台原始输入与窗口操作只在它为真时派发，worker 不自行升级；缺席按假处理，
    /// 缺少该字段的请求因此只能使用后台语义动作。
    #[serde(default)]
    pub foreground: bool,
    #[serde(flatten)]
    pub op: Op,
}

/// 一次读取的三个上限。语义固定：`max_nodes` 与 `max_depth` 限制遍历，`time_budget_ms`
/// 限制本次遍历自身的用时，三者任一达到上限都记入 `truncated_by`。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub max_nodes: u32,
    pub max_depth: u32,
    pub time_budget_ms: u64,
}

/// 观察的范围与字段选择。全部缺省时读整窗、取全部字段。
///
/// 没有按角色或文字筛选的字段：读树返回本次范围内的全部节点，筛选只作用于提供给模型的
/// 视图。在此处筛选会使筛选出的节点成为当前观察，其余控件的引用随之失效。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Select {
    /// 子树根的 `ref`。缺席表示从窗口元素开始读取。
    #[serde(default)]
    pub root: Option<String>,
    /// 是否读取控件当前值。为假时 `value` 一律缺席，可用动作仍照常判定。
    #[serde(default = "yes")]
    pub include_value: bool,
    /// 是否读取控件模式的状态细节：数值区间、复选现态、展开现态、选中状态、容器约束、
    /// 滚动位置。
    ///
    /// 为假时这些字段一律缺席，**可用动作表不受影响**：动作按模式是否存在判定，相关布尔
    /// 属性始终读取。读取大窗口时可节省这十五个属性的读取成本。
    #[serde(default = "yes")]
    pub include_state: bool,
}

const fn yes() -> bool {
    true
}

/// 不要改为 `#[derive(Default)]`：`bool` 的派生默认值是 `false`，`include_value` 会随之
/// 变为假，动作后的重读与等待将无法再读取控件值。
impl Default for Select {
    fn default() -> Self {
        Self {
            root: None,
            include_value: true,
            include_state: true,
        }
    }
}

impl Select {
    /// 范围与字段选择，逐条写入 `completeness.filtered_by`。
    ///
    /// 调用方据此区分「该控件不存在」与「该控件不在本次读取范围内」，两者不能混淆。
    pub fn describe(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(root) = &self.root {
            out.push(format!("root={root}"));
        }
        if !self.include_value {
            out.push("includeValue=false".to_owned());
        }
        if !self.include_state {
            out.push("includeState=false".to_owned());
        }
        out
    }
}

/// 两轮判定之间的最小间隔，以上一轮读取耗时的倍数计。
///
/// 判定需要读取一次控件树，大窗口每次需要数百毫秒；按固定间隔轮询会使目标应用的 UI 线程
/// 在整个等待期间持续被 UIA 占用。间隔取 4 倍后，等待自身在目标进程上的占空比上界是
/// `1 / (1 + 4) = 20%`。
const POLL_DUTY_FACTOR: u32 = 4;

/// 下一轮判定之前的休眠时长。
///
/// 同时满足三个约束：不低于调用方给出的下限、不低于上一轮读取耗时的 `POLL_DUTY_FACTOR` 倍、
/// 不超过距截止时刻的剩余时间。最后一条优先级最高：休眠超过剩余时间会错过截止时刻。
pub fn next_poll(floor: Duration, last_probe: Duration, left: Duration) -> Duration {
    let paced = last_probe.saturating_mul(POLL_DUTY_FACTOR);
    floor.max(paced).min(left)
}

/// 等待的后置条件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitUntil {
    /// 目标控件变为可用。
    Enabled,
    /// 目标控件的值变为给定值。
    Value,
    /// 目标控件从树上消失。
    Gone,
    /// 窗口中出现满足筛选条件的控件。
    Appears,
    /// 出现标题包含给定文字的顶层窗口，且不是目标窗口本身。
    Window,
}

/// 复选状态。三态控件的中间态是可以主动写入的目标态，不是单次切换的副产物。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToggleState {
    Off,
    On,
    Indeterminate,
}

impl ToggleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
            Self::Indeterminate => "indeterminate",
        }
    }
}

/// TogglePattern 只有 `Toggle()`，每次调用按固定环前进一步。要到达目标态，只能按现态计算所需步数。
///
/// 环的长度由控件决定：二态控件在 Off 与 On 之间切换，三态控件多一个 Indeterminate。
/// **环长判定错误会停在其他状态上**，因此环长由调用方按控件实际支持的状态数给出。
/// 环上没有的状态返回 `None`：二态控件无法到达中间态，调用方据此拒绝，而不是切换到其他状态。
pub fn toggle_steps(current: ToggleState, target: ToggleState, tri_state: bool) -> Option<u32> {
    let ring: &[ToggleState] = if tri_state {
        &[ToggleState::Off, ToggleState::On, ToggleState::Indeterminate]
    } else {
        &[ToggleState::Off, ToggleState::On]
    };
    let at = ring.iter().position(|s| *s == current)?;
    let to = ring.iter().position(|s| *s == target)?;
    Some(u32::try_from((to + ring.len() - at) % ring.len()).unwrap_or(0))
}

/// 滚动方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// 一次滚动的步长。ScrollPattern 只支持「一行」与「一页」，不支持像素量。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollStep {
    Line,
    Page,
}

/// 鼠标键。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// 组合键中的修饰键。按下顺序即此处给出的顺序，释放按逆序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    /// Windows 徽标键、macOS 的 Command、Linux 的 Super。
    Meta,
}

impl Modifier {
    /// 该修饰键的键名。按下状态账按键名记录，平台键码由派发端换算。
    pub const fn key_name(self) -> &'static str {
        match self {
            Self::Ctrl => "ctrl",
            Self::Alt => "alt",
            Self::Shift => "shift",
            Self::Meta => "meta",
        }
    }
}

/// 不按规则生成的主键名。字母 a–z、数字 0–9 与功能键 f1–f24 由 `key_names` 生成。
const NAMED_KEYS: [&str; 26] = [
    "enter",
    "tab",
    "escape",
    "space",
    "backspace",
    "delete",
    "insert",
    "home",
    "end",
    "page_up",
    "page_down",
    "up",
    "down",
    "left",
    "right",
    "semicolon",
    "equal",
    "comma",
    "minus",
    "period",
    "slash",
    "backquote",
    "bracket_left",
    "backslash",
    "bracket_right",
    "quote",
];

/// 主键名词表，全小写。修饰键不在其中：它们只经由 `Modifier` 给出，不能作为主键按下。
///
/// 各平台后端与宿主补发都把这些名称换算为本平台的键码，换算表必须覆盖整张词表。
pub fn key_names() -> impl Iterator<Item = String> {
    let letters = (b'a'..=b'z').map(|c| char::from(c).to_string());
    let digits = (b'0'..=b'9').map(|c| char::from(c).to_string());
    let functions = (1..=24).map(|n| format!("f{n}"));
    letters
        .chain(digits)
        .chain(functions)
        .chain(NAMED_KEYS.iter().map(|name| (*name).to_owned()))
}

/// 把调用方给出的主键名规范为词表中的写法。不区分大小写；词表外的名称返回 `None`，不推测。
pub fn key_name(raw: &str) -> Option<String> {
    let name = raw.to_ascii_lowercase();
    key_names().any(|known| known == name).then_some(name)
}

/// 控件角色表：变体与协议中的名称。只在此处列出一次，变体与名称不会出现分歧。
macro_rules! roles {
    ($($role:ident => $name:literal,)+) => {
        /// 控件角色词表。节点的 `role` 与等待 `appears` 的角色条件都使用此处的名称。
        ///
        /// 各平台后端把自身的控件类型换算为本表中的角色；平台类型在表中没有对应项时，后端返回
        /// 平台的原始类型名（Windows 是 `control_<ControlType>`），该名称不在词表中。
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum Role {
            $($role,)+
        }

        impl Role {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$role => $name,)+
                }
            }

            /// 整张词表。单测按它核对样例与各平台的换算表。
            #[cfg(test)]
            pub const ALL: &'static [Self] = &[$(Self::$role,)+];
        }
    };
}

roles! {
    Button => "button",
    Calendar => "calendar",
    CheckBox => "check_box",
    ComboBox => "combo_box",
    Edit => "edit",
    Hyperlink => "hyperlink",
    Image => "image",
    ListItem => "list_item",
    List => "list",
    Menu => "menu",
    MenuBar => "menu_bar",
    MenuItem => "menu_item",
    ProgressBar => "progress_bar",
    RadioButton => "radio_button",
    ScrollBar => "scroll_bar",
    Slider => "slider",
    Spinner => "spinner",
    StatusBar => "status_bar",
    Tab => "tab",
    TabItem => "tab_item",
    Text => "text",
    ToolBar => "tool_bar",
    ToolTip => "tool_tip",
    Tree => "tree",
    TreeItem => "tree_item",
    Custom => "custom",
    Group => "group",
    Thumb => "thumb",
    DataGrid => "data_grid",
    DataItem => "data_item",
    Document => "document",
    SplitButton => "split_button",
    Window => "window",
    Pane => "pane",
    Header => "header",
    HeaderItem => "header_item",
    Table => "table",
    TitleBar => "title_bar",
    Separator => "separator",
    SemanticZoom => "semantic_zoom",
    AppBar => "app_bar",
}

/// 窗口的显示状态。`WindowPattern` 的三种可视状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    Normal,
    Minimized,
    Maximized,
}

impl WindowState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Minimized => "minimized",
            Self::Maximized => "maximized",
        }
    }
}

/// 一次拖拽的终点。
///
/// 两种写法都不带图像坐标：图像坐标在服务端换算为屏幕坐标，worker 只接受屏幕像素与
/// 控件引用。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DragTarget {
    /// 落在另一个控件的包围盒中心。派发前重新定位该控件，读取派发时的包围盒。
    Ref {
        #[serde(rename = "ref")]
        reference: String,
    },
    /// 相对起点的屏幕像素偏移。用于滑块与拖动排序。
    Offset { dx: i32, dy: i32 },
}

/// 一次动作的内容。
///
/// 每种动作都携带完整的参数：若动作与参数分两处给出，缺少值的 `set_value` 也能转换为一条
/// 合法请求，缺少的参数要到调用 provider 时才暴露。
///
/// **后台语义动作与前台原始输入在同一个枚举中**，按 `foreground_only` 分别准入：
/// 若分成两个枚举，定位、准入、可放弃等待与动作后重读都会出现重复实现。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActionSpec {
    /// InvokePattern。按钮与菜单项的默认动作。
    Invoke,
    /// ValuePattern。空串表示清空，与缺席含义不同。
    SetValue { value: String },
    /// RangeValuePattern。越界与只读一律拒绝，不截断到边界。
    SetRangeValue { value: f64 },
    /// SelectionItemPattern。单选：把选择替换为该项。
    Select,
    /// SelectionItemPattern。增选：容器不支持多选时拒绝。
    AddToSelection,
    /// SelectionItemPattern。取消选中该项。
    RemoveFromSelection,
    /// TogglePattern。按目标态表达，不表达单次切换。
    SetToggle { state: ToggleState },
    /// ExpandCollapsePattern。
    Expand,
    /// ExpandCollapsePattern。
    Collapse,
    /// ScrollPattern。每次滚动一步，步长由 `step` 指定。
    Scroll {
        direction: ScrollDirection,
        step: ScrollStep,
    },
    /// ScrollItemPattern。把该控件滚动到可见区域。
    ScrollIntoView,
    /// ItemContainerPattern + VirtualizedItemPattern。
    ///
    /// 目标是**容器**：按名称在容器中查找一项（未实例化的项同样可以找到），找到后实例化该项。
    /// 虚拟化列表中未实例化的项不在控件树上，无法取得 `ref`，只能经此方式访问。
    RealizeItem { name: String },
    /// TextPattern。按 UTF-16 码元的偏移设选区。
    SelectText { start: u32, length: u32 },
    /// SendInput 的鼠标按下与抬起。`count` 是 1 或 2，双击由调用方按 2 表达。
    Click { button: MouseButton, count: u32 },
    /// SendInput 的指针移动。只移动，不按键。
    Hover,
    /// SendInput 的按下 → 分段移动 → 抬起。中止路径一律释放本次按下的键。
    Drag { to: DragTarget },
    /// SendInput 的滚轮。`amount` 是滚动格数，一格是系统设定的行数。
    Wheel {
        direction: ScrollDirection,
        amount: u32,
    },
    /// 文字按 UTF-16 码元投递给焦点，投递方式由各平台按接收窗口确定。代理对的两个码元相邻投递。
    TypeText { text: String },
    /// SendInput 的物理按键。修饰键按给出的顺序按下，逆序释放。
    PressKey {
        key: String,
        #[serde(default)]
        modifiers: Vec<Modifier>,
    },
    /// Win32 的前台窗口接口。受系统前台锁限制，拒绝即如实回执。
    Activate,
    /// WindowPattern 的可视状态。按目标态表达，不表达单次切换。
    SetWindowState { state: WindowState },
    /// TransformPattern 的移动。屏幕物理像素。
    MoveWindow { x: i32, y: i32 },
    /// TransformPattern 的缩放。屏幕物理像素。
    ResizeWindow { width: i32, height: i32 },
    /// WindowPattern 的关闭。发送的是关闭请求，不是强制终止进程。
    CloseWindow,
}

impl ActionSpec {
    /// 该动作只能由前台原始输入或前台窗口接口交付。
    ///
    /// 判据是该动作是否改变系统前台窗口、真实指针或键盘焦点：会改变的一律归为前台，
    /// 由用户显式开启的前台模式裁决。**不按是否使用 SendInput 划分**：
    /// 窗口状态与激活经由 Win32 与 UIA 接口，同样会改变用户正在使用的前台窗口。
    pub const fn foreground_only(&self) -> bool {
        matches!(
            self,
            Self::Click { .. }
                | Self::Hover
                | Self::Drag { .. }
                | Self::Wheel { .. }
                | Self::TypeText { .. }
                | Self::PressKey { .. }
                | Self::Activate
                | Self::SetWindowState { .. }
                | Self::MoveWindow { .. }
                | Self::ResizeWindow { .. }
                | Self::CloseWindow
        )
    }

    /// 该动作使用真实指针或键盘投递，因此要求目标窗口当前位于系统前台。
    ///
    /// 窗口动作（激活、状态、移动、缩放、关闭）不在其中：它们经由 Win32 与 UIA 接口发出，
    /// 无论目标窗口是否位于前台都可以执行。
    pub const fn takes_input(&self) -> bool {
        matches!(
            self,
            Self::Click { .. }
                | Self::Hover
                | Self::Drag { .. }
                | Self::Wheel { .. }
                | Self::TypeText { .. }
                | Self::PressKey { .. }
        )
    }

    /// 该动作的落点可以由调用方直接以屏幕坐标给出。只有指针动作支持。
    pub const fn takes_point(&self) -> bool {
        matches!(
            self,
            Self::Click { .. } | Self::Hover | Self::Drag { .. } | Self::Wheel { .. }
        )
    }

    /// 该动作可以不指定目标，直接投递给窗口。只有键盘输入支持。
    ///
    /// 键盘输入发往系统焦点所在位置，而不是某个指定的控件；前台窗口即目标窗口时，
    /// 焦点必然位于该窗口内。自绘界面不暴露业务控件，无法提供持有焦点的控件，
    /// 缺少本条规则时其整条键盘路径不可用。
    pub const fn targets_window(&self) -> bool {
        matches!(self, Self::TypeText { .. } | Self::PressKey { .. })
    }
}

/// 前台模式未开启时的拒绝原因。工具层与 worker 使用同一个原因码。
pub const FOREGROUND_DISABLED: &str =
    "foreground_disabled: 前台操作未启用";

/// 目标已不在树上时的拒绝原因前缀。等待的「控件消失」条件按它判定。
pub const REF_STALE: &str = "ref_stale";

/// 动作调用尚未返回，未重读目标窗口。调用方据此决定下一步观察哪个窗口。
pub const TARGET_BLOCKED: &str = "target_blocked";

/// 未派发时不重读：重读得到的观察会被调用方理解为动作已经发生。
pub const NOT_DISPATCHED: &str = "动作没有派发，没有重读";

/// 请求的操作。`params` 一律显式给出，空参数写为 `{}`。
#[derive(Debug, Deserialize)]
#[serde(tag = "op", content = "params", rename_all = "snake_case")]
pub enum Op {
    /// 建立执行实例绑定并设定 UIA 调用上界。
    ///
    /// 同一身份的重复握手会重设超时并清空取消登记；`hostId`/`hostEpoch` 改变一律拒绝，
    /// 一个 worker 进程只对应一个执行实例，代际变更通过更换进程实现。
    #[serde(rename_all = "camelCase")]
    Handshake {
        connection_timeout_ms: u32,
        transaction_timeout_ms: u32,
    },
    /// 把当前连接代际改为本请求信封中的 `connectionEpoch`，只允许增大。
    ///
    /// 必须在接收线程上就地处理：进入执行队列会排在旧连接的请求之后，而这些请求正是它要
    /// 拦截的。
    BindConnection {},
    /// 登记一个尚未派发的 requestId。已经进入 OS 调用的请求不会被它中止。
    Cancel {
        target: String,
    },
    ListWindows {},
    ReadTree {
        window: i64,
        #[serde(flatten)]
        select: Select,
        #[serde(flatten)]
        bounds: Bounds,
    },
    /// 在控件上执行一个动作，之后按 `root` 指定的范围整体重读。
    ///
    /// 所有改变状态的动作都经由此 op：定位、准入、可放弃等待与重读只有一处实现，
    /// 按动作拆分为多个 op 会使这四项逻辑重复实现。
    ///
    /// 目标有两种互斥的写法：`ref` 指定一个控件，派发前重新定位并读取派发时的包围盒；
    /// `point` 直接给出屏幕物理像素落点，此时必须同时给出 `expectGeneration`，
    /// 窗口在截图与派发之间移动过即拒绝。
    #[serde(rename_all = "camelCase")]
    Act {
        window: i64,
        #[serde(default, rename = "ref")]
        reference: Option<String>,
        /// 动作之后重读的范围，取调用方当前观察的范围根。缺席表示整窗。
        #[serde(default)]
        root: Option<String>,
        #[serde(default)]
        point: Option<ScreenPoint>,
        #[serde(default)]
        expect_generation: Option<String>,
        action: ActionSpec,
        #[serde(flatten)]
        bounds: Bounds,
    },
    /// 读取一个控件的文档文本与选区。只读，不改变状态。
    #[serde(rename_all = "camelCase")]
    ReadText {
        window: i64,
        #[serde(rename = "ref")]
        reference: String,
        /// 返回的 UTF-16 码元数上限。超出即截断并标记。
        max_chars: u32,
    },
    /// 截取目标窗口的图像。
    ///
    /// 这是唯一采集图像的 op：读树、动作与等待都不会执行采集代码。
    #[serde(rename_all = "camelCase")]
    CaptureImage {
        window: i64,
        /// 要采集的屏幕物理像素矩形。缺席表示整窗。
        #[serde(default)]
        region: Option<ScreenRect>,
        /// 要求窗口几何代际仍为该值。不一致即拒绝派发，不采集与几何不符的图像。
        #[serde(default)]
        expect_generation: Option<String>,
        /// 提供给模型的图像长边上限。worker 没有默认值，上限由调用方给出。
        max_edge: u32,
        /// 编码之后的字节上限。超过即拒绝，不把超限的帧写入宿主连接。
        max_bytes: u32,
        /// 采集时的等待上限：等待一帧到达，或等待窗口被遮挡的部分重绘完成。
        time_budget_ms: u64,
    },
    /// 等待一个后置条件成立。判定在 worker 一侧进行，到期时如实返回未满足及返回时的状态。
    #[serde(rename_all = "camelCase")]
    Wait {
        window: i64,
        until: WaitUntil,
        #[serde(default, rename = "ref")]
        reference: Option<String>,
        /// `until=value` 等待的值。
        #[serde(default)]
        value: Option<String>,
        /// `until=appears` 等待出现的控件角色。
        #[serde(default)]
        role: Option<String>,
        /// `until=appears` 等待出现的控件文字：名称、稳定标识或值包含该文字，不区分大小写。
        #[serde(default)]
        name_contains: Option<String>,
        /// 等待结束时重读的范围，取调用方当前观察的范围根。缺席表示整窗。
        #[serde(default)]
        root: Option<String>,
        /// `until=window` 等待的标题子串。
        #[serde(default)]
        name: Option<String>,
        /// 两次判定之间的最小间隔。
        poll_ms: u64,
        /// 从收到该请求起的最长等待时间。信封的 deadline 是硬上界，两者取先到者。
        timeout_ms: u64,
        #[serde(flatten)]
        bounds: Bounds,
    },
}

/// 执行事实。只描述本次请求要求的状态改变动作是否已交给 OS。
///
/// 只读请求与握手不改变状态，一律记为 `not_dispatched`：成功时带 `observation`，失败时带
/// `reason`。`submitted` 因此只有一个含义，不会与读取成功的回执混淆。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Dispatch {
    /// 可证明没有发出动作调用：准入拒绝、控件模式缺失、只读、目标已失效。
    NotDispatched,
    /// 动作调用已被 provider 接受并返回成功。不代表业务已完成。
    Submitted,
    /// 调用已进入 provider 但结果无法确认，动作可能已经生效。不得改记为未执行。
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub id: String,
    pub dispatch: Dispatch,
    /// 拒绝原因码，或动作调用返回的失败原文。有 `reason` 且 `dispatch` 是 `unknown` 时，
    /// 表示调用已发出但失败，不是未执行。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<Observation>,
    /// 动作或窗口准备后的重读失败时填入此字段，`dispatch` 保持原值。
    /// 即使请求动作未派发，窗口准备也可能改变状态；有此错误时旧观察不能继续使用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_error: Option<String>,
    /// 动作调用尚未返回时目标进程当前的顶层窗口，只经由 Win32 读取。
    ///
    /// 只在 `observation_error` 为 `target_blocked` 时出现：此时重读目标窗口必然
    /// 等待至超时，该字段代替重读结果说明下一步应观察哪个窗口。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking: Option<Vec<BlockingWindow>>,
    /// 回执发出之后还需清理一次该窗口所属 provider 的连接。**不写入协议**，只把该任务
    /// 从动作路径传回执行循环。见 `Backend::drain_provider`。
    #[serde(skip)]
    pub after_reply: Option<i64>,
}

impl Response {
    /// 未派发动作的终态：拒绝、参数无效、目标失效、只读请求失败。
    pub fn rejected(id: String, reason: String) -> Self {
        Self {
            id,
            dispatch: Dispatch::NotDispatched,
            reason: Some(reason),
            observation: None,
            observation_error: None,
            blocking: None,
            after_reply: None,
        }
    }

    /// 只读请求与握手的终态。
    pub fn observed(id: String, observation: Observation) -> Self {
        Self {
            id,
            dispatch: Dispatch::NotDispatched,
            reason: None,
            observation: Some(observation),
            observation_error: None,
            blocking: None,
            after_reply: None,
        }
    }

    /// 动作请求的终态：执行事实与动作后的重读结果分列。
    pub fn acted(id: String, dispatch: Dispatch, outcome: Result<Observation, String>) -> Self {
        let (observation, observation_error) = match outcome {
            Ok(o) => (Some(o), None),
            Err(e) => (None, Some(e)),
        };
        Self {
            id,
            dispatch,
            reason: None,
            observation,
            observation_error,
            blocking: None,
            after_reply: None,
        }
    }
}

/// 动作调用尚未返回时回执中列出的顶层窗口。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockingWindow {
    #[serde(flatten)]
    pub info: WindowInfo,
    /// 动作调用之前该窗口不存在。模态对话框属于此类情况。
    pub appeared: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Observation {
    #[serde(rename_all = "camelCase")]
    Ready {
        backend: &'static str,
        host_id: String,
        host_epoch: u64,
        /// 后端实际采用的上界：UIA 从接口读取，AX 与 AT-SPI 没有读取接口，返回设定的值。
        connection_timeout_ms: u32,
        transaction_timeout_ms: u32,
        /// 握手时操作系统已满足哪些前提。之后的变化由 `AccessNotice` 通报。
        access: Access,
    },
    /// 取消已登记。它不说明目标请求是否已执行：接收线程无法查询该信息，目标请求自身
    /// `reason: cancelled` 的回执才是取消生效的证据。
    #[serde(rename_all = "camelCase")]
    CancelRegistered { target: String },
    #[serde(rename_all = "camelCase")]
    ConnectionBound { connection_epoch: u64 },
    #[serde(rename_all = "camelCase")]
    Windows {
        captured_at: i64,
        windows: Vec<WindowInfo>,
    },
    Tree(Tree),
    Wait(Wait),
    Image(Image),
    Text(Text),
}

/// 一次图像采集的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub window: i64,
    pub captured_at: i64,
    /// 该帧的采集方式。后备路径与主路径必须可区分：`print_window` 依赖目标应用自身
    /// 响应 `WM_PRINT`，未绘制完整的部分在图像中为黑色。
    pub source: &'static str,
    pub geometry: Geometry,
    /// 图像的媒体类型。
    pub mime: &'static str,
    /// base64 编码的图像字节。
    pub bytes: String,
}

/// 标准 base64。图像字节须经行分隔 JSON 传给宿主，不能按原始字节传输。
pub fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 一次控件读取的全部内容。`Tree` 与 `Wait` 两种观察共用该结构。
///
/// 控件表是展平的前序序列，层级由 `parent_ref` 与 `depth` 表达。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub window: i64,
    pub captured_at: i64,
    /// 本次读取覆盖的范围：子树根的 `ref`。缺席表示整窗。
    ///
    /// **调用方据此决定作废哪一部分引用。** 缺席时整份旧观察作废，给出 ref 时只有该
    /// 子树作废，无关区域的旧引用仍然有效。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// 目标窗口当前是否可用。被模态窗口阻挡时为假。
    pub window_enabled: bool,
    /// 目标窗口当前在屏幕上完全不可见：已最小化，或被 z 序在其上方的窗口完全遮挡。
    ///
    /// 浏览器对载入后尚未在屏幕上显示过的页面不向 UIA 提供网页内容，此时控件表只有外框、
    /// 也未达到上限，该字段是调用方能看到的唯一迹象。
    pub window_covered: bool,
    pub completeness: Completeness,
    pub node_count: u32,
    pub nodes: Vec<Node>,
}

/// 一次等待的结果：条件是否成立，以及返回时读取到的状态。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wait {
    pub found: bool,
    /// 条件未成立时的原因：`timeout` 或 `cancelled`。条件成立时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub tree: Tree,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub window: i64,
    pub pid: u32,
    pub title: String,
    pub class_name: String,
}

/// 观察的完整性。
///
/// 截断与范围是两回事，分两个字段记录：`truncated_by` 表示上限截断了遍历，`filtered_by`
/// 表示读取范围与字段选择。调用方不能把「未采集到」理解为「没有」，也不能把「不在读取
/// 范围内」理解为「不存在」。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completeness {
    pub complete: bool,
    pub truncated_by: Vec<&'static str>,
    pub filtered_by: Vec<String>,
    /// 已遍历的节点数。三个上限限制的是该数值，不是返回的条数。
    pub visited: u32,
}

/// 经由控件模式发出，不切换前台、不移动指针、不设置焦点。
pub const DELIVERY_BACKGROUND: &str = "background";
/// 经由原始输入或前台窗口接口发出，会改变用户正在使用的前台窗口。只在用户启用前台模式时出现。
pub const DELIVERY_FOREGROUND: &str = "foreground";

/// 控件上的一个动作，以及该动作当前是否可执行。
///
/// `delivery` 为空表示当前无法执行，原因见 `unavailable`。模式缺失的动作不列出：
/// 每个控件列出全部二十余个动作会掩盖真正可执行的动作。前台模式关闭时，
/// 前台动作同样不列出。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeAction {
    pub action: &'static str,
    pub delivery: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<&'static str>,
}

impl NodeAction {
    /// 该动作当前可在后台执行。
    pub fn ready(action: &'static str) -> Self {
        Self {
            action,
            delivery: vec![DELIVERY_BACKGROUND],
            unavailable: None,
        }
    }

    /// 该动作当前可在前台执行。
    pub fn foreground(action: &'static str) -> Self {
        Self {
            action,
            delivery: vec![DELIVERY_FOREGROUND],
            unavailable: None,
        }
    }

    /// 控件暴露了该模式，但当前不可用。原因取自控件自身的属性，不是推测所得。
    pub fn blocked(action: &'static str, reason: &'static str) -> Self {
        Self {
            action,
            delivery: Vec::new(),
            unavailable: Some(reason),
        }
    }
}

/// RangeValuePattern 读取到的数值区间。动作前的越界判定以它为依据。
///
/// **非有限数一律不输出**：provider 对没有步长的控件返回 NaN，照常输出会在 JSON 中变为
/// `null`，而字段声明的类型是数字。三项主值任一非有限时整个区间缺席，见 `range_state`。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeState {
    pub value: f64,
    pub min: f64,
    pub max: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_change: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_change: Option<f64>,
}

/// 把读取到的五个数值合成一份区间。值、下界、上界任一非有限即整份缺席。
pub fn range_state(
    value: f64,
    min: f64,
    max: f64,
    small_change: f64,
    large_change: f64,
) -> Option<RangeState> {
    (value.is_finite() && min.is_finite() && max.is_finite()).then_some(RangeState {
        value,
        min,
        max,
        small_change: small_change.is_finite().then_some(small_change),
        large_change: large_change.is_finite().then_some(large_change),
    })
}

/// SelectionPattern 读取到的容器约束与当前选中项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionState {
    /// 容器允许同时选中多项。
    pub multiple: bool,
    /// 容器要求始终有一项被选中。
    pub required: bool,
    /// 当前选中项的名称。未选中任何项时为空。
    ///
    /// 收起的组合框在控件表中没有子节点，其选中项只能从此处读取。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub selected: Vec<String>,
    /// `selected` 未列全。
    #[serde(skip_serializing_if = "not_set")]
    pub truncated: bool,
}

/// ScrollPattern 读取到的滚动位置，单位为百分比。
///
/// 某个轴不能滚动时该字段缺席。**缺席不等于 0**：0 表示位于顶端。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical: Option<f64>,
}

/// 一次文本读取的全部内容。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub window: i64,
    pub captured_at: i64,
    /// 读取的控件。
    pub scope: String,
    pub text: String,
    /// `text` 已被 `maxChars` 截断。其后仍有内容，文档未到结尾。
    pub truncated: bool,
    /// 该控件支持的选区类型：`none` / `single` / `multiple`。
    pub selection_support: &'static str,
    pub selection: Vec<TextSelection>,
}

/// 一段选区。`start` 是其在文档中的起点，按 UTF-16 码元计。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSelection {
    pub start: u32,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// 不透明引用，动作请求原样带回。内含子树索引路径与 RuntimeId。
    #[serde(rename = "ref")]
    pub reference: String,
    /// 父节点的 `ref`。本次读取的子树根没有父节点，缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_ref: Option<String>,
    /// 相对本次读取的子树根的层数，根为 0。
    pub depth: u32,
    pub role: String,
    pub name: String,
    pub automation_id: String,
    /// ValuePattern 的值；没有 ValuePattern 而有 TextPattern 的控件（终端、控制台正文）
    /// 为当前可见的文字。字段选择不取值时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub enabled: bool,
    pub offscreen: bool,
    /// 该控件当前持有键盘焦点。前台模式关闭时一律为假：此时该属性不在缓存请求中。
    ///
    /// 文字与按键发往焦点所在位置，因此键盘动作只列在该控件上。
    #[serde(skip_serializing_if = "not_set")]
    pub focused: bool,
    /// 控件的包围盒，屏幕物理像素，与图像几何使用同一套坐标。
    ///
    /// provider 不提供包围盒的控件缺席（零尺寸同样按缺席处理）。**缺席不等于控件不存在**，
    /// 也不等于控件在屏幕外：后者由 `offscreen` 表示。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<ScreenRect>,
    /// 只列出 worker 已实现的动作。控件暴露了模式但 worker 没有对应实现时不列出，
    /// 否则调用方会按本表发出没有对应实现的请求。
    pub actions: Vec<NodeAction>,
    /// RangeValuePattern 的数值区间。没有该模式时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<RangeState>,
    /// TogglePattern 的现态。没有该模式时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle: Option<&'static str>,
    /// ExpandCollapsePattern 的现态：`collapsed` / `expanded` / `partial` / `leaf`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expand: Option<&'static str>,
    /// SelectionItemPattern 的现态。没有该模式时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    /// SelectionPattern 读取到的容器约束与当前选中项。只有选择容器具有该字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionState>,
    /// ScrollPattern 的滚动位置。滚动后的重读据此核对。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<ScrollState>,
    /// 该控件具有 TextPattern，可以读取文档文本与选区。
    #[serde(skip_serializing_if = "not_set")]
    pub text: bool,
    /// 该控件没有 RuntimeId，身份只能按角色、名称与稳定标识核对。
    ///
    /// 三项均不变而控件已被替换时无法核出，界面重排之后该引用不可靠。为真时调用方应当
    /// 重新观察，而不是复用旧引用。
    #[serde(skip_serializing_if = "not_set")]
    pub weak_identity: bool,
}

fn not_set(flag: &bool) -> bool {
    !*flag
}

/// 动作已经生效的可核实证据。每一项都经由 Win32 读取，不经过 UIA，
/// 因此不会被目标进程的嵌套消息循环阻塞。
///
/// **每种动作只采用属于它的证据项。** 前三项是后台模式调用的证据；激活会主动改变前台窗口，
/// 此时「同进程出现新顶层窗口」无法证明本次激活的效果，窗口动作因此各自使用对应属性的读取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionEvidence {
    /// 目标窗口被禁用。Win32 的模态对话框正是以此方式阻挡属主窗口。
    WindowDisabled,
    /// 目标窗口已销毁。
    WindowGone,
    /// 目标进程中出现了此前不存在的顶层窗口。
    NewWindow,
    /// 目标窗口已处于请求的显示状态。
    WindowState,
    /// 目标窗口矩形已等于请求的位置或尺寸。
    WindowRect,
}

impl ActionEvidence {
    fn as_str(self) -> &'static str {
        match self {
            Self::WindowDisabled => "目标窗口已被禁用",
            Self::WindowGone => "目标窗口已关闭",
            Self::NewWindow => "目标进程出现了新的顶层窗口",
            Self::WindowState => "目标窗口已处于请求的显示状态",
            Self::WindowRect => "目标窗口矩形已等于请求的值",
        }
    }
}

/// 一次动作调用的终态。`None` 表示尚无法判定，继续等待。
///
/// `InvokePattern.Invoke()` 打开模态对话框时，provider 一侧要等对话框关闭才返回，
/// 客户端的本次调用因此阻塞至 UIA 连接超时。**不能据此记为未执行**：动作已经生效。
/// 因此调用放在可以放弃等待的线程上，主路径改为判定可核实的事实：
/// 目标窗口被禁用、已关闭，或同进程出现新的顶层窗口，三者任一成立即为 `submitted`。
/// 没有证据且调用仍未返回时才是 `unknown`。
pub fn classify_action(
    returned: Option<&Result<(), String>>,
    evidence: Option<ActionEvidence>,
    expired: bool,
) -> Option<(Dispatch, Option<String>)> {
    if let Some(call) = returned {
        return Some(match call {
            Ok(()) => (Dispatch::Submitted, None),
            Err(text) => (Dispatch::Unknown, Some(text.clone())),
        });
    }
    if let Some(evidence) = evidence {
        return Some((
            Dispatch::Submitted,
            Some(evidence.as_str().to_owned()),
        ));
    }
    expired.then(|| {
        (
            Dispatch::Unknown,
            Some("call_pending".to_owned()),
        )
    })
}

/// worker 当前按住的鼠标键与键盘按键。
///
/// **它只描述输入状态，不是任务状态。** 按下即记录、释放即清除，宿主在确认 worker
/// 退出之后据此补发释放。空账表示该 worker 没有按住任何键。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldInput {
    /// 按住的鼠标键名。
    pub buttons: Vec<&'static str>,
    /// 按住的键，按按下顺序排列。主键是 `key_names` 中的名称，修饰键是 `Modifier::key_name`。
    ///
    /// 记录键名而不记录平台键码：worker 派发与宿主补发各自按本平台的换算表将其转换为键码。
    pub keys: Vec<String>,
}

/// 输入状态通报。与回执共用 stdout，以 `input` 字段与回执区分：回执必定带
/// `id` 与 `dispatch`，通报必定不带。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputNotice {
    pub input: HeldInput,
}

impl InputNotice {
    pub fn of(held: HeldInput) -> Self {
        Self { input: held }
    }
}

/// 桌面控制需要操作系统提供、而当前可能未提供的一项前提。每一项只由一个平台的后端报告。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Grant {
    /// macOS 的辅助功能授权。读树、动作与键盘及指针输入的投递均依赖该授权。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Accessibility,
    /// macOS 的屏幕录制授权。只影响截图。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    ScreenRecording,
    /// Linux 的会话总线上可以找到无障碍总线（`org.a11y.Bus`）。
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    AccessibilityBus,
}

impl Grant {
    /// 缺少该项时，读取与动作是否一律不可用。
    const fn gates(self) -> bool {
        !matches!(self, Self::ScreenRecording)
    }
}

/// 操作系统当前已满足哪些前提。握手回执与之后的变化通报都使用该结构。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// 读取与动作可用：`missing` 中没有缺失即导致一律不可用的前提。
    pub authorized: bool,
    /// 未满足的前提，顺序由后端固定。界面据此指明在何处开启。`authorized` 为真时也可能非空。
    pub missing: Vec<Grant>,
    /// 未满足的原因原文。只写入 stderr：它是 OS 的错误文本，协议只携带 `missing`。
    #[serde(skip)]
    pub detail: Option<String>,
}

impl Access {
    pub fn of(missing: Vec<Grant>, detail: Option<String>) -> Self {
        Self {
            authorized: !missing.iter().any(|g| g.gates()),
            missing,
            detail,
        }
    }

    /// 两份事实相同。原因原文不参与比较：同一问题的错误文本每次可能不同。
    pub fn same(&self, other: &Self) -> bool {
        self.missing == other.missing
    }
}

/// 授权变化通报。与回执、输入通报共用 stdout，以 `access` 字段区分。
#[derive(Debug, Serialize)]
pub struct AccessNotice<'a> {
    pub access: &'a Access,
}

/// macOS：本进程不是受信任的辅助功能客户端。
pub const ACCESSIBILITY_NOT_TRUSTED: &str = "accessibility_not_trusted";
/// Linux：会话里未找到或无法连接无障碍总线。
pub const ACCESSIBILITY_BUS_UNAVAILABLE: &str = "accessibility_bus_unavailable";
/// macOS：本进程没有屏幕录制授权，截图被拒绝。它不阻止读取与动作（`Grant::ScreenRecording`），
/// 但授权撤销同样需要由被拒绝的那次调用报告。
pub const SCREEN_RECORDING_NOT_GRANTED: &str = "screen_recording_not_granted";

/// 该拒绝原因是否属于操作系统未满足前提。是则服务循环即时查询一次授权事实：运行中撤销的
/// 授权依靠它在下一次调用时报告。原因码位于原文开头，其后可以接 `: 说明`。
pub fn refused_for_grant(reason: &str) -> bool {
    [
        ACCESSIBILITY_NOT_TRUSTED,
        ACCESSIBILITY_BUS_UNAVAILABLE,
        SCREEN_RECORDING_NOT_GRANTED,
    ]
    .iter()
    .any(|code| reason.strip_prefix(code).is_some_and(|rest| rest.is_empty() || rest.starts_with(':')))
}

/// 一批原始输入发出之后的执行事实。
///
/// `SendInput` 的返回值是实际插入输入队列的事件数，**它可能小于请求数**：
/// 目标进程完整性高于本进程时 UIPI 会拦截该批事件。三种终态：
/// 没有任何事件进入队列是可证明的未派发；全部进入是已派发；部分进入只能记为未知：
/// 已进入 OS 的部分可能已经生效，记为未执行会使调用方重发。
pub fn classify_input(sent: u32, requested: u32) -> (Dispatch, Option<String>) {
    if requested == 0 || sent == 0 {
        return (
            Dispatch::NotDispatched,
            Some(format!(
                "input_blocked: {requested} 个输入事件均未进入系统输入队列，\
                 目标窗口的进程完整性可能高于 qywork"
            )),
        );
    }
    if sent >= requested {
        return (Dispatch::Submitted, None);
    }
    (
        Dispatch::Unknown,
        Some(format!(
            "input_partial: {requested} 个输入事件中只发出了 {sent} 个，已发出的部分可能已生效"
        )),
    )
}

fn check_host(req: &Request, binding: &Binding) -> Result<(), &'static str> {
    if req.host_id != binding.host.host_id {
        return Err("host_mismatch");
    }
    if req.host_epoch != binding.host.host_epoch {
        return Err("host_epoch_mismatch");
    }
    Ok(())
}

/// 派发前的唯一准入判定。返回 `Err(reason)` 时调用方一律记为 `not_dispatched`。
///
/// 顺序固定：执行实例身份 → 连接代际 → 取消登记 → 截止时刻。身份或代际不符的
/// 请求不进入取消与超时判断，旧绑定的请求因此不会影响当前绑定的登记。
pub fn admit(
    req: &Request,
    binding: Option<&Binding>,
    cancelled: bool,
    now: i64,
) -> Result<(), &'static str> {
    match req.op {
        Op::Handshake { .. } => {
            if let Some(binding) = binding {
                if req.host_id != binding.host.host_id || req.host_epoch != binding.host.host_epoch
                {
                    return Err("already_bound");
                }
                // 重复握手可以重设超时与取消登记，但不能借此把连接代际改回旧值。
                if req.connection_epoch < binding.connection_epoch {
                    return Err("connection_epoch_rollback");
                }
            }
        }
        Op::BindConnection {} => {
            let Some(binding) = binding else {
                return Err("no_handshake");
            };
            check_host(req, binding)?;
            if req.connection_epoch <= binding.connection_epoch {
                return Err("connection_epoch_rollback");
            }
        }
        _ => {
            let Some(binding) = binding else {
                return Err("no_handshake");
            };
            check_host(req, binding)?;
            if req.connection_epoch != binding.connection_epoch {
                return Err("connection_epoch_mismatch");
            }
        }
    }
    if let Op::Act {
        reference,
        point,
        expect_generation,
        action,
        ..
    } = &req.op
    {
        check_act(
            action,
            reference.is_some(),
            point.is_some(),
            expect_generation.is_some(),
            req.foreground,
        )?;
    }
    if cancelled {
        return Err("cancelled");
    }
    if req.deadline.is_some_and(|d| now >= d) {
        return Err("deadline_exceeded");
    }
    Ok(())
}

/// 一次动作请求的目标与模式判定。
///
/// **前台模式关闭时前台动作在此处即被拒绝**：这是派发前的唯一准入判定，
/// 移到执行路径中判定会多出第二处裁决。后台失败不会自动升级为前台，
/// 本函数不考虑动作是否有后台替代方式。
///
/// 目标有三种写法：控件、屏幕落点、两者都不给出。第三种只有 `targets_window` 的动作
/// 可以使用，其目标是窗口本身。
pub fn check_act(
    action: &ActionSpec,
    has_ref: bool,
    has_point: bool,
    has_generation: bool,
    foreground: bool,
) -> Result<(), &'static str> {
    if action.foreground_only() && !foreground {
        return Err(FOREGROUND_DISABLED);
    }
    match (has_ref, has_point) {
        (true, true) => return Err("target_conflict: ref 与 point 只能提供其中一个"),
        (false, false) if !action.targets_window() => {
            return Err("missing_target: 必须提供 ref 或 point")
        }
        (false, true) if !action.takes_point() => {
            return Err("point_unsupported: 该动作只能按控件执行")
        }
        _ => {}
    }
    // 按图像定位必须带窗口几何代际：缺少代际时，窗口在截图与派发之间移动后仍会按原坐标点击。
    if has_point && !has_generation {
        return Err("missing_generation: 按屏幕坐标操作必须携带窗口几何代际");
    }
    Ok(())
}

/// 等待判定的输入：调用方给出的条件，以及本轮读取到的事实。
///
/// 单独写成纯函数，使五种条件的判定在没有图形会话的环境中也能测试。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen<'a> {
    /// 目标控件仍存在，附带其当前的可用状态与值。
    Element { enabled: bool, value: Option<&'a str> },
    /// 目标控件已不在树上。
    Missing,
    /// 满足筛选条件的控件数量。
    Matches(u32),
    /// 是否出现符合条件的顶层窗口。
    Window(bool),
}

/// 等待条件是否仍可能成立。
///
/// 等待值或等待可用时目标控件已不存在：控件身份按 RuntimeId 核对，重建的是另一个控件，
/// 该条件不会再成立，继续轮询只会等待至超时。其余组合照常轮询。
pub fn attainable(until: WaitUntil, seen: Seen<'_>) -> bool {
    !matches!(
        (until, seen),
        (WaitUntil::Value | WaitUntil::Enabled, Seen::Missing)
    )
}

/// 本轮读取到的事实是否满足等待条件。
pub fn satisfied(until: WaitUntil, want: Option<&str>, seen: Seen<'_>) -> bool {
    match (until, seen) {
        (WaitUntil::Enabled, Seen::Element { enabled, .. }) => enabled,
        // 值缺席表示该控件没有 ValuePattern，任何值都不会出现，不能作为空串命中。
        (WaitUntil::Value, Seen::Element { value, .. }) => value.is_some() && value == want,
        (WaitUntil::Gone, Seen::Missing) => true,
        (WaitUntil::Appears, Seen::Matches(count)) => count > 0,
        (WaitUntil::Window, Seen::Window(found)) => found,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bound() -> Binding {
        Binding {
            host: HostIdentity {
                host_id: "h1".to_owned(),
                host_epoch: 2,
            },
            connection_epoch: 5,
        }
    }

    fn parse(json: &str) -> Request {
        serde_json::from_str(json).expect("请求应当解析成功")
    }

    fn invoke_request(deadline: Option<i64>) -> Request {
        let deadline = deadline.map_or("null".to_owned(), |d| d.to_string());
        parse(&format!(
            r#"{{"id":"r1","deadline":{deadline},"hostId":"h1","hostEpoch":2,
                "connectionEpoch":5,
                "op":"act","params":{{"window":66,"ref":"w.0.1#42.7",
                "action":{{"kind":"invoke"}},
                "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}}}"#
        ))
    }

    fn handshake_request(host_id: &str, host_epoch: u64, connection_epoch: u64) -> Request {
        parse(&format!(
            r#"{{"id":"h","hostId":"{host_id}","hostEpoch":{host_epoch},
                "connectionEpoch":{connection_epoch},"op":"handshake",
                "params":{{"connectionTimeoutMs":2000,"transactionTimeoutMs":2000}}}}"#
        ))
    }

    fn bind_request(connection_epoch: u64) -> Request {
        parse(&format!(
            r#"{{"id":"b","hostId":"h1","hostEpoch":2,
                "connectionEpoch":{connection_epoch},"op":"bind_connection","params":{{}}}}"#
        ))
    }

    fn act_params(action: &str) -> Request {
        parse(&format!(
            r#"{{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"act","params":{{"window":66,"ref":"w.0#7","action":{action},
                "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}}}"#
        ))
    }

    fn action_of(req: Request) -> ActionSpec {
        match req.op {
            Op::Act { action, .. } => action,
            other => panic!("解析为其他 op：{other:?}"),
        }
    }

    #[test]
    fn request_decodes_op_and_params() {
        let req = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_tree","params":{"window":66,"maxNodes":500,"maxDepth":12,
                "timeBudgetMs":1500}}"#,
        );
        assert_eq!(req.id, "r1");
        assert_eq!(req.deadline, None);
        match req.op {
            Op::ReadTree { window, bounds, .. } => {
                assert_eq!(
                    (
                        window,
                        bounds.max_nodes,
                        bounds.max_depth,
                        bounds.time_budget_ms
                    ),
                    (66, 500, 12, 1500)
                );
            }
            other => panic!("解析为其他 op：{other:?}"),
        }
    }

    /// 筛选与字段选择均缺省时读取整窗与全部字段。
    #[test]
    fn read_tree_defaults_to_the_whole_window_with_values() {
        let req = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_tree","params":{"window":66,"maxNodes":500,"maxDepth":12,
                "timeBudgetMs":1500}}"#,
        );
        match req.op {
            Op::ReadTree { select, .. } => {
                assert_eq!(select.root, None);
                assert!(select.include_value);
                assert!(select.include_state);
                assert!(select.describe().is_empty());
            }
            other => panic!("解析为其他 op：{other:?}"),
        }
    }

    /// 范围与字段选择逐条写入 completeness，调用方据此区分「没有」与「不在读取范围内」。
    #[test]
    fn selection_is_described_field_by_field() {
        let req = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_tree","params":{"window":66,"root":"w.0#7",
                "includeValue":false,"includeState":false,
                "maxNodes":500,"maxDepth":12,"timeBudgetMs":1500}}"#,
        );
        match req.op {
            Op::ReadTree { select, .. } => {
                assert_eq!(
                    select.describe(),
                    vec![
                        "root=w.0#7".to_owned(),
                        "includeValue=false".to_owned(),
                        "includeState=false".to_owned(),
                    ]
                );
            }
            other => panic!("解析为其他 op：{other:?}"),
        }
    }

    /// 动作与等待都携带当前观察的范围根，结束时按该范围整体重读。
    #[test]
    fn act_and_wait_carry_the_observation_scope() {
        let act = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"act","params":{"window":66,"ref":"w.0.3#9","root":"w.0#7",
                "action":{"kind":"invoke"},"maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}"#,
        );
        match act.op {
            Op::Act { root, .. } => assert_eq!(root.as_deref(), Some("w.0#7")),
            other => panic!("解析为其他 op：{other:?}"),
        }
        let wait = parse(
            r#"{"id":"r2","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"wait","params":{"window":66,"until":"appears","role":"button",
                "nameContains":"保存","pollMs":250,"timeoutMs":9000,
                "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}"#,
        );
        match wait.op {
            Op::Wait {
                role,
                name_contains,
                root,
                ..
            } => {
                assert_eq!(role.as_deref(), Some("button"));
                assert_eq!(name_contains.as_deref(), Some("保存"));
                assert_eq!(root, None);
            }
            other => panic!("解析为其他 op：{other:?}"),
        }
    }

    #[test]
    fn wait_decodes_condition_and_two_bounds() {
        let req = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"wait","params":{"window":66,"until":"value","ref":"w.0#7",
                "value":"张三","pollMs":250,"timeoutMs":9000,
                "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}"#,
        );
        match req.op {
            Op::Wait {
                until,
                reference,
                value,
                poll_ms,
                timeout_ms,
                ..
            } => {
                assert_eq!(until, WaitUntil::Value);
                assert_eq!(reference.as_deref(), Some("w.0#7"));
                assert_eq!(value.as_deref(), Some("张三"));
                assert_eq!((poll_ms, timeout_ms), (250, 9000));
            }
            other => panic!("解析为其他 op：{other:?}"),
        }
    }

    #[test]
    fn op_without_params_still_requires_an_empty_object() {
        const HEAD: &str = r#""id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5"#;
        assert!(matches!(
            parse(&format!(r#"{{{HEAD},"op":"list_windows","params":{{}}}}"#)).op,
            Op::ListWindows {}
        ));
        assert!(
            serde_json::from_str::<Request>(&format!(r#"{{{HEAD},"op":"list_windows"}}"#)).is_err()
        );
    }

    #[test]
    fn unknown_op_does_not_decode_into_a_default() {
        assert!(serde_json::from_str::<Request>(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"screenshot","params":{}}"#
        )
        .is_err());
    }

    /// 不存在单独读取一个控件的 op：动作与等待都自带按范围的重读，没有第二条只读路径。
    #[test]
    fn a_single_element_read_op_does_not_exist() {
        assert!(serde_json::from_str::<Request>(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_element","params":{"window":66,"ref":"w.0#7"}}"#
        )
        .is_err());
    }

    #[test]
    fn response_omits_absent_fields() {
        let json =
            serde_json::to_string(&Response::rejected("r1".to_owned(), "read_only".to_owned()))
                .expect("回执应当序列化成功");
        assert_eq!(
            json,
            r#"{"id":"r1","dispatch":"not_dispatched","reason":"read_only"}"#
        );
    }

    fn tree(scope: Option<&str>) -> Tree {
        Tree {
            window: 66,
            captured_at: 17,
            scope: scope.map(str::to_owned),
            window_enabled: true,
            window_covered: false,
            completeness: Completeness {
                complete: true,
                truncated_by: Vec::new(),
                filtered_by: Vec::new(),
                visited: 1,
            },
            node_count: 1,
            nodes: vec![Node {
                reference: "w.0#7".to_owned(),
                parent_ref: None,
                depth: 0,
                role: "button".to_owned(),
                name: "保存".to_owned(),
                automation_id: "save".to_owned(),
                value: None,
                enabled: true,
                offscreen: false,
                focused: false,
                rect: Some(ScreenRect {
                    x: 120,
                    y: 240,
                    width: 80,
                    height: 24,
                }),
                actions: vec![NodeAction::ready("invoke")],
                range: None,
                toggle: None,
                expand: None,
                selected: None,
                selection: None,
                scroll: None,
                text: false,
                weak_identity: false,
            }],
        }
    }

    /// 层级保留在展平表中：父 ref 与深度各占一个字段，没有嵌套的子节点数组。
    #[test]
    fn the_tree_observation_is_a_flat_table_with_parent_links() {
        let value = serde_json::to_value(Observation::Tree(tree(Some("w.0#7")))).unwrap();
        assert_eq!(value["kind"], "tree");
        assert_eq!(value["scope"], "w.0#7");
        assert_eq!(value["windowEnabled"], true);
        assert_eq!(value["nodes"][0]["depth"], 0);
        assert!(value["nodes"][0].get("children").is_none());
        assert!(value["nodes"][0].get("parentRef").is_none());
    }

    /// 整窗读取没有 scope：调用方据此作废整份旧观察。
    #[test]
    fn a_whole_window_read_carries_no_scope() {
        let value = serde_json::to_value(Observation::Tree(tree(None))).unwrap();
        assert!(value.get("scope").is_none());
    }

    #[test]
    fn a_wait_observation_carries_the_outcome_beside_the_state() {
        let value = serde_json::to_value(Observation::Wait(Wait {
            found: false,
            reason: Some("timeout".to_owned()),
            tree: tree(Some("w.0#7")),
        }))
        .unwrap();
        assert_eq!(value["kind"], "wait");
        assert_eq!(value["found"], false);
        assert_eq!(value["reason"], "timeout");
        assert_eq!(value["scope"], "w.0#7");
        assert_eq!(value["nodeCount"], 1);
    }

    /// 截断与读取范围分为两个字段：只读取一棵子树不是截断。
    #[test]
    fn truncation_and_scope_are_reported_separately() {
        let mut body = tree(Some("w.0#7"));
        body.completeness = Completeness {
            complete: false,
            truncated_by: vec!["max_nodes"],
            filtered_by: vec!["root=w.0#7".to_owned()],
            visited: 500,
        };
        let value = serde_json::to_value(Observation::Tree(body)).unwrap();
        assert_eq!(value["completeness"]["truncatedBy"][0], "max_nodes");
        assert_eq!(value["completeness"]["filteredBy"][0], "root=w.0#7");
        assert_eq!(value["completeness"]["visited"], 500);
    }

    /// 调用未返回时不重读目标窗口，改为返回一份只经由 Win32 读取的顶层窗口清单：
    /// 此时目标应用的 UI 线程阻塞于该调用，任何 UIA 读取都会等待至超时。
    #[test]
    fn a_blocked_action_carries_the_windows_instead_of_a_reread() {
        let mut resp = Response::acted(
            "r1".to_owned(),
            Dispatch::Submitted,
            Err("target_blocked".to_owned()),
        );
        resp.blocking = Some(vec![
            BlockingWindow {
                info: WindowInfo {
                    window: 66,
                    pid: 900,
                    title: "夹具".to_owned(),
                    class_name: "WindowsForms10.Window".to_owned(),
                },
                appeared: false,
            },
            BlockingWindow {
                info: WindowInfo {
                    window: 67,
                    pid: 900,
                    title: "qywork modal dialog".to_owned(),
                    class_name: "#32770".to_owned(),
                },
                appeared: true,
            },
        ]);
        let value = serde_json::to_value(&resp).expect("回执应当序列化成功");
        assert_eq!(value["dispatch"], "submitted");
        assert!(value["observationError"]
            .as_str()
            .is_some_and(|t| t.starts_with("target_blocked")));
        assert!(value.get("observation").is_none());
        // 回执发出之后需清理一次 provider，该任务只在 worker 内部传递，不写入协议。
        resp.after_reply = Some(66);
        let value = serde_json::to_value(&resp).expect("回执应当序列化成功");
        assert!(value.get("afterReply").is_none());
        assert!(value.get("after_reply").is_none());
        // 身份字段与窗口清单结构相同：宿主按同一路径补充进程启动时刻与应用名。
        assert_eq!(value["blocking"][0]["window"], 66);
        assert_eq!(value["blocking"][0]["appeared"], false);
        assert_eq!(value["blocking"][1]["title"], "qywork modal dialog");
        assert_eq!(value["blocking"][1]["appeared"], true);
    }

    /// 调用已返回时照常重读，不带该字段。
    #[test]
    fn a_returned_action_carries_no_window_list() {
        let resp = Response::acted("r1".to_owned(), Dispatch::Submitted, Err("窗口已关闭".to_owned()));
        let value = serde_json::to_value(&resp).expect("回执应当序列化成功");
        assert!(value.get("blocking").is_none());
    }

    #[test]
    fn failed_reread_keeps_the_dispatch_fact() {
        let resp = Response::acted(
            "r1".to_owned(),
            Dispatch::Submitted,
            Err("窗口已关闭".to_owned()),
        );
        let json = serde_json::to_string(&resp).expect("回执应当序列化成功");
        assert!(json.contains(r#""dispatch":"submitted""#));
        assert!(json.contains(r#""observationError":"窗口已关闭""#));
    }

    #[test]
    fn failed_action_call_is_unknown_not_undispatched() {
        assert_eq!(
            classify_action(Some(&Ok(())), None, true),
            Some((Dispatch::Submitted, None))
        );
        assert_eq!(
            classify_action(Some(&Err("provider 无响应".to_owned())), None, true),
            Some((Dispatch::Unknown, Some("provider 无响应".to_owned())))
        );
    }

    /// 调用未返回而目标窗口被模态对话框阻挡：动作已经生效，必须记为 submitted。
    #[test]
    fn verifiable_evidence_settles_a_call_that_has_not_returned() {
        for evidence in [
            ActionEvidence::WindowDisabled,
            ActionEvidence::WindowGone,
            ActionEvidence::NewWindow,
        ] {
            let settled = classify_action(None, Some(evidence), false);
            let (dispatch, reason) = settled.expect("有证据即有终态");
            assert_eq!(dispatch, Dispatch::Submitted);
            assert_eq!(reason.as_deref(), Some(evidence.as_str()));
        }
    }

    /// 没有证据且调用未返回：期限之前继续等待，到期才记为 unknown。
    #[test]
    fn a_pending_call_without_evidence_waits_then_becomes_unknown() {
        assert_eq!(classify_action(None, None, false), None);
        let (dispatch, reason) = classify_action(None, None, true).expect("到期即有终态");
        assert_eq!(dispatch, Dispatch::Unknown);
        assert!(reason.is_some_and(|r| r.starts_with("call_pending")));
    }

    /// 调用自身返回的结果优先于证据：它更准确。
    #[test]
    fn a_returned_call_outranks_the_evidence() {
        assert_eq!(
            classify_action(Some(&Ok(())), Some(ActionEvidence::NewWindow), false),
            Some((Dispatch::Submitted, None))
        );
    }

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0x00, 0xff, 0x80]), "AP+A");
    }

    /// 二态控件按一次即到达，三态控件按目标态计算所需次数；环上没有的状态返回 None。
    #[test]
    fn toggle_steps_count_the_presses_a_target_state_needs() {
        use ToggleState::{Indeterminate, Off, On};
        assert_eq!(toggle_steps(Off, On, false), Some(1));
        assert_eq!(toggle_steps(On, Off, false), Some(1));
        assert_eq!(toggle_steps(Off, Off, false), Some(0));
        // 三态环按 Off → On → Indeterminate → Off 循环。
        assert_eq!(toggle_steps(Off, On, true), Some(1));
        assert_eq!(toggle_steps(Off, Indeterminate, true), Some(2));
        assert_eq!(toggle_steps(Indeterminate, Off, true), Some(1));
        assert_eq!(toggle_steps(On, Indeterminate, true), Some(1));
        // 二态控件无法到达中间态：报告不支持，而不是按两次切换到其他状态。
        assert_eq!(toggle_steps(Off, Indeterminate, false), None);
        assert_eq!(toggle_steps(Indeterminate, Off, false), None);
    }

    /// 每种动作的参数随动作名称给出，缺少一项即解析失败，不会转换为一条合法请求。
    #[test]
    fn each_action_carries_its_own_parameters() {
        assert!(matches!(
            action_of(act_params(r#"{"kind":"invoke"}"#)),
            ActionSpec::Invoke
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"set_value","value":""}"#)),
            ActionSpec::SetValue { value } if value.is_empty()
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"set_range_value","value":12.5}"#)),
            ActionSpec::SetRangeValue { value } if (value - 12.5).abs() < f64::EPSILON
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"set_toggle","state":"indeterminate"}"#)),
            ActionSpec::SetToggle { state: ToggleState::Indeterminate }
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"scroll","direction":"down","step":"page"}"#)),
            ActionSpec::Scroll { direction: ScrollDirection::Down, step: ScrollStep::Page }
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"realize_item","name":"第 900 项"}"#)),
            ActionSpec::RealizeItem { name } if name == "第 900 项"
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"select_text","start":3,"length":4}"#)),
            ActionSpec::SelectText { start: 3, length: 4 }
        ));
        for bad in [
            r#"{"kind":"set_value"}"#,
            r#"{"kind":"set_range_value"}"#,
            r#"{"kind":"set_toggle","state":"maybe"}"#,
            r#"{"kind":"scroll","direction":"down"}"#,
            r#"{"kind":"click"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(&format!(
                    r#"{{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                        "op":"act","params":{{"window":66,"ref":"w.0#7","action":{bad},
                        "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}}}"#
                ))
                .is_err(),
                "{bad} 应当解析失败"
            );
        }
    }

    /// 可用动作表必须能表达动作当前是否可用，只读与叶节点各有对应的原因码。
    #[test]
    fn an_action_offer_carries_its_delivery_and_reason() {
        let ready = serde_json::to_value(NodeAction::ready("invoke")).unwrap();
        assert_eq!(ready, json_of(r#"{"action":"invoke","delivery":["background"]}"#));
        let blocked = serde_json::to_value(NodeAction::blocked("set_value", "read_only")).unwrap();
        assert_eq!(
            blocked,
            json_of(r#"{"action":"set_value","delivery":[],"unavailable":"read_only"}"#)
        );
    }

    fn json_of(text: &str) -> serde_json::Value {
        serde_json::from_str(text).expect("用例中的 JSON 应当合法")
    }

    /// 文本观察自带所读取的控件、截断标记与选区起点。
    #[test]
    fn a_text_observation_reports_truncation_and_selection_offsets() {
        let value = serde_json::to_value(Observation::Text(Text {
            window: 66,
            captured_at: 17,
            scope: "w.3#9".to_owned(),
            text: "中文内容".to_owned(),
            truncated: true,
            selection_support: "single",
            selection: vec![TextSelection {
                start: 2,
                text: "内容".to_owned(),
                truncated: false,
            }],
        }))
        .unwrap();
        assert_eq!(value["kind"], "text");
        assert_eq!(value["scope"], "w.3#9");
        assert_eq!(value["truncated"], true);
        assert_eq!(value["selectionSupport"], "single");
        assert_eq!(value["selection"][0]["start"], 2);
        assert_eq!(value["selection"][0]["text"], "内容");
    }

    /// 读取文本是只读 op：它不带三个上限字段，也不经由动作路径。
    #[test]
    fn read_text_is_its_own_read_only_op() {
        let req = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_text","params":{"window":66,"ref":"w.3#9","maxChars":2000}}"#,
        );
        assert!(matches!(
            req.op,
            Op::ReadText { window: 66, max_chars: 2000, .. }
        ));
    }

    /// 控件状态只在对应模式存在时输出，缺席的状态不输出空字段。
    #[test]
    fn pattern_state_fields_are_absent_without_the_pattern() {
        let value = serde_json::to_value(Observation::Tree(tree(None))).unwrap();
        let node = &value["nodes"][0];
        for key in ["range", "toggle", "expand", "selected", "selection", "scroll", "text"] {
            assert!(node.get(key).is_none(), "{key} 不应出现");
        }
    }

    /// 步长不是有限数时这两个字段缺席；值或边界非有限时整份区间缺席。
    #[test]
    fn a_range_drops_the_values_the_provider_cannot_give() {
        let full = range_state(20.0, 0.0, 100.0, 1.0, 10.0).expect("有限数应当构成一份区间");
        assert_eq!(full.small_change, Some(1.0));
        let stepless = range_state(35.0, 0.0, 100.0, f64::NAN, f64::NAN)
            .expect("只有步长非有限时区间仍然成立");
        assert_eq!((stepless.small_change, stepless.large_change), (None, None));
        let value = serde_json::to_value(stepless).unwrap();
        assert!(value.get("smallChange").is_none());
        assert_eq!(value["value"], 35.0);
        assert_eq!(range_state(f64::NAN, 0.0, 100.0, 1.0, 10.0), None);
        assert_eq!(range_state(1.0, f64::NAN, 100.0, 1.0, 10.0), None);
        assert_eq!(range_state(1.0, 0.0, f64::INFINITY, 1.0, 10.0), None);
    }

    /// 选中项名称写入 `selected`，未选中任何项时该字段与截断标记都不出现。
    #[test]
    fn a_container_carries_the_names_of_what_is_selected() {
        let mut body = tree(None);
        body.nodes[0].selection = Some(SelectionState {
            multiple: false,
            required: false,
            selected: vec!["市场部".to_owned()],
            truncated: false,
        });
        let value = serde_json::to_value(Observation::Tree(body)).unwrap();
        let selection = &value["nodes"][0]["selection"];
        assert_eq!(selection["selected"], serde_json::json!(["市场部"]));
        assert_eq!(selection["multiple"], false);
        assert!(selection.get("truncated").is_none());

        let mut empty = tree(None);
        empty.nodes[0].selection = Some(SelectionState {
            multiple: true,
            required: false,
            selected: Vec::new(),
            truncated: false,
        });
        let value = serde_json::to_value(Observation::Tree(empty)).unwrap();
        let selection = &value["nodes"][0]["selection"];
        assert!(selection.get("selected").is_none(), "没有选中项时不应出现该字段");
        assert!(selection.get("truncated").is_none());
        assert_eq!(selection["multiple"], true);
    }

    /// 不能滚动的轴缺席。**缺席不是 0**：0 表示位于顶端。
    #[test]
    fn a_non_scrollable_axis_is_absent_rather_than_zero() {
        let mut body = tree(None);
        body.nodes[0].scroll = Some(ScrollState {
            horizontal: None,
            vertical: Some(0.0),
        });
        let value = serde_json::to_value(Observation::Tree(body)).unwrap();
        assert!(value["nodes"][0]["scroll"].get("horizontal").is_none());
        assert_eq!(value["nodes"][0]["scroll"]["vertical"], 0.0);
    }

    #[test]
    fn requests_before_the_handshake_are_refused() {
        let req = invoke_request(None);
        assert_eq!(admit(&req, None, false, 0), Err("no_handshake"));
    }

    #[test]
    fn handshake_needs_no_prior_identity_but_must_carry_one() {
        assert_eq!(
            admit(&handshake_request("h1", 2, 5), None, false, 0),
            Ok(())
        );
        assert!(serde_json::from_str::<Request>(
            r#"{"id":"h","connectionEpoch":5,
                "op":"handshake","params":{"connectionTimeoutMs":2000,"transactionTimeoutMs":2000}}"#
        )
        .is_err());
    }

    #[test]
    fn a_second_identity_cannot_rebind_the_same_worker() {
        let binding = bound();
        // 同一身份的重复握手仍然放行：它用于重设超时与清空取消登记。
        assert_eq!(
            admit(&handshake_request("h1", 2, 5), Some(&binding), false, 0),
            Ok(())
        );
        assert_eq!(
            admit(&handshake_request("h1", 3, 5), Some(&binding), false, 0),
            Err("already_bound")
        );
        assert_eq!(
            admit(&handshake_request("h2", 2, 5), Some(&binding), false, 0),
            Err("already_bound")
        );
        assert_eq!(
            admit(&handshake_request("h1", 2, 4), Some(&binding), false, 0),
            Err("connection_epoch_rollback")
        );
    }

    #[test]
    fn stale_host_epoch_or_id_is_refused() {
        let mut req = invoke_request(None);
        req.host_epoch = 1;
        assert_eq!(
            admit(&req, Some(&bound()), false, 0),
            Err("host_epoch_mismatch")
        );
        req.host_epoch = 2;
        req.host_id = "h2".to_owned();
        assert_eq!(admit(&req, Some(&bound()), false, 0), Err("host_mismatch"));
    }

    #[test]
    fn a_queued_request_from_the_old_connection_is_refused_after_rebinding() {
        let queued = invoke_request(None);
        let mut binding = bound();
        assert_eq!(admit(&queued, Some(&binding), false, 0), Ok(()));
        // 宿主重连：连接代际增大到 6，队列中属于代际 5 的动作请求不得再派发。
        let rebind = bind_request(6);
        assert_eq!(admit(&rebind, Some(&binding), false, 0), Ok(()));
        binding.connection_epoch = 6;
        assert_eq!(
            admit(&queued, Some(&binding), false, 0),
            Err("connection_epoch_mismatch")
        );
    }

    #[test]
    fn connection_epoch_only_moves_forward() {
        let binding = bound();
        assert_eq!(
            admit(&bind_request(5), Some(&binding), false, 0),
            Err("connection_epoch_rollback")
        );
        assert_eq!(
            admit(&bind_request(4), Some(&binding), false, 0),
            Err("connection_epoch_rollback")
        );
        assert_eq!(admit(&bind_request(6), Some(&binding), false, 0), Ok(()));
        assert_eq!(admit(&bind_request(6), None, false, 0), Err("no_handshake"));
    }

    #[test]
    fn admit_checks_identity_before_connection_epoch_and_both_before_cancellation() {
        let mut req = invoke_request(None);
        req.host_id = "h2".to_owned();
        req.connection_epoch = 99;
        assert_eq!(
            admit(&req, Some(&bound()), true, i64::MAX),
            Err("host_mismatch")
        );
        req.host_id = "h1".to_owned();
        assert_eq!(
            admit(&req, Some(&bound()), true, i64::MAX),
            Err("connection_epoch_mismatch")
        );
        req.connection_epoch = 5;
        assert_eq!(
            admit(&req, Some(&bound()), true, i64::MAX),
            Err("cancelled")
        );
    }

    #[test]
    fn a_cancelled_request_is_never_dispatched() {
        let req = invoke_request(None);
        assert_eq!(admit(&req, Some(&bound()), true, 0), Err("cancelled"));
    }

    #[test]
    fn deadline_bounds_dispatch_and_absent_deadline_passes() {
        let req = invoke_request(Some(1_000));
        assert_eq!(admit(&req, Some(&bound()), false, 999), Ok(()));
        assert_eq!(
            admit(&req, Some(&bound()), false, 1_000),
            Err("deadline_exceeded")
        );
        assert_eq!(
            admit(&req, Some(&bound()), false, 5_000),
            Err("deadline_exceeded")
        );
        assert_eq!(
            admit(&invoke_request(None), Some(&bound()), false, i64::MAX),
            Ok(())
        );
    }

    /// 五种等待条件各自只采用对应的事实，不会因读取其他事实而误判为满足。
    #[test]
    fn each_wait_condition_reads_only_its_own_fact() {
        let on = Seen::Element {
            enabled: true,
            value: Some("张三"),
        };
        let off = Seen::Element {
            enabled: false,
            value: Some(""),
        };
        assert!(satisfied(WaitUntil::Enabled, None, on));
        assert!(!satisfied(WaitUntil::Enabled, None, off));
        assert!(satisfied(WaitUntil::Value, Some("张三"), on));
        assert!(!satisfied(WaitUntil::Value, Some("李四"), on));
        assert!(satisfied(WaitUntil::Value, Some(""), off));
        assert!(satisfied(WaitUntil::Gone, None, Seen::Missing));
        assert!(!satisfied(WaitUntil::Gone, None, on));
        assert!(satisfied(WaitUntil::Appears, None, Seen::Matches(1)));
        assert!(!satisfied(WaitUntil::Appears, None, Seen::Matches(0)));
        assert!(satisfied(WaitUntil::Window, None, Seen::Window(true)));
        assert!(!satisfied(WaitUntil::Window, None, Seen::Window(false)));
        // 控件仍存在时不算消失，控件不存在时也不算值已满足。
        assert!(!satisfied(WaitUntil::Value, Some(""), Seen::Missing));
        assert!(!satisfied(WaitUntil::Enabled, None, Seen::Missing));
    }

    /// 原始失败形状：等待刚点击的链接的值，页面跳转后链接即不存在，此前会一直轮询至超时。
    #[test]
    fn a_value_or_enabled_wait_on_a_missing_control_cannot_succeed() {
        assert!(!attainable(WaitUntil::Value, Seen::Missing));
        assert!(!attainable(WaitUntil::Enabled, Seen::Missing));
        // 等待消失的条件正需要控件不存在；等待出现与等待窗口不检查单个控件。
        assert!(attainable(WaitUntil::Gone, Seen::Missing));
        assert!(attainable(WaitUntil::Appears, Seen::Matches(0)));
        assert!(attainable(WaitUntil::Window, Seen::Window(false)));
        let off = Seen::Element {
            enabled: false,
            value: None,
        };
        assert!(attainable(WaitUntil::Value, off));
        assert!(attainable(WaitUntil::Enabled, off));
    }

    /// 大窗口上的判定本身需要数百毫秒，间隔必须随之增大，否则等待会完全占用目标应用。
    #[test]
    fn the_poll_interval_paces_itself_by_the_cost_of_the_last_probe() {
        let floor = Duration::from_millis(250);
        let plenty = Duration::from_secs(60);
        // 判定耗时很短时按调用方给出的下限。
        assert_eq!(next_poll(floor, Duration::from_millis(5), plenty), floor);
        assert_eq!(next_poll(floor, Duration::ZERO, plenty), floor);
        // 判定耗时超过下限时按耗时放大：230 ms 的一轮之后间隔 920 ms，占空比 20%。
        assert_eq!(
            next_poll(floor, Duration::from_millis(230), plenty),
            Duration::from_millis(920)
        );
    }

    /// 截止时刻优先级最高：休眠超过剩余时间会错过截止时刻。
    #[test]
    fn the_poll_interval_never_sleeps_past_the_deadline() {
        let floor = Duration::from_millis(250);
        assert_eq!(
            next_poll(floor, Duration::from_millis(230), Duration::from_millis(100)),
            Duration::from_millis(100)
        );
        assert_eq!(
            next_poll(floor, Duration::ZERO, Duration::ZERO),
            Duration::ZERO
        );
    }

    /// 弱身份只在为真时输出：绝大多数控件有 RuntimeId，多输出一个字段没有意义。
    #[test]
    fn a_weak_identity_is_only_reported_when_it_is_weak() {
        let mut body = tree(None);
        let value = serde_json::to_value(Observation::Tree(body)).unwrap();
        assert!(value["nodes"][0].get("weakIdentity").is_none());

        body = tree(None);
        body.nodes[0].weak_identity = true;
        let value = serde_json::to_value(Observation::Tree(body)).unwrap();
        assert_eq!(value["nodes"][0]["weakIdentity"], true);
    }

    /// 前台动作与后台动作在同一个枚举中，按 `foreground_only` 分别准入。
    #[test]
    fn foreground_actions_are_marked_and_background_ones_are_not() {
        for spec in [
            r#"{"kind":"click","button":"left","count":2}"#,
            r#"{"kind":"hover"}"#,
            r#"{"kind":"drag","to":{"kind":"offset","dx":80,"dy":0}}"#,
            r#"{"kind":"wheel","direction":"down","amount":3}"#,
            r#"{"kind":"type_text","text":"张三"}"#,
            r#"{"kind":"press_key","key":"a","modifiers":["ctrl"]}"#,
            r#"{"kind":"activate"}"#,
            r#"{"kind":"set_window_state","state":"maximized"}"#,
            r#"{"kind":"move_window","x":100,"y":200}"#,
            r#"{"kind":"resize_window","width":900,"height":600}"#,
            r#"{"kind":"close_window"}"#,
        ] {
            assert!(
                action_of(act_params(spec)).foreground_only(),
                "{spec} 应当是前台动作"
            );
        }
        for spec in [
            r#"{"kind":"invoke"}"#,
            r#"{"kind":"set_value","value":"x"}"#,
            r#"{"kind":"scroll","direction":"down","step":"line"}"#,
            r#"{"kind":"select_text","start":0,"length":3}"#,
        ] {
            assert!(
                !action_of(act_params(spec)).foreground_only(),
                "{spec} 应当是后台动作"
            );
        }
    }

    /// 只有指针动作接受屏幕落点。其他动作即使给出坐标也没有落点的含义。
    #[test]
    fn only_pointer_actions_take_a_screen_point() {
        for spec in [
            r#"{"kind":"click","button":"right","count":1}"#,
            r#"{"kind":"hover"}"#,
            r#"{"kind":"drag","to":{"kind":"ref","ref":"w.1#9"}}"#,
            r#"{"kind":"wheel","direction":"up","amount":1}"#,
        ] {
            assert!(action_of(act_params(spec)).takes_point(), "{spec} 应当接受落点");
        }
        for spec in [
            r#"{"kind":"type_text","text":"x"}"#,
            r#"{"kind":"activate"}"#,
            r#"{"kind":"invoke"}"#,
        ] {
            assert!(
                !action_of(act_params(spec)).takes_point(),
                "{spec} 不应接受落点"
            );
        }
    }

    /// 只有键盘输入可以不指定目标：目标是窗口本身。
    ///
    /// 其他动作不指定目标即拒绝：指针动作没有落点，窗口动作没有可调用的模式对象。
    #[test]
    fn only_keyboard_actions_may_omit_the_target() {
        for spec in [
            r#"{"kind":"type_text","text":"你好"}"#,
            r#"{"kind":"press_key","key":"a","modifiers":["ctrl"]}"#,
        ] {
            let action = action_of(act_params(spec));
            assert!(action.targets_window(), "{spec} 应当可以投递给窗口");
            assert_eq!(check_act(&action, false, false, false, true), Ok(()));
            // 指定控件时照常放行，判定交给执行路径上的焦点核对。
            assert_eq!(check_act(&action, true, false, false, true), Ok(()));
            // 仍不接受屏幕落点：键盘输入没有落点。
            assert_eq!(
                check_act(&action, false, true, true, true),
                Err("point_unsupported: 该动作只能按控件执行")
            );
            // 前台模式关闭时这两种动作同样被拒绝，缺少目标不构成例外。
            assert_eq!(
                check_act(&action, false, false, false, false),
                Err(FOREGROUND_DISABLED)
            );
        }
        for spec in [
            r#"{"kind":"click","button":"left","count":1}"#,
            r#"{"kind":"hover"}"#,
            r#"{"kind":"activate"}"#,
            r#"{"kind":"close_window"}"#,
            r#"{"kind":"invoke"}"#,
        ] {
            let action = action_of(act_params(spec));
            assert!(!action.targets_window(), "{spec} 不应可以投递给窗口");
            assert_eq!(
                check_act(&action, false, false, false, true),
                Err("missing_target: 必须提供 ref 或 point"),
                "{spec} 不指定目标时应当被拒绝"
            );
        }
    }

    /// 前台动作的参数同样随动作名称给出，缺少一项或枚举值错误都会解析失败。
    #[test]
    fn foreground_action_parameters_are_checked_at_parse_time() {
        assert!(matches!(
            action_of(act_params(r#"{"kind":"click","button":"middle","count":1}"#)),
            ActionSpec::Click { button: MouseButton::Middle, count: 1 }
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"press_key","key":"enter"}"#)),
            ActionSpec::PressKey { modifiers, .. } if modifiers.is_empty()
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"set_window_state","state":"minimized"}"#)),
            ActionSpec::SetWindowState { state: WindowState::Minimized }
        ));
        assert!(matches!(
            action_of(act_params(r#"{"kind":"drag","to":{"kind":"offset","dx":-4,"dy":9}}"#)),
            ActionSpec::Drag { to: DragTarget::Offset { dx: -4, dy: 9 } }
        ));
        for bad in [
            r#"{"kind":"click","button":"left"}"#,
            r#"{"kind":"click","button":"back","count":1}"#,
            r#"{"kind":"wheel","direction":"down"}"#,
            r#"{"kind":"type_text"}"#,
            r#"{"kind":"press_key","key":"a","modifiers":["hyper"]}"#,
            r#"{"kind":"set_window_state","state":"tiny"}"#,
            r#"{"kind":"drag"}"#,
            r#"{"kind":"drag","to":{"kind":"offset","dx":1}}"#,
            r#"{"kind":"move_window","x":1}"#,
            r#"{"kind":"resize_window","width":900}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(&format!(
                    r#"{{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                        "op":"act","params":{{"window":66,"ref":"w.0#7","action":{bad},
                        "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}}}"#
                ))
                .is_err(),
                "{bad} 应当解析失败"
            );
        }
    }

    fn act_request(action: &str, target: &str, foreground: bool) -> Request {
        parse(&format!(
            r#"{{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "foreground":{foreground},"op":"act","params":{{"window":66,{target}
                "action":{action},"maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}}}"#
        ))
    }

    /// 前台模式关闭时前台动作在准入判定即被拒绝，不发出任何系统调用。
    #[test]
    fn foreground_actions_are_refused_while_the_mode_is_off() {
        let click = r#"{"kind":"click","button":"left","count":1}"#;
        let off = act_request(click, r#""ref":"w.0#7","#, false);
        assert_eq!(admit(&off, Some(&bound()), false, 0), Err(FOREGROUND_DISABLED));
        let on = act_request(click, r#""ref":"w.0#7","#, true);
        assert_eq!(admit(&on, Some(&bound()), false, 0), Ok(()));
        // 后台动作不受该开关影响。
        let background = act_request(r#"{"kind":"invoke"}"#, r#""ref":"w.0#7","#, false);
        assert_eq!(admit(&background, Some(&bound()), false, 0), Ok(()));
    }

    /// 先判定身份与代际：旧代际的前台请求得到的是代际不符，不是前台未启用。
    #[test]
    fn identity_is_checked_before_the_foreground_mode() {
        let mut req = act_request(r#"{"kind":"click","button":"left","count":1}"#, r#""ref":"w.0#7","#, false);
        req.connection_epoch = 4;
        assert_eq!(
            admit(&req, Some(&bound()), false, 0),
            Err("connection_epoch_mismatch")
        );
    }

    /// 两种目标写法互斥，且按图像定位必须带窗口几何代际。
    #[test]
    fn a_target_is_either_a_control_or_a_screen_point() {
        let click = r#"{"kind":"click","button":"left","count":1}"#;
        let point = r#""point":{"x":10,"y":20},"expectGeneration":"g","#;
        assert_eq!(admit(&act_request(click, point, true), Some(&bound()), false, 0), Ok(()));
        assert_eq!(
            admit(
                &act_request(click, r#""ref":"w.0#7","point":{"x":10,"y":20},"expectGeneration":"g","#, true),
                Some(&bound()),
                false,
                0
            ),
            Err("target_conflict: ref 与 point 只能提供其中一个")
        );
        assert_eq!(
            admit(&act_request(click, "", true), Some(&bound()), false, 0),
            Err("missing_target: 必须提供 ref 或 point")
        );
        assert_eq!(
            admit(
                &act_request(click, r#""point":{"x":10,"y":20},"#, true),
                Some(&bound()),
                false,
                0
            ),
            Err("missing_generation: 按屏幕坐标操作必须携带窗口几何代际")
        );
        // 键盘与窗口动作没有落点。
        assert_eq!(
            admit(
                &act_request(r#"{"kind":"activate"}"#, point, true),
                Some(&bound()),
                false,
                0
            ),
            Err("point_unsupported: 该动作只能按控件执行")
        );
    }

    /// 前台开关缺席时按关闭处理：缺少该字段的请求只能使用后台动作。
    #[test]
    fn the_foreground_flag_defaults_to_off() {
        assert!(!invoke_request(None).foreground);
        let on: Request = serde_json::from_str(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "foreground":true,"op":"list_windows","params":{}}"#,
        )
        .expect("请求应当解析成功");
        assert!(on.foreground);
    }

    /// 按图像定位的动作不给出 ref，而给出屏幕落点与窗口几何代际。
    #[test]
    fn an_action_can_target_a_screen_point_instead_of_a_control() {
        let req = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "foreground":true,"op":"act","params":{"window":66,
                "point":{"x":-1800,"y":240},"expectGeneration":"100,100,800,600@96#7",
                "action":{"kind":"click","button":"left","count":1},
                "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}"#,
        );
        match req.op {
            Op::Act {
                reference,
                point,
                expect_generation,
                ..
            } => {
                assert_eq!(reference, None);
                assert_eq!(point, Some(ScreenPoint { x: -1800, y: 240 }));
                assert_eq!(expect_generation.as_deref(), Some("100,100,800,600@96#7"));
            }
            other => panic!("解析为其他 op：{other:?}"),
        }
    }

    /// 前台动作的可用项与后台动作在同一张表中，以 delivery 区分。
    #[test]
    fn a_foreground_offer_declares_its_own_delivery() {
        let offer = serde_json::to_value(NodeAction::foreground("click")).unwrap();
        assert_eq!(offer, json_of(r#"{"action":"click","delivery":["foreground"]}"#));
    }

    /// 一批输入全部进入队列才是已派发；部分发出只能记为未知，全部未进入才是未派发。
    #[test]
    fn a_partly_sent_input_batch_is_unknown_not_undispatched() {
        assert_eq!(classify_input(6, 6), (Dispatch::Submitted, None));
        let (dispatch, reason) = classify_input(4, 6);
        assert_eq!(dispatch, Dispatch::Unknown);
        assert!(reason.is_some_and(|r| r.starts_with("input_partial") && r.contains("只发出了 4")));
        let (dispatch, reason) = classify_input(0, 6);
        assert_eq!(dispatch, Dispatch::NotDispatched);
        assert!(reason.is_some_and(|r| r.starts_with("input_blocked")));
        assert_eq!(classify_input(0, 0).0, Dispatch::NotDispatched);
    }

    /// 窗口动作各自采用对应的证据，与后台的三项证据不混用。
    #[test]
    fn window_action_evidence_names_what_was_read_back() {
        for evidence in [
            ActionEvidence::WindowState,
            ActionEvidence::WindowRect,
        ] {
            let (dispatch, reason) =
                classify_action(None, Some(evidence), false).expect("有证据即有终态");
            assert_eq!(dispatch, Dispatch::Submitted);
            assert_eq!(reason.as_deref(), Some(evidence.as_str()));
        }
    }

    /// 输入状态通报不带 id 与 dispatch，回执必定带：宿主据此区分这两种行。
    #[test]
    fn an_input_notice_is_told_apart_from_a_receipt_by_its_shape() {
        let notice = serde_json::to_value(InputNotice::of(HeldInput {
            buttons: vec!["left"],
            keys: vec!["ctrl".to_owned(), "a".to_owned()],
        }))
        .expect("通报应当序列化成功");
        assert_eq!(notice["input"]["buttons"][0], "left");
        assert_eq!(notice["input"]["keys"], json_of(r#"["ctrl","a"]"#));
        assert!(notice.get("id").is_none());
        assert!(notice.get("dispatch").is_none());
        let receipt =
            serde_json::to_value(Response::rejected("r1".to_owned(), "x".to_owned())).unwrap();
        assert!(receipt.get("input").is_none());
        assert_eq!(
            serde_json::to_value(InputNotice::of(HeldInput::default())).unwrap()["input"],
            json_of(r#"{"buttons":[],"keys":[]}"#)
        );
    }

    /// 缺少辅助功能授权或无障碍总线即不可用；只缺少屏幕录制授权时读取与动作照常可用。
    #[test]
    fn only_the_gating_grants_withhold_authorization() {
        assert!(Access::of(Vec::new(), None).authorized);
        assert!(!Access::of(vec![Grant::Accessibility], None).authorized);
        assert!(!Access::of(vec![Grant::AccessibilityBus], None).authorized);
        assert!(Access::of(vec![Grant::ScreenRecording], None).authorized);
        assert!(!Access::of(vec![Grant::Accessibility, Grant::ScreenRecording], None).authorized);
    }

    /// 原因原文不写入协议，也不算事实变化：同一问题的错误文本每次可能不同。
    #[test]
    fn the_access_notice_carries_the_facts_but_not_the_os_text() {
        let denied = Access::of(vec![Grant::AccessibilityBus], Some("连接会话总线失败".to_owned()));
        let notice = serde_json::to_value(AccessNotice { access: &denied }).unwrap();
        assert_eq!(
            notice,
            json_of(r#"{"access":{"authorized":false,"missing":["accessibility_bus"]}}"#)
        );
        assert!(notice.get("id").is_none() && notice.get("input").is_none());
        let again = Access::of(vec![Grant::AccessibilityBus], Some("另一段原文".to_owned()));
        assert!(denied.same(&again));
        assert!(!denied.same(&Access::of(Vec::new(), None)));
        let screen = Access::of(vec![Grant::Accessibility, Grant::ScreenRecording], None);
        assert_eq!(
            serde_json::to_value(&screen).unwrap()["missing"],
            json_of(r#"["accessibility","screen_recording"]"#)
        );
    }

    /// 只接受原因码本身或「码: 说明」；原因码出现在其他位置或接在其他词之后都不算。
    #[test]
    fn a_grant_refusal_is_recognised_by_its_leading_code() {
        assert!(refused_for_grant("accessibility_not_trusted"));
        assert!(refused_for_grant("accessibility_not_trusted: 系统设置里没有允许"));
        assert!(refused_for_grant("accessibility_bus_unavailable: 连接会话总线失败"));
        assert!(refused_for_grant("screen_recording_not_granted: 系统设置里没有给屏幕录制权限"));
        for other in [
            "ref_stale: 第 0 层没有下标 3 的子节点",
            "target_lost: accessibility_bus_unavailable",
            "accessibility_bus_unavailable_later",
            "",
        ] {
            assert!(!refused_for_grant(other), "{other}");
        }
    }

    /// 握手回执携带握手时的授权事实：宿主据此发布 `authorized`，不自行判定平台。
    #[test]
    fn the_ready_observation_carries_the_access_facts() {
        let ready = serde_json::to_value(Observation::Ready {
            backend: "linux-atspi",
            host_id: "h1".to_owned(),
            host_epoch: 2,
            connection_timeout_ms: 2000,
            transaction_timeout_ms: 2000,
            access: Access::of(Vec::new(), None),
        })
        .unwrap();
        assert_eq!(ready["kind"], "ready");
        assert_eq!(ready["access"], json_of(r#"{"authorized":true,"missing":[]}"#));
    }

    /// 修饰键只有四个名称：`win` 不是别名，使用它的请求解析失败。
    #[test]
    fn the_meta_modifier_has_no_platform_alias() {
        let meta = action_of(act_params(
            r#"{"kind":"press_key","key":"r","modifiers":["meta","shift"]}"#,
        ));
        assert!(matches!(
            meta,
            ActionSpec::PressKey { modifiers, .. } if modifiers == [Modifier::Meta, Modifier::Shift]
        ));
        assert!(serde_json::from_str::<Request>(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"act","params":{"window":66,"ref":"w.0#7",
                "action":{"kind":"press_key","key":"r","modifiers":["win"]},
                "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}"#
        )
        .is_err());
        assert_eq!(
            [Modifier::Ctrl, Modifier::Alt, Modifier::Shift, Modifier::Meta].map(Modifier::key_name),
            ["ctrl", "alt", "shift", "meta"]
        );
    }

    /// 主键名不区分大小写，规范为小写；修饰键与词表外的名称不是主键。
    #[test]
    fn a_key_name_is_normalised_or_refused() {
        assert_eq!(key_name("A").as_deref(), Some("a"));
        assert_eq!(key_name("F12").as_deref(), Some("f12"));
        assert_eq!(key_name("Page_Down").as_deref(), Some("page_down"));
        assert_eq!(key_name("bracket_left").as_deref(), Some("bracket_left"));
        for unknown in ["ctrl", "meta", "f25", "f0", "f01", "any", ""] {
            assert_eq!(key_name(unknown), None, "{unknown}");
        }
        let all: Vec<String> = key_names().collect();
        assert_eq!(all.len(), 26 + 10 + 24 + NAMED_KEYS.len());
        assert!(all.iter().all(|k| *k == k.to_ascii_lowercase()));
    }

    /// 角色名互不相同，且都由小写字母与下划线组成：宿主与服务端按名称逐字比较。
    #[test]
    fn role_names_are_unique_snake_case_words() {
        let names: Vec<&str> = Role::ALL.iter().map(|r| r.as_str()).collect();
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len());
        assert!(names
            .iter()
            .all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_lowercase() || c == '_')));
    }

    /// 没有 ValuePattern 的控件不会出现任何值，不能把「没有值」作为空串命中。
    #[test]
    fn a_control_without_a_value_never_satisfies_the_value_condition() {
        let novalue = Seen::Element {
            enabled: true,
            value: None,
        };
        assert!(!satisfied(WaitUntil::Value, Some(""), novalue));
        assert!(!satisfied(WaitUntil::Value, None, novalue));
    }

    // ── 与服务端、宿主共用的样例 ──

    /// 三端共用的样例。三端各写一份夹具即不再构成契约：宿主遗漏 worker 的一个字段时，
    /// 三端各自的测试仍全部通过。
    const SAMPLES: &str =
        include_str!("../../../../../packages/core/src/protocol/native-desktop.samples.json");

    fn samples() -> serde_json::Value {
        serde_json::from_str(SAMPLES).expect("样例文件必须能解析")
    }

    fn sample_request(key: &str) -> Request {
        serde_json::from_value(samples()["workerRequests"][key].clone())
            .unwrap_or_else(|e| panic!("样例请求 {key} 应当解析成功：{e}"))
    }

    /// 宿主转换出的每一种请求都必须被 worker 解析为相同的值：字段名拼写错误时 serde 按缺席处理，
    /// 解析仍然成功，只有逐项比对才能发现。
    #[test]
    fn host_requests_from_the_shared_samples_carry_every_field() {
        for key in samples()["workerRequests"].as_object().expect("样例").keys() {
            let r = sample_request(key);
            assert_eq!(
                (r.id.as_str(), r.deadline, r.host_id.as_str(), r.host_epoch, r.connection_epoch),
                ("w1", Some(1_757_744_400_000), "h1", 2, 3),
                "{key}"
            );
        }
        let bounds = |b: Bounds| (b.max_nodes, b.max_depth, b.time_budget_ms);
        assert!(matches!(sample_request("list_windows").op, Op::ListWindows {}));
        match sample_request("read_tree").op {
            Op::ReadTree { window, select, bounds: b } => {
                assert_eq!(window, 66);
                assert_eq!(select.root.as_deref(), Some("w.0.1#42.7"));
                assert!(!select.include_value && !select.include_state);
                assert_eq!(bounds(b), (400, 12, 800));
            }
            other => panic!("{other:?}"),
        }
        let act = sample_request("act_ref");
        assert!(!act.foreground);
        match act.op {
            Op::Act { window, reference, root, point, expect_generation, action, bounds: b } => {
                assert_eq!(window, 66);
                assert_eq!(reference.as_deref(), Some("w.0.1#42.7"));
                assert_eq!(root.as_deref(), Some("w.0"));
                assert_eq!((point, expect_generation), (None, None));
                assert!(matches!(action, ActionSpec::SetValue { value } if value == "你好"));
                assert_eq!(bounds(b), (400, 12, 800));
            }
            other => panic!("{other:?}"),
        }
        let act = sample_request("act_point");
        assert!(act.foreground);
        match act.op {
            Op::Act { reference, point, expect_generation, action, .. } => {
                assert_eq!(reference, None);
                assert_eq!(point, Some(ScreenPoint { x: 120, y: -40 }));
                assert_eq!(expect_generation.as_deref(), Some("80,80,520,460@96#1"));
                assert!(matches!(action, ActionSpec::Click { button: MouseButton::Left, count: 2 }));
            }
            other => panic!("{other:?}"),
        }
        match sample_request("read_text").op {
            Op::ReadText { window, reference, max_chars } => {
                assert_eq!((window, reference.as_str(), max_chars), (66, "w.0.3", 4000));
            }
            other => panic!("{other:?}"),
        }
        match sample_request("wait").op {
            Op::Wait {
                window,
                until,
                reference,
                value,
                role,
                name_contains,
                root,
                name,
                poll_ms,
                timeout_ms,
                bounds: b,
            } => {
                assert_eq!((window, until), (66, WaitUntil::Appears));
                assert_eq!(reference.as_deref(), Some("w.0.1"));
                assert_eq!(value.as_deref(), Some("完成"));
                assert_eq!(role.as_deref(), Some("slider"));
                assert_eq!(name_contains.as_deref(), Some("音量"));
                assert_eq!(root.as_deref(), Some("w.0"));
                assert_eq!(name.as_deref(), Some("另存为"));
                assert_eq!((poll_ms, timeout_ms), (150, 5000));
                assert_eq!(bounds(b), (400, 12, 800));
            }
            other => panic!("{other:?}"),
        }
        match sample_request("capture_image").op {
            Op::CaptureImage { window, region, expect_generation, max_edge, max_bytes, time_budget_ms } => {
                assert_eq!(window, 66);
                assert_eq!(region, Some(ScreenRect { x: -10, y: 20, width: 300, height: 200 }));
                assert_eq!(expect_generation.as_deref(), Some("80,80,520,460@96#1"));
                assert_eq!((max_edge, max_bytes, time_budget_ms), (1568, 3_000_000, 800));
            }
            other => panic!("{other:?}"),
        }
    }

    fn tree_body(nodes: Vec<Node>) -> Tree {
        Tree {
            window: 66,
            captured_at: 1_757_744_400_100,
            scope: Some("w.0".to_owned()),
            window_enabled: true,
            window_covered: false,
            completeness: Completeness {
                complete: false,
                truncated_by: vec!["max_nodes"],
                filtered_by: vec!["root".to_owned()],
                visited: 400,
            },
            node_count: 2,
            nodes,
        }
    }

    /// 填写了全部可选字段的控件。结构体字面量要求列全字段：`Node` 新增字段时此处先编译
    /// 失败，样例随之补充，宿主与服务端两侧的样例测试再各自核对是否已处理该字段。
    fn full_node() -> Node {
        Node {
            reference: "w.0.1#42.7".to_owned(),
            parent_ref: Some("w.0".to_owned()),
            depth: 1,
            role: Role::Slider.as_str().to_owned(),
            name: "音量".to_owned(),
            automation_id: "volume".to_owned(),
            value: Some("30".to_owned()),
            enabled: true,
            offscreen: false,
            focused: true,
            rect: Some(ScreenRect { x: -120, y: 40, width: 200, height: 24 }),
            actions: vec![
                NodeAction::ready("set_range_value"),
                NodeAction::blocked("scroll", "not_scrollable"),
            ],
            range: Some(RangeState {
                value: 30.0,
                min: 0.0,
                max: 100.0,
                small_change: Some(1.0),
                large_change: Some(10.0),
            }),
            toggle: Some("on"),
            expand: Some("collapsed"),
            selected: Some(true),
            selection: Some(SelectionState {
                multiple: false,
                required: true,
                selected: vec!["低".to_owned()],
                truncated: true,
            }),
            scroll: Some(ScrollState { horizontal: Some(0.0), vertical: Some(55.5) }),
            text: true,
            weak_identity: true,
        }
    }

    fn bare_node() -> Node {
        Node {
            reference: "w.0".to_owned(),
            parent_ref: None,
            depth: 0,
            role: Role::Window.as_str().to_owned(),
            name: "未命名 - 记事本".to_owned(),
            automation_id: String::new(),
            value: None,
            enabled: true,
            offscreen: false,
            focused: false,
            rect: None,
            actions: Vec::new(),
            range: None,
            toggle: None,
            expand: None,
            selected: None,
            selection: None,
            scroll: None,
            text: false,
            weak_identity: false,
        }
    }

    fn window(window: i64, pid: u32, title: &str, class_name: &str) -> WindowInfo {
        WindowInfo {
            window,
            pid,
            title: title.to_owned(),
            class_name: class_name.to_owned(),
        }
    }

    /// worker 发出的每一种回执逐字等于样例。顶层字段与观察字段都在此处固定：
    /// worker 新增字段而样例没有时，宿主一侧无法验证该字段是否被转发。
    #[test]
    fn responses_serialize_to_the_shared_samples() {
        let all = samples();
        let expected = &all["workerResponses"];
        let cases: Vec<(&str, Response)> = vec![
            (
                "windows",
                Response::observed(
                    "w1".to_owned(),
                    Observation::Windows {
                        captured_at: 1_757_744_400_100,
                        windows: vec![
                            window(66, 900, "未命名", "Notepad"),
                            window(99, 901, "身份查不到", "Other"),
                        ],
                    },
                ),
            ),
            (
                "tree",
                Response::observed(
                    "w1".to_owned(),
                    Observation::Tree(tree_body(vec![bare_node(), full_node()])),
                ),
            ),
            (
                "wait",
                Response::observed(
                    "w1".to_owned(),
                    Observation::Wait(Wait {
                        found: false,
                        reason: Some("timeout".to_owned()),
                        tree: Tree {
                            window: 66,
                            captured_at: 1_757_744_400_100,
                            scope: Some("w.0".to_owned()),
                            window_enabled: false,
                            window_covered: true,
                            completeness: Completeness {
                                complete: true,
                                truncated_by: Vec::new(),
                                filtered_by: Vec::new(),
                                visited: 1,
                            },
                            node_count: 0,
                            nodes: Vec::new(),
                        },
                    }),
                ),
            ),
            (
                "text",
                Response::observed(
                    "w1".to_owned(),
                    Observation::Text(Text {
                        window: 66,
                        captured_at: 1_757_744_400_100,
                        scope: "w.0.3".to_owned(),
                        text: "第一行".to_owned(),
                        truncated: true,
                        selection_support: "single",
                        selection: vec![TextSelection {
                            start: 0,
                            text: "第".to_owned(),
                            truncated: false,
                        }],
                    }),
                ),
            ),
            (
                "image",
                Response::observed(
                    "w1".to_owned(),
                    Observation::Image(Image {
                        window: 66,
                        captured_at: 1_757_744_400_100,
                        source: "wgc",
                        geometry: Geometry {
                            image_width: 506,
                            image_height: 453,
                            screen: ScreenRect { x: 87, y: 80, width: 506, height: 453 },
                            dpi: 96,
                            generation: "80,80,520,460@96#1".to_owned(),
                        },
                        mime: "image/png",
                        bytes: "iVBORw0KGgo=".to_owned(),
                    }),
                ),
            ),
            (
                "act_blocked",
                Response {
                    id: "w1".to_owned(),
                    dispatch: Dispatch::Unknown,
                    reason: Some("call_pending".to_owned()),
                    observation: None,
                    observation_error: Some("target_blocked".to_owned()),
                    blocking: Some(vec![
                        BlockingWindow { info: window(88, 900, "另存为", "#32770"), appeared: true },
                        BlockingWindow { info: window(99, 901, "身份查不到", "Other"), appeared: false },
                    ]),
                    after_reply: None,
                },
            ),
            ("rejected", Response::rejected("w1".to_owned(), "stale_epoch".to_owned())),
        ];
        assert_eq!(cases.len(), expected.as_object().expect("样例").len());
        for (key, response) in cases {
            assert_eq!(serde_json::to_value(&response).expect("可序列化"), expected[key], "{key}");
        }
    }

    /// 样例中出现的每一个 `role`（请求的角色条件与控件表的角色）都是词表中的名称。
    /// 写法不同的角色在 worker 一侧逐字比较，不会命中任何控件。
    #[test]
    fn every_role_in_the_shared_samples_is_in_the_vocabulary() {
        fn roles(value: &serde_json::Value, out: &mut Vec<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, item) in map {
                        match (key.as_str(), item) {
                            ("role", serde_json::Value::String(role)) => out.push(role.clone()),
                            _ => roles(item, out),
                        }
                    }
                }
                serde_json::Value::Array(items) => items.iter().for_each(|i| roles(i, out)),
                _ => {}
            }
        }
        let mut found = Vec::new();
        roles(&samples(), &mut found);
        assert!(found.len() >= 4, "样例中应当有请求与控件表两处角色：{found:?}");
        for role in found {
            assert!(
                Role::ALL.iter().any(|known| known.as_str() == role),
                "{role} 不在角色词表中"
            );
        }
    }

    /// 样例中等待 `appears` 的角色与文字命中样例控件表中的控件：两处使用同一套词。
    #[test]
    fn the_sample_appears_condition_matches_a_sample_node() {
        let Op::Wait { role, name_contains, .. } = sample_request("wait").op else {
            panic!("wait 样例应当解析为等待");
        };
        let nodes = [bare_node(), full_node()];
        let hits = nodes
            .iter()
            .filter(|n| {
                crate::tree::matches_target(role.as_deref(), name_contains.as_deref(), n)
            })
            .count();
        assert_eq!(hits, 1);
    }
}
