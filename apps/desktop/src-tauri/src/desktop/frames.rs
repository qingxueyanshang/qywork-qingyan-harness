//! 两段协议的帧及两者之间的翻译。
//!
//! 上游是服务端 ⇄ 宿主的 `/native/desktop`（字段与
//! `packages/core/src/protocol/native-desktop.ts` 逐字对应），下游是宿主 ⇄ worker 的
//! 行分隔 JSON（字段与 `apps/desktop/native/computer-host/src/protocol.rs` 逐字对应）。
//! 两段的对应关系由 `packages/core/src/protocol/native-desktop.samples.json` 锁定：服务端、宿主与
//! worker 的测试读取同一份样例，宿主遗漏转发某个字段时本文件的样例测试失败。
//!
//! 本模块不涉及进程、连接与 OS，全部翻译都是纯函数。
//!
//! 两条边界：
//!
//! 1. **只有六种 op 会被翻译并下发**（`FORWARDED_OPS`）。worker 的 `handshake` / `bind_connection` / `cancel`
//!    由宿主自行发起，服务端无法发送这三种 op，因此它们的观察（`ready` / `cancel_registered` /
//!    `connection_bound`）不可能出现在服务端请求的回执里。
//! 2. **缺省字段一律使用 `Option` + `skip_serializing_if`。** 多发送一个 `null` 会使接收端的
//!    可选字段判定从「不存在」变为「存在且为空」。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 服务端请求中可翻译为 worker 请求的 op。`cancel` 由宿主展开，不在此列。
const FORWARDED_OPS: [&str; 6] = [
    "list_windows",
    "read_tree",
    "act",
    "read_text",
    "wait",
    "capture_image",
];

/// 执行实例身份与当前连接代际。回执、事件与 worker 请求都按此填写。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub host_id: String,
    pub host_epoch: u64,
    pub connection_epoch: u64,
}

// ── 服务端 ⇄ 宿主 ──

/// 操作系统已具备的前提条件。**唯一的来源是 worker**：其握手回执与后续的授权通报。
///
/// 宿主只转发，不按平台自行判定，也不解释 `missing` 中的名称。缺省值表示没有 worker 时
/// 不存在该项：不授权、不列缺项，界面根据 `workerReady` 为假显示组件未就绪。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub authorized: bool,
    pub missing: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReady {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub host_id: String,
    pub host_epoch: u64,
    pub connection_epoch: u64,
    pub platform: &'static str,
    pub worker_ready: bool,
    #[serde(flatten)]
    pub access: Access,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFrame {
    #[serde(rename = "type")]
    pub frame: &'static str,
    pub connection_epoch: u64,
    pub host_id: String,
    pub host_epoch: u64,
    pub kind: &'static str,
    pub worker_ready: bool,
    #[serde(flatten)]
    pub access: Access,
}

// 测试中按样例做往返比对时需要序列化；生产路径只反序列化。
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub struct RequestFrame {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub connection_epoch: u64,
    pub host_id: String,
    pub host_epoch: u64,
    pub executor_id: String,
    /// 以 Unix 纪元毫秒表示的绝对时刻。原样交给 worker：请求在队列中等待的时间必须计入预算。
    pub deadline: i64,
    /// 用户是否启用前台接管。原样交给 worker，宿主不自行判定也不缓存该值。
    #[serde(default)]
    pub foreground: bool,
    pub op: String,
    #[serde(default)]
    pub target: Option<Target>,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    /// 要执行的动作。原样交给 worker：动作与参数的合法组合由 worker 确定，
    /// 宿主再判定一次就形成第二份词表。
    #[serde(default)]
    pub action: Option<Value>,
    /// `read_text` 返回的 UTF-16 码元数上限。
    #[serde(default)]
    pub max_chars: Option<u32>,
    #[serde(default)]
    pub max_nodes: Option<u32>,
    #[serde(default)]
    pub max_depth: Option<u32>,
    #[serde(default)]
    pub time_budget_ms: Option<u64>,
    /// 读取范围的根：`read_tree` 只读取该 ref 下的子树，`act` 与 `wait` 结束时按它重新读取。
    /// 缺失表示整个窗口。
    #[serde(default)]
    pub root: Option<String>,
    /// `wait` 的 `until=appears` 等待出现的控件角色。
    #[serde(default)]
    pub role: Option<String>,
    /// `wait` 的 `until=appears` 等待出现的控件文字。
    #[serde(default)]
    pub name_contains: Option<String>,
    #[serde(default)]
    pub include_value: Option<bool>,
    #[serde(default)]
    pub include_state: Option<bool>,
    /// 等待的后置条件。
    #[serde(default)]
    pub until: Option<String>,
    /// `until=window` 等待的标题子串。
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub poll_ms: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 指针动作的屏幕物理像素落点。与 `ref` 互斥。
    #[serde(default)]
    pub point: Option<Value>,
    /// `capture_image` 采集的屏幕物理像素矩形。缺失表示整个窗口。
    #[serde(default)]
    pub region: Option<Value>,
    /// `capture_image` 要求的窗口几何代际。
    #[serde(default)]
    pub expect_generation: Option<String>,
    #[serde(default)]
    pub max_edge: Option<u32>,
    #[serde(default)]
    pub max_bytes: Option<u32>,
}

impl RequestFrame {
    /// 从未通过字段校验的请求帧中取出请求 id 与三项身份，用于回执拒绝。
    /// 任一项缺失或类型不符时返回 `None`：服务端按这四项配对回执，缺项的回执无法完成任何调用。
    pub fn identity(value: &Value) -> Option<(String, Binding)> {
        let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        let number = |key: &str| value.get(key)?.as_u64();
        Some((
            text("requestId")?,
            Binding {
                host_id: text("hostId")?,
                host_epoch: number("hostEpoch")?,
                connection_epoch: number("connectionEpoch")?,
            },
        ))
    }
}

/// 目标窗口身份。三项同时提供，派发前重新核对，因此能够识别句柄复用。
#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub window: i64,
    pub pid: u32,
    pub process_started_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultFrame {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: String,
    pub connection_epoch: u64,
    pub host_id: String,
    pub host_epoch: u64,
    pub dispatch: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_error: Option<String>,
    /// 动作调用尚未返回时目标进程当前的顶层窗口。身份三项与窗口清单的结构相同。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking: Option<Value>,
}

impl ResultFrame {
    /// 本地拒绝的终态：未向 worker 的 stdin 写入任何帧。
    pub fn refused(request_id: String, binding: &Binding, reason: impl Into<String>) -> Self {
        Self {
            kind: "desktop.result",
            request_id,
            connection_epoch: binding.connection_epoch,
            host_id: binding.host_id.clone(),
            host_epoch: binding.host_epoch,
            dispatch: "not_dispatched",
            reason: Some(reason.into()),
            observation: None,
            observation_error: None,
            blocking: None,
        }
    }

    /// 只携带执行事实的终态：用于收尾与取消回执。
    pub fn settled(
        request_id: String,
        binding: &Binding,
        dispatch: Dispatch,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            kind: "desktop.result",
            request_id,
            connection_epoch: binding.connection_epoch,
            host_id: binding.host_id.clone(),
            host_epoch: binding.host_epoch,
            dispatch: dispatch.as_str(),
            reason: Some(reason.into()),
            observation: None,
            observation_error: None,
            blocking: None,
        }
    }
}

/// 执行事实的三种状态。只描述状态改变动作是否已交给 OS。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dispatch {
    NotDispatched,
    Submitted,
    Unknown,
}

impl Dispatch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotDispatched => "not_dispatched",
            Self::Submitted => "submitted",
            Self::Unknown => "unknown",
        }
    }
}

// ── 宿主 ⇄ worker ──

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
    pub host_id: String,
    pub host_epoch: u64,
    pub connection_epoch: u64,
    /// 用户是否启用前台接管。宿主自行发起的请求一律为假：它们不派发任何动作。
    pub foreground: bool,
    pub op: &'static str,
    pub params: Value,
}

impl WorkerRequest {
    fn new(id: String, binding: &Binding, op: &'static str, params: Value) -> Self {
        Self {
            id,
            deadline: None,
            host_id: binding.host_id.clone(),
            host_epoch: binding.host_epoch,
            connection_epoch: binding.connection_epoch,
            foreground: false,
            op,
            params,
        }
    }

    /// 建立执行实例绑定并设定 UIA 调用上界。每个 worker 进程只发送一次。
    pub fn handshake(
        id: String,
        binding: &Binding,
        connection_timeout_ms: u32,
        transaction_timeout_ms: u32,
    ) -> Self {
        Self::new(
            id,
            binding,
            "handshake",
            json!({
                "connectionTimeoutMs": connection_timeout_ms,
                "transactionTimeoutMs": transaction_timeout_ms
            }),
        )
    }

    /// 推进 worker 使用的连接代际。宿主每次建立 WS 连接后发送一次，旧连接上排队的动作随之作废。
    pub fn bind_connection(id: String, binding: &Binding) -> Self {
        Self::new(id, binding, "bind_connection", json!({}))
    }

    /// 登记一个尚未派发的 worker 请求 id。已经进入 OS 调用的请求不会被它中止。
    pub fn cancel(id: String, binding: &Binding, target: &str) -> Self {
        Self::new(id, binding, "cancel", json!({ "target": target }))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResponse {
    pub id: String,
    pub dispatch: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub observation: Option<Value>,
    #[serde(default)]
    pub observation_error: Option<String>,
    /// 动作调用尚未返回时目标进程当前的顶层窗口。
    #[serde(default)]
    pub blocking: Option<Value>,
}

impl WorkerResponse {
    /// 该回执是否为 worker 的就绪回执。为假时握手被拒绝，`reason` 为原因。
    pub fn is_ready(&self) -> bool {
        self.observation
            .as_ref()
            .and_then(|o| o.get("kind")?.as_str())
            == Some("ready")
    }

    /// 就绪回执中握手时刻的授权事实。不是就绪回执或缺少该字段时为 `None`。
    pub fn ready_access(&self) -> Option<Access> {
        if !self.is_ready() {
            return None;
        }
        let access = self.observation.as_ref()?.get("access")?;
        serde_json::from_value(access.clone()).ok()
    }
}

/// 把服务端请求翻译成一条 worker 请求。
///
/// `window` 由调用方在核对过目标身份之后给出：本函数不做 OS 查询，也不接受
/// 未经核对的 `frame.target.window`。返回 `Err(原因码)` 时调用方一律返回
/// `not_dispatched`，不向 worker 写入任何帧。
pub fn to_worker(
    id: String,
    frame: &RequestFrame,
    binding: &Binding,
    window: i64,
) -> Result<WorkerRequest, &'static str> {
    if frame.kind != "desktop.request" {
        return Err("unknown_frame");
    }
    let params = match frame.op.as_str() {
        "list_windows" => json!({}),
        "read_tree" => {
            let mut params = bounds(frame, window)?;
            merge(&mut params, select(frame));
            params
        }
        "act" => {
            let mut params = bounds(frame, window)?;
            merge(
                &mut params,
                json!({ "action": frame.action.as_ref().ok_or("missing_action")? }),
            );
            // 两种目标指定方式互斥，由 worker 的准入判定裁决哪一种有效；宿主只原样转发，
            // 再判定一次就形成第二份词表。
            if let Some(reference) = &frame.reference {
                merge(&mut params, json!({ "ref": reference }));
            }
            if let Some(point) = &frame.point {
                merge(&mut params, json!({ "point": point }));
            }
            if let Some(generation) = &frame.expect_generation {
                merge(&mut params, json!({ "expectGeneration": generation }));
            }
            if let Some(root) = &frame.root {
                merge(&mut params, json!({ "root": root }));
            }
            params
        }
        "read_text" => json!({
            "window": window,
            "ref": reference(frame)?,
            "maxChars": frame.max_chars.ok_or("missing_max_chars")?,
        }),
        "wait" => {
            let mut params = bounds(frame, window)?;
            if let Some(root) = &frame.root {
                merge(&mut params, json!({ "root": root }));
            }
            if let Some(role) = &frame.role {
                merge(&mut params, json!({ "role": role }));
            }
            if let Some(text) = &frame.name_contains {
                merge(&mut params, json!({ "nameContains": text }));
            }
            merge(
                &mut params,
                json!({
                    "until": frame.until.as_deref().ok_or("missing_until")?,
                    "pollMs": frame.poll_ms.ok_or("missing_poll")?,
                    "timeoutMs": frame.timeout_ms.ok_or("missing_timeout")?,
                }),
            );
            if let Some(reference) = &frame.reference {
                merge(&mut params, json!({ "ref": reference }));
            }
            if let Some(value) = &frame.value {
                merge(&mut params, json!({ "value": value }));
            }
            if let Some(name) = &frame.name {
                merge(&mut params, json!({ "name": name }));
            }
            params
        }
        "capture_image" => {
            let mut params = json!({
                "window": window,
                "maxEdge": frame.max_edge.ok_or("missing_max_edge")?,
                "maxBytes": frame.max_bytes.ok_or("missing_max_bytes")?,
                "timeBudgetMs": frame.time_budget_ms.ok_or("missing_time_budget")?,
            });
            if let Some(region) = &frame.region {
                merge(&mut params, json!({ "region": region }));
            }
            // 区域来自上一张图时必须同时提供代际：缺少代际时，窗口在两次采集之间移动后仍会采集，
            // 得到的是另一块界面。
            if let Some(generation) = &frame.expect_generation {
                merge(&mut params, json!({ "expectGeneration": generation }));
            }
            params
        }
        _ => return Err("unsupported_op"),
    };
    let op = FORWARDED_OPS
        .iter()
        .find(|op| **op == frame.op)
        .ok_or("unsupported_op")?;
    let mut request = WorkerRequest::new(id, binding, op, params);
    request.deadline = Some(frame.deadline);
    request.foreground = frame.foreground;
    Ok(request)
}

/// 三个上限与已核对的窗口句柄。缺少任何一项都不翻译：worker 没有默认值，缺失即为无界读取。
fn bounds(frame: &RequestFrame, window: i64) -> Result<Value, &'static str> {
    Ok(json!({
        "window": window,
        "maxNodes": frame.max_nodes.ok_or("missing_max_nodes")?,
        "maxDepth": frame.max_depth.ok_or("missing_max_depth")?,
        "timeBudgetMs": frame.time_budget_ms.ok_or("missing_time_budget")?,
    }))
}

/// 读树的范围与字段选择。缺失的项一律不写入：多发送一个 `null` 会使 worker 的可选字段
/// 判定从「不存在」变为「存在且为空」。
fn select(frame: &RequestFrame) -> Value {
    let mut out = json!({});
    if let Some(root) = &frame.root {
        merge(&mut out, json!({ "root": root }));
    }
    if let Some(include) = frame.include_value {
        merge(&mut out, json!({ "includeValue": include }));
    }
    if let Some(include) = frame.include_state {
        merge(&mut out, json!({ "includeState": include }));
    }
    out
}

fn merge(into: &mut Value, from: Value) {
    let (Some(target), Value::Object(source)) = (into.as_object_mut(), from) else {
        return;
    };
    for (key, value) in source {
        target.insert(key, value);
    }
}

fn reference(frame: &RequestFrame) -> Result<&str, &'static str> {
    frame.reference.as_deref().ok_or("missing_ref")
}

/// worker 上报的一行。
///
/// 三种结构按字段区分，不依赖额外的类型标记：回执必定带 `id` 与 `dispatch`，
/// 输入状态通报只带 `input`，授权通报只带 `access`。两种通报必须排在回执之前：
/// `untagged` 按声明顺序尝试，先尝试回执分支会把通报也解析为一条没有 id 的回执。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum WorkerLine {
    Input(InputNotice),
    Access(AccessNotice),
    Response(WorkerResponse),
}

/// worker 当前按住的鼠标键与键盘按键。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputNotice {
    pub input: HeldInput,
}

/// 握手之后操作系统的前提条件发生变化。
#[derive(Debug, Deserialize)]
pub struct AccessNotice {
    pub access: Access,
}

/// **只描述输入状态，不是任务状态。** 宿主在确认 worker 退出之后据此补发释放。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldInput {
    pub buttons: Vec<String>,
    /// 按住的键，使用协议键名，按按下顺序排列。转换为本平台键码在 `input::release` 中完成。
    pub keys: Vec<String>,
}

impl HeldInput {
    pub fn is_empty(&self) -> bool {
        self.buttons.is_empty() && self.keys.is_empty()
    }
}

/// 该 op 是否需要目标窗口身份。`list_windows` 与 `cancel` 不带 target。
pub fn needs_target(op: &str) -> bool {
    matches!(
        op,
        "read_tree" | "act" | "read_text" | "wait" | "capture_image"
    )
}

/// 把一条 worker 回执翻译成服务端结果帧。
///
/// `observation` 由调用方提供：窗口清单需要由宿主补充进程启动时刻与应用名，该步骤需要
/// OS 查询，不在本模块中执行。
pub fn to_result(
    request_id: String,
    binding: &Binding,
    response: WorkerResponse,
    observation: Option<Value>,
) -> ResultFrame {
    let dispatch = match response.dispatch.as_str() {
        "submitted" => Dispatch::Submitted,
        "unknown" => Dispatch::Unknown,
        _ => Dispatch::NotDispatched,
    };
    ResultFrame {
        kind: "desktop.result",
        request_id,
        connection_epoch: binding.connection_epoch,
        host_id: binding.host_id.clone(),
        host_epoch: binding.host_epoch,
        dispatch: dispatch.as_str(),
        reason: response.reason,
        observation,
        observation_error: response.observation_error,
        blocking: None,
    }
}

/// 把一条 worker 回执连同它的观察翻译成服务端结果帧。
///
/// 窗口清单与阻塞窗口需要补充进程启动时刻与应用名，由 `identify` 提供（它执行 OS 查询，本模块
/// 不执行）；无法补全身份的窗口整条丢弃，不为其编造启动时刻：目标身份缺少一项时，
/// 无法识别句柄复用。控件表、等待、图像与文本观察原样透传。
pub fn relay(
    request_id: String,
    binding: &Binding,
    mut response: WorkerResponse,
    mut identify: impl FnMut(i64, u32) -> Option<(i64, String)>,
) -> ResultFrame {
    let observation = response.observation.take();
    let blocking = response.blocking.take();
    let mut frame = to_result(request_id, binding, response, None);
    match observation.map(|o| project(&o, &mut identify)) {
        None => {}
        Some(Ok(projected)) => frame.observation = Some(projected),
        Some(Err(reason)) => frame.observation_error = Some(reason),
    }
    frame.blocking = blocking.and_then(|b| enrich_blocking(&b, &mut identify));
    frame
}

/// 把 worker 的观察转换为服务端协议中的结构。无法识别的观察种类如实报错，不透传。
fn project(
    observation: &Value,
    identify: impl FnMut(i64, u32) -> Option<(i64, String)>,
) -> Result<Value, String> {
    match observation.get("kind").and_then(Value::as_str) {
        Some("windows") => {
            enrich_windows(observation, identify).ok_or_else(|| "窗口清单的字段与协议不一致".to_owned())
        }
        Some("tree" | "wait" | "image" | "text") => Ok(observation.clone()),
        other => Err(format!("无法识别的观察 {}", other.unwrap_or("(无 kind)"))),
    }
}

/// 把 worker 的窗口清单补全为服务端协议要求的结构。
///
/// `identify` 提供进程启动时刻与可执行文件名；无法取得的窗口整条丢弃，不为其编造
/// 启动时刻：目标身份缺少一项时无法识别句柄复用，动作会作用于另一个窗口。
pub fn enrich_windows(
    observation: &Value,
    identify: impl FnMut(i64, u32) -> Option<(i64, String)>,
) -> Option<Value> {
    if observation.get("kind")?.as_str()? != "windows" {
        return None;
    }
    Some(json!({
        "kind": "windows",
        "capturedAt": observation.get("capturedAt").and_then(Value::as_i64).unwrap_or_default(),
        "windows": enrich_list(observation.get("windows")?.as_array()?, identify),
    }))
}

/// 补全动作回执中的顶层窗口清单。与窗口清单使用同一条补全路径，因此身份三项结构相同，
/// 服务端按同一套规则登记不透明 id；`appeared` 原样保留。
pub fn enrich_blocking(
    blocking: &Value,
    identify: impl FnMut(i64, u32) -> Option<(i64, String)>,
) -> Option<Value> {
    Some(Value::Array(enrich_list(blocking.as_array()?, identify)))
}

/// 逐条补充进程启动时刻与可执行文件名。无法补全的条目整条丢弃。
fn enrich_list(
    windows: &[Value],
    mut identify: impl FnMut(i64, u32) -> Option<(i64, String)>,
) -> Vec<Value> {
    let mut out = Vec::new();
    for w in windows {
        let (Some(handle), Some(pid)) = (
            w.get("window").and_then(Value::as_i64),
            w.get("pid").and_then(Value::as_u64),
        ) else {
            continue;
        };
        let Ok(pid) = u32::try_from(pid) else { continue };
        let Some((started_at, app)) = identify(handle, pid) else {
            continue;
        };
        let mut entry = json!({
            "handle": handle,
            "pid": pid,
            "processStartedAt": started_at,
            "app": app,
            "title": w.get("title").and_then(Value::as_str).unwrap_or_default(),
        });
        if let Some(appeared) = w.get("appeared").and_then(Value::as_bool) {
            merge(&mut entry, json!({ "appeared": appeared }));
        }
        out.push(entry);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> Binding {
        Binding {
            host_id: "h1".to_owned(),
            host_epoch: 2,
            connection_epoch: 5,
        }
    }

    fn request(op: &str) -> RequestFrame {
        RequestFrame {
            kind: "desktop.request".to_owned(),
            request_id: "dr_1".to_owned(),
            connection_epoch: 5,
            host_id: "h1".to_owned(),
            host_epoch: 2,
            executor_id: "dx_1".to_owned(),
            deadline: 1_700_000_000_000,
            foreground: false,
            op: op.to_owned(),
            target: Some(Target {
                window: 66,
                pid: 900,
                process_started_at: 1_699_000_000_000,
            }),
            reference: Some("w.0.1#42.7".to_owned()),
            point: None,
            value: None,
            action: None,
            max_chars: None,
            max_nodes: Some(500),
            max_depth: Some(12),
            time_budget_ms: Some(1500),
            root: None,
            role: None,
            name_contains: None,
            include_value: None,
            include_state: None,
            until: None,
            name: None,
            poll_ms: None,
            timeout_ms: None,
            region: None,
            expect_generation: None,
            max_edge: None,
            max_bytes: None,
        }
    }

    #[test]
    fn read_tree_carries_the_verified_handle_and_the_absolute_deadline() {
        let worker = to_worker("w1".to_owned(), &request("read_tree"), &binding(), 77)
            .expect("read_tree 应当能翻译");
        assert_eq!(
            serde_json::to_value(&worker).unwrap(),
            json!({
                "id": "w1", "deadline": 1_700_000_000_000i64,
                "hostId": "h1", "hostEpoch": 2, "connectionEpoch": 5,
                "foreground": false, "op": "read_tree",
                "params": {"window": 77, "maxNodes": 500, "maxDepth": 12, "timeBudgetMs": 1500}
            })
        );
    }

    /// 翻译只使用服务端核对过的句柄。使用帧中的句柄会使句柄复用的核对失效。
    #[test]
    fn the_frames_own_window_handle_is_never_used() {
        let mut frame = request("act");
        frame.action = Some(json!({"kind": "invoke"}));
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 4242).unwrap();
        assert_eq!(worker.params["window"], json!(4242));
    }

    /// 动作原样下发，宿主不解释它：词表只在 worker 中维护。空串表示清空，同样原样下发。
    #[test]
    fn the_action_travels_verbatim_and_is_required() {
        let mut frame = request("act");
        frame.action = Some(json!({"kind": "set_value", "value": ""}));
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 66).unwrap();
        assert_eq!(worker.op, "act");
        assert_eq!(worker.params["action"], json!({"kind": "set_value", "value": ""}));
        assert_eq!(worker.params["ref"], json!("w.0.1#42.7"));

        frame.action = None;
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 66).err(),
            Some("missing_action")
        );
    }

    /// 前台开关随每条请求原样下发：宿主不缓存该值，运行中关闭后在下一条请求上即生效。
    #[test]
    fn the_foreground_switch_travels_with_every_request() {
        let mut frame = request("act");
        frame.action = Some(json!({"kind": "click", "button": "left", "count": 1}));
        let off = to_worker("w1".to_owned(), &frame, &binding(), 66).unwrap();
        assert!(!off.foreground);
        frame.foreground = true;
        let on = to_worker("w1".to_owned(), &frame, &binding(), 66).unwrap();
        assert!(on.foreground);
        // 宿主自行发起的请求一律不启用前台：它们不派发任何动作。
        assert!(!WorkerRequest::cancel("w2".to_owned(), &binding(), "w1").foreground);
        assert!(!WorkerRequest::bind_connection("w3".to_owned(), &binding()).foreground);
    }

    /// 按图定位的动作携带屏幕落点与窗口几何代际，不带 ref。两种目标由 worker 裁决。
    #[test]
    fn a_pointer_action_can_carry_a_screen_point_instead_of_a_control() {
        let mut frame = request("act");
        frame.foreground = true;
        frame.reference = None;
        frame.action = Some(json!({"kind": "click", "button": "right", "count": 1}));
        frame.point = Some(json!({"x": -1800, "y": 240}));
        frame.expect_generation = Some("100,100,800,600@96#7".to_owned());
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 66).unwrap();
        assert_eq!(worker.params["point"], json!({"x": -1800, "y": 240}));
        assert_eq!(worker.params["expectGeneration"], json!("100,100,800,600@96#7"));
        assert!(worker.params.get("ref").is_none());
    }

    /// 输入状态通报与回执按字段区分：通报没有 id 与 dispatch，回执没有 input。
    #[test]
    fn an_input_notice_is_not_mistaken_for_a_receipt() {
        let notice = serde_json::from_str::<WorkerLine>(
            r#"{"input":{"buttons":["left"],"keys":["ctrl","a"]}}"#,
        )
        .expect("通报应当解析成功");
        match notice {
            WorkerLine::Input(notice) => {
                assert_eq!(notice.input.buttons, vec!["left".to_owned()]);
                assert_eq!(notice.input.keys, vec!["ctrl".to_owned(), "a".to_owned()]);
                assert!(!notice.input.is_empty());
            }
            other => panic!("解析结果错误：{other:?}"),
        }
        let receipt = serde_json::from_str::<WorkerLine>(
            r#"{"id":"w1","dispatch":"submitted"}"#,
        )
        .expect("回执应当解析成功");
        match receipt {
            WorkerLine::Response(r) => assert_eq!((r.id.as_str(), r.dispatch.as_str()), ("w1", "submitted")),
            other => panic!("被解析为通报：{other:?}"),
        }
        let empty = serde_json::from_str::<WorkerLine>(r#"{"input":{"buttons":[],"keys":[]}}"#)
            .expect("空的输入状态应当解析成功");
        match empty {
            WorkerLine::Input(notice) => assert!(notice.input.is_empty()),
            other => panic!("解析结果错误：{other:?}"),
        }
    }

    /// 授权通报与另外两种行按 `access` 字段区分；就绪回执中嵌套的 `access` 不是通报。
    #[test]
    fn an_access_notice_is_told_apart_from_receipts_and_input_notices() {
        let notice = serde_json::from_str::<WorkerLine>(
            r#"{"access":{"authorized":false,"missing":["accessibility","screen_recording"]}}"#,
        )
        .expect("通报应当解析成功");
        match notice {
            WorkerLine::Access(notice) => assert_eq!(
                notice.access,
                Access {
                    authorized: false,
                    missing: vec!["accessibility".to_owned(), "screen_recording".to_owned()],
                }
            ),
            other => panic!("解析结果错误：{other:?}"),
        }
        let ready = serde_json::from_str::<WorkerLine>(
            r#"{"id":"w1","dispatch":"not_dispatched","observation":{"kind":"ready",
                "access":{"authorized":true,"missing":[]}}}"#,
        )
        .expect("就绪回执应当解析成功");
        assert!(matches!(ready, WorkerLine::Response(_)), "{ready:?}");
    }

    /// 读取文本是只读 op：只需要句柄、控件与自身的上限，不带读树的三个上限。
    #[test]
    fn read_text_carries_only_its_own_limit() {
        let mut frame = request("read_text");
        frame.max_chars = Some(4000);
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 77).unwrap();
        assert_eq!(
            worker.params,
            json!({"window": 77, "ref": "w.0.1#42.7", "maxChars": 4000})
        );
        frame.max_chars = None;
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 77).err(),
            Some("missing_max_chars")
        );
    }

    #[test]
    fn missing_read_tree_bounds_are_refused_instead_of_defaulted() {
        let mut frame = request("read_tree");
        frame.max_nodes = None;
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 66).err(),
            Some("missing_max_nodes")
        );
        let mut frame = request("read_tree");
        frame.time_budget_ms = None;
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 66).err(),
            Some("missing_time_budget")
        );
    }

    /// 这几种 op 由宿主自行发起或已删除，服务端无法发送。翻译层放行它们等于让
    /// worker 的 `ready` / `cancel_registered` / `connection_bound` 观察传到服务端。
    #[test]
    fn host_only_ops_do_not_translate() {
        for op in [
            "handshake",
            "bind_connection",
            "cancel",
            "screenshot",
            "set_value",
            "invoke",
        ] {
            assert_eq!(
                to_worker("w1".to_owned(), &request(op), &binding(), 66).err(),
                Some("unsupported_op"),
                "{op}"
            );
        }
    }

    /// 字段不合法的请求仍须回执：服务端按请求 id 与三项身份配对，取不出这四项时回执无法完成任何调用。
    #[test]
    fn an_invalid_request_still_yields_its_identity_for_the_refusal() {
        let raw = json!({
            "type": "desktop.request",
            "requestId": "dr_9",
            "connectionEpoch": 5,
            "hostId": "h1",
            "hostEpoch": 2,
            "deadline": "不是数字",
            "op": "act",
        });
        assert!(RequestFrame::deserialize(&raw).is_err());
        let (request_id, reply) = RequestFrame::identity(&raw).expect("身份四项齐全");
        let frame = serde_json::to_value(ResultFrame::refused(request_id, &reply, "bad_request: x"))
            .expect("回执可序列化");
        assert_eq!(
            frame,
            json!({
                "type": "desktop.result",
                "requestId": "dr_9",
                "connectionEpoch": 5,
                "hostId": "h1",
                "hostEpoch": 2,
                "dispatch": "not_dispatched",
                "reason": "bad_request: x",
            })
        );

        let mut partial = raw.clone();
        partial.as_object_mut().expect("对象").remove("hostEpoch");
        assert!(RequestFrame::identity(&partial).is_none());
    }

    #[test]
    fn a_frame_of_another_kind_is_refused() {
        let mut frame = request("list_windows");
        frame.kind = "desktop.event".to_owned();
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 66).err(),
            Some("unknown_frame")
        );
    }

    #[test]
    fn only_window_bound_ops_need_a_target() {
        assert!(!needs_target("list_windows"));
        assert!(!needs_target("cancel"));
        for op in ["read_tree", "act", "read_text", "wait", "capture_image"] {
            assert!(needs_target(op), "{op}");
        }
    }

    /// 整窗采集携带三个上限与核对过的句柄，不带区域与代际。
    #[test]
    fn a_whole_window_capture_carries_the_limits_and_nothing_else() {
        let mut frame = request("capture_image");
        frame.max_edge = Some(1568);
        frame.max_bytes = Some(4 << 20);
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 77).unwrap();
        assert_eq!(worker.op, "capture_image");
        assert_eq!(
            worker.params,
            json!({"window": 77, "maxEdge": 1568, "maxBytes": 4 << 20, "timeBudgetMs": 1500})
        );
    }

    /// 按上一张图的区域重新采集时，区域与代际一同下发：缺少代际时，窗口移动后仍会采集。
    #[test]
    fn a_region_capture_carries_the_rect_and_the_generation() {
        let mut frame = request("capture_image");
        frame.max_edge = Some(1568);
        frame.max_bytes = Some(4 << 20);
        frame.region = Some(json!({"x": -1800, "y": -100, "width": 400, "height": 300}));
        frame.expect_generation = Some("80,80,520,460@96#65537".to_owned());
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 77).unwrap();
        assert_eq!(
            worker.params["region"],
            json!({"x": -1800, "y": -100, "width": 400, "height": 300})
        );
        assert_eq!(
            worker.params["expectGeneration"],
            json!("80,80,520,460@96#65537")
        );
    }

    /// 采集的上限同样没有默认值：缺失时图像的尺寸与字节数都没有上限。
    #[test]
    fn missing_capture_limits_are_refused_instead_of_defaulted() {
        let mut frame = request("capture_image");
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 77).err(),
            Some("missing_max_edge")
        );
        frame.max_edge = Some(1568);
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 77).err(),
            Some("missing_max_bytes")
        );
        frame.max_bytes = Some(4 << 20);
        frame.time_budget_ms = None;
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 77).err(),
            Some("missing_time_budget")
        );
    }

    /// 筛选与字段选择缺失时均不写入 params：多发送一个 `null` 会使 worker 把「不存在」
    /// 读取为「存在且为空」。
    #[test]
    fn an_absent_selection_adds_no_keys() {
        let worker = to_worker("w1".to_owned(), &request("read_tree"), &binding(), 77).unwrap();
        let params = worker.params.as_object().expect("params 应当是对象");
        assert_eq!(
            params.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["maxDepth", "maxNodes", "timeBudgetMs", "window"]
        );
    }

    /// 读树只携带范围与字段选择；角色与文字不进入读树，它们只作用于交给模型的视图。
    #[test]
    fn a_read_travels_as_root_and_field_selection_only() {
        let mut frame = request("read_tree");
        frame.root = Some("w.0#7".to_owned());
        frame.role = Some("button".to_owned());
        frame.name_contains = Some("保存".to_owned());
        frame.include_value = Some(false);
        frame.include_state = Some(false);
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 77).unwrap();
        assert_eq!(worker.params["root"], json!("w.0#7"));
        assert!(worker.params.get("role").is_none());
        assert!(worker.params.get("nameContains").is_none());
        assert_eq!(worker.params["includeValue"], json!(false));
        assert_eq!(worker.params["includeState"], json!(false));
        assert_eq!(worker.params["window"], json!(77));
    }

    /// 动作携带三个上限与当前观察的范围根：动作完成后按该范围完整重新读取，上限由服务端提供，
    /// worker 没有默认值。
    #[test]
    fn an_action_carries_the_bounds_and_scope_for_the_follow_up_read() {
        let mut frame = request("act");
        frame.action = Some(json!({"kind": "invoke"}));
        frame.root = Some("w.0#7".to_owned());
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 77).unwrap();
        assert_eq!(worker.params["maxNodes"], json!(500));
        assert_eq!(worker.params["maxDepth"], json!(12));
        assert_eq!(worker.params["timeBudgetMs"], json!(1500));
        assert_eq!(worker.params["root"], json!("w.0#7"));
    }

    /// 等待携带 `appears` 的角色与文字，以及结束时重新读取的范围根。
    #[test]
    fn a_wait_carries_the_appears_condition_and_scope() {
        let mut frame = request("wait");
        frame.until = Some("appears".to_owned());
        frame.poll_ms = Some(250);
        frame.timeout_ms = Some(9000);
        frame.role = Some("button".to_owned());
        frame.name_contains = Some("保存".to_owned());
        frame.root = Some("w.0#7".to_owned());
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 77).unwrap();
        assert_eq!(worker.params["role"], json!("button"));
        assert_eq!(worker.params["nameContains"], json!("保存"));
        assert_eq!(worker.params["root"], json!("w.0#7"));
    }

    #[test]
    fn wait_carries_the_condition_and_both_time_limits() {
        let mut frame = request("wait");
        frame.until = Some("value".to_owned());
        frame.value = Some("张三".to_owned());
        frame.poll_ms = Some(250);
        frame.timeout_ms = Some(9_000);
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 77).unwrap();
        assert_eq!(worker.op, "wait");
        assert_eq!(worker.params["until"], json!("value"));
        assert_eq!(worker.params["ref"], json!("w.0.1#42.7"));
        assert_eq!(worker.params["value"], json!("张三"));
        assert_eq!(worker.params["pollMs"], json!(250));
        assert_eq!(worker.params["timeoutMs"], json!(9_000));
        // 信封的 deadline 仍然照常发送：它是宿主中对应 pending 条目的硬上界。
        assert_eq!(worker.deadline, Some(1_700_000_000_000));
    }

    #[test]
    fn wait_without_a_condition_or_a_limit_is_refused() {
        let mut frame = request("wait");
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 77).err(),
            Some("missing_until")
        );
        frame.until = Some("enabled".to_owned());
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 77).err(),
            Some("missing_poll")
        );
        frame.poll_ms = Some(250);
        assert_eq!(
            to_worker("w1".to_owned(), &frame, &binding(), 77).err(),
            Some("missing_timeout")
        );
    }

    #[test]
    fn a_failed_reread_keeps_the_dispatch_fact() {
        let response = WorkerResponse {
            id: "w1".to_owned(),
            dispatch: "submitted".to_owned(),
            reason: None,
            observation: None,
            observation_error: Some("窗口已关闭".to_owned()),
            blocking: None,
        };
        let frame = to_result("dr_1".to_owned(), &binding(), response, None);
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            json!({
                "type": "desktop.result", "requestId": "dr_1", "connectionEpoch": 5,
                "hostId": "h1", "hostEpoch": 2, "dispatch": "submitted",
                "observationError": "窗口已关闭"
            })
        );
    }

    /// worker 返回无法识别的执行事实时，按未派发读取会使调用方重发一次可能已经生效的动作，
    /// 因此未知字面量只能归入 `not_dispatched` 之外的判定；本测试锁定当前的三个字面量。
    #[test]
    fn dispatch_words_map_one_to_one() {
        for (word, expected) in [
            ("not_dispatched", "not_dispatched"),
            ("submitted", "submitted"),
            ("unknown", "unknown"),
        ] {
            let response = WorkerResponse {
                id: "w1".to_owned(),
                dispatch: word.to_owned(),
                reason: None,
                observation: None,
                observation_error: None,
                blocking: None,
            };
            assert_eq!(
                to_result("dr_1".to_owned(), &binding(), response, None).dispatch,
                expected
            );
        }
    }

    #[test]
    fn readiness_and_access_come_from_the_worker_observation() {
        let response = WorkerResponse {
            id: "h_1".to_owned(),
            dispatch: "not_dispatched".to_owned(),
            reason: None,
            observation: Some(json!({
                "kind": "ready", "backend": "linux-atspi",
                "access": {"authorized": false, "missing": ["accessibility_bus"]}
            })),
            observation_error: None,
            blocking: None,
        };
        assert!(response.is_ready());
        assert_eq!(
            response.ready_access(),
            Some(Access {
                authorized: false,
                missing: vec!["accessibility_bus".to_owned()],
            })
        );

        let other = WorkerResponse {
            id: "h_1".to_owned(),
            dispatch: "not_dispatched".to_owned(),
            reason: Some("timeout_setup_failed".to_owned()),
            observation: None,
            observation_error: None,
            blocking: None,
        };
        assert!(!other.is_ready());
        assert_eq!(other.ready_access(), None);
    }

    #[test]
    fn windows_gain_the_process_identity_and_drop_the_class_name() {
        let observation = json!({
            "kind": "windows",
            "capturedAt": 17,
            "windows": [
                {"window": 66, "pid": 900, "title": "夹具", "className": "WindowsForms10.Window"},
                {"window": 67, "pid": 901, "title": "无法读取身份的窗口", "className": "X"}
            ]
        });
        let enriched = enrich_windows(&observation, |_, pid| {
            (pid == 900).then(|| (1_699_000_000_000, "fixture.exe".to_owned()))
        })
        .expect("windows 观察应当能补全");
        assert_eq!(
            enriched,
            json!({
                "kind": "windows",
                "capturedAt": 17,
                "windows": [{
                    "handle": 66, "pid": 900,
                    "processStartedAt": 1_699_000_000_000i64,
                    "app": "fixture.exe", "title": "夹具"
                }]
            })
        );
    }

    /// 动作回执中的窗口清单与 `list_windows` 使用同一条补全路径：身份三项结构相同，服务端
    /// 因此按同一套规则登记不透明 id，不另建规则。`appeared` 原样保留。
    #[test]
    fn a_blocking_list_is_enriched_like_the_window_list() {
        let blocking = json!([
            {"window": 66, "pid": 900, "title": "夹具", "className": "WindowsForms10.Window", "appeared": false},
            {"window": 67, "pid": 900, "title": "modal", "className": "#32770", "appeared": true},
            {"window": 68, "pid": 901, "title": "无法读取身份", "className": "X", "appeared": true}
        ]);
        let enriched = enrich_blocking(&blocking, |_, pid| {
            (pid == 900).then(|| (1_699_000_000_000, "fixture.exe".to_owned()))
        })
        .expect("窗口清单应当能补全");
        assert_eq!(
            enriched,
            json!([
                {
                    "handle": 66, "pid": 900, "processStartedAt": 1_699_000_000_000i64,
                    "app": "fixture.exe", "title": "夹具", "appeared": false
                },
                {
                    "handle": 67, "pid": 900, "processStartedAt": 1_699_000_000_000i64,
                    "app": "fixture.exe", "title": "modal", "appeared": true
                }
            ])
        );
    }

    /// 窗口清单本身不带 `appeared`，补全之后也不应新增该字段。
    #[test]
    fn the_window_list_gains_no_appeared_flag() {
        let observation = json!({
            "kind": "windows", "capturedAt": 17,
            "windows": [{"window": 66, "pid": 900, "title": "夹具", "className": "X"}]
        });
        let enriched = enrich_windows(&observation, |_, _| {
            Some((1_699_000_000_000, "fixture.exe".to_owned()))
        })
        .expect("窗口清单应当能补全");
        assert!(enriched["windows"][0].get("appeared").is_none());
    }

    #[test]
    fn a_non_windows_observation_is_left_alone() {
        let tree = json!({"kind": "tree", "window": 66, "capturedAt": 1});
        assert_eq!(enrich_windows(&tree, |_, _| None), None);
    }

    // ── 与服务端、worker 共用的样例 ──

    /// 三端共用的一份样例。三端各写一份夹具就不再构成契约：宿主遗漏一个字段时，另外两端的
    /// 测试仍全部通过。
    const SAMPLES: &str =
        include_str!("../../../../../packages/core/src/protocol/native-desktop.samples.json");

    fn samples() -> Value {
        serde_json::from_str(SAMPLES).expect("样例文件必须能解析")
    }

    fn sample_binding() -> Binding {
        Binding {
            host_id: "h1".to_owned(),
            host_epoch: 2,
            connection_epoch: 3,
        }
    }

    /// 进程启动时刻与应用名的测试替身：只识别样例中 pid 900 的两个窗口。
    fn identify(handle: i64, pid: u32) -> Option<(i64, String)> {
        (pid == 900 && (handle == 66 || handle == 88))
            .then(|| (1_700_000_000_000, "记事本".to_owned()))
    }

    /// 服务端请求中宿主未声明的字段会被 serde 静默丢弃。样例中的每个字段都必须原样进入
    /// `RequestFrame`，只有 `actionId` 例外：动作身份只在服务端使用，宿主不转发。
    #[test]
    fn request_frame_keeps_every_field_of_the_shared_samples() {
        for (key, sample) in samples()["requests"].as_object().expect("样例") {
            let frame: RequestFrame = serde_json::from_value(sample.clone()).expect(key);
            let mut back = serde_json::to_value(&frame).expect("可序列化");
            back.as_object_mut().expect("对象").retain(|_, v| !v.is_null());
            let mut expected = sample.clone();
            expected.as_object_mut().expect("对象").remove("actionId");
            assert_eq!(back, expected, "{key}");
        }
    }

    #[test]
    fn server_requests_translate_to_the_shared_worker_requests() {
        let all = samples();
        let requests = all["requests"].as_object().expect("样例");
        assert_eq!(requests.len(), all["workerRequests"].as_object().expect("样例").len());
        for (key, sample) in requests {
            let frame: RequestFrame = serde_json::from_value(sample.clone()).expect(key);
            let window = frame.target.map_or(0, |t| t.window);
            let worker = to_worker("w1".to_owned(), &frame, &sample_binding(), window)
                .unwrap_or_else(|e| panic!("{key}: {e}"));
            assert_eq!(
                serde_json::to_value(&worker).expect("可序列化"),
                all["workerRequests"][key],
                "{key}"
            );
        }
    }

    /// worker 回执经宿主转换为结果帧。宿主遗漏转发 worker 的某个字段时，此处的结果帧与样例不一致。
    #[test]
    fn worker_responses_relay_to_the_shared_result_frames() {
        let all = samples();
        let responses = all["workerResponses"].as_object().expect("样例");
        assert_eq!(responses.len(), all["results"].as_object().expect("样例").len());
        for (key, sample) in responses {
            let Ok(WorkerLine::Response(response)) = serde_json::from_value(sample.clone()) else {
                panic!("{key} 不是一条回执");
            };
            let frame = relay("dr_1".to_owned(), &sample_binding(), response, identify);
            assert_eq!(
                serde_json::to_value(&frame).expect("可序列化"),
                all["results"][key],
                "{key}"
            );
        }
    }

    #[test]
    fn host_frames_match_the_shared_samples() {
        let all = samples();
        let binding = sample_binding();
        let ready = HostReady {
            kind: "host.ready",
            host_id: binding.host_id.clone(),
            host_epoch: binding.host_epoch,
            connection_epoch: binding.connection_epoch,
            platform: "windows",
            worker_ready: true,
            access: Access {
                authorized: true,
                missing: Vec::new(),
            },
        };
        assert_eq!(serde_json::to_value(&ready).expect("可序列化"), all["hostReady"]);
        let event = EventFrame {
            frame: "desktop.event",
            connection_epoch: binding.connection_epoch,
            host_id: binding.host_id.clone(),
            host_epoch: binding.host_epoch,
            kind: "worker.state",
            worker_ready: true,
            access: Access {
                authorized: true,
                missing: vec!["screen_recording".to_owned()],
            },
        };
        assert_eq!(serde_json::to_value(&event).expect("可序列化"), all["workerState"]);
    }
}
