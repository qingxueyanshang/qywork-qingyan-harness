//! 电脑控制宿主：位于随包的 worker 进程与服务端 `/native/desktop` 之间。
//!
//! 本模块不解释任务意图，只负责四件事：管理 worker 的生命周期、确定三条身份的值、把服务端的帧
//! 翻译为 worker 请求并把回执翻译回去、在 worker 退出时把在途请求按事实收尾。
//!
//! 三条身份的产生方与失效边界：
//!
//! - `hostId`：本进程启动时生成一次，进程内不变。
//! - `hostEpoch`：每更换一个 worker 进程自增一次。WS 未断开而 worker 被更换时只有它变化，
//!   旧观察、旧 ref 与旧队列整体作废。
//! - `connectionEpoch`：每次建立宿主 WS 自增一次，经 `bind_connection` 交给 worker，
//!   旧连接上排队的动作随之被 worker 拒绝。
//!
//! 边界：**结果帧返回请求自身携带的三项身份，而不是宿主当前的三项身份。** 服务端按四项配对，
//! 改用当前值时，一条跨代际的迟到回执会结算另一次调用。

mod bridge;
#[cfg(windows)]
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

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::ws::WsSender;
use frames::{
    needs_target, relay, to_worker, Access, Binding, Dispatch,
    EventFrame, HeldInput, HostReady, RequestFrame, ResultFrame, WorkerLine, WorkerRequest,
    WorkerResponse,
};
use crate::restart::{next_attempt, restart_delay};
use worker::{cancel_outcome, cancel_targets, drain_server, CancelOutcome, Origin, Pending};

/// `externalBin` 中随包 worker 的名称。
const WORKER_NAME: &str = "qy-computer-host";

/// UIA 等跨进程接口没有请求级硬上界，只能为其设置连接与事务超时。
const CONNECTION_TIMEOUT_MS: u32 = 2_000;
const TRANSACTION_TIMEOUT_MS: u32 = 2_000;

/// worker 启动后在此时限内未握手成功即判定启动失败。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// 退出时等待 worker 自行结束的上限。超过即不再等待：不能因其无响应而阻止应用退出。
const EXIT_WAIT: Duration = Duration::from_secs(3);

/// 替换 worker 时先关闭 stdin，等待该时长后仍未退出即强制终止。worker 读到 stdin 结束即退出进程，
/// 强制终止只用于进程退出未在期限内完成的情形。
const REPLACE_GRACE: Duration = Duration::from_secs(2);

/// 替换之后等待下一代 worker 握手就绪的上限。到期仍未就绪即如实回执，不无限等待。
const REPLACE_READY_WAIT: Duration = Duration::from_secs(20);

/// 轮询间隔。取消展开时等待在途请求终结、退出时等待 worker 结束都使用该值。
const POLL_MS: u64 = 25;

/// 进程内唯一的桌面宿主。一个 qywork 进程只持有一份桌面执行权。
static HOST: OnceLock<Arc<DesktopHost>> = OnceLock::new();

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
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
    /// 当前 worker 的写入端。`None` 表示当前没有可派发的 worker。
    link: Option<Arc<worker::WorkerLink>>,
    worker_pid: Option<u32>,
    worker_ready: bool,
    /// 当前 worker 最后一次上报的授权事实。没有 worker 时为缺省值：不授权、不列缺项。
    access: Access,
    /// worker 当前使用的连接代际。worker 只接受严格增大的值，因此必须记录该值才能判定是否发送
    /// `bind_connection`：worker 启动与 WS 建立连接没有固定先后，握手携带的可能已经是旧值。
    worker_connection_epoch: u64,
    /// 已经交给 worker 的请求，按 worker 请求 id 索引。
    pending: HashMap<String, Pending>,
    next_worker_id: u64,
    /// 握手回执的等待者。只有 worker 监督线程会登记。
    handshake: Option<(String, Sender<WorkerResponse>)>,
    /// 当前 worker 上报的按下状态。**它只是输入状态，不是任务状态**：
    /// 宿主在确认 worker 退出之后据此补发释放，其他判定一律不读取该字段。
    held: HeldInput,
    /// 置位后连接线程不再重连，监督线程不再启动 worker。
    stopping: bool,
}

pub struct DesktopHost {
    host_id: String,
    worker_path: PathBuf,
    /// 桌面执行权。`None` 表示未取得，本进程的电脑控制整体不可用，也不启动 worker。
    /// 只在其生命周期内有效：丢弃即释放，因此宿主必须在整个存活期间持有它。
    _desktop_lock: Option<lock::DesktopLock>,
    state: Mutex<HostState>,
}

/// 启动宿主：占用桌面执行权、定位随包 worker、连接 sidecar 的宿主路径。
///
/// 失败时只写日志并停用该能力：电脑控制无法启动时不应阻止整个应用启动。
pub fn start(app: &AppHandle, port: u16, key: String) {
    // 与 `qy` sidecar 使用同一套定位方式：`externalBin` 的产物位于可执行文件旁，
    // 开发态与安装态由插件自行判定。不要改为自行拼接路径，那会形成第二处声明。
    let command: std::process::Command = match app.shell().sidecar(WORKER_NAME) {
        Ok(command) => command.into(),
        Err(e) => {
            log::error!("未找到随包的 {WORKER_NAME}，电脑控制未启用：{e}");
            return;
        }
    };
    start_with_worker(PathBuf::from(command.get_program()), port, key);
}

/// 同上，但直接传入 worker 可执行文件的路径。`start` 与端到端夹具共用该实现。
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
            access: Access::default(),
            worker_connection_epoch: 0,
            pending: HashMap::new(),
            next_worker_id: 0,
            handshake: None,
            held: HeldInput::default(),
            stopping: false,
        }),
    });
    // 已启动过时沿用第一个实例：桌面执行权只有一份，第二个宿主无法取得锁而始终不可用。
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

/// 停止电脑控制：先禁止新的派发并结清在途请求，再让 worker 结束，最后断开宿主连接。
///
/// 顺序不能颠倒。先断开连接时，在途请求的收尾回执无法发出，服务端只能等待超时，而超时
/// 一律按已派发记录：一次可证明未发出的动作会被记录为可能已经执行。
///
/// 结束 worker 的方式是关闭其 stdin，而不是终止进程：worker 读到 stdin 结束即退出进程，
/// 不等待执行线程正在进行的 OS 调用；它按住的键由 `worker_gone` 按最后一次通报补发抬起。
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
    /// 当前 worker 进程的 pid。`None` 表示当前没有 worker。
    ///
    /// 端到端夹具据此定位要终止的进程：按可执行文件名查找会命中用户自行运行的进程。
    pub fn worker_pid(&self) -> Option<u32> {
        self.state.lock().expect("桌面宿主状态锁被污染").worker_pid
    }

    fn is_stopping(&self) -> bool {
        self.state.lock().expect("桌面宿主状态锁被污染").stopping
    }

    /// 宿主当前的三条身份。
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
            // 握手回执在就绪之前记录授权事实，就绪之前不发布该事实。
            access: if state.worker_ready {
                state.access.clone()
            } else {
                Access::default()
            },
        }
    }

    /// 断开连接：只释放发送端，**不改变 worker**。WS 重连与 worker 更替是两件独立的事，
    /// 各自只使对应的状态失效。
    fn disconnected(&self) {
        let sender = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.sender.take()
        };
        if let Some(sender) = sender {
            sender.shutdown();
        }
    }

    /// 把新的连接代际通知 worker。此后 worker 会拒绝队列中属于旧连接的动作请求。
    ///
    /// 必须在把新的 `host.ready` 发给服务端**之前**调用：服务端收到注册帧后即按新代际
    /// 发送请求，而 worker 仍使用旧代际时，会以代际不符为由拒绝全部请求。
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

    /// 向 worker 写入一条请求，并把在途表中的对应条目标记为已写出。
    ///
    /// 返回 `false` 表示该行未写入 stdin：调用方据此按 `not_dispatched` 收尾。
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
                log::warn!("写入 worker stdin 失败：{e}");
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
        // 先解析为 Value 再转换为 RequestFrame：字段不合法时仍需取出身份四项用于回执，
        // 否则服务端对应的 pending 只能等到超时。
        let value: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("无法识别的桌面宿主帧：{e}");
                return;
            }
        };
        let frame = match RequestFrame::deserialize(&value) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("桌面宿主帧字段不合法：{e}");
                if let Some((request_id, reply)) = RequestFrame::identity(&value) {
                    self.send_frame(&ResultFrame::refused(
                        request_id,
                        &reply,
                        format!("bad_request: {e}"),
                    ));
                }
                return;
            }
        };
        // 回执按请求自身携带的三项身份填写：服务端的 pending 记录的正是它发出的身份。
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

    /// 派发一条操作请求。返回 `Err(原因)` 时未向 worker 写入任何帧。
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
        // 前台模式的请求在派发前把前台权限转让给 worker：用户发送消息时前台进程通常是本
        // 进程，系统只允许前台进程转让该权限。不检查返回值：转让失败时 worker 自身还有
        // 第二级手段，此处没有需要裁决的事项。只有 Windows 有该机制，见 `foreground`。
        #[cfg(windows)]
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

    /// 服务端的取消以执行者为单位，worker 的取消以请求 id 为单位：此处展开为一组逐 id 取消。
    ///
    /// 回执的执行事实表示该执行者名下是否还有可能正在执行的请求：截止时刻之前
    /// 全部终结才返回 `not_dispatched`，否则返回 `unknown`。服务端据此决定能否把桌面
    /// 交给下一个执行者：过早移交会使两个执行者同时操作同一个桌面。
    ///
    /// **到期仍有在途请求时先替换 worker 再回执。** 阻塞于 provider 的 OS 调用没有请求级上界，
    /// 而服务端收到 `unknown` 之后会锁定整个桌面，唯一的解除条件是宿主更换代际。不替换时
    /// 锁定将持续到应用退出；worker 作为独立进程可以整体替换，这正是其存在的原因。
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
        // 在另一条线程上等待：读循环需要继续接收其他请求，在读循环上等待会阻塞整条连接。
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

    /// 等待该组 worker 请求全部终结。截止时刻之前未全部终结即要求替换 worker。
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

    /// 在有限时间内替换当前 worker，并等待下一代 worker 握手就绪。
    ///
    /// 先禁止新的派发并关闭 stdin：worker 读到 stdin 结束即退出进程，执行线程阻塞于 OS 调用时
    /// 同样如此；超过 `REPLACE_GRACE` 仍未退出即强制终止，且只终止本宿主启动的 pid。
    ///
    /// 收尾与代际更替都不在此处执行：进程退出后，监督循环仍经由 `worker_gone` 路径处理
    /// （在途请求按事实记录、`hostEpoch` 加一、握手完成后才发送新的 ready），因此更替同样计入
    /// 重启退避与上限：一个必然无响应的目标不会使 worker 被无限重启。
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
            log::warn!("替换后的 computer-host worker 未在期限内就绪");
        }
    }

    /// 接收 worker 上报的一行。宿主自行发起的几种请求的回执在此处终止，不传给服务端。
    fn on_worker_response(&self, line: &str) {
        let response = match serde_json::from_str::<WorkerLine>(line) {
            Ok(WorkerLine::Response(r)) => r,
            // 按下状态只记录，不进入回执路径：它不对应任何请求。
            Ok(WorkerLine::Input(notice)) => {
                self.state.lock().expect("桌面宿主状态锁被污染").held = notice.input;
                return;
            }
            Ok(WorkerLine::Access(notice)) => {
                self.access_changed(notice.access);
                return;
            }
            Err(e) => {
                log::warn!("无法识别的 worker 回执：{e}");
                return;
            }
        };
        let origin = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            if state.handshake.as_ref().is_some_and(|(id, _)| *id == response.id) {
                let (id, tx) = state.handshake.take().expect("上一行已确认其存在");
                state.pending.remove(&id);
                // 授权事实在读取 stdout 的线程上按行序记录：之后的授权通报必定排在其后。
                if let Some(access) = response.ready_access() {
                    state.access = access;
                }
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
        let frame = relay(request_id, &binding, response, |handle, pid| self.identify(handle, pid));
        self.send_frame(&frame);
    }

    /// 授权事实发生变化：记录该事实，worker 已就绪时发送一条状态事件。
    ///
    /// 尚未就绪时只记录不发送：随后的 `host.ready` 携带的就是该事实。
    fn access_changed(&self, access: Access) {
        let event = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.access = access;
            state.worker_ready.then(|| EventFrame {
                frame: "desktop.event",
                connection_epoch: state.connection_epoch,
                host_id: self.host_id.clone(),
                host_epoch: state.host_epoch,
                kind: "worker.state",
                worker_ready: true,
                access: state.access.clone(),
            })
        };
        if let Some(event) = event {
            log::info!(
                "computer-host 授权变化 authorized={} missing={:?}",
                event.access.authorized,
                event.access.missing
            );
            self.send_frame(&event);
        }
    }

    /// 一个窗口的进程启动时刻与可执行文件名。Windows 上句柄与 pid 不一致即无法识别。
    ///
    /// 其他平台上窗口的所属进程只有 worker 的窗口清单这一个来源（X11 的 `_NET_WM_PID` 或 X-Resource、AX 的
    /// `AXUIElementGetPid`），宿主不另行查询。
    #[cfg_attr(not(windows), allow(unused_variables))]
    fn identify(&self, handle: i64, pid: u32) -> Option<(i64, String)> {
        #[cfg(windows)]
        if identity::window_pid(handle)? != pid {
            return None;
        }
        let found = identity::process_identity(pid)?;
        Some((found.started_at_ms, found.app))
    }

    /// worker 退出时：停止派发、结清在途请求、发布不可用状态。
    ///
    /// **结果帧必须在状态事件之前发送。** 顺序相反时，服务端先收到不可用状态，会把其
    /// pending 一律按已派发结算，而其中可证明未写出的请求应记录为未执行。
    fn stop_dispatch_and_settle(&self, reason: &str) {
        let settled = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.stopping = true;
            state.worker_ready = false;
            state.handshake = None;
            // 释放写入端即关闭 worker 的 stdin，worker 据此退出。
            state.link = None;
            drain_server(&mut state.pending)
        };
        for (request_id, binding, dispatch) in settled {
            self.send_frame(&ResultFrame::settled(request_id, &binding, dispatch, reason));
        }
    }

    /// worker 已退出，为其按住的键与鼠标键补发一次抬起。
    ///
    /// **只有 worker 未能自行清理时才会执行到此处**：worker 正常退出与每一条中止路径都会先
    /// 释放本次按下的键，记录随之清空；被强制终止时记录停留在最后一次通报的状态。
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
            "computer-host worker 退出时仍按住 {:?} 与 {:?}，已补发 {sent} 个抬起事件",
            held.buttons,
            held.keys
        );
    }

    fn worker_gone(&self, reason: &str) {
        self.release_held_input();
        let (settled, event) = {
            let mut state = self.state.lock().expect("桌面宿主状态锁被污染");
            state.worker_ready = false;
            state.access = Access::default();
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
                    access: Access::default(),
                },
            )
        };
        for (request_id, binding, dispatch) in settled {
            self.send_frame(&ResultFrame::settled(request_id, &binding, dispatch, reason));
        }
        self.send_frame(&event);
    }

    /// 等待状态条件成立。返回该条件是否在期限内成立。
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
            log::warn!("worker 未在 {limit:?} 内退出，不再等待");
        }
    }
}

/// 三条身份的代际迁移都在此处，且只增不减。
///
/// 它们分别推进：连接代际随宿主 WS 变化，执行实例代际随 worker 进程变化。合并为一个数值
/// 时，无法表达 WS 未断开而 worker 被更换的情形，而此时旧 ref 与旧队列同样整体作废。
impl HostState {
    fn take_worker_id(&mut self) -> String {
        self.next_worker_id += 1;
        format!("w{}", self.next_worker_id)
    }

    /// 新建一条宿主 WS：连接代际自增。worker 使用的连接代际不变，由 `bind_connection` 推进。
    fn open_connection(&mut self) -> u64 {
        self.connection_epoch += 1;
        self.connection_epoch
    }

    /// 新建一个 worker 进程：执行实例代际自增，就绪状态同时重置为未就绪。
    fn open_worker(&mut self) -> u64 {
        self.host_epoch += 1;
        self.worker_ready = false;
        self.host_epoch
    }

    /// 是否需要向 worker 发送 `bind_connection`。worker 只接受严格增大的连接代际，
    /// 未就绪的 worker 也无法接受：其绑定在握手后才建立。
    fn needs_rebind(&self, connection_epoch: u64) -> bool {
        self.worker_ready && connection_epoch > self.worker_connection_epoch
    }
}

/// 目标窗口身份的派发前核对。
///
/// 用 pid 实时查询一次启动时刻，与观察时记录的一致才派发；Windows 上还要实时查询一次句柄的所属进程。
/// 缺少这一步时，若目标窗口在观察与动作之间关闭、句柄被另一个窗口复用，动作会作用于该
/// 窗口而不报错。
///
/// 其他平台不实时查询句柄的所属进程：窗口 → 进程只有 worker 的窗口清单这一个来源，服务端按清单中的
/// 句柄、pid 与启动时刻三项登记窗口，下一份清单中三项不一致的旧编号在服务端即被拒绝。
/// 无法核对的情形只有一种：清单重新读取之前，X11 窗口号被另一个进程复用，而原所属进程仍在运行。
fn verify_target(target: frames::Target) -> Result<(), String> {
    #[cfg(windows)]
    if identity::window_pid(target.window) != Some(target.pid) {
        return Err("target_lost".to_owned());
    }
    let found = identity::process_identity(target.pid).ok_or("target_lost")?;
    if found.started_at_ms != target.process_started_at {
        return Err("target_lost".to_owned());
    }
    Ok(())
}

/// worker 监督循环：启动 worker、握手、等待其退出、按退避启动下一个。
///
/// 只在新建 worker 进程时分配新的 `hostEpoch`，且**在确认上一个进程已经退出之后**才分配：
/// 两个 worker 同时存在会使同一代际下出现两个执行实例。
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

/// 执行一个 worker 进程的完整生命周期。返回时该进程已经退出。
fn run_worker(host: &Arc<DesktopHost>) -> Result<(), String> {
    let spawned = worker::spawn(&host.worker_path)
        .map_err(|e| format!("无法启动 {}：{e}", host.worker_path.display()))?;
    let mut child = spawned.child;
    let pid = spawned.link.pid();
    // 作业对象一直持有到本函数返回，即该 worker 进程的整个生命周期。提前丢弃它会立即
    // 终止 worker：作业的最后一个句柄关闭时，内核终止作业中的全部进程。
    #[cfg(windows)]
    let _job = spawned.job;
    log::info!("computer-host worker 已启动 pid={pid}");

    // stderr 只写日志：后端无法启动的原因与缺少的授权前提都从这里输出。
    let stderr = spawned.stderr;
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log::warn!("computer-host: {line}");
        }
    });

    // 写入端只在宿主状态中保留一份。此处再保留一个 `Arc` 时，退出时从状态中取走它也无法关闭
    // worker 的 stdin，而关闭 stdin 正是 worker 的退出信号。
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
        Err("握手请求未写入 worker stdin".to_owned())
    };
    if outcome.is_err() {
        let _ = child.kill();
    }
    // 无论成败都等待该进程实际退出：确认其已退出后才允许分配下一个 hostEpoch。
    let _ = child.wait();
    let _ = reader.join();
    outcome
}

/// 登记新一代 worker：分配 `hostEpoch`、接入写入端、准备握手回执的等待者。
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

/// 等待握手回执，然后发布新的执行实例。
///
/// worker 未发布就绪时不发布执行实例：此时 UIA 调用没有上界，调用无法保证有终态。
fn await_ready(
    host: &Arc<DesktopHost>,
    rx: &Receiver<WorkerResponse>,
    binding: &Binding,
) -> Result<(), String> {
    let response = rx
        .recv_timeout(HANDSHAKE_TIMEOUT)
        .map_err(|_| "worker 未在超时前返回握手回执".to_owned())?;
    if !response.is_ready() {
        return Err(response.reason.unwrap_or_else(|| "握手被拒绝".to_owned()));
    }
    // 授权事实已由读取 stdout 的线程按行序记录（`on_worker_response`），此处只核对其存在。
    if response.ready_access().is_none() {
        return Err("握手回执缺少授权事实".to_owned());
    }
    let ready = {
        let mut state = host.state.lock().expect("桌面宿主状态锁被污染");
        state.worker_ready = true;
        // 握手携带的是 `begin_worker` 时刻的连接代际。WS 可能在此期间才建立连接并推高代际，
        // 因此先记录 worker 实际使用的代际，再由 `rebind_worker` 补齐差值。
        state.worker_connection_epoch = binding.connection_epoch;
        HostReady {
            kind: "host.ready",
            host_id: host.host_id.clone(),
            host_epoch: binding.host_epoch,
            connection_epoch: state.connection_epoch,
            platform: platform(),
            worker_ready: true,
            access: state.access.clone(),
        }
    };
    host.rebind_worker();
    // 代际更替时在同一条 WS 上重发 `host.ready`：服务端据此作废旧执行实例名下的全部状态。
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
            access: Access::default(),
            worker_connection_epoch: 0,
            pending: HashMap::new(),
            next_worker_id: 0,
            handshake: None,
            held: HeldInput::default(),
            stopping: false,
        }
    }

    /// 两条代际各自推进：更换 worker 不改变连接代际，重连不改变执行实例代际。
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
        // 未就绪的 worker 尚未建立绑定，无法接受连接代际。
        assert!(!s.needs_rebind(4));
        s.worker_ready = true;
        assert!(s.needs_rebind(4));
        assert!(!s.needs_rebind(3));
        assert!(!s.needs_rebind(2));
    }

    /// worker 请求 id 只增不重复：重复时，一条迟到的回执会认领另一次请求。
    #[test]
    fn worker_request_ids_do_not_repeat() {
        let mut s = state();
        let ids: Vec<String> = (0..3).map(|_| s.take_worker_id()).collect();
        assert_eq!(ids, vec!["w1", "w2", "w3"]);
    }

    fn host() -> DesktopHost {
        DesktopHost {
            host_id: "h1".to_owned(),
            worker_path: PathBuf::new(),
            _desktop_lock: None,
            state: Mutex::new(state()),
        }
    }

    /// 授权事实只来自 worker：握手回执中的授权事实与之后的授权通报；worker 退出后恢复为缺省值。
    #[test]
    fn the_access_facts_follow_the_worker_lines() {
        let host = host();
        let (tx, rx) = std::sync::mpsc::channel();
        host.state.lock().unwrap().handshake = Some(("w1".to_owned(), tx));
        host.on_worker_response(
            r#"{"id":"w1","dispatch":"not_dispatched","observation":{"kind":"ready",
                "access":{"authorized":false,"missing":["accessibility","screen_recording"]}}}"#,
        );
        assert!(rx.recv().unwrap().is_ready());
        let denied = Access {
            authorized: false,
            missing: vec!["accessibility".to_owned(), "screen_recording".to_owned()],
        };
        assert_eq!(host.state.lock().unwrap().access, denied);

        host.state.lock().unwrap().worker_ready = true;
        host.on_worker_response(
            r#"{"access":{"authorized":true,"missing":["screen_recording"]}}"#,
        );
        assert_eq!(
            host.state.lock().unwrap().access,
            Access {
                authorized: true,
                missing: vec!["screen_recording".to_owned()],
            }
        );

        host.worker_gone("测试");
        assert_eq!(host.state.lock().unwrap().access, Access::default());
    }

    /// 无法识别的句柄一律拒绝派发。放行它等于让动作作用于一个已不存在的窗口所在的位置。
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
