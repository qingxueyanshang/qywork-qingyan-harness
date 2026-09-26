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
/// worker 不自行生成也不沿用旧值：换一个 worker 进程，旧的观察、ref 与排队请求全部作废。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub host_id: String,
    pub host_epoch: u64,
}

/// 握手之后 worker 认的那一份绑定：执行实例身份 + 当前连接代际。
///
/// 两者生命周期不同，不能合成一个结构：身份在 worker 进程内固定不变，连接代际随宿主 WS
/// 重连增大。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub host: HostIdentity,
    pub connection_epoch: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// requestId。解析失败的请求也要带着它回执，否则调用方的 pending 没有终态。
    pub id: String,
    /// Unix 纪元毫秒的绝对时刻；缺省表示不设截止。
    ///
    /// 必须是绝对时刻而不是相对毫秒：请求在队列里等待的时间要计入预算，否则排在一次长
    /// 调用后面的请求会拿着已经用完的预算被派发。
    #[serde(default)]
    pub deadline: Option<i64>,
    /// 执行实例身份，每条请求都要带。缺字段的请求解析失败，按 `bad_request` 回执。
    pub host_id: String,
    pub host_epoch: u64,
    /// 宿主 WS 的连接代际，每条请求都要带。
    ///
    /// 服务端在重连时丢弃旧 pending，但 worker 的执行队列里还压着旧连接的动作请求；没有
    /// 这个字段，那些动作会照常派发而没有任何人能收回执。
    pub connection_epoch: u64,
    /// 用户有没有启用前台接管。
    ///
    /// 前台原始输入与窗口操作只在它为真时派发，worker 不自行升级；缺席按假算，
    /// 少一个字段的请求因此只拿得到后台语义动作。
    #[serde(default)]
    pub foreground: bool,
    #[serde(flatten)]
    pub op: Op,
}

/// 一次读取的三个上限。语义固定：`max_nodes` 与 `max_depth` 限遍历，`time_budget_ms`
/// 限这次遍历自身的用时，三者任一触顶都记进 `truncated_by`。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub max_nodes: u32,
    pub max_depth: u32,
    pub time_budget_ms: u64,
}

/// 观察的范围与字段选择。全部缺省时读整窗、取全部字段。
///
/// 没有按角色或文字筛选的字段：读树交回本次范围内的全部节点，筛选只作用于交给模型的
/// 视图。在这里筛会让筛出来的几个节点成为当前观察，其余控件的引用随之失效。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Select {
    /// 子树根的 `ref`。缺席表示从窗口元素开始读。
    #[serde(default)]
    pub root: Option<String>,
    /// 取不取控件当前值。为假时 `value` 一律缺席，可用动作仍照常判定。
    #[serde(default = "yes")]
    pub include_value: bool,
    /// 取不取控件模式的状态细节：数值区间、复选现态、展开现态、选中状态、容器约束、
    /// 滚动位置。
    ///
    /// 为假时这几格一律缺席，**可用动作表不受影响**——动作按模式有没有判，那几个布尔
    /// 属性一直取。读大窗口时省下这十五个属性的取数成本。
    #[serde(default = "yes")]
    pub include_state: bool,
}

const fn yes() -> bool {
    true
}

/// 不要换成 `#[derive(Default)]`：`bool` 的派生默认值是 `false`，`include_value` 会跟着
/// 变成假，动作后的重读与等待就再也读不到控件值。
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
    /// 范围与字段选择，逐条写进 `completeness.filtered_by`。
    ///
    /// 调用方据此区分「这个控件不存在」与「这个控件不在本次读取范围里」，两者不能混。
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

/// 两轮判定之间至少空出上一轮读取耗时的几倍。
///
/// 判定要读一次控件树，大窗口一次就是几百毫秒；按固定间隔轮询等于让目标应用的 UI 线程
/// 在整个等待期间一直被 UIA 占着。空出 4 倍之后，等待自身在目标进程上的占空比上界是
/// `1 / (1 + 4) = 20%`。
const POLL_DUTY_FACTOR: u32 = 4;

/// 下一轮判定之前睡多久。
///
/// 三条一起夹：不低于调用方给的下限、不低于上一轮读取耗时的 `POLL_DUTY_FACTOR` 倍、
/// 不超过截止时刻还剩的时间。最后一条最优先——睡过头就错过了自己的期限。
pub fn next_poll(floor: Duration, last_probe: Duration, left: Duration) -> Duration {
    let paced = last_probe.saturating_mul(POLL_DUTY_FACTOR);
    floor.max(paced).min(left)
}

/// 等待的后置条件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitUntil {
    /// 目标控件变成可用。
    Enabled,
    /// 目标控件的值变成给定的那一个。
    Value,
    /// 目标控件从树上消失。
    Gone,
    /// 窗口里出现一个满足筛选条件的控件。
    Appears,
    /// 出现一个标题包含给定文字的顶层窗口，且不是目标窗口自己。
    Window,
}

/// 复选状态。三态控件的中间态是一个可以主动写入的目标态，不是「切一次」的副产物。
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

/// TogglePattern 只有 `Toggle()`，它按固定环转一格。要到达一个目标态只能按现态算要转几格。
///
/// 环的长度由控件自己决定：二态控件在 Off 与 On 之间转，三态控件多一个 Indeterminate。
/// **环长判错就会停在别的状态上**，所以它由调用方按控件实际支持的状态数给出。
/// 环上没有的状态返回 `None`：二态控件到不了中间态，调用方据此拒绝而不是转到别处去。
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

/// 一次滚动的步长。ScrollPattern 只认「一行」与「一页」，没有像素量。
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

/// 组合键里的修饰键。按下顺序即这里给的顺序，释放按逆序。
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
    /// 这个修饰键的键名。按下状态账按键名记，平台键码由派发端换算。
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

/// 主键名词表，全小写。修饰键不在其中：它们只经 `Modifier` 给出，不能当主键按。
///
/// 各平台后端与宿主补发都把这些名字换算成本平台的键码，换算表必须覆盖整张词表。
pub fn key_names() -> impl Iterator<Item = String> {
    let letters = (b'a'..=b'z').map(|c| char::from(c).to_string());
    let digits = (b'0'..=b'9').map(|c| char::from(c).to_string());
    let functions = (1..=24).map(|n| format!("f{n}"));
    letters
        .chain(digits)
        .chain(functions)
        .chain(NAMED_KEYS.iter().map(|name| (*name).to_owned()))
}

/// 把调用方给的主键名规范成词表里的写法。不分大小写；词表外的名字返回 `None`，不猜。
pub fn key_name(raw: &str) -> Option<String> {
    let name = raw.to_ascii_lowercase();
    key_names().any(|known| known == name).then_some(name)
}

/// 一组控件角色：变体、协议里的名字。只在这里列一次，变体与名字不会分叉。
macro_rules! roles {
    ($($role:ident => $name:literal,)+) => {
        /// 控件角色词表。节点的 `role` 与等待 `appears` 的角色条件都用这里的名字。
        ///
        /// 各平台后端把自己的控件类型换算进这张表；平台类型在表里没有对应时，后端交回
        /// 它自己的原始类型名（Windows 是 `control_<ControlType>`），它不在词表里。
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
/// 两种给法都不带图像坐标：图像坐标在服务端换算成屏幕坐标，worker 只认屏幕像素与
/// 控件引用。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DragTarget {
    /// 落在另一个控件的包围盒中心。派发前重新定位它，读那一刻的包围盒。
    Ref {
        #[serde(rename = "ref")]
        reference: String,
    },
    /// 相对起点的屏幕像素偏移。滑块与拖动排序用它。
    Offset { dx: i32, dy: i32 },
}

/// 一次动作要执行什么。
///
/// 每一种都带齐自己的参数：动作与参数分两处给的话，`set_value` 少了值也能翻译成一条
/// 合法请求，缺的那一项要到 provider 调用那一刻才暴露。
///
/// **后台语义动作与前台原始输入在同一个枚举里**，按 `foreground_only` 分开准入：
/// 分成两个枚举的话，定位、准入、可放弃等待与动作后重读会各有一份拷贝。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActionSpec {
    /// InvokePattern。按钮与菜单项的默认动作。
    Invoke,
    /// ValuePattern。空串是清空，与缺席不是一回事。
    SetValue { value: String },
    /// RangeValuePattern。越界与只读一律拒绝，不夹到边界上。
    SetRangeValue { value: f64 },
    /// SelectionItemPattern。单选：把选择换成这一项。
    Select,
    /// SelectionItemPattern。增选：容器不支持多选时拒绝。
    AddToSelection,
    /// SelectionItemPattern。取消选中这一项。
    RemoveFromSelection,
    /// TogglePattern。按目标态表达，不是「切一次」。
    SetToggle { state: ToggleState },
    /// ExpandCollapsePattern。
    Expand,
    /// ExpandCollapsePattern。
    Collapse,
    /// ScrollPattern。一次一步，步长由 `step` 给。
    Scroll {
        direction: ScrollDirection,
        step: ScrollStep,
    },
    /// ScrollItemPattern。把这个控件滚进可见区。
    ScrollIntoView,
    /// ItemContainerPattern + VirtualizedItemPattern。
    ///
    /// 目标是**容器**：按名称在容器里找一项（未实例化的项也找得到），找到就实例化它。
    /// 虚拟化列表里没实例化的项不在控件树上，拿不到 `ref`，只能这样进得去。
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
    /// 文字按 UTF-16 码元投成字符消息，不产生键盘事件。代理对的两个码元相邻投出。
    TypeText { text: String },
    /// SendInput 的物理按键。修饰键按给出的顺序按下，逆序释放。
    PressKey {
        key: String,
        #[serde(default)]
        modifiers: Vec<Modifier>,
    },
    /// Win32 的前台窗口接口。受系统前台锁限制，拒绝即如实回执。
    Activate,
    /// WindowPattern 的可视状态。按目标态表达，不是「切一次」。
    SetWindowState { state: WindowState },
    /// TransformPattern 的移动。屏幕物理像素。
    MoveWindow { x: i32, y: i32 },
    /// TransformPattern 的缩放。屏幕物理像素。
    ResizeWindow { width: i32, height: i32 },
    /// WindowPattern 的关闭。发的是关闭请求，不是强杀进程。
    CloseWindow,
}

impl ActionSpec {
    /// 这个动作只能由前台原始输入或前台窗口接口交付。
    ///
    /// 判据是它会不会改变系统前台窗口、真实指针或键盘焦点：会的一律归前台，
    /// 由用户显式开启的前台模式裁决。**不按「用的是不是 SendInput」分**——
    /// 窗口状态与激活走的是 Win32 与 UIA 接口，一样会把前台从用户手上拿走。
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

    /// 这个动作用真实指针或键盘投递，因此要求目标窗口此刻在系统前台。
    ///
    /// 窗口动作（激活、状态、移动、缩放、关闭）不在内：它们经 Win32 与 UIA 接口发出，
    /// 目标窗口在不在前台都执行得了。
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

    /// 这个动作的落点可以由调用方直接给屏幕坐标。只有指针动作可以。
    pub const fn takes_point(&self) -> bool {
        matches!(
            self,
            Self::Click { .. } | Self::Hover | Self::Drag { .. } | Self::Wheel { .. }
        )
    }

    /// 这个动作可以不给目标，直接投给窗口。只有键盘输入可以。
    ///
    /// 键盘输入去的是系统焦点所在，而不是某个被点名的控件；前台窗口就是目标窗口时，
    /// 焦点必然落在这个窗口里。自绘界面不暴露业务控件，给不出一个持有焦点的控件，
    /// 少了这一条它们整条键盘路径不可用。
    pub const fn targets_window(&self) -> bool {
        matches!(self, Self::TypeText { .. } | Self::PressKey { .. })
    }
}

/// 前台模式没开时的拒绝原因。工具层与 worker 用同一个码。
pub const FOREGROUND_DISABLED: &str =
    "foreground_disabled: 前台操作未启用";

/// 目标已经不在树上时的拒绝原因前缀。等待的「控件消失」条件按它判定。
pub const REF_STALE: &str = "ref_stale";

/// 动作调用尚未返回，没有重读目标窗口。调用方按它决定下一步观察哪个窗口。
pub const TARGET_BLOCKED: &str = "target_blocked";

/// 没有派发就不重读：那一份观察会被调用方读成动作已经发生。
pub const NOT_DISPATCHED: &str = "动作没有派发，没有重读";

/// 请求动作。`params` 一律显式给出，空参数写 `{}`。
#[derive(Debug, Deserialize)]
#[serde(tag = "op", content = "params", rename_all = "snake_case")]
pub enum Op {
    /// 建立执行实例绑定并设定 UIA 调用上界。
    ///
    /// 同一身份的重复握手会重设超时并清空取消登记；换了 `hostId`/`hostEpoch` 一律拒绝，
    /// 一个 worker 进程只对应一个执行实例，换代际靠换进程。
    #[serde(rename_all = "camelCase")]
    Handshake {
        connection_timeout_ms: u32,
        transaction_timeout_ms: u32,
    },
    /// 把当前连接代际改成本请求信封里的 `connectionEpoch`，只许增大。
    ///
    /// 必须在接收线程上就地处理：排进执行队列就会跟在旧连接的请求后面，那些请求正是它要
    /// 拦下的。
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
    /// 在控件上执行一个动作，之后按 `root` 给的范围整份重读。
    ///
    /// 所有改变状态的动作走这一条：定位、准入、可放弃等待与重读只有一处实现，
    /// 按动作分成多个 op 会让这四件事各有一份拷贝。
    ///
    /// 目标两种给法，互斥：`ref` 指一个控件，派发前重新定位并读那一刻的包围盒；
    /// `point` 直接给屏幕物理像素落点，那时必须同时给 `expectGeneration`，
    /// 窗口在采图与派发之间移动过即拒绝。
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
    /// 读一个控件的文档文本与选区。只读，不改变状态。
    #[serde(rename_all = "camelCase")]
    ReadText {
        window: i64,
        #[serde(rename = "ref")]
        reference: String,
        /// 交回多少个 UTF-16 码元。超出即截断并标记。
        max_chars: u32,
    },
    /// 采一张目标窗口的图。
    ///
    /// 这是唯一会采集图像的 op：读树、动作与等待都走不到采集代码。
    #[serde(rename_all = "camelCase")]
    CaptureImage {
        window: i64,
        /// 要采的屏幕物理像素矩形。缺席表示整窗。
        #[serde(default)]
        region: Option<ScreenRect>,
        /// 要求窗口几何代际仍是这一个。对不上即拒绝派发，不采一张对不上号的图。
        #[serde(default)]
        expect_generation: Option<String>,
        /// 交给模型的图像长边上限。worker 不自带默认值，上限由调用方给。
        max_edge: u32,
        /// 编码之后的字节上限。超过即拒绝，不把一帧塞进宿主连接。
        max_bytes: u32,
        /// 采集时等待的上限：等一帧到达，或等窗口被盖住的部分重绘完。
        time_budget_ms: u64,
    },
    /// 等一个后置条件成立。判定在 worker 这一侧做，到期如实回未满足与返回那一刻的状态。
    #[serde(rename_all = "camelCase")]
    Wait {
        window: i64,
        until: WaitUntil,
        #[serde(default, rename = "ref")]
        reference: Option<String>,
        /// `until=value` 要等到的值。
        #[serde(default)]
        value: Option<String>,
        /// `until=appears` 要出现的控件角色。
        #[serde(default)]
        role: Option<String>,
        /// `until=appears` 要出现的控件文字：名称、稳定标识或值包含它，不分大小写。
        #[serde(default)]
        name_contains: Option<String>,
        /// 等待结束时重读的范围，取调用方当前观察的范围根。缺席表示整窗。
        #[serde(default)]
        root: Option<String>,
        /// `until=window` 要等的标题子串。
        #[serde(default)]
        name: Option<String>,
        /// 两次判定之间至少隔多久。
        poll_ms: u64,
        /// 从收到这条请求算起最多等多久。信封的 deadline 是硬上界，两者取先到的那个。
        timeout_ms: u64,
        #[serde(flatten)]
        bounds: Bounds,
    },
}

/// 执行事实。只描述「这次请求要求的状态改变动作」有没有交到 OS 手里。
///
/// 只读请求与握手不改变状态，一律记 `not_dispatched`：成功时带 `observation`，失败时带
/// `reason`。这样 `submitted` 只有一个含义，不会被读取成功的回执稀释。
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
    /// 表示调用已经发出而失败，不是没有执行。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<Observation>,
    /// 动作已派发但随后的重读失败时填这里，`dispatch` 保持原值。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_error: Option<String>,
    /// 动作调用尚未返回时目标进程此刻的顶层窗口，纯 Win32 读出。
    ///
    /// 只在 `observation_error` 是 `target_blocked` 那一支出现：那时重读目标窗口必然
    /// 等到超时，这一格替它说清「下一步该看哪个窗口」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking: Option<Vec<BlockingWindow>>,
    /// 回执发出之后还要清一次这个窗口所属 provider 的连接。**不上线**，只把这件事
    /// 从动作路径带回执行循环。见 `Backend::drain_provider`。
    #[serde(skip)]
    pub after_reply: Option<i64>,
}

impl Response {
    /// 没有派发动作的终态：拒绝、参数无效、目标失效、只读请求失败。
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

/// 动作调用尚未返回时交回的一个顶层窗口。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockingWindow {
    #[serde(flatten)]
    pub info: WindowInfo,
    /// 动作调用之前这个窗口不存在。模态对话框就是这样冒出来的。
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
        /// 后端实际采用的上界：UIA 从接口读回，AX 与 AT-SPI 没有读回接口，交回设定的值。
        connection_timeout_ms: u32,
        transaction_timeout_ms: u32,
        /// 握手这一刻操作系统给了哪些前提。之后的变化由 `AccessNotice` 通报。
        access: Access,
    },
    /// 取消已登记。它不说明目标请求有没有执行过——接收线程查不到那件事，目标请求自己那条
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
    /// 这一帧是怎么采到的。退路与主路径要分得开：`print_window` 依赖目标应用自己
    /// 响应 `WM_PRINT`，画不全的部分在图上是黑的。
    pub source: &'static str,
    pub geometry: Geometry,
    /// 图像的媒体类型。
    pub mime: &'static str,
    /// base64 编码的图像字节。
    pub bytes: String,
}

/// 标准 base64。图像字节要经行分隔 JSON 交给宿主，不能按原始字节走。
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

/// 一次控件读取的全部内容。`Tree` 与 `Wait` 两种观察共用它。
///
/// 控件表是展平的前序序列，层级由 `parent_ref` 与 `depth` 表达。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub window: i64,
    pub captured_at: i64,
    /// 本次读取覆盖的范围：子树根的 `ref`。缺席表示整窗。
    ///
    /// **调用方按它决定作废哪一段引用。** 缺席时整份旧观察作废，给出 ref 时只有那一段
    /// 子树作废，无关区域的旧引用仍然成立。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// 目标窗口此刻可不可用。模态窗口挡住它时为假。
    pub window_enabled: bool,
    /// 目标窗口此刻在屏幕上一点都看不见：最小化，或被 z 序在它上面的窗口完全盖住。
    ///
    /// 浏览器对载入之后还没在屏幕上显示过的页面不向 UIA 交出网页内容，控件表这时只有外框、
    /// 也没有撞上限，这一格是调用方能看到的唯一迹象。
    pub window_covered: bool,
    pub completeness: Completeness,
    pub node_count: u32,
    pub nodes: Vec<Node>,
}

/// 一次等待的结果：有没有等到，加上返回那一刻读到的状态。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wait {
    pub found: bool,
    /// 没等到时的原因：`timeout` 或 `cancelled`。等到时缺席。
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
/// 截断与范围是两件事，分两格记：`truncated_by` 说的是上限截断了遍历，`filtered_by`
/// 说的是读取范围与字段选择。调用方不能把「没采到」读成「没有」，也不能把「不在读取
/// 范围里」读成「不存在」。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completeness {
    pub complete: bool,
    pub truncated_by: Vec<&'static str>,
    pub filtered_by: Vec<String>,
    /// 遍历过的节点数。三个上限限的是它，不是返回的条数。
    pub visited: u32,
}

/// 经控件模式发出，不置前台、不动指针、不设焦点。
pub const DELIVERY_BACKGROUND: &str = "background";
/// 经原始输入或前台窗口接口发出，会把前台从用户手上拿走。只在用户启用前台模式时出现。
pub const DELIVERY_FOREGROUND: &str = "foreground";

/// 控件上的一个动作，连同它此刻能不能执行。
///
/// `delivery` 为空表示此刻执行不了，原因在 `unavailable`。模式缺失的动作不列：
/// 每个控件列出全部二十几个动作会把「这里能做什么」盖住。前台模式关着时，
/// 前台动作同样一条都不列。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeAction {
    pub action: &'static str,
    pub delivery: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<&'static str>,
}

impl NodeAction {
    /// 这个动作此刻能后台执行。
    pub fn ready(action: &'static str) -> Self {
        Self {
            action,
            delivery: vec![DELIVERY_BACKGROUND],
            unavailable: None,
        }
    }

    /// 这个动作此刻能前台执行。
    pub fn foreground(action: &'static str) -> Self {
        Self {
            action,
            delivery: vec![DELIVERY_FOREGROUND],
            unavailable: None,
        }
    }

    /// 控件暴露了这个模式，但此刻用不了。原因是控件自己的属性，不是猜的。
    pub fn blocked(action: &'static str, reason: &'static str) -> Self {
        Self {
            action,
            delivery: Vec::new(),
            unavailable: Some(reason),
        }
    }
}

/// RangeValuePattern 读到的数值区间。动作前的越界判定按它做。
///
/// **非有限数一律不发**：provider 对没有步长的控件交回 NaN，照发会在 JSON 里变成
/// `null`，而字段声明的是数字。三项主值任一非有限时整个区间缺席，见 `range_state`。
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

/// 把读到的五个数收成一份区间。值、下界、上界任一非有限即整份缺席。
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

/// SelectionPattern 读到的容器约束与当前选中项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionState {
    /// 容器允许同时选中多项。
    pub multiple: bool,
    /// 容器要求始终有一项被选中。
    pub required: bool,
    /// 当前选中项的名称。一项都没选中时为空。
    ///
    /// 收起的组合框在控件表里没有子节点，它的选中项只在这里读得到。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub selected: Vec<String>,
    /// `selected` 不是全部。
    #[serde(skip_serializing_if = "not_set")]
    pub truncated: bool,
}

/// ScrollPattern 读到的滚动位置，百分比。
///
/// 某个轴不能滚动时那一格缺席。**缺席不等于 0**：0 是「在顶端」。
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
    /// 读的是哪个控件。
    pub scope: String,
    pub text: String,
    /// `text` 被 `maxChars` 截断了。后面还有内容，不是文档到此为止。
    pub truncated: bool,
    /// 这个控件支持哪种选区：`none` / `single` / `multiple`。
    pub selection_support: &'static str,
    pub selection: Vec<TextSelection>,
}

/// 一段选区。`start` 是它在文档里的起点，按 UTF-16 码元计。
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
    /// 是此刻可见的文字。字段选择不取值时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub enabled: bool,
    pub offscreen: bool,
    /// 这个控件此刻持有键盘焦点。前台模式关着时一律为假——那时这一项不在缓存请求里。
    ///
    /// 文字与按键去的是焦点所在的地方，所以键盘动作只列在这个控件上。
    #[serde(skip_serializing_if = "not_set")]
    pub focused: bool,
    /// 控件的包围盒，屏幕物理像素，与图像几何同一套坐标。
    ///
    /// provider 不给包围盒的控件缺席（零尺寸同样按缺席算）。**缺席不等于控件不存在**，
    /// 也不等于它在屏幕外——那一件事由 `offscreen` 说。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<ScreenRect>,
    /// 只列 worker 已实现的动作。控件暴露了模式但 worker 没有对应实现时不列，
    /// 否则调用方会按这张表发出永远拿不到实现的请求。
    pub actions: Vec<NodeAction>,
    /// RangeValuePattern 的数值区间。没有这个模式时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<RangeState>,
    /// TogglePattern 的现态。没有这个模式时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle: Option<&'static str>,
    /// ExpandCollapsePattern 的现态：`collapsed` / `expanded` / `partial` / `leaf`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expand: Option<&'static str>,
    /// SelectionItemPattern 的现态。没有这个模式时缺席。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    /// SelectionPattern 读到的容器约束与当前选中项。只有选择容器有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionState>,
    /// ScrollPattern 的滚动位置。滚动后重读按它核对。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<ScrollState>,
    /// 这个控件有 TextPattern，可以读文档文本与选区。
    #[serde(skip_serializing_if = "not_set")]
    pub text: bool,
    /// 这个控件没有 RuntimeId，身份只能按角色、名称与稳定标识核对。
    ///
    /// 三项都不变而控件被换掉时核不出来，界面重排之后这个引用不可靠。为真时调用方应当
    /// 重新观察而不是复用旧引用。
    #[serde(skip_serializing_if = "not_set")]
    pub weak_identity: bool,
}

fn not_set(flag: &bool) -> bool {
    !*flag
}

/// 动作已经生效的可核实证据。每一项都由 Win32 读出，读它们不进 UIA，
/// 因此不会被目标进程的嵌套消息循环挡住。
///
/// **每种动作只认属于它的那几项。** 前三项是后台模式调用的证据；激活会主动改前台，
/// 那时「同进程出现新顶层窗口」证明不了这次激活做过什么，窗口动作因此各用各的读回值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionEvidence {
    /// 目标窗口被禁用。Win32 的模态对话框正是这样挡住属主窗口的。
    WindowDisabled,
    /// 目标窗口已经销毁。
    WindowGone,
    /// 目标进程里多出一个此前没有的顶层窗口。
    NewWindow,
    /// 目标窗口已经处于请求的显示状态。
    WindowState,
    /// 目标窗口矩形已经是请求的位置或尺寸。
    WindowRect,
}

impl ActionEvidence {
    fn as_str(self) -> &'static str {
        match self {
            Self::WindowDisabled => "目标窗口已被禁用",
            Self::WindowGone => "目标窗口已关闭",
            Self::NewWindow => "目标进程出现了新的顶层窗口",
            Self::WindowState => "目标窗口已经是请求的显示状态",
            Self::WindowRect => "目标窗口矩形已经是请求的值",
        }
    }
}

/// 一次动作调用的终态。`None` = 还判不出来，接着等。
///
/// `InvokePattern.Invoke()` 点开模态对话框时，provider 那一侧要等对话框关掉才返回，
/// 客户端这次调用因此挂到 UIA 连接超时。**不能据此记未执行**：动作已经生效了。
/// 所以调用放到一条可以放弃等待的线程上，主路径改判可核实的事实——
/// 目标窗口被禁用、已关闭，或者同进程多出一个顶层窗口——三者任一成立即 `submitted`。
/// 没有证据而调用仍未返回才是 `unknown`。
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

/// worker 此刻按住不放的鼠标键与键。
///
/// **它只描述输入状态，不是任务状态。** 随按随记、释放即清，宿主按它在确认 worker
/// 退出之后补发释放。空账表示这个 worker 手上没有按住任何键。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldInput {
    /// 按住的鼠标键名。
    pub buttons: Vec<&'static str>,
    /// 按住的键，按下顺序。主键是 `key_names` 里的名字，修饰键是 `Modifier::key_name`。
    ///
    /// 记键名不记平台键码：worker 派发与宿主补发各自按本平台的换算表把它换成键码。
    pub keys: Vec<String>,
}

/// 输入状态通报。与回执共用 stdout，靠 `input` 这一格与回执区分——回执一定带
/// `id` 与 `dispatch`，通报一定不带。
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

/// 桌面控制要操作系统给、而此刻可能没给的一项前提。每一项只有一个平台的后端会报。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Grant {
    /// macOS 的辅助功能授权。读树、动作与键鼠投递都归它。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Accessibility,
    /// macOS 的屏幕录制授权。只管取图。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    ScreenRecording,
    /// Linux 的会话总线上找得到无障碍总线（`org.a11y.Bus`）。
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    AccessibilityBus,
}

impl Grant {
    /// 缺了这一项，读取与动作是否一律不可用。
    const fn gates(self) -> bool {
        !matches!(self, Self::ScreenRecording)
    }
}

/// 操作系统此刻给了哪些前提。握手回执与之后的变化通报都是这个形状。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// 读取与动作可用：`missing` 里没有缺了就一律不可用的那种前提。
    pub authorized: bool,
    /// 没给的前提，顺序由后端固定。界面据此指明去哪里开。`authorized` 为真时也可能不空。
    pub missing: Vec<Grant>,
    /// 没给的原因原文。只写进 stderr：它是 OS 的错误文本，协议只带 `missing`。
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

    /// 两份事实相同。原因原文不算：同一件事的错误文本可能每次都不一样。
    pub fn same(&self, other: &Self) -> bool {
        self.missing == other.missing
    }
}

/// 授权变化通报。与回执、输入通报共用 stdout，靠 `access` 这一格区分。
#[derive(Debug, Serialize)]
pub struct AccessNotice<'a> {
    pub access: &'a Access,
}

/// 一批原始输入发出之后的执行事实。
///
/// `SendInput` 的返回值是真的插进输入队列的事件数，**它可能小于请求数**：
/// 目标进程完整性比本进程高时 UIPI 会把这一批挡掉。三种终态：
/// 一个事件都没进去是可证明的未派发；全部进去是已派发；进去一部分只能是未知——
/// 已经进 OS 的那一部分可能已经生效，记成未执行会让调用方重发一次。
pub fn classify_input(sent: u32, requested: u32) -> (Dispatch, Option<String>) {
    if requested == 0 || sent == 0 {
        return (
            Dispatch::NotDispatched,
            Some(format!(
                "input_blocked: {requested} 个输入事件一个都没有进入系统输入队列，\
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
            "input_partial: {requested} 个输入事件只发出了 {sent} 个，已发出的部分可能已经生效"
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

/// 派发前的唯一准入判定。返回 `Err(reason)` 时调用方一律记 `not_dispatched`。
///
/// 顺序固定：执行实例身份 → 连接代际 → 取消登记 → 截止时刻。身份或代际不符的
/// 请求不进入取消与超时判断，旧绑定的请求因此影响不到当前绑定的登记。
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
                // 重复握手可以重设超时与取消登记，但不能借它把连接代际调回旧值。
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
/// **前台模式关着时前台动作在这里就被拒**：这是派发前的唯一准入判定，
/// 放到执行路径里判就会多出第二处裁决。后台失败不会自动升级成前台，
/// 这个函数不看动作有没有后台替代品。
///
/// 目标三种写法：控件、屏幕落点、两者都不给。第三种只有 `targets_window` 的动作
/// 能用，它的目标是窗口本身。
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
        (true, true) => return Err("target_conflict: ref 与 point 只能给一个"),
        (false, false) if !action.targets_window() => {
            return Err("missing_target: 要给 ref 或 point")
        }
        (false, true) if !action.takes_point() => {
            return Err("point_unsupported: 这个动作只能按控件执行")
        }
        _ => {}
    }
    // 按图定位必须带窗口几何代际：少了它，窗口在采图与派发之间移动过也照点。
    if has_point && !has_generation {
        return Err("missing_generation: 按屏幕坐标操作要带窗口几何代际");
    }
    Ok(())
}

/// 等待判定的输入：调用方给的条件，加上这一轮读到的事实。
///
/// 单列成纯函数，是为了让五种条件的判定在没有图形会话的环境里也能测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen<'a> {
    /// 目标控件还在，带着它此刻的可用状态与值。
    Element { enabled: bool, value: Option<&'a str> },
    /// 目标控件已经不在树上。
    Missing,
    /// 满足筛选条件的控件有多少个。
    Matches(u32),
    /// 有没有出现符合条件的顶层窗口。
    Window(bool),
}

/// 等待条件还能不能成立。
///
/// 等值或等可用时目标控件已经不在：控件身份按 RuntimeId 核，重建出来的是另一个控件，
/// 这个条件不会再成立，继续轮询只会等到超时。其余组合照常轮询。
pub fn attainable(until: WaitUntil, seen: Seen<'_>) -> bool {
    !matches!(
        (until, seen),
        (WaitUntil::Value | WaitUntil::Enabled, Seen::Missing)
    )
}

/// 这一轮读到的事实满不满足等待条件。
pub fn satisfied(until: WaitUntil, want: Option<&str>, seen: Seen<'_>) -> bool {
    match (until, seen) {
        (WaitUntil::Enabled, Seen::Element { enabled, .. }) => enabled,
        // 值缺席表示这个控件没有 ValuePattern，它等不到任何值，不能当成空串命中。
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
            other => panic!("解析成了别的 op：{other:?}"),
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
            other => panic!("解析成了别的 op：{other:?}"),
        }
    }

    /// 筛选与字段选择都缺省时读整窗、取全部字段。
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
            other => panic!("解析成了别的 op：{other:?}"),
        }
    }

    /// 范围与字段选择逐条写进 completeness，调用方据此分得出「没有」与「不在读取范围里」。
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
            other => panic!("解析成了别的 op：{other:?}"),
        }
    }

    /// 动作与等待都带当前观察的范围根，结束时按它整份重读。
    #[test]
    fn act_and_wait_carry_the_observation_scope() {
        let act = parse(
            r#"{"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"act","params":{"window":66,"ref":"w.0.3#9","root":"w.0#7",
                "action":{"kind":"invoke"},"maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}"#,
        );
        match act.op {
            Op::Act { root, .. } => assert_eq!(root.as_deref(), Some("w.0#7")),
            other => panic!("解析成了别的 op：{other:?}"),
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
            other => panic!("解析成了别的 op：{other:?}"),
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
            other => panic!("解析成了别的 op：{other:?}"),
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

    /// 单读一个控件的 op 不存在：动作与等待都自带按范围的重读，没有第二条只读路径。
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

    /// 层级留在展平表上：父 ref 与深度各一格，没有嵌套的子节点数组。
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

    /// 整窗读没有 scope：调用方据此作废整份旧观察。
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

    /// 截断与读取范围分两格：只读了一棵子树不是截断。
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

    /// 调用没返回时不重读目标窗口，换成一份纯 Win32 的顶层窗口清单：
    /// 那一刻目标应用的 UI 线程卡在调用里，任何 UIA 读取都会等到超时。
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
        // 回执发出之后要清一次 provider，这件事只在 worker 内部传，不上线。
        resp.after_reply = Some(66);
        let value = serde_json::to_value(&resp).expect("回执应当序列化成功");
        assert!(value.get("afterReply").is_none());
        assert!(value.get("after_reply").is_none());
        // 身份字段与窗口清单同形：宿主按同一条路径补进程启动时刻与应用名。
        assert_eq!(value["blocking"][0]["window"], 66);
        assert_eq!(value["blocking"][0]["appeared"], false);
        assert_eq!(value["blocking"][1]["title"], "qywork modal dialog");
        assert_eq!(value["blocking"][1]["appeared"], true);
    }

    /// 调用返回了就照常重读，不带这一格。
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

    /// 调用没返回而目标窗口被模态对话框挡住：动作已经生效，必须记 submitted。
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

    /// 没有证据、调用也没返回：期限之前接着等，到期才记 unknown。
    #[test]
    fn a_pending_call_without_evidence_waits_then_becomes_unknown() {
        assert_eq!(classify_action(None, None, false), None);
        let (dispatch, reason) = classify_action(None, None, true).expect("到期即有终态");
        assert_eq!(dispatch, Dispatch::Unknown);
        assert!(reason.is_some_and(|r| r.starts_with("call_pending")));
    }

    /// 调用自己带回来的结果优先于证据：它说得更准。
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

    /// 二态控件按一下就到，三态控件按目标态算要按几下；环上没有的状态返回 None。
    #[test]
    fn toggle_steps_count_the_presses_a_target_state_needs() {
        use ToggleState::{Indeterminate, Off, On};
        assert_eq!(toggle_steps(Off, On, false), Some(1));
        assert_eq!(toggle_steps(On, Off, false), Some(1));
        assert_eq!(toggle_steps(Off, Off, false), Some(0));
        // 三态环按 Off → On → Indeterminate → Off 转。
        assert_eq!(toggle_steps(Off, On, true), Some(1));
        assert_eq!(toggle_steps(Off, Indeterminate, true), Some(2));
        assert_eq!(toggle_steps(Indeterminate, Off, true), Some(1));
        assert_eq!(toggle_steps(On, Indeterminate, true), Some(1));
        // 二态控件到不了中间态：报不支持，不是按两下凑过去。
        assert_eq!(toggle_steps(Off, Indeterminate, false), None);
        assert_eq!(toggle_steps(Indeterminate, Off, false), None);
    }

    /// 每种动作的参数跟着自己的名字走，少一项就解析失败，不会翻译成一条合法请求。
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

    /// 可用动作表要说得出「这个动作此刻能不能用」，只读与叶节点各有自己的原因码。
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
        serde_json::from_str(text).expect("用例里的 JSON 应当合法")
    }

    /// 文本观察自带读的是哪个控件、截断标记与选区起点。
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

    /// 读文本是只读 op：它不带上限三件套，也不进动作那条路径。
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

    /// 控件状态只在对应模式存在时上线，缺席的不发空格子。
    #[test]
    fn pattern_state_fields_are_absent_without_the_pattern() {
        let value = serde_json::to_value(Observation::Tree(tree(None))).unwrap();
        let node = &value["nodes"][0];
        for key in ["range", "toggle", "expand", "selected", "selection", "scroll", "text"] {
            assert!(node.get(key).is_none(), "{key} 不该出现");
        }
    }

    /// 步长读不出有限数时那两格缺席；值或边界非有限时整份区间缺席。
    #[test]
    fn a_range_drops_the_values_the_provider_cannot_give() {
        let full = range_state(20.0, 0.0, 100.0, 1.0, 10.0).expect("有限数应当成一份区间");
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

    /// 选中项名称进 `selected`，一项都没选中时这一格与截断标记都不出现。
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
        assert!(selection.get("selected").is_none(), "没有选中项时不该出现这一格");
        assert!(selection.get("truncated").is_none());
        assert_eq!(selection["multiple"], true);
    }

    /// 滚不动的那个轴缺席。**缺席不是 0**：0 是「在顶端」。
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
        // 同身份重复握手仍然放行：它用来重设超时与清空取消登记。
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
        // 宿主重连：连接代际推进到 6，队列里那条属于代际 5 的动作请求不得再派发。
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

    /// 五种等待条件各自只认自己那一种事实，读错一种不会误判成满足。
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
        // 控件还在就不算消失，控件没了也不算值等到了。
        assert!(!satisfied(WaitUntil::Value, Some(""), Seen::Missing));
        assert!(!satisfied(WaitUntil::Enabled, None, Seen::Missing));
    }

    /// 原始失败形状：等刚点过的链接的值，页面一跳转链接就不在了，此前要轮询到超时。
    #[test]
    fn a_value_or_enabled_wait_on_a_missing_control_cannot_succeed() {
        assert!(!attainable(WaitUntil::Value, Seen::Missing));
        assert!(!attainable(WaitUntil::Enabled, Seen::Missing));
        // 等消失的恰好要它不在；等出现与等窗口不看单个控件。
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

    /// 大窗口上的判定本身要花几百毫秒，间隔得跟着放大，否则等待会把目标应用占满。
    #[test]
    fn the_poll_interval_paces_itself_by_the_cost_of_the_last_probe() {
        let floor = Duration::from_millis(250);
        let plenty = Duration::from_secs(60);
        // 判定很便宜时按调用方给的下限走。
        assert_eq!(next_poll(floor, Duration::from_millis(5), plenty), floor);
        assert_eq!(next_poll(floor, Duration::ZERO, plenty), floor);
        // 判定贵到超过下限时按它放大：230 ms 的一轮之后空出 920 ms，占空比 20%。
        assert_eq!(
            next_poll(floor, Duration::from_millis(230), plenty),
            Duration::from_millis(920)
        );
    }

    /// 截止时刻最优先：睡过头就错过了自己的期限。
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

    /// 弱身份只在为真时上线：绝大多数控件有 RuntimeId，多发一格没有意义。
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

    /// 前台动作与后台动作在同一个枚举里，按 `foreground_only` 分开准入。
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

    /// 只有指针动作接受屏幕落点。别的动作给了坐标也没有落点可言。
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
                "{spec} 不该接受落点"
            );
        }
    }

    /// 只有键盘输入可以不给目标：目标是窗口本身。
    ///
    /// 别的动作不给目标即拒——指针动作没有落点可言，窗口动作没有可调用的模式对象。
    #[test]
    fn only_keyboard_actions_may_omit_the_target() {
        for spec in [
            r#"{"kind":"type_text","text":"你好"}"#,
            r#"{"kind":"press_key","key":"a","modifiers":["ctrl"]}"#,
        ] {
            let action = action_of(act_params(spec));
            assert!(action.targets_window(), "{spec} 应当可以投给窗口");
            assert_eq!(check_act(&action, false, false, false, true), Ok(()));
            // 点名控件时仍然照常放行，判定留给执行路径上的焦点核对。
            assert_eq!(check_act(&action, true, false, false, true), Ok(()));
            // 屏幕落点仍然不接受：键盘输入没有落点可言。
            assert_eq!(
                check_act(&action, false, true, true, true),
                Err("point_unsupported: 这个动作只能按控件执行")
            );
            // 前台模式关着时这两种一样拒，缺目标不构成例外。
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
            assert!(!action.targets_window(), "{spec} 不该可以投给窗口");
            assert_eq!(
                check_act(&action, false, false, false, true),
                Err("missing_target: 要给 ref 或 point"),
                "{spec} 不给目标应当被拒"
            );
        }
    }

    /// 前台动作的参数同样跟着自己的名字走，少一项或写错枚举都解析失败。
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

    /// 前台模式关着时前台动作在准入判定就被拒，一条系统调用都不发。
    #[test]
    fn foreground_actions_are_refused_while_the_mode_is_off() {
        let click = r#"{"kind":"click","button":"left","count":1}"#;
        let off = act_request(click, r#""ref":"w.0#7","#, false);
        assert_eq!(admit(&off, Some(&bound()), false, 0), Err(FOREGROUND_DISABLED));
        let on = act_request(click, r#""ref":"w.0#7","#, true);
        assert_eq!(admit(&on, Some(&bound()), false, 0), Ok(()));
        // 后台动作不受这个开关影响。
        let background = act_request(r#"{"kind":"invoke"}"#, r#""ref":"w.0#7","#, false);
        assert_eq!(admit(&background, Some(&bound()), false, 0), Ok(()));
    }

    /// 身份与代际先判：旧代际的前台请求拿到的是代际不符，不是前台未启用。
    #[test]
    fn identity_is_checked_before_the_foreground_mode() {
        let mut req = act_request(r#"{"kind":"click","button":"left","count":1}"#, r#""ref":"w.0#7","#, false);
        req.connection_epoch = 4;
        assert_eq!(
            admit(&req, Some(&bound()), false, 0),
            Err("connection_epoch_mismatch")
        );
    }

    /// 两种目标给法互斥，且按图定位必须带窗口几何代际。
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
            Err("target_conflict: ref 与 point 只能给一个")
        );
        assert_eq!(
            admit(&act_request(click, "", true), Some(&bound()), false, 0),
            Err("missing_target: 要给 ref 或 point")
        );
        assert_eq!(
            admit(
                &act_request(click, r#""point":{"x":10,"y":20},"#, true),
                Some(&bound()),
                false,
                0
            ),
            Err("missing_generation: 按屏幕坐标操作要带窗口几何代际")
        );
        // 键盘与窗口动作没有落点可言。
        assert_eq!(
            admit(
                &act_request(r#"{"kind":"activate"}"#, point, true),
                Some(&bound()),
                false,
                0
            ),
            Err("point_unsupported: 这个动作只能按控件执行")
        );
    }

    /// 前台开关缺席按关算：少一个字段的请求只拿得到后台动作。
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

    /// 按图定位的动作不给 ref，给屏幕落点与窗口几何代际。
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
            other => panic!("解析成了别的 op：{other:?}"),
        }
    }

    /// 前台动作的可用项与后台动作在同一张表里，靠 delivery 分。
    #[test]
    fn a_foreground_offer_declares_its_own_delivery() {
        let offer = serde_json::to_value(NodeAction::foreground("click")).unwrap();
        assert_eq!(offer, json_of(r#"{"action":"click","delivery":["foreground"]}"#));
    }

    /// 一批输入全进队列才是已派发；发出去一部分只能是未知，一个都没进才是未派发。
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

    /// 窗口动作各认各的证据，与后台那三条不混。
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

    /// 输入状态通报不带 id 与 dispatch，回执一定带：宿主据此分得开这两种行。
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

    /// 缺辅助功能或无障碍总线即不可用；只缺屏幕录制时读取与动作照常可用。
    #[test]
    fn only_the_gating_grants_withhold_authorization() {
        assert!(Access::of(Vec::new(), None).authorized);
        assert!(!Access::of(vec![Grant::Accessibility], None).authorized);
        assert!(!Access::of(vec![Grant::AccessibilityBus], None).authorized);
        assert!(Access::of(vec![Grant::ScreenRecording], None).authorized);
        assert!(!Access::of(vec![Grant::Accessibility, Grant::ScreenRecording], None).authorized);
    }

    /// 原因原文不进协议，也不算事实变化：同一件事的错误文本每次可能不同。
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

    /// 握手回执带着那一刻的授权事实：宿主据此发布 `authorized`，不自己判平台。
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

    /// 修饰键只有四个名字：`win` 不是别名，写它的请求解析失败。
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

    /// 主键名不分大小写，规范成小写；修饰键与词表外的名字不是主键。
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

    /// 角色名互不相同，且都是小写加下划线：宿主与服务端按名字逐字比较。
    #[test]
    fn role_names_are_unique_snake_case_words() {
        let names: Vec<&str> = Role::ALL.iter().map(|r| r.as_str()).collect();
        let unique: std::collections::HashSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len());
        assert!(names
            .iter()
            .all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_lowercase() || c == '_')));
    }

    /// 没有 ValuePattern 的控件等不到任何值，不能把「没有值」当成空串命中。
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

    /// 三端共用的一份样例。三端各写一份夹具就不再是契约：宿主漏接 worker 的一个字段，
    /// 三端各自的测试照样全绿。
    const SAMPLES: &str =
        include_str!("../../../../../packages/core/src/protocol/native-desktop.samples.json");

    fn samples() -> serde_json::Value {
        serde_json::from_str(SAMPLES).expect("样例文件要能解析")
    }

    fn sample_request(key: &str) -> Request {
        serde_json::from_value(samples()["workerRequests"][key].clone())
            .unwrap_or_else(|e| panic!("样例请求 {key} 应当解析成功：{e}"))
    }

    /// 宿主翻出来的每一种请求都要被 worker 读成同样的值：字段名拼错时 serde 按缺席处理，
    /// 解析照样成功，只有逐项比对才看得出来。
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

    /// 每个可选字段都填上的控件。结构体字面量要求列全字段：`Node` 多一个字段，这里先编译
    /// 不过，样例随之要补，宿主与服务端两侧的样例测试再各自核对它有没有接住。
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

    /// worker 发出的每一种回执逐字等于样例。顶层字段与观察字段都在这里锁住：
    /// worker 加了字段而样例没有，宿主那侧就验不到它有没有被转发。
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

    /// 样例里出现的每一个 `role`（请求的角色条件与控件表的角色）都是词表里的名字。
    /// 写法不同的角色在 worker 这一侧逐字比较，永远不命中任何控件。
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
        assert!(found.len() >= 4, "样例里应当有请求与控件表两处角色：{found:?}");
        for role in found {
            assert!(
                Role::ALL.iter().any(|known| known.as_str() == role),
                "{role} 不在角色词表里"
            );
        }
    }

    /// 样例里等待 `appears` 的角色与文字命中样例控件表里的控件：两处用的是同一套词。
    #[test]
    fn the_sample_appears_condition_matches_a_sample_node() {
        let Op::Wait { role, name_contains, .. } = sample_request("wait").op else {
            panic!("wait 样例应当解析成等待");
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
