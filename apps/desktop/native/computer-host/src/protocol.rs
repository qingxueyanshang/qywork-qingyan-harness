//! 宿主与 worker 之间的行分隔 JSON 协议：请求、回执、执行事实三态与派发前的准入判定。
//!
//! 本模块不调用任何 OS 接口，全部判定都能在没有图形会话的环境里测试。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 协议版本。版本不一致的请求直接拒绝，不做字段级兼容。
pub const PROTOCOL_VERSION: u32 = 1;

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
    #[serde(rename_all = "camelCase")]
    ReadTree {
        window: i64,
        max_nodes: u32,
        max_depth: u32,
        time_budget_ms: u64,
    },
    ReadElement {
        window: i64,
        #[serde(rename = "ref")]
        reference: String,
    },
    SetValue {
        window: i64,
        #[serde(rename = "ref")]
        reference: String,
        value: String,
    },
    Invoke {
        window: i64,
        #[serde(rename = "ref")]
        reference: String,
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
    #[serde(rename_all = "camelCase")]
    Tree {
        window: i64,
        captured_at: i64,
        completeness: Completeness,
        node_count: u32,
        root: Node,
    },
    #[serde(rename_all = "camelCase")]
    Element {
        window: i64,
        captured_at: i64,
        element: Node,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub window: i64,
    pub pid: u32,
    pub title: String,
    pub class_name: String,
}

/// 观察的完整性。截断原因逐条列出，调用方不能把「没采到」读成「没有」。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completeness {
    pub complete: bool,
    pub truncated_by: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// 不透明引用，动作请求原样带回。内含子树索引路径与 RuntimeId。
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    pub name: String,
    pub automation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub enabled: bool,
    pub offscreen: bool,
    /// 只列 worker 已实现的动作。控件暴露了模式但 worker 没有对应 op 时不列，
    /// 否则调用方会按这张表发出永远拿不到实现的请求。
    pub actions: Vec<&'static str>,
    pub children: Vec<Node>,
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
            r#"{{"v":1,"id":"r1","deadline":{deadline},"hostId":"h1","hostEpoch":2,
                "connectionEpoch":5,
                "op":"invoke","params":{{"window":66,"ref":"w.0.1#42.7"}}}}"#
        ))
    }

    fn handshake_request(host_id: &str, host_epoch: u64, connection_epoch: u64) -> Request {
        parse(&format!(
            r#"{{"v":1,"id":"h","hostId":"{host_id}","hostEpoch":{host_epoch},
                "connectionEpoch":{connection_epoch},"op":"handshake",
                "params":{{"connectionTimeoutMs":2000,"transactionTimeoutMs":2000}}}}"#
        ))
    }

    fn bind_request(connection_epoch: u64) -> Request {
        parse(&format!(
            r#"{{"v":1,"id":"b","hostId":"h1","hostEpoch":2,
                "connectionEpoch":{connection_epoch},"op":"bind_connection","params":{{}}}}"#
        ))
    }

    #[test]
    fn request_decodes_op_and_params() {
        let req = parse(
            r#"{"v":1,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_tree","params":{"window":66,"maxNodes":500,"maxDepth":12,
                "timeBudgetMs":1500}}"#,
        );
        assert_eq!(req.id, "r1");
        assert_eq!(req.deadline, None);
        match req.op {
            Op::ReadTree {
                window,
                max_nodes,
                max_depth,
                time_budget_ms,
            } => {
                assert_eq!(
                    (window, max_nodes, max_depth, time_budget_ms),
                    (66, 500, 12, 1500)
                );
            }
            other => panic!("解析成了别的 op：{other:?}"),
        }
    }

    #[test]
    fn op_without_params_still_requires_an_empty_object() {
        const HEAD: &str = r#""v":1,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5"#;
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
            r#"{"v":1,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"screenshot","params":{}}"#
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
            r#"{"v":1,"id":"r1","dispatch":"not_dispatched","reason":"read_only"}"#
        );
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
            r#"{"v":1,"id":"h","connectionEpoch":5,
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
        req.v = 2;
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
}
