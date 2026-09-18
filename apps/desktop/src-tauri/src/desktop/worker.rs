//! worker 子进程：拉起、逐行写请求、退出后的在途收尾与重启退避。
//!
//! IPC 是子进程 stdio 上的行分隔 JSON：管道随进程关闭，worker 退出即 stdout 结束，
//! 宿主不需要心跳，也不新增本机可连的端点。
//!
//! 四条边界：
//!
//! 1. **登记先于写入。** 在途表里先有这一条，再写 stdin；`written` 只在 `write_all`
//!    成功之后置上。收尾的分类全靠这一格。
//! 2. **收尾分类与服务端那侧同一条规则**（`packages/server/src/desktop/bridge.ts`）：
//!    可证明没写出去的记 `not_dispatched`，其余记 `unknown`。两层用不同规则就是两本账。
//! 3. **重启有退避也有上限。** 一启动就崩的 worker 不能被无限拉起；活过
//!    `HEALTHY_RUN_MS` 才算这一次启动成功，退避计数归零。替换一个卡住的 worker 走的是
//!    同一条退避，不另设计数。
//! 4. **强杀只在关 stdin 之后、且只对本宿主起的那个 pid。** 按可执行文件名找进程会命中
//!    用户自己开着的另一个 qywork。

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use super::frames::{Binding, Dispatch};

/// 重启退避的起点与上界。
const RESTART_BASE_MS: u64 = 500;
const RESTART_MAX_MS: u64 = 15_000;
/// 连续失败多少次之后不再重启。到达上限即电脑操作整条发布为不可用。
const RESTART_MAX_ATTEMPTS: u32 = 5;
/// 活过这个时长即认为这次启动是成功的，下一次失败从头退避。
const HEALTHY_RUN_MS: u128 = 60_000;

/// 执行者级取消等到的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// 这个执行者名下已经没有可能正在执行的请求，桌面可以交给下一个执行者。
    Settled,
    /// 截止时刻到了还有在途。**必须换掉 worker**：卡在 provider 里的调用没有请求级上界，
    /// 继续等下去，协调器那侧「说不清结清没有」的挂起就没有解除条件。
    Replace,
}

/// 执行者级取消该不该继续等。`None` = 还没到判定时刻，接着等。
///
/// 终态优先于时钟：在途已经清空时即使已经过了截止时刻也算结清，那是一个可证明的事实。
pub fn cancel_outcome(outstanding: bool, now: i64, deadline: i64) -> Option<CancelOutcome> {
    if !outstanding {
        return Some(CancelOutcome::Settled);
    }
    (now >= deadline).then_some(CancelOutcome::Replace)
}

/// 一条已经交给 worker 的请求。
pub struct Pending {
    pub origin: Origin,
    /// 这一行有没有真的写进 worker 的 stdin。
    pub written: bool,
}

/// 这条请求是谁发起的。宿主自己发起的那几种回执止于宿主，不透到服务端。
pub enum Origin {
    Server {
        request_id: String,
        executor_id: String,
        /// 请求自己带的三条身份。结果帧按它填，不按宿主此刻的那一份：服务端的 pending
        /// 记的就是它发出去的那一份，换成当前值会让跨代际的迟到回执结算另一次调用。
        binding: Binding,
    },
    Host,
}

/// 写 worker stdin 的一端。整行一次写出：分两次写会让两个线程的请求在同一行里交错。
pub struct WorkerLink {
    pid: u32,
    stdin: Mutex<std::process::ChildStdin>,
}

impl WorkerLink {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn write_line(&self, line: &str) -> std::io::Result<()> {
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| std::io::Error::other("worker stdin 锁被污染"))?;
        guard.write_all(line.as_bytes())?;
        guard.write_all(b"\n")?;
        guard.flush()
    }
}

pub struct Spawned {
    pub child: Child,
    pub link: WorkerLink,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

/// 拉起一个 worker 进程。三条管道都要接：stdout 是回执，stderr 是它退出的原因。
pub fn spawn(path: &Path) -> std::io::Result<Spawned> {
    let mut command = Command::new(path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW。不加它，GUI 进程拉起控制台子进程会闪一个黑框。
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("worker 没有 stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("worker 没有 stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("worker 没有 stderr"))?;
    Ok(Spawned {
        child,
        link: WorkerLink {
            pid,
            stdin: Mutex::new(stdin),
        },
        stdout,
        stderr,
    })
}

/// worker 没了之后的在途收尾：取出服务端那些请求与它们的执行事实，并清空整张表。
///
/// 宿主自己发起的那几条直接丢弃——它们的回执止于宿主，没有人在等一个结果帧。
pub fn drain_server(pending: &mut HashMap<String, Pending>) -> Vec<(String, Binding, Dispatch)> {
    let mut out = Vec::new();
    for (_, entry) in pending.drain() {
        if let Origin::Server {
            request_id,
            binding,
            ..
        } = entry.origin
        {
            out.push((
                request_id,
                binding,
                if entry.written {
                    Dispatch::Unknown
                } else {
                    Dispatch::NotDispatched
                },
            ));
        }
    }
    out
}

/// 一个执行者名下还在 worker 那边的请求 id。服务端的执行者级 `cancel` 按它展开成
/// worker 的逐 id `cancel`。
pub fn cancel_targets(pending: &HashMap<String, Pending>, executor_id: &str) -> Vec<String> {
    let mut ids: Vec<String> = pending
        .iter()
        .filter(|(_, entry)| match &entry.origin {
            Origin::Server { executor_id: owner, .. } => owner == executor_id,
            Origin::Host => false,
        })
        .map(|(id, _)| id.clone())
        .collect();
    // 发送顺序固定，日志与用例才对得上。
    ids.sort();
    ids
}

/// 强杀一个 worker 进程。
///
/// 只在关掉它的 stdin、等过一个短期限仍没退出之后调用，且 `pid` 只能是本宿主起的那一个。
/// 卡在 OS 调用里的进程不会响应 stdin 结束，不强杀就换不掉它。
#[cfg(windows)]
pub fn terminate(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    // SAFETY: 句柄由本函数独占，成功打开才使用，出口处只关一次。
    unsafe {
        match OpenProcess(PROCESS_TERMINATE, false, pid) {
            Ok(process) => {
                if let Err(e) = TerminateProcess(process, 1) {
                    log::warn!("强杀 worker pid={pid} 失败：{e}");
                }
                let _ = CloseHandle(process);
            }
            Err(e) => log::warn!("打不开 worker pid={pid}：{e}"),
        }
    }
}

#[cfg(unix)]
pub fn terminate(pid: u32) {
    const SIGKILL: i32 = 9;
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    // SAFETY: 只传一个进程号与一个信号号，两者都是本函数构造的合法值。
    if unsafe { kill(pid as i32, SIGKILL) } != 0 {
        log::warn!("强杀 worker pid={pid} 失败");
    }
}

/// 第 `attempt` 次重启等多久。`None` = 到达上限，不再重启。
pub fn restart_delay(attempt: u32) -> Option<Duration> {
    if attempt >= RESTART_MAX_ATTEMPTS {
        return None;
    }
    let ms = RESTART_BASE_MS
        .checked_shl(attempt)
        .unwrap_or(RESTART_MAX_MS)
        .min(RESTART_MAX_MS);
    Some(Duration::from_millis(ms))
}

/// 这一次 worker 活了 `ran_for` 之后退出，下一次重启算第几次。
pub fn next_attempt(attempt: u32, ran_for: Duration) -> u32 {
    if ran_for.as_millis() >= HEALTHY_RUN_MS {
        0
    } else {
        attempt + 1
    }
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

    fn server(request_id: &str, executor_id: &str, written: bool) -> Pending {
        Pending {
            origin: Origin::Server {
                request_id: request_id.to_owned(),
                executor_id: executor_id.to_owned(),
                binding: binding(),
            },
            written,
        }
    }

    fn table() -> HashMap<String, Pending> {
        HashMap::from([
            ("w1".to_owned(), server("dr_1", "dx_1", true)),
            ("w2".to_owned(), server("dr_2", "dx_1", false)),
            ("w3".to_owned(), server("dr_3", "dx_2", true)),
            (
                "h_1".to_owned(),
                Pending {
                    origin: Origin::Host,
                    written: true,
                },
            ),
        ])
    }

    /// 写出去的记 unknown、没写出去的记 not_dispatched；宿主自己那条不产生结果帧。
    #[test]
    fn exit_settles_by_whether_the_line_reached_stdin() {
        let mut pending = table();
        let mut settled = drain_server(&mut pending);
        settled.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            settled,
            vec![
                ("dr_1".to_owned(), binding(), Dispatch::Unknown),
                ("dr_2".to_owned(), binding(), Dispatch::NotDispatched),
                ("dr_3".to_owned(), binding(), Dispatch::Unknown),
            ]
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn an_executor_cancel_expands_to_only_its_own_requests() {
        let pending = table();
        assert_eq!(cancel_targets(&pending, "dx_1"), vec!["w1", "w2"]);
        assert_eq!(cancel_targets(&pending, "dx_2"), vec!["w3"]);
        assert!(cancel_targets(&pending, "dx_9").is_empty());
    }

    #[test]
    fn restart_backs_off_and_then_gives_up() {
        assert_eq!(restart_delay(0), Some(Duration::from_millis(500)));
        assert_eq!(restart_delay(1), Some(Duration::from_millis(1_000)));
        assert_eq!(restart_delay(2), Some(Duration::from_millis(2_000)));
        assert_eq!(restart_delay(3), Some(Duration::from_millis(4_000)));
        assert_eq!(restart_delay(4), Some(Duration::from_millis(8_000)));
        assert_eq!(restart_delay(RESTART_MAX_ATTEMPTS), None);
        assert_eq!(restart_delay(99), None);
    }

    /// 到期仍有在途即要求换掉 worker；在途清空是可证明的终态，晚于截止时刻也算结清。
    #[test]
    fn a_cancel_that_outlives_its_deadline_asks_for_a_new_worker() {
        assert_eq!(cancel_outcome(false, 0, 100), Some(CancelOutcome::Settled));
        assert_eq!(cancel_outcome(false, 500, 100), Some(CancelOutcome::Settled));
        assert_eq!(cancel_outcome(true, 99, 100), None);
        assert_eq!(cancel_outcome(true, 100, 100), Some(CancelOutcome::Replace));
        assert_eq!(cancel_outcome(true, 500, 100), Some(CancelOutcome::Replace));
    }

    /// 一启动就崩的 worker 退避到上限即停；活过一分钟的那一次让计数归零，
    /// 否则跑了一整天才崩一次的 worker 也会在第五次之后永远不再起来。
    #[test]
    fn a_healthy_run_resets_the_backoff() {
        assert_eq!(next_attempt(0, Duration::from_millis(80)), 1);
        assert_eq!(next_attempt(4, Duration::from_millis(80)), 5);
        assert_eq!(next_attempt(4, Duration::from_secs(60)), 0);
        assert_eq!(next_attempt(4, Duration::from_secs(3_600)), 0);
    }
}
