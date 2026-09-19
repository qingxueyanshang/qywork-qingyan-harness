//! 宿主与 worker 之间的行分隔 JSON 协议：请求、回执、执行事实三态与派发前的准入判定。
//!
//! 本模块不调用任何 OS 接口，全部判定都能在没有图形会话的环境里测试。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::geometry::{Geometry, ScreenRect};

/// 协议版本。版本不一致的请求直接拒绝，不做字段级兼容。
pub const PROTOCOL_VERSION: u32 = 3;

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
    pub v: u32,
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
    #[serde(flatten)]
    pub op: Op,
}

/// 一次读取的三个上限。语义固定：`max_nodes` 与 `max_depth` 限遍历，`time_budget_ms`
/// 限这次遍历自身的用时，三者任一触顶都记进 `truncated_by`。
///
/// 筛选不走这里：被筛掉的节点仍然被遍历过，它不是截断。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub max_nodes: u32,
    pub max_depth: u32,
    pub time_budget_ms: u64,
}

/// 观察的筛选与字段选择。全部缺省时读整窗、取全部字段。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Select {
    /// 子树根的 `ref`。缺席表示从窗口元素开始读。
    #[serde(default)]
    pub root: Option<String>,
    /// 只留这个角色的控件。
    #[serde(default)]
    pub role: Option<String>,
    /// 只留名称、稳定标识或值包含这段文字的控件，不分大小写。
    #[serde(default)]
    pub name_contains: Option<String>,
    /// 取不取控件当前值。为假时 `value` 一律缺席，可用动作仍照常判定。
    #[serde(default = "yes")]
    pub include_value: bool,
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
            role: None,
            name_contains: None,
            include_value: true,
        }
    }
}

impl Select {
    /// 施加了哪些筛选，逐条写进 `completeness.filtered_by`。
    ///
    /// 调用方据此区分「这个控件不存在」与「这个控件被筛掉了」，两者不能混。
    pub fn describe(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(root) = &self.root {
            out.push(format!("root={root}"));
        }
        if let Some(role) = &self.role {
            out.push(format!("role={role}"));
        }
        if let Some(text) = &self.name_contains {
            out.push(format!("nameContains={text}"));
        }
        if !self.include_value {
            out.push("includeValue=false".to_owned());
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
    /// 给控件写值，之后重读它所在的子树。
    SetValue {
        window: i64,
        #[serde(rename = "ref")]
        reference: String,
        value: String,
        #[serde(flatten)]
        bounds: Bounds,
    },
    /// 调用控件的默认动作，之后重读它所在的子树。
    Invoke {
        window: i64,
        #[serde(rename = "ref")]
        reference: String,
        #[serde(flatten)]
        bounds: Bounds,
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
        /// 等一帧到达的上限。
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
        /// `until=appears` 的筛选条件。与读树那一份同形，字段也在同一层，
        /// 不是嵌在 `select` 对象里。
        #[serde(flatten)]
        select: Select,
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
    pub v: u32,
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
}

impl Response {
    /// 没有派发动作的终态：拒绝、参数无效、目标失效、只读请求失败。
    pub fn rejected(id: String, reason: String) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            dispatch: Dispatch::NotDispatched,
            reason: Some(reason),
            observation: None,
            observation_error: None,
        }
    }

    /// 只读请求与握手的终态。
    pub fn observed(id: String, observation: Observation) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            dispatch: Dispatch::NotDispatched,
            reason: None,
            observation: Some(observation),
            observation_error: None,
        }
    }

    /// 动作请求的终态：执行事实与动作后的重读结果分列。
    pub fn acted(id: String, dispatch: Dispatch, outcome: Result<Observation, String>) -> Self {
        let (observation, observation_error) = match outcome {
            Ok(o) => (Some(o), None),
            Err(e) => (None, Some(e)),
        };
        Self {
            v: PROTOCOL_VERSION,
            id,
            dispatch,
            reason: None,
            observation,
            observation_error,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Observation {
    #[serde(rename_all = "camelCase")]
    Ready {
        protocol: u32,
        backend: &'static str,
        host_id: String,
        host_epoch: u64,
        /// 从 UIA 接口读回来的实际值，不是请求里那两个数的回声。
        connection_timeout_ms: u32,
        transaction_timeout_ms: u32,
        /// 本进程的 DPI 感知模式是不是 per-monitor v2，从 OS 读回来的实际值。
        ///
        /// 为假时窗口矩形被系统虚拟化过，采到的图与控件包围盒对不上同一套坐标，
        /// 采集请求一律拒绝。
        dpi_per_monitor_v2: bool,
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
/// 截断与筛选是两件事，分两格记：`truncated_by` 说的是上限截断了遍历，`filtered_by`
/// 说的是哪些条件把遍历过的节点挡在了结果外面。调用方不能把「没采到」读成「没有」，
/// 也不能把「被筛掉」读成「不存在」。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completeness {
    pub complete: bool,
    pub truncated_by: Vec<&'static str>,
    pub filtered_by: Vec<String>,
    /// 遍历过的节点数。三个上限限的是它，不是返回的条数。
    pub visited: u32,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub enabled: bool,
    pub offscreen: bool,
    /// 控件的包围盒，屏幕物理像素，与图像几何同一套坐标。
    ///
    /// provider 不给包围盒的控件缺席（零尺寸同样按缺席算）。**缺席不等于控件不存在**，
    /// 也不等于它在屏幕外——那一件事由 `offscreen` 说。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<ScreenRect>,
    /// 只列 worker 已实现的动作。控件暴露了模式但 worker 没有对应 op 时不列，
    /// 否则调用方会按这张表发出永远拿不到实现的请求。
    pub actions: Vec<&'static str>,
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

/// 动作调用返回后的执行事实映射。
///
/// 失败一律记 `unknown`：UIA 是跨进程调用，provider 可能已经执行完动作才返回错误，
/// 调用方无法据此断定状态未变。
pub fn action_dispatch(call: &Result<(), String>) -> Dispatch {
    match call {
        Ok(()) => Dispatch::Submitted,
        Err(_) => Dispatch::Unknown,
    }
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
/// 顺序固定：协议版本 → 执行实例身份 → 连接代际 → 取消登记 → 截止时刻。身份或代际不符的
/// 请求不进入取消与超时判断，旧绑定的请求因此影响不到当前绑定的登记。
pub fn admit(
    req: &Request,
    binding: Option<&Binding>,
    cancelled: bool,
    now: i64,
) -> Result<(), &'static str> {
    if req.v != PROTOCOL_VERSION {
        return Err("protocol_version");
    }
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
    if cancelled {
        return Err("cancelled");
    }
    if req.deadline.is_some_and(|d| now >= d) {
        return Err("deadline_exceeded");
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
            r#"{{"v":3,"id":"r1","deadline":{deadline},"hostId":"h1","hostEpoch":2,
                "connectionEpoch":5,
                "op":"invoke","params":{{"window":66,"ref":"w.0.1#42.7",
                "maxNodes":50,"maxDepth":4,"timeBudgetMs":800}}}}"#
        ))
    }

    fn handshake_request(host_id: &str, host_epoch: u64, connection_epoch: u64) -> Request {
        parse(&format!(
            r#"{{"v":3,"id":"h","hostId":"{host_id}","hostEpoch":{host_epoch},
                "connectionEpoch":{connection_epoch},"op":"handshake",
                "params":{{"connectionTimeoutMs":2000,"transactionTimeoutMs":2000}}}}"#
        ))
    }

    fn bind_request(connection_epoch: u64) -> Request {
        parse(&format!(
            r#"{{"v":3,"id":"b","hostId":"h1","hostEpoch":2,
                "connectionEpoch":{connection_epoch},"op":"bind_connection","params":{{}}}}"#
        ))
    }

    #[test]
    fn request_decodes_op_and_params() {
        let req = parse(
            r#"{"v":3,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
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
            r#"{"v":3,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_tree","params":{"window":66,"maxNodes":500,"maxDepth":12,
                "timeBudgetMs":1500}}"#,
        );
        match req.op {
            Op::ReadTree { select, .. } => {
                assert_eq!(select.root, None);
                assert!(select.include_value);
                assert!(select.describe().is_empty());
            }
            other => panic!("解析成了别的 op：{other:?}"),
        }
    }

    /// 筛选逐条写进 completeness，调用方据此分得出「没有」与「被筛掉」。
    #[test]
    fn selection_is_described_field_by_field() {
        let req = parse(
            r#"{"v":3,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_tree","params":{"window":66,"root":"w.0#7","role":"button",
                "nameContains":"保存","includeValue":false,
                "maxNodes":500,"maxDepth":12,"timeBudgetMs":1500}}"#,
        );
        match req.op {
            Op::ReadTree { select, .. } => {
                assert_eq!(
                    select.describe(),
                    vec![
                        "root=w.0#7".to_owned(),
                        "role=button".to_owned(),
                        "nameContains=保存".to_owned(),
                        "includeValue=false".to_owned(),
                    ]
                );
            }
            other => panic!("解析成了别的 op：{other:?}"),
        }
    }

    #[test]
    fn wait_decodes_condition_and_two_bounds() {
        let req = parse(
            r#"{"v":3,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
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
        const HEAD: &str = r#""v":3,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5"#;
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
            r#"{"v":3,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"screenshot","params":{}}"#
        )
        .is_err());
    }

    /// 单读一个控件的 op 不存在：动作与等待都自带子树重读，没有第二条只读路径。
    #[test]
    fn a_single_element_read_op_does_not_exist() {
        assert!(serde_json::from_str::<Request>(
            r#"{"v":3,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
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
            r#"{"v":3,"id":"r1","dispatch":"not_dispatched","reason":"read_only"}"#
        );
    }

    fn tree(scope: Option<&str>) -> Tree {
        Tree {
            window: 66,
            captured_at: 17,
            scope: scope.map(str::to_owned),
            window_enabled: true,
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
                rect: Some(ScreenRect {
                    x: 120,
                    y: 240,
                    width: 80,
                    height: 24,
                }),
                actions: vec!["invoke"],
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

    /// 截断与筛选分两格：被筛掉的节点遍历过，它不是截断。
    #[test]
    fn truncation_and_filtering_are_reported_separately() {
        let mut body = tree(None);
        body.completeness = Completeness {
            complete: false,
            truncated_by: vec!["max_nodes"],
            filtered_by: vec!["role=button".to_owned()],
            visited: 500,
        };
        let value = serde_json::to_value(Observation::Tree(body)).unwrap();
        assert_eq!(value["completeness"]["truncatedBy"][0], "max_nodes");
        assert_eq!(value["completeness"]["filteredBy"][0], "role=button");
        assert_eq!(value["completeness"]["visited"], 500);
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
        assert_eq!(action_dispatch(&Ok(())), Dispatch::Submitted);
        assert_eq!(
            action_dispatch(&Err("provider 无响应".to_owned())),
            Dispatch::Unknown
        );
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
            r#"{"v":3,"id":"h","connectionEpoch":5,
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
    fn protocol_version_is_checked_before_everything_else() {
        let mut req = invoke_request(None);
        req.v = 1;
        assert_eq!(admit(&req, None, true, i64::MAX), Err("protocol_version"));
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
}
