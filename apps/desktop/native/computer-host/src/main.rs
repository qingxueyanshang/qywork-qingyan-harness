//! 结构化桌面控制 worker。宿主经子进程 stdio 发来行分隔 JSON 请求，worker 逐条回执。
//!
//! 选 stdio 不选命名管道：stdio 随子进程一同关闭，worker 退出即 stdin 结束，宿主不需要
//! 心跳或残留端点清理；本机命名管道还要自己做访问控制，而继承来的 stdio 只有父子两端。
//!
//! 接收与执行分在两个线程：一次 OS 调用可能阻塞到 UIA 超时上界，取消消息要在那段时间里
//! 仍能被读到并登记，不能排在长调用后面。
//!
//! 每条请求都有终态：解析失败、后端不可用、通道已关闭都各自回一条 `not_dispatched`。

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
use protocol::{
    action_dispatch, admit, now_ms, Binding, HostIdentity, Observation, Op, Request, Response,
    PROTOCOL_VERSION,
};

#[cfg(windows)]
fn main() -> std::process::ExitCode {
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
/// 该条目留到下次握手被清空。
#[cfg(windows)]
#[derive(Default)]
struct State {
    binding: Mutex<Option<Binding>>,
    cancelled: Mutex<HashSet<String>>,
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
fn execute_all(rx: Receiver<Request>, state: &State) {
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
    for req in rx {
        reply(&handle(&backend, state, req));
    }
}

#[cfg(windows)]
fn handle(backend: &windows::Backend, state: &State, req: Request) -> Response {
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
                        },
                    )
                }
                // 上界设不上就不发布 ready：没有上界的 UIA 调用没有终态。
                Err(e) => Response::rejected(req.id, format!("timeout_setup_failed: {e}")),
            }
        }
        // 这两条由接收线程处理，不进执行队列。
        Op::Cancel { .. } | Op::BindConnection {} => {
            Response::rejected(req.id, "not_queued".to_owned())
        }
        Op::ListWindows {} => observe(req.id, windows::list_windows()),
        Op::ReadTree {
            window,
            max_nodes,
            max_depth,
            time_budget_ms,
        } => observe(
            req.id,
            backend.read_tree(window, max_nodes, max_depth, time_budget_ms),
        ),
        Op::ReadElement { window, reference } => {
            observe(req.id, backend.read_element(window, &reference))
        }
        Op::SetValue {
            window,
            reference,
            value,
        } => {
            let attempt = backend.set_value(window, &reference, &value);
            act(req.id, backend, window, &reference, attempt)
        }
        Op::Invoke { window, reference } => {
            let attempt = backend.invoke(window, &reference);
            act(req.id, backend, window, &reference, attempt)
        }
    }
}

/// 只读请求的终态：读到什么就带什么，读不到带原因，两种都不改变状态。
#[cfg(windows)]
fn observe(id: String, outcome: Result<Observation, String>) -> Response {
    match outcome {
        Ok(o) => Response::observed(id, o),
        Err(e) => Response::rejected(id, e),
    }
}

/// 动作请求的终态：执行事实由调用结果决定，动作后的重读单列。
///
/// 重读失败不回退执行事实——动作可能已经生效，改记未执行会让调用方重发一次。
#[cfg(windows)]
fn act(
    id: String,
    backend: &windows::Backend,
    window: i64,
    reference: &str,
    attempt: windows::Attempt,
) -> Response {
    match attempt {
        windows::Attempt::Refused(reason) => Response::rejected(id, reason),
        windows::Attempt::Called(call) => {
            let dispatch = action_dispatch(&call);
            let mut response =
                Response::acted(id, dispatch, backend.read_element(window, reference));
            if let Err(e) = call {
                response.reason = Some(e);
            }
            response
        }
    }
}

/// 整行一次写出。分两次写会让两个线程的回执在同一行里交错。
#[cfg(windows)]
fn reply(response: &Response) {
    match serde_json::to_string(response) {
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
