//! 两段协议的帧与它们之间的翻译。
//!
//! 上一段是服务端 ⇄ 宿主的 `/native/desktop`（字段与
//! `packages/core/src/protocol/native-desktop.ts` 逐字对应），下一段是宿主 ⇄ worker 的
//! 行分隔 JSON（字段与 `apps/desktop/native/computer-host/src/protocol.rs` 逐字对应）。
//! 两段的对应由 `packages/core/src/protocol/native-desktop.samples.json` 锁住：服务端、宿主与
//! worker 的测试读同一份样例，宿主漏转一个字段时本文件的样例测试失败。
//!
//! 本模块不碰进程、连接与 OS，全部翻译都是纯函数。
//!
//! 两条边界：
//!
//! 1. **只有六种 op 会被翻译下去**（`FORWARDED_OPS`）。 worker 的 `handshake` / `bind_connection` / `cancel`
//!    由宿主自己发起，服务端发不出这三种，因此它们的观察（`ready` / `cancel_registered` /
//!    `connection_bound`）不可能出现在服务端请求的回执里。
//! 2. **缺省字段一律 `Option` + `skip_serializing_if`。** 多发一个 `null` 会让接收端的
//!    可选字段判定从「没有」变成「有且为空」。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 服务端请求的 op 里能翻译成 worker 请求的那些。`cancel` 由宿主展开，不在此列。
const FORWARDED_OPS: [&str; 6] = [
    "list_windows",
    "read_tree",
    "act",
    "read_text",
    "wait",
    "capture_image",
];

/// 执行实例身份加当前连接代际。回执、事件与 worker 请求都按这一份填。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub host_id: String,
    pub host_epoch: u64,
    pub connection_epoch: u64,
}

// ── 服务端 ⇄ 宿主 ──

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
    pub authorized: bool,
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
    pub authorized: bool,
}

// 测试里按样例做往返比对要序列化它；生产路径只反序列化。
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
    /// Unix 纪元毫秒的绝对时刻。原样交给 worker：请求在队列里等待的时间要计入预算。
    pub deadline: i64,
    /// 用户有没有启用前台接管。原样交给 worker，宿主不自行判定也不缓存它。
    #[serde(default)]
    pub foreground: bool,
    pub op: String,
    #[serde(default)]
    pub target: Option<Target>,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    /// 一次动作要执行什么。原样交给 worker：动作与参数的合法组合由 worker 定，
    /// 宿主再判一遍就是第二份词表。
    #[serde(default)]
    pub action: Option<Value>,
    /// `read_text` 要回多少个 UTF-16 码元。
    #[serde(default)]
    pub max_chars: Option<u32>,
    #[serde(default)]
    pub max_nodes: Option<u32>,
    #[serde(default)]
    pub max_depth: Option<u32>,
    #[serde(default)]
    pub time_budget_ms: Option<u64>,
    /// 读取范围的根：`read_tree` 只读这个 ref 底下的子树，`act` 与 `wait` 结束时按它重读。
    /// 缺席表示整窗。
    #[serde(default)]
    pub root: Option<String>,
    /// `wait` 的 `until=appears` 要出现的控件角色。
    #[serde(default)]
    pub role: Option<String>,
    /// `wait` 的 `until=appears` 要出现的控件文字。
    #[serde(default)]
    pub name_contains: Option<String>,
    #[serde(default)]
    pub include_value: Option<bool>,
    #[serde(default)]
    pub include_state: Option<bool>,
    /// 等待的后置条件。
    #[serde(default)]
    pub until: Option<String>,
    /// `until=window` 要等的标题子串。
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub poll_ms: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 指针动作的屏幕物理像素落点。与 `ref` 互斥。
    #[serde(default)]
    pub point: Option<Value>,
    /// `capture_image` 要采的屏幕物理像素矩形。缺席表示整窗。
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

/// 目标窗口身份。三项一起给，派发前重新核对，句柄复用因此识别得出。
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
    /// 动作调用尚未返回时目标进程此刻的顶层窗口。身份三项与窗口清单同形。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking: Option<Value>,
}

impl ResultFrame {
    /// 本地拒绝的终态：一帧都没写进 worker 的 stdin。
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

    /// 只带执行事实的终态：收尾与取消回执用它。
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

/// 执行事实三态。只描述状态改变动作有没有交到 OS 手里。
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
    /// 用户有没有启用前台接管。宿主自己发起的请求一律为假：它们不派发任何动作。
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

    /// 建立执行实例绑定并设定 UIA 调用上界。每个 worker 进程只发一次。
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

    /// 推进 worker 认的连接代际。宿主每次建立 WS 后发一次，旧连接排队的动作随之作废。
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
    /// 动作调用尚未返回时目标进程此刻的顶层窗口。
    #[serde(default)]
    pub blocking: Option<Value>,
}

impl WorkerResponse {
    /// 这条回执是不是 worker 发布就绪的那一条。为假时握手被拒，`reason` 是原因。
    pub fn is_ready(&self) -> bool {
        self.observation
            .as_ref()
            .and_then(|o| o.get("kind")?.as_str())
            == Some("ready")
    }
}

/// 把服务端请求翻译成一条 worker 请求。
///
/// `window` 由调用方在核对过目标身份之后给出：本函数不做 OS 查询，也不接受
/// 未经核对的 `frame.target.window`。返回 `Err(原因码)` 时调用方一律回
/// `not_dispatched`，一帧都不写进 worker。
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
            // 两种目标给法互斥，哪一种成立由 worker 的准入判定裁决；宿主只原样转，
            // 再判一遍就是第二份词表。
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
            // 区域来自上一张图时代际必须一起给：少了它，窗口在两次采集之间移动过也照采，
            // 采回来的是另一块界面。
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

/// 三个上限加已核对的窗口句柄。缺任何一项都不翻译：worker 没有默认值，缺了就是无界读取。
fn bounds(frame: &RequestFrame, window: i64) -> Result<Value, &'static str> {
    Ok(json!({
        "window": window,
        "maxNodes": frame.max_nodes.ok_or("missing_max_nodes")?,
        "maxDepth": frame.max_depth.ok_or("missing_max_depth")?,
        "timeBudgetMs": frame.time_budget_ms.ok_or("missing_time_budget")?,
    }))
}

/// 读树的范围与字段选择。缺席的项一律不写进去：多发一个 `null` 会让 worker 的可选字段
/// 判定从「没有」变成「有且为空」。
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

/// worker 发上来的一行。
///
/// 两种形状靠字段区分，不靠额外的类型标记：回执一定带 `id` 与 `dispatch`，
/// 输入状态通报一定只带 `input`。顺序不能反——`untagged` 按声明顺序试，
/// 回执那一支先试就会把通报也解析成一条没有 id 的回执。
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum WorkerLine {
    Input(InputNotice),
    Response(WorkerResponse),
}

/// worker 此刻按住的鼠标键与虚拟键码。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputNotice {
    pub input: HeldInput,
}

/// **只描述输入状态，不是任务状态。** 宿主按它在确认 worker 退出之后补发释放。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldInput {
    pub buttons: Vec<String>,
    pub keys: Vec<HeldKey>,
}

/// 一个按住不放的物理键。扩展键标志要一起带：抬起事件少了它，目标应用收到的是
/// 小键盘上的同码键，它按下的那一个仍然停在按下状态。
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldKey {
    pub vk: u16,
    pub extended: bool,
}

impl HeldInput {
    pub fn is_empty(&self) -> bool {
        self.buttons.is_empty() && self.keys.is_empty()
    }
}

/// 这个 op 需不需要目标窗口身份。`list_windows` 与 `cancel` 不带 target。
pub fn needs_target(op: &str) -> bool {
    matches!(
        op,
        "read_tree" | "act" | "read_text" | "wait" | "capture_image"
    )
}

/// 把一条 worker 回执翻译成服务端结果帧。
///
/// `observation` 由调用方给出：窗口清单要由宿主补上进程启动时刻与应用名，那一步需要
/// OS 查询，不在本模块里做。
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
/// 窗口清单与阻塞窗口要补进程启动时刻与应用名，由 `identify` 交出（它做 OS 查询，本模块
/// 不做）；补不上身份的窗口整条丢掉，不给它一个编造的启动时刻——目标身份少一项，句柄复用
/// 就识别不出来。控件表、等待、图像与文本观察原样透传。
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

/// 把 worker 的观察投影成服务端协议里的形状。认不出的观察种类如实报错，不透传。
fn project(
    observation: &Value,
    identify: impl FnMut(i64, u32) -> Option<(i64, String)>,
) -> Result<Value, String> {
    match observation.get("kind").and_then(Value::as_str) {
        Some("windows") => {
            enrich_windows(observation, identify).ok_or_else(|| "窗口清单的字段对不上".to_owned())
        }
        Some("tree" | "wait" | "image" | "text") => Ok(observation.clone()),
        other => Err(format!("认不出的观察 {}", other.unwrap_or("(无 kind)"))),
    }
}

/// 把 worker 的窗口清单补成服务端协议要的形状。
///
/// `identify` 交出进程启动时刻与可执行文件名；取不到的窗口整条丢掉，不给它一个编造的
/// 启动时刻——目标身份少一项，句柄复用就识别不出来，动作会落到另一个窗口上。
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

/// 动作回执里那份顶层窗口清单的补全。与窗口清单走同一条补全路径，身份三项因此同形，
/// 服务端按同一套规则登记不透明 id；`appeared` 原样保留。
pub fn enrich_blocking(
    blocking: &Value,
    identify: impl FnMut(i64, u32) -> Option<(i64, String)>,
) -> Option<Value> {
    Some(Value::Array(enrich_list(blocking.as_array()?, identify)))
}

/// 逐条补上进程启动时刻与可执行文件名。补不上的整条丢掉。
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

    /// 翻译只认服务端核对过的句柄。拿帧里那一个的话，句柄复用就白核对了。
    #[test]
    fn the_frames_own_window_handle_is_never_used() {
        let mut frame = request("act");
        frame.action = Some(json!({"kind": "invoke"}));
        let worker = to_worker("w1".to_owned(), &frame, &binding(), 4242).unwrap();
        assert_eq!(worker.params["window"], json!(4242));
    }

    /// 动作原样下去，宿主不解释它：词表只有 worker 一份。空串是清空，照样带下去。
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

    /// 前台开关随每条请求原样下去：宿主不缓存它，运行中关掉在下一条请求上就生效。
    #[test]
    fn the_foreground_switch_travels_with_every_request() {
        let mut frame = request("act");
        frame.action = Some(json!({"kind": "click", "button": "left", "count": 1}));
        let off = to_worker("w1".to_owned(), &frame, &binding(), 66).unwrap();
        assert!(!off.foreground);
        frame.foreground = true;
        let on = to_worker("w1".to_owned(), &frame, &binding(), 66).unwrap();
        assert!(on.foreground);
        // 宿主自己发起的请求一律不带前台：它们不派发任何动作。
        assert!(!WorkerRequest::cancel("w2".to_owned(), &binding(), "w1").foreground);
        assert!(!WorkerRequest::bind_connection("w3".to_owned(), &binding()).foreground);
    }

    /// 按图定位的动作带屏幕落点与窗口几何代际，不带 ref。两种目标由 worker 裁决。
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

    /// 输入状态通报与回执靠字段分：通报没有 id 与 dispatch，回执没有 input。
    #[test]
    fn an_input_notice_is_not_mistaken_for_a_receipt() {
        let notice = serde_json::from_str::<WorkerLine>(
            r#"{"input":{"buttons":["left"],"keys":[{"vk":17,"extended":false}]}}"#,
        )
        .expect("通报应当解析成功");
        match notice {
            WorkerLine::Input(notice) => {
                assert_eq!(notice.input.buttons, vec!["left".to_owned()]);
                assert_eq!(notice.input.keys.len(), 1);
                assert_eq!(notice.input.keys[0].vk, 17);
                assert!(!notice.input.is_empty());
            }
            WorkerLine::Response(r) => panic!("解析成了回执：{r:?}"),
        }
        let receipt = serde_json::from_str::<WorkerLine>(
            r#"{"id":"w1","dispatch":"submitted"}"#,
        )
        .expect("回执应当解析成功");
        match receipt {
            WorkerLine::Response(r) => assert_eq!((r.id.as_str(), r.dispatch.as_str()), ("w1", "submitted")),
            WorkerLine::Input(n) => panic!("解析成了通报：{n:?}"),
        }
        let empty = serde_json::from_str::<WorkerLine>(r#"{"input":{"buttons":[],"keys":[]}}"#)
            .expect("空账应当解析成功");
        match empty {
            WorkerLine::Input(notice) => assert!(notice.input.is_empty()),
            WorkerLine::Response(r) => panic!("解析成了回执：{r:?}"),
        }
    }

    /// 读文本是只读 op：只要句柄、控件与上限，不带读树那三个上限。
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

    /// 这几种 op 由宿主自己发起或者已经删掉，服务端发不出去。翻译层放行它们就等于让
    /// worker 的 `ready` / `cancel_registered` / `connection_bound` 观察流到服务端。
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

    /// 整窗采集带三个上限与核对过的句柄，不带区域也不带代际。
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

    /// 按上一张图的区域重采时，区域与代际一起下去：少了代际，窗口移动过也照采。
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

    /// 采集的上限同样没有默认值：缺了就是一张尺寸与字节都无界的图。
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

    /// 筛选与字段选择缺席时一个都不写进 params：多发一个 `null` 会让 worker 把「没有」
    /// 读成「有且为空」。
    #[test]
    fn an_absent_selection_adds_no_keys() {
        let worker = to_worker("w1".to_owned(), &request("read_tree"), &binding(), 77).unwrap();
        let params = worker.params.as_object().expect("params 应当是对象");
        assert_eq!(
            params.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["maxDepth", "maxNodes", "timeBudgetMs", "window"]
        );
    }

    /// 读树只带范围与字段选择；角色与文字不进读树，它们只作用于交给模型的视图。
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

    /// 动作带三个上限与当前观察的范围根：动作后按这个范围整份重读，上限由服务端给，
    /// worker 不自带默认值。
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

    /// 等待带 `appears` 的角色与文字，以及结束时重读的范围根。
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
        // 信封的 deadline 仍然照发：它是宿主那条 pending 的硬上界。
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

    /// worker 换了一个认不出的执行事实时按未派发读会让调用方重发一次可能已经生效的动作，
    /// 所以未知字面量只能落到 `not_dispatched` 之外的判定上——这里锁住当前三个字面量。
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
    fn readiness_comes_from_the_worker_observation() {
        let response = WorkerResponse {
            id: "h_1".to_owned(),
            dispatch: "not_dispatched".to_owned(),
            reason: None,
            observation: Some(json!({"kind": "ready", "backend": "windows-uia"})),
            observation_error: None,
            blocking: None,
        };
        assert!(response.is_ready());

        let other = WorkerResponse {
            id: "h_1".to_owned(),
            dispatch: "not_dispatched".to_owned(),
            reason: Some("timeout_setup_failed".to_owned()),
            observation: None,
            observation_error: None,
            blocking: None,
        };
        assert!(!other.is_ready());
    }

    #[test]
    fn windows_gain_the_process_identity_and_drop_the_class_name() {
        let observation = json!({
            "kind": "windows",
            "capturedAt": 17,
            "windows": [
                {"window": 66, "pid": 900, "title": "夹具", "className": "WindowsForms10.Window"},
                {"window": 67, "pid": 901, "title": "读不到身份的窗口", "className": "X"}
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

    /// 动作回执里那份窗口清单与 `list_windows` 同一条补全路径：身份三项同形，服务端
    /// 因此按同一套规则登记不透明 id，不另造一套。`appeared` 原样保留。
    #[test]
    fn a_blocking_list_is_enriched_like_the_window_list() {
        let blocking = json!([
            {"window": 66, "pid": 900, "title": "夹具", "className": "WindowsForms10.Window", "appeared": false},
            {"window": 67, "pid": 900, "title": "modal", "className": "#32770", "appeared": true},
            {"window": 68, "pid": 901, "title": "读不到身份", "className": "X", "appeared": true}
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

    /// 窗口清单本身不带 `appeared`，补全之后也不该凭空多一格。
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

    /// 三端共用的一份样例。三端各写一份夹具就不再是契约：宿主漏接一个字段，另外两端的
    /// 测试照样全绿。
    const SAMPLES: &str =
        include_str!("../../../../../packages/core/src/protocol/native-desktop.samples.json");

    fn samples() -> Value {
        serde_json::from_str(SAMPLES).expect("样例文件要能解析")
    }

    fn sample_binding() -> Binding {
        Binding {
            host_id: "h1".to_owned(),
            host_epoch: 2,
            connection_epoch: 3,
        }
    }

    /// 进程启动时刻与应用名的替身：只认得出样例里 pid 900 的两个窗口。
    fn identify(handle: i64, pid: u32) -> Option<(i64, String)> {
        (pid == 900 && (handle == 66 || handle == 88))
            .then(|| (1_700_000_000_000, "记事本".to_owned()))
    }

    /// 服务端请求里宿主没声明的字段会被 serde 静默丢掉。样例里的每个字段都要原样落进
    /// `RequestFrame`，只有 `actionId` 例外：动作身份只在服务端用，宿主不转发它。
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

    /// worker 回执经宿主转成结果帧。宿主漏转 worker 的一个字段时，这里的结果帧与样例对不上。
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
            authorized: true,
        };
        assert_eq!(serde_json::to_value(&ready).expect("可序列化"), all["hostReady"]);
        let event = EventFrame {
            frame: "desktop.event",
            connection_epoch: binding.connection_epoch,
            host_id: binding.host_id.clone(),
            host_epoch: binding.host_epoch,
            kind: "worker.state",
            worker_ready: false,
            authorized: true,
        };
        assert_eq!(serde_json::to_value(&event).expect("可序列化"), all["workerState"]);
    }
}
