//! worker 子进程：启动、逐行写入请求、退出后的在途收尾与重启退避。
//!
//! IPC 是子进程 stdio 上的行分隔 JSON：管道随进程关闭，worker 退出即 stdout 结束，
//! 宿主不需要心跳，也不新增本机可连接的端点。
//!
//! 五条边界：
//!
//! 1. **登记先于写入。** 先在在途表中登记该请求，再写入 stdin；`written` 只在 `write_all`
//!    成功之后置位。收尾分类完全依赖该字段。
//! 2. **收尾分类与服务端使用同一条规则**（`packages/server/src/desktop/bridge.ts`）：
//!    可证明未写出的记为 `not_dispatched`，其余记为 `unknown`。两层使用不同规则就形成两套账。
//! 3. **重启有退避也有上限**，规则位于 `crate::restart`，与浏览器进程共用。替换无响应的
//!    worker 使用同一套退避，不另设计数。
//! 4. **强制终止只在关闭 stdin 之后执行，且只针对本宿主启动的 pid。** 按可执行文件名查找进程会命中
//!    用户自行运行的另一个 qywork。
//! 5. **宿主被强制终止时 worker 随之结束。** 此时宿主代码无法执行，只能交给内核：Windows 使用
//!    作业对象，Linux 使用启动时设置的 `PR_SET_PDEATHSIG`；macOS 两者都没有，由 worker 自行
//!    监听父进程退出。

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use super::frames::{Binding, Dispatch};

/// 执行者级取消的等待结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// 该执行者名下已没有可能正在执行的请求，桌面可以交给下一个执行者。
    Settled,
    /// 截止时刻到达时仍有在途请求。**必须替换 worker**：阻塞于 provider 的调用没有请求级上界，
    /// 继续等待时，协调器中无法确定是否已结清的挂起状态没有解除条件。
    Replace,
}

/// 执行者级取消是否继续等待。`None` 表示尚未到判定时刻，继续等待。
///
/// 终态优先于时钟：在途请求已清空时，即使已过截止时刻也视为结清，这是可证明的事实。
pub fn cancel_outcome(outstanding: bool, now: i64, deadline: i64) -> Option<CancelOutcome> {
    if !outstanding {
        return Some(CancelOutcome::Settled);
    }
    (now >= deadline).then_some(CancelOutcome::Replace)
}

/// 一条已经交给 worker 的请求。
pub struct Pending {
    pub origin: Origin,
    /// 该行是否已实际写入 worker 的 stdin。
    pub written: bool,
}

/// 请求的发起方。宿主自行发起的请求的回执在宿主终止，不传给服务端。
pub enum Origin {
    Server {
        request_id: String,
        executor_id: String,
        /// 请求自身携带的三条身份。结果帧按此填写，不按宿主当前的身份：服务端的 pending
        /// 记录的正是它发出的身份，改用当前值会使跨代际的迟到回执结算另一次调用。
        binding: Binding,
    },
    Host,
}

/// 写入 worker stdin 的一端。整行一次写出：分两次写入会使两个线程的请求在同一行中交错。
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
    /// 绑定该 worker 的作业对象。**worker 的存续时间不超过该对象。**
    ///
    /// 宿主进程被强制终止时没有任何代码能够执行，只有内核在最后一个句柄关闭时终止作业中的
    /// 进程。调用方必须持有它直到不再需要该 worker，提前丢弃即立即终止 worker。
    #[cfg(windows)]
    pub job: Option<Job>,
}

/// 一个 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的作业对象。
#[cfg(windows)]
pub struct Job(windows::Win32::Foundation::HANDLE);

// SAFETY: 句柄由本类型独占，只在 Drop 中关闭一次。
#[cfg(windows)]
unsafe impl Send for Job {}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: 句柄由 CreateJobObjectW 交给本类型，此处是唯一的关闭点。
        unsafe { let _ = windows::Win32::Foundation::CloseHandle(self.0); }
    }
}

/// 把已启动的进程放入作业对象，作业关闭时其中的进程随之终止。
///
/// 失败不阻止 worker 启动：无法取得该保护时 worker 照常工作，只是宿主被强制终止后会留下孤儿进程。
#[cfg(windows)]
fn confine(child: &Child) -> Option<Job> {
    use std::os::windows::io::AsRawHandle;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // SAFETY: 三步都只使用本函数构造的句柄与结构体；失败即返回 None，不留下不完整的状态。
    unsafe {
        let job = CreateJobObjectW(None, None).ok()?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast(),
            u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).ok()?,
        );
        let assigned = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle()));
        if let (Ok(()), Ok(())) = (set, assigned) {
            return Some(Job(job));
        }
        let _ = windows::Win32::Foundation::CloseHandle(job);
    }
    None
}

/// 使 worker 在启动它的线程退出时收到 `SIGKILL`。
///
/// `PR_SET_PDEATHSIG` 关联的是线程而不是进程：启动 worker 的是监督线程，它等到 worker 退出后才
/// 返回，因此该线程只会在宿主进程结束时退出。不要改为在其他生命周期较短的线程上启动 worker。
///
/// `getppid` 的核对覆盖父进程在 `fork` 与 `prctl` 之间已经退出的情形：此时不会再收到信号。
#[cfg(target_os = "linux")]
fn die_with_parent(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: 取本进程号，无副作用。
    let parent = unsafe { libc::getpid() };
    // SAFETY: 闭包在 fork 之后、exec 之前的子进程中执行，只调用 async-signal-safe 的系统调用。
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(std::io::Error::other("宿主已退出"));
            }
            Ok(())
        });
    }
}

/// 启动一个 worker 进程。三条管道都必须连接：stdout 传递回执，stderr 输出其退出原因。
pub fn spawn(path: &Path) -> std::io::Result<Spawned> {
    let mut command = Command::new(path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW。不设置该标志时，GUI 进程启动控制台子进程会短暂显示一个控制台窗口。
        command.creation_flags(0x0800_0000);
    }
    #[cfg(target_os = "linux")]
    die_with_parent(&mut command);
    let mut child = command.spawn()?;
    let pid = child.id();
    #[cfg(windows)]
    let job = confine(&child);
    #[cfg(windows)]
    if job.is_none() {
        log::warn!("computer-host worker pid={pid} 未能放入作业对象，宿主被强制终止时该进程会残留");
    }
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
        #[cfg(windows)]
        job,
    })
}

/// worker 退出后的在途收尾：取出服务端发起的请求及其执行事实，并清空整张表。
///
/// 宿主自行发起的请求直接丢弃：它们的回执在宿主终止，没有调用方等待结果帧。
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

/// 执行者名下仍由 worker 处理的请求 id。服务端的执行者级 `cancel` 据此展开为
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
    // 发送顺序固定，日志与用例才能一致。
    ids.sort();
    ids
}

/// 强制终止一个 worker 进程。
///
/// 只在关闭其 stdin 并等待一个短期限后仍未退出时调用，且 `pid` 只能是本宿主启动的进程。
/// 进程退出未在期限内完成时，不强制终止就无法替换它。
#[cfg(windows)]
pub fn terminate(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    // SAFETY: 句柄由本函数独占，仅在成功打开后使用，在出口处只关闭一次。
    unsafe {
        match OpenProcess(PROCESS_TERMINATE, false, pid) {
            Ok(process) => {
                if let Err(e) = TerminateProcess(process, 1) {
                    log::warn!("强制终止 worker pid={pid} 失败：{e}");
                }
                let _ = CloseHandle(process);
            }
            Err(e) => log::warn!("无法打开 worker pid={pid}：{e}"),
        }
    }
}

#[cfg(unix)]
pub fn terminate(pid: u32) {
    const SIGKILL: i32 = 9;
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    // SAFETY: 只传入一个进程号与一个信号编号，两者都是本函数构造的合法值。
    if unsafe { kill(pid as i32, SIGKILL) } != 0 {
        log::warn!("强制终止 worker pid={pid} 失败");
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

    /// 已写出的记为 unknown，未写出的记为 not_dispatched；宿主自行发起的请求不产生结果帧。
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

    /// 到期仍有在途请求即要求替换 worker；在途请求清空是可证明的终态，晚于截止时刻也视为结清。
    #[test]
    fn a_cancel_that_outlives_its_deadline_asks_for_a_new_worker() {
        assert_eq!(cancel_outcome(false, 0, 100), Some(CancelOutcome::Settled));
        assert_eq!(cancel_outcome(false, 500, 100), Some(CancelOutcome::Settled));
        assert_eq!(cancel_outcome(true, 99, 100), None);
        assert_eq!(cancel_outcome(true, 100, 100), Some(CancelOutcome::Replace));
        assert_eq!(cancel_outcome(true, 500, 100), Some(CancelOutcome::Replace));
    }
}
