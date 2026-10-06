//! 服务循环：宿主经由子进程 stdio 发送按行分隔的 JSON 请求，worker 逐条回执。本模块不区分
//! 平台，平台接口只经由 `Backend` 调用。
//!
//! 使用 stdio 而不使用命名管道：stdio 随子进程一同关闭，worker 退出即 stdin 结束，宿主无需
//! 心跳或清理残留端点；本机命名管道还需自行实现访问控制，而继承的 stdio 只有父子两端。
//!
//! 三类线程：
//!
//! - **接收线程**：读取 stdin。取消与连接代际当场处理，其余请求进入执行队列。一次 OS 调用
//!   可能阻塞至调用上界，取消消息在此期间必须仍能被读取并登记。
//! - **执行线程**：逐条执行窗口发现、读树、动作与采集。
//! - **等待线程**：每条 `wait` 请求对应一条线程，各自创建后端实例。等待最长可达分钟级，
//!   放在执行线程上会阻塞同一时段的窗口发现与读树，而取消必须在等待期间生效。
//!
//! 每条请求都有终态：解析失败、后端不可用、通道已关闭时各自返回一条 `not_dispatched`。
//!
//! 授权事实（`Backend::access`）只在三个时刻实时查询：握手时、一次调用因缺少前提被拒绝之后
//! （`refused_for_grant`）、以及缺少前提期间每隔 `ACCESS_POLL` 一次。前提齐备时不轮询：
//! 运行中撤销的授权由下一次被拒绝的调用报告。

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::backend::{ActRequest, Attempt, Backend, CaptureRequest, WaitRequest};
use crate::input;
use crate::protocol::{
    admit, now_ms, refused_for_grant, Access, AccessNotice, Binding, HostIdentity, InputNotice,
    Dispatch, Observation, Op, Request, Response, NOT_DISPATCHED,
};

/// 缺少前提时重新查询授权的间隔。用户在系统设置中授权之后，界面在该间隔内显示变化。
const ACCESS_POLL: Duration = Duration::from_secs(1);

/// worker 的全部跨线程状态。
///
/// 取消登记按 requestId 记录，执行线程取出目标请求时一并移除；目标请求始终未到达时，
/// 该条目保留到下次握手时清空。等待中的请求例外：它在派发之后才可能被取消，由等待线程
/// 每轮查询一次并在收尾时移除。
#[derive(Default)]
struct State {
    binding: Mutex<Option<Binding>>,
    cancelled: Mutex<HashSet<String>>,
    /// 宿主握手时提供的调用上界。等待线程创建后端时必须使用同一组上界。
    timeouts: Mutex<Option<(u32, u32)>>,
    access: Mutex<AccessLedger>,
}

/// 最后一次交给宿主的授权事实，以及重查线程是否在运行。只做判定，不调用 OS、不写入 stdout。
#[derive(Default)]
struct AccessLedger {
    /// 握手回执或最后一条通报中的授权事实。握手之前为 `None`。
    reported: Option<Access>,
    polling: bool,
}

/// 一次实时查询之后需要执行的操作。
#[derive(Debug)]
struct AccessStep {
    /// 事实发生变化时需要发送的通报。
    notify: Option<Access>,
    /// 是否需要启动一条重查线程。
    poll: bool,
}

impl AccessLedger {
    /// 握手：记录 `Ready` 中交给宿主的授权事实。返回是否需要启动重查线程。
    fn handshake(&mut self, now: &Access) -> bool {
        self.reported = Some(now.clone());
        self.start_poll()
    }

    /// 记录一次实时查询的结果。握手之前的查询结果不计入：此时宿主还没有可对比的基准。
    fn observe(&mut self, now: Access) -> AccessStep {
        let Some(reported) = &self.reported else {
            return AccessStep {
                notify: None,
                poll: false,
            };
        };
        let notify = (!reported.same(&now)).then(|| now.clone());
        if notify.is_some() {
            self.reported = Some(now);
        }
        AccessStep {
            notify,
            poll: self.start_poll(),
        }
    }

    /// 重查线程在每轮末尾调用：前提齐备即停止，并记录线程已停止，下一次被拒绝的调用会重新启动一条。
    fn keep_polling(&mut self) -> bool {
        let keep = self.missing_any();
        if !keep {
            self.polling = false;
        }
        keep
    }

    fn start_poll(&mut self) -> bool {
        let start = self.missing_any() && !self.polling;
        if start {
            self.polling = true;
        }
        start
    }

    fn missing_any(&self) -> bool {
        self.reported.as_ref().is_some_and(|a| !a.missing.is_empty())
    }
}

/// 执行 worker 进程的完整生命周期。stdin 结束即以退出码 0 结束进程，不返回。
pub fn run<B: Backend>() -> ! {
    // 按下状态的登记一有变化即发送一行通报：宿主确认 worker 退出之后按最后一次通报补发释放。
    // 注册必须在任何请求进入之前完成，遗漏一次通报就会遗漏一次释放。
    input::on_change(|held| notify_input(&InputNotice::of(held)));
    // 启动时先报告一次空登记：宿主据此得知这一代 worker 没有按住任何键。
    notify_input(&InputNotice::of(input::held()));

    let state = Arc::new(State::default());
    let (tx, rx) = std::sync::mpsc::channel::<Request>();
    let executor_state = Arc::clone(&state);
    // 不保留句柄：进程退出时不等待执行线程，见本函数末尾。
    std::thread::spawn(move || execute_all::<B>(rx, &executor_state));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        match line {
            Ok(line) => intake(&line, &state, &tx),
            Err(e) => {
                eprintln!("读取 stdin 失败：{e}");
                break;
            }
        }
    }
    // 直接结束进程，队列中尚未执行的请求一并丢弃，按住的键由宿主按最后一次通报补发抬起。
    // 不要改成先 join 执行线程：阻塞于 OS 调用的执行线程不会返回，宿主已不再管理的 worker
    // 会一直留在系统中。
    std::process::exit(0)
}

/// 接收线程：解析一行，取消请求当场处理，其余请求进入执行队列。
fn intake(line: &str, state: &State, tx: &Sender<Request>) {
    if line.trim().is_empty() {
        return;
    }
    // 先解析为 Value 再转换为 Request：字段不合法时仍需取出 id 用于回执，否则宿主对应的
    // pending 没有终态。
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return reply(&Response::rejected(String::new(), format!("bad_json: {e}"))),
    };
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let req: Request = match serde_json::from_value(value) {
        Ok(r) => r,
        Err(e) => return reply(&Response::rejected(id, format!("bad_request: {e}"))),
    };
    // 取消与连接代际更新都在本线程上当场完成：它们必须在一次耗时较长的 OS 调用进行期间生效，
    // 进入执行队列则会排在该调用之后。
    match &req.op {
        Op::Cancel { target } => {
            let target = target.clone();
            reply(&cancel(&req, target, state));
        }
        Op::BindConnection {} => reply(&bind_connection(&req, state)),
        _ => {
            let id = req.id.clone();
            if tx.send(req).is_err() {
                reply(&Response::rejected(id, "worker_stopped".to_owned()));
            }
        }
    }
}

fn cancel(req: &Request, target: String, state: &State) -> Response {
    let binding = state.binding.lock().expect("绑定锁").clone();
    if let Err(reason) = admit(req, binding.as_ref(), false, now_ms()) {
        return Response::rejected(req.id.clone(), reason.to_owned());
    }
    state
        .cancelled
        .lock()
        .expect("取消登记锁")
        .insert(target.clone());
    Response::observed(req.id.clone(), Observation::CancelRegistered { target })
}

/// 推进连接代际。此后队列中属于旧代际的请求在准入时被拒绝，动作不会被派发。
fn bind_connection(req: &Request, state: &State) -> Response {
    let mut guard = state.binding.lock().expect("绑定锁");
    if let Err(reason) = admit(req, guard.as_ref(), false, now_ms()) {
        return Response::rejected(req.id.clone(), reason.to_owned());
    }
    let Some(binding) = guard.as_mut() else {
        return Response::rejected(req.id.clone(), "no_handshake".to_owned());
    };
    binding.connection_epoch = req.connection_epoch;
    Response::observed(
        req.id.clone(),
        Observation::ConnectionBound {
            connection_epoch: req.connection_epoch,
        },
    )
}

fn execute_all<B: Backend>(rx: Receiver<Request>, state: &Arc<State>) {
    let backend = match B::new() {
        Ok(b) => b,
        Err(e) => {
            for req in rx {
                reply(&Response::rejected(
                    req.id,
                    format!("backend_unavailable: {e}"),
                ));
            }
            return;
        }
    };
    for req in rx {
        // 等待请求使用独立线程：等待可能长达分钟级，留在本线程上会阻塞后续的读树请求。
        if matches!(req.op, Op::Wait { .. }) {
            spawn_wait::<B>(req, state);
            continue;
        }
        let response = handle(&backend, state, req);
        let drain = response.after_reply;
        reply(&response);
        recheck_if_refused::<B>(&response, state);
        // 先发出回执，再承担本次 provider 重连的开销：在回执之前重连时，一次打开模态框的
        // 动作必须等满连接超时才能回执。
        if let Some(window) = drain {
            backend.drain_provider(window);
        }
    }
}

fn handle<B: Backend>(backend: &B, state: &Arc<State>, req: Request) -> Response {
    let cancelled = state.cancelled.lock().expect("取消登记锁").remove(&req.id);
    let binding = state.binding.lock().expect("绑定锁").clone();
    if let Err(reason) = admit(&req, binding.as_ref(), cancelled, now_ms()) {
        return Response::rejected(req.id, reason.to_owned());
    }
    match req.op {
        Op::Handshake {
            connection_timeout_ms,
            transaction_timeout_ms,
        } => {
            let bound = Binding {
                host: HostIdentity {
                    host_id: req.host_id,
                    host_epoch: req.host_epoch,
                },
                connection_epoch: req.connection_epoch,
            };
            match backend.set_timeouts(connection_timeout_ms, transaction_timeout_ms) {
                Ok((connection, transaction)) => {
                    *state.binding.lock().expect("绑定锁") = Some(bound.clone());
                    *state.timeouts.lock().expect("超时锁") = Some((connection, transaction));
                    state.cancelled.lock().expect("取消登记锁").clear();
                    let access = B::access();
                    if !access.missing.is_empty() {
                        report(&access);
                    }
                    if state.access.lock().expect("授权锁").handshake(&access) {
                        spawn_access_poll::<B>(Arc::clone(state));
                    }
                    Response::observed(
                        req.id,
                        Observation::Ready {
                            backend: B::NAME,
                            host_id: bound.host.host_id,
                            host_epoch: bound.host.host_epoch,
                            connection_timeout_ms: connection,
                            transaction_timeout_ms: transaction,
                            access,
                        },
                    )
                }
                // 上界设置失败时不发布 ready：没有上界的跨进程调用没有终态。
                Err(e) => Response::rejected(req.id, format!("timeout_setup_failed: {e}")),
            }
        }
        // 取消与连接绑定由接收线程处理，等待由独立线程处理，均不应执行到此处。
        Op::Cancel { .. } | Op::BindConnection {} | Op::Wait { .. } => {
            Response::rejected(req.id, "not_queued".to_owned())
        }
        Op::ListWindows {} => observe(req.id, backend.list_windows()),
        Op::ReadTree {
            window,
            select,
            bounds,
        } => observe(
            req.id,
            backend.read_tree(window, &select, bounds, req.foreground),
        ),
        Op::Act {
            window,
            reference,
            root,
            point,
            expect_generation,
            action,
            bounds,
        } => act(
            req.id,
            backend,
            state,
            &ActRequest {
                window,
                reference: reference.as_deref(),
                root: root.as_deref(),
                point,
                expect_generation: expect_generation.as_deref(),
                action: &action,
                bounds,
                foreground: req.foreground,
            },
        ),
        Op::ReadText {
            window,
            reference,
            max_chars,
        } => observe(req.id, backend.read_text(window, &reference, max_chars)),
        Op::CaptureImage {
            window,
            region,
            expect_generation,
            max_edge,
            max_bytes,
            time_budget_ms,
        } => {
            let outcome = backend.capture_image(&CaptureRequest {
                window,
                region,
                expect_generation: expect_generation.as_deref(),
                max_edge,
                max_bytes,
                budget: Duration::from_millis(time_budget_ms),
            });
            observe(req.id, outcome.map(Observation::Image))
        }
    }
}

/// 启动一条等待线程。
///
/// 等待线程自行创建后端实例，不借用执行线程的实例：后端的客户端状态可能归线程所有
/// （UIA 的 COM 单元），而跨线程共享一个客户端时，等待中的一次长调用会阻塞执行线程正在进行的调用。
fn spawn_wait<B: Backend>(req: Request, state: &Arc<State>) {
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        let response = run_wait::<B>(&state, req);
        reply(&response);
        recheck_if_refused::<B>(&response, &state);
    });
}

fn run_wait<B: Backend>(state: &State, req: Request) -> Response {
    let id = req.id.clone();
    let binding = state.binding.lock().expect("绑定锁").clone();
    let cancelled = state.cancelled.lock().expect("取消登记锁").remove(&id);
    if let Err(reason) = admit(&req, binding.as_ref(), cancelled, now_ms()) {
        return Response::rejected(id, reason.to_owned());
    }
    let Op::Wait {
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
        bounds,
    } = req.op
    else {
        return Response::rejected(id, "not_a_wait".to_owned());
    };
    let backend = match B::new() {
        Ok(b) => b,
        Err(e) => return Response::rejected(id, format!("backend_unavailable: {e}")),
    };
    if let Some((connection, transaction)) = *state.timeouts.lock().expect("超时锁") {
        if let Err(e) = backend.set_timeouts(connection, transaction) {
            return Response::rejected(id, format!("timeout_setup_failed: {e}"));
        }
    }
    let deadline = wait_deadline(timeout_ms, req.deadline, now_ms());
    let request = WaitRequest {
        window,
        until,
        reference: reference.as_deref(),
        value: value.as_deref(),
        role: role.as_deref(),
        name_contains: name_contains.as_deref(),
        root: root.as_deref(),
        name: name.as_deref(),
        poll: Duration::from_millis(poll_ms.max(1)),
        deadline,
        bounds,
        foreground: req.foreground,
    };
    let stop = || state.cancelled.lock().expect("取消登记锁").contains(&id);
    let outcome = backend.wait(&request, &stop);
    state.cancelled.lock().expect("取消登记锁").remove(&id);
    match outcome {
        Ok(observation) => Response::observed(req.id, observation),
        Err(e) => Response::rejected(req.id, e),
    }
}

/// 等待的截止时刻：取调用方给出的时长与信封中的绝对期限二者中较早的一个。
///
/// 两者都必须考虑：时长是调用方要求的等待时间，信封期限是宿主对应 pending 的上界，超过该上界
/// 再返回的回执已无人等待。
fn wait_deadline(timeout_ms: u64, envelope: Option<i64>, now: i64) -> Instant {
    let at = Instant::now();
    let own = Duration::from_millis(timeout_ms);
    let Some(envelope) = envelope else {
        return at + own;
    };
    let left = u64::try_from(envelope.saturating_sub(now)).unwrap_or(0);
    at + own.min(Duration::from_millis(left))
}

/// 只读请求的终态：读取成功即附带结果，失败则附带原因，两种都不改变状态。
fn observe(id: String, outcome: Result<Observation, String>) -> Response {
    match outcome {
        Ok(o) => Response::observed(id, o),
        Err(e) => Response::rejected(id, e),
    }
}

/// 动作请求的终态：执行事实由调用结果决定，动作后的重读单列。
///
/// 重读失败不回退执行事实：动作可能已经生效，改记为未执行会使调用方重发一次。
fn act<B: Backend>(id: String, backend: &B, state: &State, req: &ActRequest<'_>) -> Response {
    // 派发之后到达的取消必须在拖拽途中生效：准入时的登记已被取出，此处查询的是此后新增的
    // 登记。拖拽是唯一一个在派发中途仍能被中止的动作。
    let stop = || state.cancelled.lock().expect("取消登记锁").contains(&id);
    let (attempt, observed) = backend.act(req, &stop);
    state.cancelled.lock().expect("取消登记锁").remove(&id);
    action_response(id, req.window, attempt, observed)
}

fn action_response(
    id: String,
    window: i64,
    attempt: Attempt,
    observed: Result<Observation, String>,
) -> Response {
    match attempt {
        Attempt::Refused(reason) => {
            if matches!(&observed, Err(error) if error == NOT_DISPATCHED) {
                return Response::rejected(id, reason);
            }
            // 输入未派发与窗口准备已经发生可以同时成立；保留重读结果或重读失败。
            let mut response = Response::acted(id, Dispatch::NotDispatched, observed);
            response.reason = Some(reason);
            response
        }
        Attempt::Called(outcome) => {
            let mut response = Response::acted(id, outcome.dispatch, observed);
            response.reason = outcome.reason;
            // 调用未返回时用该字段代替必然超时的重读，见 `Outcome::returned`。
            if !outcome.returned {
                response.blocking = Some(outcome.windows);
                response.after_reply = Some(window);
            }
            response
        }
    }
}

/// 发送一行输入状态通报。与回执共用 stdout 的整行写出路径，两者不会在同一行中交错。
fn notify_input(notice: &InputNotice) {
    write_line(serde_json::to_string(notice));
}

/// 回执因缺少前提被拒绝（原因或重读错误以 `refused_for_grant` 的错误码开头）时实时查询一次
/// 授权事实：前提在运行中被撤销时，宿主从此处得知。先发出回执再查询，不延迟本条请求的终态。
fn recheck_if_refused<B: Backend>(response: &Response, state: &Arc<State>) {
    let refused = [&response.reason, &response.observation_error]
        .into_iter()
        .flatten()
        .any(|text| refused_for_grant(text));
    if refused {
        apply_access::<B>(state, B::access());
    }
}

/// 记录一次实时查询的结果，事实变化时发送一行通报，缺少前提且没有重查线程时启动一条。
fn apply_access<B: Backend>(state: &Arc<State>, now: Access) {
    let step = state.access.lock().expect("授权锁").observe(now);
    if let Some(changed) = &step.notify {
        report(changed);
        write_line(serde_json::to_string(&AccessNotice { access: changed }));
    }
    if step.poll {
        spawn_access_poll::<B>(Arc::clone(state));
    }
}

/// 缺少前提期间每隔 `ACCESS_POLL` 重查一次，前提齐备即停止：用户在系统设置中授权之后无需重启。
fn spawn_access_poll<B: Backend>(state: Arc<State>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(ACCESS_POLL);
        apply_access::<B>(&state, B::access());
        if !state.access.lock().expect("授权锁").keep_polling() {
            return;
        }
    });
}

/// 授权事实与未授权原因的原文写入 stderr，宿主将其转入应用日志。
fn report(access: &Access) {
    match &access.detail {
        Some(detail) => eprintln!(
            "授权 authorized={} missing={:?}：{detail}",
            access.authorized, access.missing
        ),
        None => eprintln!(
            "授权 authorized={} missing={:?}",
            access.authorized, access.missing
        ),
    }
}

/// 整行一次写出。分两次写入会使两个线程的回执在同一行中交错。
fn reply(response: &Response) {
    write_line(serde_json::to_string(response));
}

fn write_line(text: serde_json::Result<String>) {
    match text {
        Ok(mut line) => {
            line.push('\n');
            let mut out = std::io::stdout().lock();
            if let Err(e) = out.write_all(line.as_bytes()).and_then(|()| out.flush()) {
                eprintln!("写入 stdout 失败：{e}");
            }
        }
        Err(e) => eprintln!("回执序列化失败：{e}"),
    }
}

/// 只测试不涉及 OS 的判定。等待的条件判定在 `protocol.rs` 中测试，轮询收尾在 `backend.rs` 中测试。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Grant;

    #[test]
    fn refused_input_preserves_the_observation_after_window_preparation() {
        let response = action_response(
            "r1".to_owned(),
            66,
            Attempt::Refused("geometry_changed".to_owned()),
            Ok(Observation::Windows { captured_at: 1, windows: Vec::new() }),
        );
        assert_eq!(response.dispatch, Dispatch::NotDispatched);
        assert_eq!(response.reason.as_deref(), Some("geometry_changed"));
        assert!(response.observation.is_some());
    }

    #[test]
    fn refused_input_preserves_a_failed_reread_but_pure_rejection_does_not_invalidate() {
        for (error, retained) in [("provider_timeout", true), (NOT_DISPATCHED, false)] {
            let response = action_response(
                "r1".to_owned(),
                66,
                Attempt::Refused("foreground_lock".to_owned()),
                Err(error.to_owned()),
            );
            assert_eq!(response.dispatch, Dispatch::NotDispatched);
            assert_eq!(response.reason.as_deref(), Some("foreground_lock"));
            assert_eq!(response.observation_error.as_deref(), retained.then_some(error));
        }
    }

    /// 两个期限取较早的一个：调用方要求等待 10 秒而宿主的 pending 只剩 2 秒时，等待 2 秒即返回。
    #[test]
    fn the_wait_deadline_takes_whichever_comes_first() {
        let now = 1_000_000i64;
        let short = wait_deadline(10_000, Some(now + 2_000), now);
        let long = wait_deadline(10_000, Some(now + 60_000), now);
        let none = wait_deadline(10_000, None, now);
        let at = Instant::now();
        assert!(short.saturating_duration_since(at) <= Duration::from_millis(2_100));
        assert!(long.saturating_duration_since(at) > Duration::from_millis(9_000));
        assert!(none.saturating_duration_since(at) > Duration::from_millis(9_000));
    }

    /// 信封期限已过时不等待：立即到期，不再按调用方给出的时长等待。
    #[test]
    fn an_expired_envelope_leaves_no_time_to_wait() {
        let now = 1_000_000i64;
        let past = wait_deadline(10_000, Some(now - 5), now);
        assert!(past <= Instant::now() + Duration::from_millis(5));
    }

    fn access(missing: Vec<Grant>) -> Access {
        Access::of(missing, None)
    }

    /// 按事实比较，不比较原因原文，与 `Access::same` 相同。
    impl PartialEq for AccessStep {
        fn eq(&self, other: &Self) -> bool {
            let notify = match (&self.notify, &other.notify) {
                (None, None) => true,
                (Some(a), Some(b)) => a.same(b),
                _ => false,
            };
            notify && self.poll == other.poll
        }
    }

    fn step(notify: Option<Vec<Grant>>, poll: bool) -> AccessStep {
        AccessStep {
            notify: notify.map(access),
            poll,
        }
    }

    /// 撤销与恢复：握手时前提齐备则不轮询；调用被拒绝后实时查询到缺项即通报并启动重查；重查到
    /// 前提齐备即通报并停止线程；之后再次被撤销时仍能重新启动一条。
    #[test]
    fn a_revoked_grant_is_reported_and_polled_until_it_returns() {
        let mut ledger = AccessLedger::default();
        assert!(!ledger.handshake(&access(Vec::new())));
        // 实时查询结果未变化：不通报，不启动线程。
        assert_eq!(ledger.observe(access(Vec::new())), step(None, false));

        let bus = vec![Grant::AccessibilityBus];
        assert_eq!(ledger.observe(access(bus.clone())), step(Some(bus.clone()), true));
        // 重查线程运行期间又有调用被拒绝：相同的事实不重复通报，也不启动第二条线程。
        assert_eq!(ledger.observe(access(bus.clone())), step(None, false));
        assert!(ledger.keep_polling());

        assert_eq!(ledger.observe(access(Vec::new())), step(Some(Vec::new()), false));
        assert!(!ledger.keep_polling());

        assert_eq!(ledger.observe(access(bus.clone())), step(Some(bus), true));
    }

    /// 握手时已缺少前提：启动重查线程；只缺少屏幕录制权限时同样需要查询，该权限随时可能被授予。
    #[test]
    fn a_missing_grant_at_handshake_starts_the_poll_once() {
        let mut ledger = AccessLedger::default();
        let screen = vec![Grant::ScreenRecording];
        assert!(ledger.handshake(&access(vec![Grant::Accessibility, Grant::ScreenRecording])));
        assert_eq!(ledger.observe(access(screen.clone())), step(Some(screen), false));
        assert!(ledger.keep_polling());
    }

    /// 握手之前的查询结果不计入：宿主还没有可对比的基准，也没有可以通报的执行实例。
    #[test]
    fn nothing_is_reported_before_the_handshake() {
        let mut ledger = AccessLedger::default();
        assert_eq!(ledger.observe(access(vec![Grant::Accessibility])), step(None, false));
        assert!(!ledger.keep_polling());
    }

    /// 等待请求使用独立线程：`execute_all` 按此结构识别等待请求，识别错误时它会进入执行队列，
    /// 一次分钟级的等待会阻塞后续全部读树请求。
    #[test]
    fn a_wait_is_recognised_before_it_reaches_the_queue() {
        let req: Request = serde_json::from_str(
            r#"{"v":2,"id":"r1","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"wait","params":{"window":66,"until":"enabled","ref":"w.0#7",
                "pollMs":100,"timeoutMs":1000,"maxNodes":10,"maxDepth":2,"timeBudgetMs":100}}"#,
        )
        .expect("等待请求应当解析成功");
        assert!(matches!(req.op, Op::Wait { .. }));
        let read: Request = serde_json::from_str(
            r#"{"v":2,"id":"r2","hostId":"h1","hostEpoch":2,"connectionEpoch":5,
                "op":"read_tree","params":{"window":66,"maxNodes":10,"maxDepth":2,
                "timeBudgetMs":100}}"#,
        )
        .expect("读树请求应当解析成功");
        assert!(!matches!(read.op, Op::Wait { .. }));
    }
}
