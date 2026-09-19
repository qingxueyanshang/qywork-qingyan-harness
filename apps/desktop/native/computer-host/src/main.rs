//! 结构化桌面控制 worker。宿主经子进程 stdio 发来行分隔 JSON 请求，worker 逐条回执。
//!
//! 选 stdio 不选命名管道：stdio 随子进程一同关闭，worker 退出即 stdin 结束，宿主不需要
//! 心跳或残留端点清理；本机命名管道还要自己做访问控制，而继承来的 stdio 只有父子两端。
//!
//! 三类线程：
//!
//! - **接收线程**：读 stdin。取消与连接代际就地处理，其余进执行队列。一次 OS 调用可能
//!   阻塞到 UIA 超时上界，取消消息要在那段时间里仍能被读到并登记。
//! - **执行线程**：一条一条跑窗口发现、读树与动作。
//! - **等待线程**：每条 `wait` 请求一条，自带 COM 单元与 UIA 客户端。等待最长可以到分钟级，
//!   放执行线程上会把同一时间的窗口发现与读树全堵住，而取消要在等待期间生效。
//!
//! 每条请求都有终态：解析失败、后端不可用、通道已关闭都各自回一条 `not_dispatched`。

#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod clipboard;
#[cfg(windows)]
mod foreground;
mod geometry;
#[cfg(windows)]
mod input;
mod protocol;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
use std::collections::HashSet;
#[cfg(windows)]
use std::io::{BufRead, Write};
#[cfg(windows)]
use std::sync::mpsc::{Receiver, Sender};
#[cfg(windows)]
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use protocol::{
    admit, now_ms, Binding, HostIdentity, InputNotice, Observation, Op, Request, Response,
    PROTOCOL_VERSION,
};

/// 本进程的 DPI 感知模式。`main` 最前面设一次，此后只读。
///
/// **必须在任何窗口矩形或 DPI 查询之前设**：设晚了，系统已经按虚拟化的坐标回答过问题，
/// 而那些答案不会重来。
#[cfg(windows)]
static DPI_PER_MONITOR_V2: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    // 按下状态账一有变化就发一行：宿主按最后一次通报在确认 worker 退出之后补发释放。
    // 注册要在任何请求进来之前做完，漏一次通报就漏一次释放。
    input::on_change(|held| notify_input(&InputNotice::of(held)));
    // 起来先报一次空账：宿主据此知道这一代 worker 手上什么都没按住。
    notify_input(&InputNotice::of(input::held()));
    let per_monitor_v2 = capture::set_per_monitor_v2();
    let _ = DPI_PER_MONITOR_V2.set(per_monitor_v2);
    // 宿主把 worker 的 stderr 转进应用日志：图像几何对不上时，这一行说得出是哪一档
    // DPI 感知、有几台显示器、虚拟桌面的原点在哪。
    eprintln!("dpi per_monitor_v2={per_monitor_v2} displays {}", capture::monitor_report());
    serve()
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("qy-computer-host 只实现了 Windows 后端，当前平台没有可用实现");
    std::process::ExitCode::FAILURE
}

/// worker 的全部跨线程状态。
///
/// 取消登记按 requestId 记，执行线程取到目标请求时一并移除；目标请求始终没有到达时，
/// 该条目留到下次握手被清空。等待中的请求例外：它在派发之后才可能被取消，由等待线程
/// 每轮查一次并在收尾时移除。
#[cfg(windows)]
#[derive(Default)]
struct State {
    binding: Mutex<Option<Binding>>,
    cancelled: Mutex<HashSet<String>>,
    /// 宿主握手时给的 UIA 调用上界。等待线程自建客户端时要用同一份。
    timeouts: Mutex<Option<(u32, u32)>>,
}

#[cfg(windows)]
fn serve() -> std::process::ExitCode {
    let state = Arc::new(State::default());
    let (tx, rx) = std::sync::mpsc::channel::<Request>();
    let executor_state = Arc::clone(&state);
    let executor = std::thread::spawn(move || execute_all(rx, &executor_state));

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
    drop(tx);
    let _ = executor.join();
    std::process::ExitCode::SUCCESS
}

/// 接收线程：解析一行，取消就地处理，其余进执行队列。
#[cfg(windows)]
fn intake(line: &str, state: &State, tx: &Sender<Request>) {
    if line.trim().is_empty() {
        return;
    }
    // 先解成 Value 再转 Request：字段不合法时仍要取出 id 回执，否则宿主那条 pending
    // 没有终态。
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
    // 取消与连接代际更新都在这条线程上就地完成：它们要在一次长 OS 调用进行期间生效，
    // 排进执行队列就会跟在那条调用后面。
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

#[cfg(windows)]
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

/// 推进连接代际。此后队列里属于旧代际的请求会在准入时被拒，动作不会被派发。
#[cfg(windows)]
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

#[cfg(windows)]
fn execute_all(rx: Receiver<Request>, state: &Arc<State>) {
    let backend = match windows::Backend::new() {
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
    // 采集器建不起来不拦住整条 worker：结构化观察与动作不碰它，只有采集请求要如实报错。
    let capturer = capture::Capturer::new();
    if let Err(e) = &capturer {
        eprintln!("图像采集不可用：{e}");
    }
    for req in rx {
        // 等待自带线程：它可能要等到分钟级，留在这条线程上会把后面的读树一并堵住。
        if matches!(req.op, Op::Wait { .. }) {
            spawn_wait(req, state);
            continue;
        }
        let response = handle(&backend, capturer.as_ref(), state, req);
        let drain = response.after_reply;
        reply(&response);
        // 回执先出去，再付这一次 provider 重连的代价：放回执之前付的话，一次点开模态框的
        // 动作要等满连接超时才回得了。
        if let Some(window) = drain {
            backend.drain_provider(window);
        }
    }
}

#[cfg(windows)]
fn handle(
    backend: &windows::Backend,
    capturer: Result<&capture::Capturer, &String>,
    state: &State,
    req: Request,
) -> Response {
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
                    Response::observed(
                        req.id,
                        Observation::Ready {
                            protocol: PROTOCOL_VERSION,
                            backend: windows::BACKEND,
                            host_id: bound.host.host_id,
                            host_epoch: bound.host.host_epoch,
                            connection_timeout_ms: connection,
                            transaction_timeout_ms: transaction,
                            dpi_per_monitor_v2: dpi_per_monitor_v2(),
                        },
                    )
                }
                // 上界设不上就不发布 ready：没有上界的 UIA 调用没有终态。
                Err(e) => Response::rejected(req.id, format!("timeout_setup_failed: {e}")),
            }
        }
        // 这两条由接收线程处理，等待由自己的线程处理，都不该走到这里。
        Op::Cancel { .. } | Op::BindConnection {} | Op::Wait { .. } => {
            Response::rejected(req.id, "not_queued".to_owned())
        }
        Op::ListWindows {} => observe(req.id, windows::list_windows()),
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
            point,
            expect_generation,
            action,
            bounds,
        } => act(
            req.id,
            backend,
            state,
            &windows::ActRequest {
                window,
                reference: reference.as_deref(),
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
            // per-monitor v2 没设上时窗口矩形被系统虚拟化过，采到的图与控件包围盒不在
            // 同一套坐标上。交一张对不上号的图比不交更糟，所以这里直接拒。
            if !dpi_per_monitor_v2() {
                return Response::rejected(
                    req.id,
                    "dpi_awareness_unset: 进程不是 per-monitor v2 DPI 感知，图像几何不可信"
                        .to_owned(),
                );
            }
            let outcome = match capturer {
                Ok(capturer) => capturer.capture(&capture::CaptureRequest {
                    window,
                    region,
                    expect_generation: expect_generation.as_deref(),
                    max_edge,
                    max_bytes,
                    budget: Duration::from_millis(time_budget_ms),
                }),
                Err(e) => Err(format!("backend_unavailable: {e}")),
            };
            observe(req.id, outcome.map(Observation::Image))
        }
    }
}

/// 本进程的 DPI 感知模式。`main` 没跑过（单测进程）时按未设记。
#[cfg(windows)]
fn dpi_per_monitor_v2() -> bool {
    DPI_PER_MONITOR_V2.get().copied().unwrap_or(false)
}

/// 起一条等待线程。
///
/// 它自建 COM 单元与 UIA 客户端，不借执行线程那一份：COM 单元属于线程，而跨线程共享
/// 一个客户端会让等待里的一次长调用挡住执行线程手上那一次。
#[cfg(windows)]
fn spawn_wait(req: Request, state: &Arc<State>) {
    let state = Arc::clone(state);
    std::thread::spawn(move || reply(&run_wait(&state, req)));
}

#[cfg(windows)]
fn run_wait(state: &State, req: Request) -> Response {
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
        select,
        name,
        poll_ms,
        timeout_ms,
        bounds,
    } = req.op
    else {
        return Response::rejected(id, "not_a_wait".to_owned());
    };
    let backend = match windows::Backend::new() {
        Ok(b) => b,
        Err(e) => return Response::rejected(id, format!("backend_unavailable: {e}")),
    };
    if let Some((connection, transaction)) = *state.timeouts.lock().expect("超时锁") {
        if let Err(e) = backend.set_timeouts(connection, transaction) {
            return Response::rejected(id, format!("timeout_setup_failed: {e}"));
        }
    }
    let deadline = wait_deadline(timeout_ms, req.deadline, now_ms());
    let request = windows::WaitRequest {
        window,
        until,
        reference: reference.as_deref(),
        value: value.as_deref(),
        select: &select,
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

/// 等待的截止时刻：调用方给的时长与信封里的绝对期限取先到的那个。
///
/// 两个都要看：时长是调用方要等多久，信封期限是宿主那条 pending 的上界，超过它再返回的
/// 回执没有人在等。
#[cfg(windows)]
fn wait_deadline(timeout_ms: u64, envelope: Option<i64>, now: i64) -> Instant {
    let at = Instant::now();
    let own = Duration::from_millis(timeout_ms);
    let Some(envelope) = envelope else {
        return at + own;
    };
    let left = u64::try_from(envelope.saturating_sub(now)).unwrap_or(0);
    at + own.min(Duration::from_millis(left))
}

/// 只读请求的终态：读到什么就带什么，读不到带原因，两种都不改变状态。
#[cfg(windows)]
fn observe(id: String, outcome: Result<Observation, String>) -> Response {
    match outcome {
        Ok(o) => Response::observed(id, o),
        Err(e) => Response::rejected(id, e),
    }
}

/// 动作请求的终态：执行事实由调用结果决定，动作后的子树重读单列。
///
/// 重读失败不回退执行事实——动作可能已经生效，改记未执行会让调用方重发一次。
#[cfg(windows)]
fn act(
    id: String,
    backend: &windows::Backend,
    state: &State,
    req: &windows::ActRequest<'_>,
) -> Response {
    // 派发之后到达的取消要在拖拽途中生效：准入那一刻的登记已经被取走，这里查的是
    // 此后新登记的那一条。拖拽是唯一一个在派发中途还能被中止的动作。
    let stop = || state.cancelled.lock().expect("取消登记锁").contains(&id);
    let (attempt, observed) = backend.act(req, &stop);
    state.cancelled.lock().expect("取消登记锁").remove(&id);
    match attempt {
        windows::Attempt::Refused(reason) => Response::rejected(id, reason),
        windows::Attempt::Called(outcome) => {
            let mut response = Response::acted(id, outcome.dispatch, observed);
            response.reason = outcome.reason;
            if let Some(text) = outcome.text {
                response.delivery = Some(text.method);
                response.clipboard_restored = text.clipboard_restored;
            }
            // 调用没返回时这一格替掉那次必然超时的重读，见 `Outcome::returned`。
            if !outcome.returned {
                response.blocking = Some(outcome.windows);
                response.after_reply = Some(req.window);
            }
            response
        }
    }
}

/// 发一行输入状态通报。与回执共用 stdout 的整行写出路径，两者不会在同一行里交错。
#[cfg(windows)]
fn notify_input(notice: &InputNotice) {
    write_line(serde_json::to_string(notice));
}

/// 整行一次写出。分两次写会让两个线程的回执在同一行里交错。
#[cfg(windows)]
fn reply(response: &Response) {
    write_line(serde_json::to_string(response));
}

#[cfg(windows)]
fn write_line(text: serde_json::Result<String>) {
    match text {
        Ok(mut line) => {
            line.push('\n');
            let mut out = std::io::stdout().lock();
            if let Err(e) = out.write_all(line.as_bytes()).and_then(|()| out.flush()) {
                eprintln!("写 stdout 失败：{e}");
            }
        }
        Err(e) => eprintln!("回执序列化失败：{e}"),
    }
}

/// 只测不碰 OS 的那几条判定。等待的条件判定在 `protocol.rs`，子树筛选在 `windows.rs`。
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 两个期限取先到的那个：调用方要等 10 秒而宿主的 pending 只剩 2 秒时，等到 2 秒就回。
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

    /// 信封期限已经过去时不等：立刻到期，不按调用方给的时长再等一轮。
    #[test]
    fn an_expired_envelope_leaves_no_time_to_wait() {
        let now = 1_000_000i64;
        let past = wait_deadline(10_000, Some(now - 5), now);
        assert!(past <= Instant::now() + Duration::from_millis(5));
    }

    /// 等待请求走自己的线程：`execute_all` 按这个形状认它，认错就会排进执行队列，
    /// 一次分钟级的等待会把后面的读树全堵住。
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
