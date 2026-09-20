//! 电脑控制宿主：随包的 worker 进程与服务端 `/native/desktop` 之间的那一段。
//!
//! 这一层不解释任务意图，只做四件事：管 worker 的生死、给三条身份定值、把服务端的帧
//! 翻译成 worker 请求再把回执翻回去、在 worker 没了时把在途请求按事实收尾。
//!
//! 三条身份的产生方与失效边界：
//!
//! - `hostId`：本进程启动时生成一次，进程内不变。
//! - `hostEpoch`：每换一个 worker 进程自增一次。WS 不断而 worker 被换掉时只有它变，
//!   旧观察、旧 ref 与旧队列整体作废。
//! - `connectionEpoch`：每次建立宿主 WS 自增一次，经 `bind_connection` 交给 worker，
//!   旧连接排队的动作随之被 worker 拒绝。
//!
//! 边界：**结果帧回的是请求自己带的那三项，不是宿主此刻的那三项。** 服务端按四项配对，
//! 换成当前值的话，一条跨代际的迟到回执会结算另一次调用。

mod bridge;
mod foreground;
mod frames;
mod identity;
mod input;
mod lock;
mod worker;

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::ws::WsSender;
use frames::{
    enrich_blocking, enrich_windows, needs_target, to_result, to_worker, Binding, Dispatch,
    EventFrame, HeldInput, HostReady, RequestFrame, ResultFrame, WorkerLine, WorkerRequest,
    WorkerResponse,
};
use worker::{
    cancel_outcome, cancel_targets, drain_server, next_attempt, restart_delay, CancelOutcome,
    Origin, Pending,
};

/// `externalBin` 里那个随包 worker 的名字。
const WORKER_NAME: &str = "qy-computer-host";

/// UIA 这类跨进程接口没有请求级硬上界，只能给它一个连接与事务超时。
const CONNECTION_TIMEOUT_MS: u32 = 2_000;
const TRANSACTION_TIMEOUT_MS: u32 = 2_000;

/// worker 起来之后多久还没握手成功就判它没起来。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// 退出时等 worker 自己收场的上限。超过就不等了——不能因为它卡住而拦住应用退出。
const EXIT_WAIT: Duration = Duration::from_secs(3);

/// 替换 worker 时先关 stdin，等这么久它还在就强杀。卡在 OS 调用里的进程读不到 stdin 结束。
const REPLACE_GRACE: Duration = Duration::from_secs(2);

/// 替换之后等下一代握手就绪的上限。到期仍未就绪即如实回执，不无限等。
const REPLACE_READY_WAIT: Duration = Duration::from_secs(20);

/// 轮询间隔。取消展开等在途请求终结、退出等 worker 收场都用它。
const POLL_MS: u64 = 25;

/// 进程内唯一的桌面宿主。一个 qywork 进程只持有一份桌面执行权。
static HOST: OnceLock<Arc<DesktopHost>> = OnceLock::new();

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// 操作系统有没有授予桌面控制所需的权限。
///
/// Windows 的 UIA 不需要用户授权，如实报真。宿主自身未提权时操作不了提权窗口是 UIPI
/// 的进程完整性规则，不是这一格的含义——它由动作回执里 worker 的调用失败原文表达。
///
/// macOS 的辅助功能授权与 Linux 的 AT-SPI 会话权限随各自的原生后端一起做，在那之前
/// 如实报假：这两端的 worker 现在直接以错误退出，不存在可用的桌面控制。
const fn authorized() -> bool {
    cfg!(windows)
}

const fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

struct HostState {
    sender: Option<Arc<WsSender>>,
    connection_epoch: u64,
    host_epoch: u64,
    /// 当前 worker 的写入端。`None` = 此刻没有可派发的 worker。
    link: Option<Arc<worker::WorkerLink>>,
    worker_pid: Option<u32>,
    worker_ready: bool,
    /// worker 此刻认的连接代际。它只接受严格增大的值，所以要记下来才判得出该不该发
    /// `bind_connection`：worker 起来与 WS 建连没有固定先后，握手带的可能已经是旧值。
    worker_connection_epoch: u64,
    /// 已经交给 worker 的请求，按 worker 请求 id 索引。
    pending: HashMap<String, Pending>,
    next_worker_id: u64,
    /// 握手回执的等待者。只有 worker 监督线程会登记。
    handshake: Option<(String, Sender<WorkerResponse>)>,
    /// 当前 worker 报上来的按下状态账。**它只是输入状态，不是任务状态**：
    /// 宿主按它在确认 worker 退出之后补发释放，别的判定一概不读它。
    held: HeldInput,
    /// 置上之后连接线程不再重连、监督线程不再拉起 worker。
    stopping: bool,
}

pub struct DesktopHost {
    host_id: String,
    worker_path: PathBuf,
    /// 桌面执行权。`None` = 没抢到，本进程整条电脑控制不可用，也不拉起 worker。
    /// 只按它的存活期起作用：丢弃它即释放，因此宿主活多久就要拿着它多久。
    _desktop_lock: Option<lock::DesktopLock>,
    state: Mutex<HostState>,
}

/// 拉起宿主：占桌面执行权、定位随包 worker、连上 sidecar 的宿主路径。
///
/// 失败只写日志并结束这条能力——电脑控制起不来不该拦住整个应用启动。
pub fn start(app: &AppHandle, port: u16, key: String) {
    // 与 `qy` sidecar 同一套定位：`externalBin` 的产物就在可执行文件旁边，
    // 开发态与安装态由插件自己判。不要改成自己拼路径，那是第二处声明。
    let command: std::process::Command = match app.shell().sidecar(WORKER_NAME) {
        Ok(command) => command.into(),
        Err(e) => {
            log::error!("找不到随包的 {WORKER_NAME}，电脑控制不启用：{e}");
            return;
        }
    };
    start_with_worker(PathBuf::from(command.get_program()), port, key);
}

/// 同上，但直接给 worker 可执行文件的路径。`start` 与端到端夹具共用这一条实现。
pub fn start_with_worker(worker_path: PathBuf, port: u16, key: String) -> Arc<DesktopHost> {
    let desktop_lock = match lock::acquire() {
        Ok(held) => Some(held),
        Err(reason) => {
            log::warn!("电脑控制不可用：{reason}");
            None
        }
    };
    let available = desktop_lock.is_some();
    let host = Arc::new(DesktopHost {
        host_id: crate::hostkey::new_host_key(),
        worker_path,
        _desktop_lock: desktop_lock,
        state: Mutex::new(HostState {
            sender: None,
            connection_epoch: 0,
            host_epoch: 0,
            link: None,
            worker_pid: None,
            worker_ready: false,
            worker_connection_epoch: 0,
            pending: HashMap::new(),
            next_worker_id: 0,
            handshake: None,
            held: HeldInput::default(),
            stopping: false,
        }),
    });
    // 已经起过一次时沿用第一份：桌面执行权只有一把，第二份宿主会抢不到锁而永远不可用。
    let host = match HOST.get() {
        Some(existing) => Arc::clone(existing),
        None => {
            let _ = HOST.set(Arc::clone(&host));
            host
        }
    };
    bridge::spawn(Arc::clone(&host), port, key);
    if available {
        let supervised = Arc::clone(&host);
        std::thread::spawn(move || supervise(&supervised));
    }
    host
}

/// 停掉电脑控制：先禁新派发并结清在途，再让 worker 收场，最后断开宿主连接。
///
/// 顺序不能反。先断连接的话，在途请求的收尾回执发不出去，服务端那边只剩超时，而超时
/// 一律按已派发记——一次可证明没有发出去的动作会被记成可能已经执行。
///
/// 收 worker 用的是关它的 stdin，不是杀进程：worker 的退出路径就是 stdin 结束，
/// 它会先让执行线程收完手上那一次 OS 调用。
pub fn shutdown() {
    let Some(host) = HOST.get() else { return };
    host.stop_dispatch_and_settle("qywork 正在退出");
    host.wait_for_worker_exit(EXIT_WAIT);
    let sender = {
        let mut state = host.state.lock().expect("桌面宿主状态锁被污染");
        state.sender.take()
    };
    if let Some(sender) = sender {
        sender.shutdown();
    }
}

impl DesktopHost {
    /// 当前 worker 进程的 pid。`None` = 此刻没有 worker。
    ///
    /// 端到端夹具按它定位要杀的那个进程：按可执行文件名找会命中用户自己开着的那一个。
    pub fn worker_pid(&self) -> Option<u32> {
        self.state.lock().expect("桌面宿主状态锁被污染").worker_pid
    }

    fn is_stopping(&self) -> bool {
        self.state.lock().expect("桌面宿主状态锁被污染").stopping
    }

    /// 宿主此刻的三条身份。
    fn binding(&self) -> Binding {
        let state = self.state.lock().expect("桌面宿主状态锁被污染");
        Binding {
            host_id: self.host_id.clone(),
            host_epoch: state.host_epoch,
            connection_epoch: state.connection_epoch,
        }
    }

    /// 新连接接管发送端并自增连接代际。
    fn connected(&self, sender: Arc<WsSender>) -> HostReady {
        let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
        let connection_epoch = state.open_connection();
        state.sender = Some(sender);
        HostReady {
            kind: "host.ready",
            host_id: self.host_id.clone(),
            host_epoch: state.host_epoch,
            connection_epoch,
            platform: platform(),
            worker_ready: state.worker_ready,
            authorized: authorized(),
        }
    }

    /// 断连：只放掉发送端，**不动 worker**。WS 重连与 worker 换代是两件事，
    /// 各自失效各自的那一份。
    fn disconnected(&self) {
        let sender = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.sender.take()
        };
        if let Some(sender) = sender {
            sender.shutdown();
        }
    }

    /// 把新的连接代际告诉 worker。此后它会拒绝队列里属于旧连接的动作请求。
    ///
    /// 必须在把新的 `host.ready` 发给服务端**之前**调用：服务端一收到注册帧就按新代际
    /// 发请求，而 worker 还认着旧代际，那些请求会被它按代际不符全部拒掉。
    fn rebind_worker(&self) {
        let binding = self.binding();
        let request = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            if !state.needs_rebind(binding.connection_epoch) {
                return;
            }
            let id = state.take_worker_id();
            state.pending.insert(
                id.clone(),
                Pending {
                    origin: Origin::Host,
                    written: false,
                },
            );
            WorkerRequest::bind_connection(id, &binding)
        };
        if self.write_to_worker(&request) {
            self.state
                .lock()
                .expect("桌面宿主状态锁被污染")
                .worker_connection_epoch = binding.connection_epoch;
        }
    }

    fn send_frame<T: serde::Serialize>(&self, frame: &T) {
        let sender = {
            let state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.sender.clone()
        };
        let Some(sender) = sender else { return };
        match serde_json::to_string(frame) {
            Ok(text) => {
                if let Err(e) = sender.send_text(&text) {
                    log::warn!("桌面宿主帧发送失败：{e}");
                }
            }
            Err(e) => log::error!("桌面宿主帧序列化失败：{e}"),
        }
    }

    /// 写一条请求给 worker，并把在途表里那一条标成已写出。
    ///
    /// 返回 `false` 表示这一行没有进 stdin：调用方据此按 `not_dispatched` 收尾。
    fn write_to_worker(&self, request: &WorkerRequest) -> bool {
        let Ok(line) = serde_json::to_string(request) else {
            log::error!("worker 请求序列化失败 id={}", request.id);
            self.state
                .lock()
                .expect("桌面宿主状态锁被污染")
                .pending
                .remove(&request.id);
            return false;
        };
        let link = {
            let state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.link.clone()
        };
        let Some(link) = link else {
            self.state
                .lock()
                .expect("桌面宿主状态锁被污染")
                .pending
                .remove(&request.id);
            return false;
        };
        match link.write_line(&line) {
            Ok(()) => {
                let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
                if let Some(entry) = state.pending.get_mut(&request.id) {
                    entry.written = true;
                }
                true
            }
            Err(e) => {
                log::warn!("写 worker stdin 失败：{e}");
                self.state
                    .lock()
                    .expect("桌面宿主状态锁被污染")
                    .pending
                    .remove(&request.id);
                false
            }
        }
    }

    /// 处理服务端发来的一帧。
    fn on_request(self: &Arc<Self>, raw: &str) {
        // 先解成 Value 再转 RequestFrame：字段不合法时仍要取出身份四项回执，
        // 否则服务端那条 pending 只能等到超时。
        let value: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("认不出的桌面宿主帧：{e}");
                return;
            }
        };
        let frame: RequestFrame = match serde_json::from_value(value) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("桌面宿主帧字段不合法：{e}");
                return;
            }
        };
        // 回执按请求自己带的那三项填：服务端的 pending 记的就是它发出去的那一份。
        let reply = Binding {
            host_id: frame.host_id.clone(),
            host_epoch: frame.host_epoch,
            connection_epoch: frame.connection_epoch,
        };
        let current = self.binding();
        if reply != current {
            self.send_frame(&ResultFrame::refused(
                frame.request_id.clone(),
                &reply,
                "stale_identity",
            ));
            return;
        }
        if frame.op == "cancel" {
            self.cancel_executor(&frame, &reply);
            return;
        }
        if let Err(reason) = self.dispatch(&frame, &reply) {
            self.send_frame(&ResultFrame::refused(
                frame.request_id.clone(),
                &reply,
                reason,
            ));
        }
    }

    /// 派发一条操作请求。返回 `Err(原因)` 时一帧都没写进 worker。
    fn dispatch(&self, frame: &RequestFrame, binding: &Binding) -> Result<(), String> {
        if !self
            .state
            .lock()
            .expect("桌面宿主状态锁被污染")
            .worker_ready
        {
            return Err("worker_unavailable".to_owned());
        }
        let window = if needs_target(&frame.op) {
            let target = frame
                .target
                .ok_or_else(|| "missing_target".to_owned())?;
            verify_target(target)?;
            target.window
        } else {
            0
        };
        // 前台模式的请求派发前把前台权让给 worker：用户发消息那一刻前台进程通常就是本
        // 进程，系统只允许前台进程转让这份权限。不看返回值——让不成时 worker 自己还有
        // 第二级手段，这里没有可裁决的事。
        if frame.foreground {
            if let Some(pid) = self.worker_pid() {
                foreground::grant(pid);
            }
        }
        let request = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            let id = state.take_worker_id();
            let request =
                to_worker(id.clone(), frame, binding, window).map_err(str::to_owned)?;
            state.pending.insert(
                id,
                Pending {
                    origin: Origin::Server {
                        request_id: frame.request_id.clone(),
                        executor_id: frame.executor_id.clone(),
                        binding: binding.clone(),
                    },
                    written: false,
                },
            );
            request
        };
        if self.write_to_worker(&request) {
            Ok(())
        } else {
            Err("worker_unavailable".to_owned())
        }
    }

    /// 服务端的取消是执行者级的，worker 的是按请求 id 的：这里展开成一组逐 id 取消。
    ///
    /// 回执的执行事实说的是「这个执行者名下还有没有可能正在执行的请求」：截止时刻之前
    /// 全部终结了才回 `not_dispatched`，否则回 `unknown`。服务端据此决定能不能把桌面
    /// 交给下一个执行者——交早了，两个执行者会同时在动同一个桌面。
    ///
    /// **到期仍有在途时先换掉 worker 再回执。** 卡在 provider 里的 OS 调用没有请求级上界，
    /// 而服务端那侧收到 `unknown` 之后会挡住整个桌面，解除条件只有宿主换代际。不换的话
    /// 这一挡就到应用退出为止——独立进程能整个换掉，正是它存在的理由。
    fn cancel_executor(self: &Arc<Self>, frame: &RequestFrame, binding: &Binding) {
        let requests = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            let targets = cancel_targets(&state.pending, &frame.executor_id);
            targets
                .into_iter()
                .map(|target| {
                    let id = state.take_worker_id();
                    state.pending.insert(
                        id.clone(),
                        Pending {
                            origin: Origin::Host,
                            written: false,
                        },
                    );
                    (WorkerRequest::cancel(id, binding, &target), target)
                })
                .collect::<Vec<_>>()
        };
        let watched: Vec<String> = requests.iter().map(|(_, target)| target.clone()).collect();
        for (request, _) in &requests {
            self.write_to_worker(request);
        }
        // 等在另一条线程上：读循环要继续收别的请求，等在它上面会把整条连接堵住。
        let host = Arc::clone(self);
        let request_id = frame.request_id.clone();
        let binding = binding.clone();
        let deadline = frame.deadline;
        std::thread::spawn(move || {
            let (dispatch, reason) = match host.await_settled(&watched, deadline) {
                CancelOutcome::Settled => (Dispatch::NotDispatched, "cancelled"),
                CancelOutcome::Replace => {
                    host.replace_worker("执行者取消到期仍有在途请求");
                    (Dispatch::Unknown, "worker_replaced")
                }
            };
            host.send_frame(&ResultFrame::settled(request_id, &binding, dispatch, reason));
        });
    }

    /// 等这一组 worker 请求全部终结。截止时刻之前没等到即要求换掉 worker。
    fn await_settled(&self, watched: &[String], deadline: i64) -> CancelOutcome {
        loop {
            let outstanding = {
                let state = self.state.lock().expect("桌面宿主状态锁被污染");
                watched.iter().any(|id| state.pending.contains_key(id))
            };
            if let Some(outcome) = cancel_outcome(outstanding, now_ms(), deadline) {
                return outcome;
            }
            std::thread::sleep(Duration::from_millis(POLL_MS));
        }
    }

    /// 有界地换掉当前 worker，并等下一代握手就绪。
    ///
    /// 先禁新派发并关掉 stdin——worker 的正常退出路径就是 stdin 结束；卡在 OS 调用里的
    /// 进程不会响应它，所以过了 `REPLACE_GRACE` 就强杀，且只杀本宿主起的那个 pid。
    ///
    /// 收尾与换代都不在这里做：进程一没，监督循环走的还是 `worker_gone` 那条路径
    /// （在途按事实记账、`hostEpoch` 加一、握手完成才发新的 ready），换代因此也照常计入
    /// 重启退避与上限——一个必然卡死的目标不会把 worker 无限拉起。
    fn replace_worker(&self, reason: &str) {
        let pid = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.worker_ready = false;
            state.link = None;
            state.worker_pid
        };
        let Some(pid) = pid else { return };
        log::warn!("{reason}，替换 computer-host worker pid={pid}");
        if !self.wait_until(REPLACE_GRACE, |state| state.worker_pid.is_none()) {
            worker::terminate(pid);
        }
        if !self.wait_until(REPLACE_READY_WAIT, |state| state.worker_ready) {
            log::warn!("替换后的 computer-host worker 没有在期限内就绪");
        }
    }

    /// 收一条 worker 发上来的行。宿主自己发起的那几种回执止于这里，不透到服务端。
    fn on_worker_response(&self, line: &str) {
        let mut response = match serde_json::from_str::<WorkerLine>(line) {
            Ok(WorkerLine::Response(r)) => r,
            // 按下状态账只记下来，不进回执路径：它不对应任何一条请求。
            Ok(WorkerLine::Input(notice)) => {
                self.state.lock().expect("桌面宿主状态锁被污染").held = notice.input;
                return;
            }
            Err(e) => {
                log::warn!("认不出的 worker 回执：{e}");
                return;
            }
        };
        let origin = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            if state.handshake.as_ref().is_some_and(|(id, _)| *id == response.id) {
                let (id, tx) = state.handshake.take().expect("上一行刚判过它存在");
                state.pending.remove(&id);
                drop(state);
                let _ = tx.send(response);
                return;
            }
            state.pending.remove(&response.id).map(|entry| entry.origin)
        };
        let Some(Origin::Server {
            request_id,
            binding,
            ..
        }) = origin
        else {
            if let Some(reason) = &response.reason {
                log::info!("worker 回执 {} {reason}", response.id);
            }
            return;
        };
        let observation = response.observation.take();
        let blocking = response.blocking.take();
        let mut frame = to_result(request_id, &binding, response, None);
        match observation.map(|o| self.project(o)) {
            None => {}
            Some(Ok(projected)) => frame.observation = Some(projected),
            Some(Err(reason)) => frame.observation_error = Some(reason),
        }
        // 补不上身份的窗口在这里被丢掉，与窗口清单同一条规则：目标身份少一项，
        // 句柄复用就识别不出来。
        frame.blocking = blocking.and_then(|b| enrich_blocking(&b, |handle, pid| self.identify(handle, pid)));
        self.send_frame(&frame);
    }

    /// 一个窗口的进程启动时刻与可执行文件名。句柄与 pid 对不上即认不出。
    fn identify(&self, handle: i64, pid: u32) -> Option<(i64, String)> {
        if identity::window_pid(handle)? != pid {
            return None;
        }
        let found = identity::process_identity(pid)?;
        Some((found.started_at_ms, found.app))
    }

    /// 把 worker 的观察投影成服务端协议里的形状。
    ///
    /// 窗口清单要补进程启动时刻与可执行文件名；补不上的窗口整条丢掉，不给它一个编造的
    /// 启动时刻——目标身份少一项，句柄复用就识别不出来。
    fn project(&self, observation: serde_json::Value) -> Result<serde_json::Value, String> {
        match observation.get("kind").and_then(serde_json::Value::as_str) {
            Some("windows") => enrich_windows(&observation, |handle, pid| self.identify(handle, pid))
                .ok_or_else(|| "窗口清单的字段对不上".to_owned()),
            Some("tree" | "wait" | "image" | "text") => Ok(observation),
            other => Err(format!("认不出的观察 {}", other.unwrap_or("(无 kind)"))),
        }
    }

    /// worker 没了：停派发、结清在途、把不可用发布出去。
    ///
    /// **结果帧要在状态事件之前发。** 反过来的话，服务端先收到不可用就会把自己那些
    /// pending 一律按已派发收掉，而其中可证明没写出去的那些本该记成未执行。
    fn stop_dispatch_and_settle(&self, reason: &str) {
        let settled = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.stopping = true;
            state.worker_ready = false;
            state.handshake = None;
            // 放掉写入端即关掉 worker 的 stdin，它据此退出。
            state.link = None;
            drain_server(&mut state.pending)
        };
        for (request_id, binding, dispatch) in settled {
            self.send_frame(&ResultFrame::settled(request_id, &binding, dispatch, reason));
        }
    }

    /// worker 已经退出，把它按住的键与鼠标键补一次抬起。
    ///
    /// **只有 worker 自己来不及收拾时才轮得到这里**：它正常退出与每一条中止路径都会先
    /// 释放本次按下的那一份，账随之清空；被强杀时那份账停在最后一次通报上。
    fn release_held_input(&self) {
        let held = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            std::mem::take(&mut state.held)
        };
        if held.is_empty() {
            return;
        }
        let sent = input::release(&held);
        log::warn!(
            "computer-host worker 退出时还按着 {:?} 与 {:?}，已补发 {sent} 个抬起事件",
            held.buttons,
            held.keys
        );
    }

    fn worker_gone(&self, reason: &str) {
        self.release_held_input();
        let (settled, event) = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.worker_ready = false;
            state.handshake = None;
            state.link = None;
            state.worker_pid = None;
            (
                drain_server(&mut state.pending),
                EventFrame {
                    frame: "desktop.event",
                    connection_epoch: state.connection_epoch,
                    host_id: self.host_id.clone(),
                    host_epoch: state.host_epoch,
                    kind: "worker.state",
                    worker_ready: false,
                    authorized: authorized(),
                },
            )
        };
        for (request_id, binding, dispatch) in settled {
            self.send_frame(&ResultFrame::settled(request_id, &binding, dispatch, reason));
        }
        self.send_frame(&event);
    }

    /// 等一个状态条件成立。返回它有没有在期限内成立。
    fn wait_until(&self, limit: Duration, done: impl Fn(&HostState) -> bool) -> bool {
        let until = Instant::now() + limit;
        loop {
            if done(&self.state.lock().expect("桌面宿主状态锁被污染")) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(POLL_MS));
        }
    }

    fn wait_for_worker_exit(&self, limit: Duration) {
        if !self.wait_until(limit, |state| state.worker_pid.is_none()) {
            log::warn!("worker 没有在 {limit:?} 内退出，不再等待");
        }
    }
}

/// 三条身份的代际迁移都在这里，且都只进不退。
///
/// 它们分开推进：连接代际跟着宿主 WS 走，执行实例代际跟着 worker 进程走。合成一个数
/// 的话，WS 不断而 worker 被换掉这件事就表达不出来，而那时旧 ref 与旧队列同样整体作废。
impl HostState {
    fn take_worker_id(&mut self) -> String {
        self.next_worker_id += 1;
        format!("w{}", self.next_worker_id)
    }

    /// 新建一条宿主 WS：连接代际自增。worker 认的那一个不动，它由 `bind_connection` 推进。
    fn open_connection(&mut self) -> u64 {
        self.connection_epoch += 1;
        self.connection_epoch
    }

    /// 新建一个 worker 进程：执行实例代际自增，就绪状态一并落回未就绪。
    fn open_worker(&mut self) -> u64 {
        self.host_epoch += 1;
        self.worker_ready = false;
        self.host_epoch
    }

    /// 该不该给 worker 发 `bind_connection`。worker 只接受严格增大的连接代际，
    /// 没就绪的 worker 也接不了——它的绑定要等握手才建立。
    fn needs_rebind(&self, connection_epoch: u64) -> bool {
        self.worker_ready && connection_epoch > self.worker_connection_epoch
    }
}

/// 目标窗口身份的派发前核对。
///
/// 句柄现问一次归属进程，pid 现问一次启动时刻，两项都与观察时记下的一致才派发。
/// 少了这一步，目标窗口在观察与动作之间关闭、句柄被另一个窗口复用时，动作会落在那个
/// 窗口上而不报错。
fn verify_target(target: frames::Target) -> Result<(), String> {
    if identity::window_pid(target.window) != Some(target.pid) {
        return Err("target_lost".to_owned());
    }
    let found = identity::process_identity(target.pid).ok_or("target_lost")?;
    if found.started_at_ms != target.process_started_at {
        return Err("target_lost".to_owned());
    }
    Ok(())
}

/// worker 监督循环：起一个、握手、等它退出、按退避起下一个。
///
/// 每次新建 worker 进程才分配新的 `hostEpoch`，且**确认上一个进程已经退出之后**才分配：
/// 两个 worker 同时存活会让同一个代际下出现两份执行实例。
fn supervise(host: &Arc<DesktopHost>) {
    let mut attempt = 0;
    loop {
        if host.is_stopping() {
            return;
        }
        let started = Instant::now();
        if let Err(e) = run_worker(host) {
            log::warn!("computer-host worker 未能就绪：{e}");
        }
        host.worker_gone("桌面执行组件已退出");
        if host.is_stopping() {
            return;
        }
        attempt = next_attempt(attempt, started.elapsed());
        let Some(delay) = restart_delay(attempt) else {
            log::error!("computer-host worker 连续启动失败，电脑控制不再自动重启");
            return;
        };
        log::info!("{delay:?} 后重启 computer-host worker（第 {attempt} 次）");
        std::thread::sleep(delay);
    }
}

/// 跑完一个 worker 进程的一生。返回时那个进程已经退出。
fn run_worker(host: &Arc<DesktopHost>) -> Result<(), String> {
    let spawned = worker::spawn(&host.worker_path)
        .map_err(|e| format!("拉不起 {}：{e}", host.worker_path.display()))?;
    let mut child = spawned.child;
    let pid = spawned.link.pid();
    // 作业对象按住到本函数返回为止，也就是这个 worker 进程的一生。提前丢掉它就是当场
    // 杀掉 worker：作业里最后一个句柄关闭时内核收掉作业里的全部进程。
    let _job = spawned.job;
    log::info!("computer-host worker 已启动 pid={pid}");

    // stderr 只写日志：非 Windows 的 worker 直接在这里说明它没有可用实现。
    let stderr = spawned.stderr;
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log::warn!("computer-host: {line}");
        }
    });

    // 写入端只交给宿主状态一份。这里再留一个 `Arc` 的话，退出时把它从状态里拿走也关不掉
    // worker 的 stdin——而关 stdin 正是 worker 的退出信号。
    let (binding, handshake) = begin_worker(host, Arc::new(spawned.link), pid);
    let reader = {
        let host = Arc::clone(host);
        let stdout = spawned.stdout;
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                host.on_worker_response(&line);
            }
        })
    };

    let request = WorkerRequest::handshake(
        handshake.0,
        &binding,
        CONNECTION_TIMEOUT_MS,
        TRANSACTION_TIMEOUT_MS,
    );
    let outcome = if host.write_to_worker(&request) {
        await_ready(host, &handshake.1, &binding)
    } else {
        Err("握手请求没有写进 worker stdin".to_owned())
    };
    if outcome.is_err() {
        let _ = child.kill();
    }
    // 不论成败都等这个进程真的退出：确认它没了才允许分配下一个 hostEpoch。
    let _ = child.wait();
    let _ = reader.join();
    outcome
}

/// 登记新一代 worker：分配 `hostEpoch`、接上写入端、准备握手回执的等待者。
fn begin_worker(
    host: &Arc<DesktopHost>,
    link: Arc<worker::WorkerLink>,
    pid: u32,
) -> (Binding, (String, Receiver<WorkerResponse>)) {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut state = host.state.lock().expect("桌面宿主状态锁被污染");
    let host_epoch = state.open_worker();
    state.link = Some(link);
    state.worker_pid = Some(pid);
    let id = state.take_worker_id();
    state.pending.insert(
        id.clone(),
        Pending {
            origin: Origin::Host,
            written: false,
        },
    );
    state.handshake = Some((id.clone(), tx));
    let binding = Binding {
        host_id: host.host_id.clone(),
        host_epoch,
        connection_epoch: state.connection_epoch,
    };
    (binding, (id, rx))
}

/// 等握手回执，然后把新的执行实例发布出去。
///
/// worker 没有发布就绪即不发布执行实例：那时 UIA 调用没有上界，一次调用不会有终态。
fn await_ready(
    host: &Arc<DesktopHost>,
    rx: &Receiver<WorkerResponse>,
    binding: &Binding,
) -> Result<(), String> {
    let response = rx
        .recv_timeout(HANDSHAKE_TIMEOUT)
        .map_err(|_| "worker 在超时内没有回握手".to_owned())?;
    if !response.is_ready() {
        return Err(response.reason.unwrap_or_else(|| "握手被拒".to_owned()));
    }
    let ready = {
        let mut state = host.state.lock().expect("桌面宿主状态锁被污染");
        state.worker_ready = true;
        // 握手带的是 `begin_worker` 那一刻的连接代际。WS 可能在这期间才连上并把代际推高，
        // 所以先记下 worker 实际认的那一个，再由 `rebind_worker` 补齐差值。
        state.worker_connection_epoch = binding.connection_epoch;
        HostReady {
            kind: "host.ready",
            host_id: host.host_id.clone(),
            host_epoch: binding.host_epoch,
            connection_epoch: state.connection_epoch,
            platform: platform(),
            worker_ready: true,
            authorized: authorized(),
        }
    };
    host.rebind_worker();
    // 换代走同一条 WS 上重发 `host.ready`：服务端据此作废旧执行实例名下的一切。
    host.send_frame(&ready);
    log::info!("computer-host worker 已就绪 hostEpoch={}", binding.host_epoch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> HostState {
        HostState {
            sender: None,
            connection_epoch: 0,
            host_epoch: 0,
            link: None,
            worker_pid: None,
            worker_ready: false,
            worker_connection_epoch: 0,
            pending: HashMap::new(),
            next_worker_id: 0,
            handshake: None,
            held: HeldInput::default(),
            stopping: false,
        }
    }

    /// 两条代际各自推进：换 worker 不动连接代际，重连不动执行实例代际。
    #[test]
    fn the_two_epochs_advance_independently() {
        let mut s = state();
        assert_eq!(s.open_connection(), 1);
        assert_eq!(s.open_worker(), 1);
        assert_eq!(s.open_connection(), 2);
        assert_eq!((s.host_epoch, s.connection_epoch), (1, 2));
        assert_eq!(s.open_worker(), 2);
        assert_eq!((s.host_epoch, s.connection_epoch), (2, 2));
    }

    /// 新 worker 一律从未就绪开始：握手成功之前不得发布就绪。
    #[test]
    fn a_new_worker_starts_unready() {
        let mut s = state();
        s.worker_ready = true;
        s.open_worker();
        assert!(!s.worker_ready);
    }

    #[test]
    fn rebinding_only_happens_when_the_connection_epoch_actually_advances() {
        let mut s = state();
        s.worker_connection_epoch = 3;
        // 没就绪的 worker 还没有绑定，接不了连接代际。
        assert!(!s.needs_rebind(4));
        s.worker_ready = true;
        assert!(s.needs_rebind(4));
        assert!(!s.needs_rebind(3));
        assert!(!s.needs_rebind(2));
    }

    /// worker 请求 id 只增不重复：重复的话，一条迟到的回执会认领另一次请求。
    #[test]
    fn worker_request_ids_do_not_repeat() {
        let mut s = state();
        let ids: Vec<String> = (0..3).map(|_| s.take_worker_id()).collect();
        assert_eq!(ids, vec!["w1", "w2", "w3"]);
    }

    /// 认不出的句柄一律拒派发。放行它等于让动作落到一个已经不存在的窗口的位置上。
    #[cfg(windows)]
    #[test]
    fn an_unknown_window_handle_is_refused_before_dispatch() {
        let target = frames::Target {
            window: 1,
            pid: 4,
            process_started_at: 0,
        };
        assert_eq!(verify_target(target).err().as_deref(), Some("target_lost"));
    }
}
