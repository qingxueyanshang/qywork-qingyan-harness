//! 交互式终端：每个会话对应一个 PTY，输出以事件推送给 WebView。
//!
//! **本层例外地持有状态。** lib.rs 文件头规定「外壳不持有业务状态、WebView 直接连接
//! sidecar」，该规定针对会话、账本、权限等**两端都应具备**的状态。PTY 不属于此类：
//! 它是真实的本机子进程与一对操作系统句柄，无法跨网络传递，手机端也不可能具备。
//! 放入 sidecar 等于把「在本机运行任意命令」开放到局域网（CLAUDE.md E）。
//! 因此终端是桌面端独有能力，在握手之外由 `isDesktopShell()` 判定，其他端不显示入口。
//!
//! 会话不随面板切换而销毁：用户切换到文件视图或收起整个面板时，命令仍需继续运行。
//! 只在显式关闭（页签上的 ×）、子进程自行退出与应用退出时销毁。三条路径都只在调用方的线程中移除表项，
//! 终止进程、停止写入与释放 PTY 由 `retire` 在独立线程中完成。
//!
//! 每个 id 对应一个会话，前端可同时打开多个（页签由 `panelTabs` 管理）。每个会话记录其所属的
//! 工作区：前端按工作区分别显示页签，切换工作区不关闭任何会话。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// 一次读取的上限。过小会使长输出被切分为大量事件（每个事件一次 IPC 序列化），
/// 过大则增加首字节延迟。8K 是 ConPTY 与 pty 常见的单次写入量级。
const READ_CHUNK: usize = 8 * 1024;

/// 回放缓冲的上限。**它用于重建屏幕，不是滚动历史**：能容纳一屏全屏 TUI 的
/// 重绘（清屏 + 定位 + 满屏字符，几十 K 量级）并留出余量即可，历史记录由 xterm
/// 自身的 5000 行回滚缓冲管理。更大的上限只会占用常驻内存保存不会被查看的字节。
const BACKLOG_CAP: usize = 256 * 1024;

/// 写线程一次写入 PTY 的上限。每一块写入之前检查停止标记：关闭之后不再向该会话写入队列中剩余的输入。
/// 不小于 4：按字符边界切分时每块至少容纳一个字符。
const WRITE_CHUNK: usize = 4 * 1024;

/// 释放 PTY 主端的等待上限，超过即终止伪控制台的宿主进程，见 `retire`。
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// 应用退出时等待全部会话收尾的上限，见 `shutdown`。
const EXIT_LIMIT: Duration = Duration::from_secs(2);

/// 终止伪控制台宿主进程的操作，见 `retire`。
type ForceClose = Box<dyn FnOnce() + Send>;

struct Session {
    /// 会话所属的工作区。**创建后不再修改**：id 与 PTY 一一对应，
    /// 修改归属等于把一个正在运行的 shell 记到另一个工作区名下。
    workspace_id: String,
    /// 外壳进程中的创建序号，与浏览器页共用一个计数器。界面按它排列页签栏。
    created_seq: u64,
    master: Box<dyn MasterPty + Send>,
    input: Input,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 终止伪控制台的宿主进程（Windows 的 conhost）。其他平台没有该进程；Windows 上无法唯一确定时为 `None`。
    console: Option<ForceClose>,
    /// 最近输出的原样副本，供前端重新接入时回放。
    ///
    /// **前端的 xterm 实例随页面存在**：整页刷新后它是新的空白屏幕，而 shell
    /// 仍在运行；不回放时，用户重新接入后只能看到空白屏幕。
    /// 保存原始字节序列（含转义序列）而不是渲染后的文本：回放即把这段字节重新写入
    /// xterm 解析，模式、颜色、光标位置随之恢复。
    backlog: Arc<Mutex<Backlog>>,
}

/// 写线程的输入队列与停止标记，见 `spawn_writer`。
struct Input {
    queue: Sender<String>,
    /// 置位后写线程不再写入，队列中尚未写入的输入随之丢弃。
    stop: Arc<AtomicBool>,
}

/// 回放缓冲与会话的累计输出偏移，由读线程写入、`terminal_open` 读取。
#[derive(Default)]
struct Backlog {
    text: String,
    /// 会话至今输出的累计字节数，即下一块输出的起始偏移。截断 `text` 不改变它。
    end: u64,
}

impl Backlog {
    /// 追加一块输出，返回它的起始偏移。
    ///
    /// 偏移的分配与追加在同一次加锁内完成，`terminal_open` 在同一把锁下取快照与 `end`：
    /// 起始偏移小于 `end` 的块都已在快照中，不小于 `end` 的块都不在。前端按此去重，
    /// 不要把偏移的分配移到锁外，否则一块输出可能既在快照中又被判为快照之后的输出。
    fn push(&mut self, text: &str) -> u64 {
        let offset = self.end;
        self.end += text.len() as u64;
        push_backlog(&mut self.text, text);
        offset
    }
}

#[derive(Default)]
pub struct TerminalHandle(Mutex<HashMap<String, Session>>);

/// `terminal_list` 的一行：会话 id、工作区归属与创建序号。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    id: String,
    workspace_id: String,
    created_seq: u64,
}

/// 输出与退出事件都携带会话的创建序号：同一个 id 关闭后可以重新打开（「重开」），
/// 旧进程的残余输出与退出必须能与新会话区分。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    id: String,
    created_seq: u64,
    /// 本块在会话累计输出中的起始字节偏移，见 `Backlog::push`。
    offset: u64,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    id: String,
    created_seq: u64,
    /// 退出码。无法取得（被信号终止、平台不报告）时为 `None`，不要伪造为 0：
    /// 「正常结束」与「结束方式未知」对用户是两种不同的情况。
    code: Option<u32>,
}

/// `terminal_open` 的结果：会话的创建序号、需要回放的输出与回放的结束偏移。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    created_seq: u64,
    backlog: String,
    /// 回放末尾在会话累计输出中的字节偏移。起始偏移小于它的输出事件已包含在回放中。
    end: u64,
}

/// 打开一个会话，**返回创建序号、需要回放的输出与回放的结束偏移**。
///
/// 已存在的 id 不报错，直接返回其序号与回放缓冲：前端在面板重新挂载时会无条件
/// 调用一次，报错会使已打开的终端显示「已存在」错误。新建的会话
/// 没有可回放的内容，回放为空串，结束偏移为 0。
///
/// **重新接入必须提供同一个工作区**，否则拒绝：接受时该 PTY 会同时出现在两个工作区的
/// 页签上，而它只有一份 cwd 与一个子进程。
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<TerminalHandle>,
    id: String,
    workspace_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<Opened, String> {
    if let Some(session) = state.0.lock().get(&id) {
        if session.workspace_id != workspace_id {
            return Err("该终端属于另一个项目".to_owned());
        }
        let backlog = session.backlog.lock();
        return Ok(Opened {
            created_seq: session.created_seq,
            backlog: backlog.text.clone(),
            end: backlog.end,
        });
    }

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    #[cfg(windows)]
    let hosts = console_hosts();
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("无法打开 PTY：{e}"))?;
    #[cfg(windows)]
    let console = hosts.and_then(|before| new_console_host(&before));
    #[cfg(not(windows))]
    let console: Option<ForceClose> = None;

    let mut cmd = CommandBuilder::new(default_shell());
    // 目录不存在时使用系统默认目录，不要直接失败：账本中的项目可能已被用户移动，
    // 此时打开家目录的终端比打开失败更有用。
    let dir = PathBuf::from(&cwd);
    if dir.is_dir() {
        cmd.cwd(dir);
    }
    // 不声明时许多程序会退化为最基础的输出（无颜色、无光标定位），
    // 而 xterm.js 按 256 色终端渲染。
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("无法启动 shell：{e}"))?;
    // slave 端必须在此处立即释放。保留它时读端永远收不到 EOF：
    // 子进程退出后读线程仍阻塞在 read() 上，终端停止响应。
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("无法取得写端：{e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("无法取得读端：{e}"))?;

    let backlog = Arc::new(Mutex::new(Backlog::default()));
    // 重新接入已存在的 id 时在函数开头已返回，序号只在此处分配一次。
    let created_seq = crate::next_created_seq();
    state.0.lock().insert(
        id.clone(),
        Session {
            workspace_id,
            created_seq,
            master: pair.master,
            input: spawn_writer(id.clone(), writer),
            killer,
            console,
            backlog: backlog.clone(),
        },
    );

    let emitter = app.clone();
    spawn_reader(
        id.clone(),
        created_seq,
        reader,
        backlog,
        move |output: Output| {
            let _ = emitter.emit("terminal:output", output);
        },
    );

    // 等待回收子进程的线程。**不能与读线程合并**：读端需等待 EOF，而 EOF 之后
    // 还需取得退出码；分开后两者各自阻塞在自己的句柄上，到达顺序不影响结果。
    //
    // **先把会话从表中移除，再上报退出。** 保留时该 id 永远「已存在」，
    // 用户点击「重开」时 `terminal_open` 直接返回成功，但不会启动新的 shell。
    // 只移除本次打开的那个会话，且只有移除了表项才上报：`terminal_close` 已移除时不上报。
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        let removed = take_current(
            &mut app.state::<TerminalHandle>().0.lock(),
            &id,
            created_seq,
            |s| s.created_seq,
        );
        if let Some(session) = removed {
            let _ = app.emit(
                "terminal:exit",
                Exit {
                    id,
                    created_seq,
                    code,
                },
            );
            drop(retire(session, CLOSE_WAIT));
        }
    });

    Ok(Opened {
        created_seq,
        backlog: String::new(),
        end: 0,
    })
}

/// 表项仍是 `created_seq` 那一次打开的会话时将其移除并返回。
///
/// 同一个 id 关闭后可以立即重新打开，旧进程的回收可能晚于新会话插入；只按 id 移除会删除新会话，
/// 新终端随即无法写入，并被报告为已退出。
fn take_current<V>(
    map: &mut HashMap<String, V>,
    id: &str,
    created_seq: u64,
    seq_of: impl Fn(&V) -> u64,
) -> Option<V> {
    if map.get(id).map(seq_of) != Some(created_seq) {
        return None;
    }
    map.remove(id)
}

/// 当前打开的会话。
///
/// **前端的页签是此表的镜像。** 镜像会因前端整体重建而清空（整页重载、
/// 开发期热更新替换该模块），而 shell 仍在运行；不与此表核对时，该会话
/// 没有任何界面入口，只能在应用退出时由 `shutdown` 终止。
#[tauri::command]
pub fn terminal_list(state: State<TerminalHandle>) -> Vec<TerminalSession> {
    state
        .0
        .lock()
        .iter()
        .map(|(id, session)| TerminalSession {
            id: id.clone(),
            workspace_id: session.workspace_id.clone(),
            created_seq: session.created_seq,
        })
        .collect()
}

/// 键盘输入。原样写入 PTY，不做任何解析：回车、Ctrl-C、方向键都是字节，
/// 由 shell 自行识别。
///
/// 只入队，不在此处写入：本命令在主线程执行，见 `spawn_writer`。
#[tauri::command]
pub fn terminal_write(state: State<TerminalHandle>, id: String, data: String) -> Result<(), String> {
    let map = state.0.lock();
    let session = map.get(&id).ok_or("终端会话已不存在")?;
    session
        .input
        .queue
        .send(data)
        .map_err(|_| "终端写入已停止".to_owned())
}

/// 调整尺寸。**必须通知 PTY**：只修改 xterm 一侧时，`less`、`vim` 等
/// 按 COLUMNS 换行的程序都会按旧宽度排版，导致错误折行。
#[tauri::command]
pub fn terminal_resize(
    state: State<TerminalHandle>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock();
    let session = map.get(&id).ok_or("终端会话已不存在")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// 关闭一个会话：从表中移除，终止 shell 等收尾在后台完成。
///
/// **不存在的 id 直接返回。** 子进程可能已自行退出（回收线程已将其移除），
/// 用户随后点击页签上的 × 时若报「会话已不存在」，该页签将无法关闭。
///
/// 表项已在此处移除，回收线程不再上报 `terminal:exit`（见 `take_current`）。
#[tauri::command]
pub fn terminal_close(state: State<TerminalHandle>, id: String) {
    close(&state, &id, CLOSE_WAIT);
}

/// 表项在返回之前移除，同一 id 可以立即重新打开；旧会话的收尾不读取表，与新会话互不影响。
fn close(state: &TerminalHandle, id: &str, wait: Duration) {
    let removed = state.0.lock().remove(id);
    if let Some(session) = removed {
        drop(retire(session, wait));
    }
}

/// 应用退出时终止全部会话，在 `EXIT_LIMIT` 内等待收尾完成，超过即返回，不阻止退出。理由与 sidecar 相同：
/// Windows 上父进程退出不会终止子进程，残留的 shell 会持有工作区中的文件句柄。
///
/// 退出时不需要伪控制台的最后一帧输出，因此不等待其自行关闭，直接终止宿主进程。
/// 收尾含阻塞调用，不要在主线程调用本函数。
pub fn shutdown(state: &TerminalHandle) {
    let sessions: Vec<Session> = state.0.lock().drain().map(|(_, s)| s).collect();
    let deadline = Instant::now() + EXIT_LIMIT;
    let finished: Vec<Receiver<()>> = sessions
        .into_iter()
        .map(|session| retire(session, Duration::ZERO))
        .collect();
    for done in finished {
        let _ = done.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    }
}

/// 已从表中移除的会话的收尾：停止写入、终止子进程、释放 PTY 主端。在独立线程中执行，
/// 返回的接收端在收尾完成时收到消息。
///
/// 释放主端在 Windows 上即 ClosePseudoConsole，它等待 conhost 退出。conhost 中仍有未处理的输入时，
/// conhost 不退出，该调用不返回（关闭之前写入 1 MB、shell 未读取输入，实测数分钟内不返回）。
/// 因此释放在 `wait` 内未完成即终止 conhost：该调用随之返回，读线程读到 EOF 后退出，阻塞在写入上的
/// 写线程因管道关闭而退出。不要把收尾移回调用方的线程：`terminal_close` 与退出处理在主线程执行，
/// 主线程阻塞时外壳的全部命令停止响应。
fn retire(session: Session, wait: Duration) -> Receiver<()> {
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let Session {
            master,
            input,
            mut killer,
            console,
            ..
        } = session;
        input.stop.store(true, Ordering::Release);
        drop(input.queue);
        // 不按返回值判定：Windows 上该调用在终止成功时同样返回错误。
        let _ = killer.kill();
        let (closed, released) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drop(master);
            let _ = closed.send(());
        });
        if released.recv_timeout(wait).is_err() {
            if let Some(force) = console {
                force();
            }
            let _ = released.recv();
        }
        let _ = done.send(());
    });
    finished
}

/// 本进程的伪控制台宿主进程（conhost）。创建伪控制台时，系统把它作为本进程的子进程启动。
/// 进程快照无法取得时返回 `None`。
#[cfg(windows)]
fn console_hosts() -> Option<std::collections::HashSet<u32>> {
    let me = std::process::id();
    let table = crate::desktop::identity::process_table()?;
    Some(
        table
            .into_iter()
            .filter(|(_, (parent, exe))| *parent == me && exe.eq_ignore_ascii_case("conhost.exe"))
            .map(|(pid, _)| pid)
            .collect(),
    )
}

/// 创建伪控制台之后新出现的那一个宿主进程，返回终止它的操作。新出现的进程不是恰好一个时无法确定，返回 `None`。
///
/// 在创建时打开进程句柄并持有到终止：按 pid 在终止时再打开，pid 可能已被另一个进程复用。
#[cfg(windows)]
fn new_console_host(before: &std::collections::HashSet<u32>) -> Option<ForceClose> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    /// 进程句柄。保存为整数使其可以移入收尾线程，在释放时关闭。
    struct Owned(isize);
    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: 句柄由 `OpenProcess` 取得，只在此处关闭一次。
            unsafe {
                let _ = CloseHandle(windows::Win32::Foundation::HANDLE(self.0 as *mut core::ffi::c_void));
            }
        }
    }

    let mut new = console_hosts()?.into_iter().filter(|pid| !before.contains(pid));
    let (Some(pid), None) = (new.next(), new.next()) else {
        return None;
    };
    // SAFETY: 只请求终止权限；失败时返回错误，不产生句柄。
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }.ok()?;
    let owned = Owned(handle.0 as isize);
    Some(Box::new(move || {
        // SAFETY: 句柄在 `owned` 释放之前有效。
        unsafe {
            let _ = TerminateProcess(
                windows::Win32::Foundation::HANDLE(owned.0 as *mut core::ffi::c_void),
                1,
            );
        }
        drop(owned);
    }))
}

/// 读线程：PTY → 事件。
///
/// **不能对每个 chunk 直接调用 `from_utf8_lossy`。** 一个汉字占三个字节，读取的块可能
/// 在字符中间断开，逐块解码会把断点两侧各变成一个替换字符，使中文输出出现乱码。
/// 因此不完整的尾部字节保留在 `carry` 中，等待下一块。
fn spawn_reader(
    id: String,
    created_seq: u64,
    mut reader: Box<dyn Read + Send>,
    backlog: Arc<Mutex<Backlog>>,
    emit: impl Fn(Output) + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            let text = take_valid(&mut carry);
            if !text.is_empty() {
                let offset = backlog.lock().push(&text);
                emit(Output {
                    id: id.clone(),
                    created_seq,
                    offset,
                    data: text,
                });
            }
        }
    });
}

/// 写线程：输入队列 → PTY，每个会话一个。
///
/// PTY 的写入速率受子进程读取速度限制，大段粘贴需要数秒才能写完；`terminal_write` 在主线程执行，
/// 在其中写入会使界面在此期间停止响应。按 `WRITE_CHUNK` 分块写入，每块之前检查停止标记：
/// 关闭会话（`retire`）置位之后不再写入，正在进行的一块写入在管道关闭时以失败结束。
/// 写入失败时线程同样退出，之后的入队返回错误。
fn spawn_writer(id: String, mut writer: Box<dyn Write + Send>) -> Input {
    let (input, queue) = std::sync::mpsc::channel::<String>();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    std::thread::spawn(move || {
        for data in queue {
            for part in char_chunks(&data, WRITE_CHUNK) {
                if stopped.load(Ordering::Acquire) {
                    return;
                }
                if let Err(e) = writer
                    .write_all(part.as_bytes())
                    .and_then(|()| writer.flush())
                {
                    log::error!("终端 {id} 写入失败：{e}");
                    return;
                }
            }
        }
    });
    Input { queue: input, stop }
}

/// 按不超过 `size` 字节的块切分，切分点位于字符边界。`size` 不小于 4。
fn char_chunks(text: &str, size: usize) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut end = rest.len().min(size);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (part, tail) = rest.split_at(end);
        rest = tail;
        Some(part)
    })
}

/// 向回放缓冲追加，超出上限时从头部截断。
///
/// **截断点必须位于字符边界**，否则缓冲中会留下半个字符，回放时该位置显示为替换字符。
/// 从头部截断可能把某条转义序列切成两半，回放的第一行可能出现几个乱码字符；
/// 不为此增加对齐逻辑：全屏程序的下一次重绘会覆盖这些字符，普通输出中换行很多。
fn push_backlog(buf: &mut String, text: &str) {
    buf.push_str(text);
    if buf.len() <= BACKLOG_CAP {
        return;
    }
    let mut cut = buf.len() - BACKLOG_CAP;
    while cut < buf.len() && !buf.is_char_boundary(cut) {
        cut += 1;
    }
    buf.drain(..cut);
}

/// 取出 `carry` 中全部完整的 UTF-8 字符，只把末尾不完整的字符保留在原处。
///
/// 确实非法的字节（不是尚未读完，而是本身不是 UTF-8）换成替换字符后继续处理其后的字节：
/// 留在缓冲区头部的非法字节会使后续所有输出都无法发出；在非法字节处停止处理时，
/// 其后的合法字节要等到下一次输出才发出。
fn take_valid(carry: &mut Vec<u8>) -> String {
    let mut out = String::new();
    let mut start = 0;
    while start < carry.len() {
        let error = match std::str::from_utf8(&carry[start..]) {
            Ok(s) => {
                out.push_str(s);
                start = carry.len();
                break;
            }
            Err(e) => e,
        };
        let good = start + error.valid_up_to();
        // 前 `valid_up_to` 个字节已经校验，不会取到缺省值。
        out.push_str(std::str::from_utf8(&carry[start..good]).unwrap_or_default());
        match error.error_len() {
            Some(bad) => {
                out.push('\u{FFFD}');
                start = good + bad;
            }
            None => {
                start = good;
                break;
            }
        }
    }
    carry.drain(..start);
    out
}

/// 选择使用的 shell。
///
/// Windows 上使用 PowerShell 而不是 Git Bash：该终端是**用户自己的终端**，
/// 应使用系统默认 shell。agent 侧优先使用 Git Bash 是为了使模型编写的
/// POSIX 组合命令能够执行（见 `packages/tools/src/shell.ts`），与用户手动输入命令的预期不同。
fn default_shell() -> String {
    if cfg!(windows) {
        // 固定使用 powershell.exe，不读取 COMSPEC：该变量指向 cmd.exe，
        // 它是批处理解释器，而不是本机的默认交互 shell。
        "powershell.exe".to_owned()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 原始失败形状：关闭后用同一 id 重新打开，旧进程的回收晚于新会话插入，按 id 移除了新会话。
    #[test]
    fn reaping_an_old_session_leaves_the_reopened_one() {
        let mut map: HashMap<String, u64> = HashMap::new();
        map.insert("t1".to_owned(), 7);
        // 用户关闭：表项先被 `terminal_close` 移除。
        map.remove("t1");
        // 同一 id 重新打开，序号更大。
        map.insert("t1".to_owned(), 9);
        // 旧进程的回收线程此时才执行。
        assert!(take_current(&mut map, "t1", 7, |s| *s).is_none());
        assert_eq!(map.get("t1"), Some(&9));
    }

    #[test]
    fn reaping_the_current_session_removes_it_once() {
        let mut map: HashMap<String, u64> = HashMap::new();
        map.insert("t1".to_owned(), 7);
        assert_eq!(take_current(&mut map, "t1", 7, |s| *s), Some(7));
        assert!(take_current(&mut map, "t1", 7, |s| *s).is_none());
    }

    /// 原始失败形状：非法字节之后的合法字节留在缓冲中，直到下一次输出才发出。
    #[test]
    fn valid_bytes_after_an_invalid_byte_are_taken_in_the_same_call() {
        let mut carry = vec![b'a', 0xFF, b'b'];
        assert_eq!(take_valid(&mut carry), "a\u{FFFD}b");
        assert!(carry.is_empty());

        let mut carry = vec![0xFF, 0xFE, b'c'];
        assert_eq!(take_valid(&mut carry), "\u{FFFD}\u{FFFD}c");
        assert!(carry.is_empty());
    }

    #[test]
    fn a_character_split_across_chunks_is_emitted_once_complete() {
        let bytes = "中文".as_bytes();
        let mut carry = bytes[..4].to_vec();
        assert_eq!(take_valid(&mut carry), "中");
        assert_eq!(carry, bytes[3..4]);
        carry.extend_from_slice(&bytes[4..]);
        assert_eq!(take_valid(&mut carry), "文");
        assert!(carry.is_empty());
    }

    #[test]
    fn an_incomplete_tail_stays_in_the_buffer() {
        let tail = &"文".as_bytes()[..2];
        let mut carry = tail.to_vec();
        assert_eq!(take_valid(&mut carry), "");
        assert_eq!(carry, tail);

        let mut carry = vec![b'x', 0xFF];
        carry.extend_from_slice(tail);
        assert_eq!(take_valid(&mut carry), "x\u{FFFD}");
        assert_eq!(carry, tail);
    }

    #[test]
    fn backlog_truncation_keeps_the_cap_and_character_boundaries() {
        let mut buf = String::new();
        push_backlog(&mut buf, &"a".repeat(BACKLOG_CAP - 1));
        assert_eq!(buf.len(), BACKLOG_CAP - 1);
        // 追加一个三字节字符与一个 ASCII 字符：超出上限 3 字节，头部的截断点落在 ASCII 上。
        push_backlog(&mut buf, "中b");
        assert_eq!(buf.len(), BACKLOG_CAP);
        assert!(buf.ends_with("中b"));

        // 头部是多字节字符时，截断点后移到下一个字符边界，缓冲不超过上限。
        let mut buf = "中".repeat(BACKLOG_CAP / 3);
        push_backlog(&mut buf, "xy");
        assert!(buf.len() <= BACKLOG_CAP);
        assert!(buf.starts_with('中'));
        assert!(buf.ends_with("xy"));
    }

    #[test]
    fn each_chunk_gets_its_start_offset_and_the_end_covers_the_snapshot() {
        let mut backlog = Backlog::default();
        assert_eq!(backlog.push("ab"), 0);
        assert_eq!(backlog.push("中"), 2);
        assert_eq!(backlog.push("c"), 5);
        assert_eq!(backlog.end, 6);
        assert_eq!(backlog.text, "ab中c");
    }

    /// 截断只缩短回放，累计偏移继续递增：重新接入时回放末尾与之后的输出事件仍能按偏移衔接。
    #[test]
    fn truncation_does_not_change_the_cumulative_offset() {
        let mut backlog = Backlog::default();
        let first = "x".repeat(BACKLOG_CAP);
        assert_eq!(backlog.push(&first), 0);
        assert_eq!(backlog.push("中文"), BACKLOG_CAP as u64);
        assert_eq!(backlog.text.len(), BACKLOG_CAP);
        assert!(backlog.text.ends_with("中文"));
        assert_eq!(backlog.end, BACKLOG_CAP as u64 + 6);
        assert_eq!(backlog.push("y"), BACKLOG_CAP as u64 + 6);
    }

    /// 测试用写端：首次写入阻塞到 `release` 收到信号，写入内容记录到 `written`，释放时通知 `dropped`。
    struct Probe {
        release: Option<std::sync::mpsc::Receiver<()>>,
        written: Arc<Mutex<Vec<u8>>>,
        fail: bool,
        dropped: std::sync::mpsc::Sender<()>,
    }

    impl Write for Probe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if let Some(release) = self.release.take() {
                let _ = release.recv();
            }
            if self.fail {
                return Err(std::io::Error::other("管道已关闭"));
            }
            self.written.lock().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for Probe {
        fn drop(&mut self) {
            let _ = self.dropped.send(());
        }
    }

    const THREAD_EXIT: std::time::Duration = std::time::Duration::from_secs(10);

    /// 原始失败形状：写入在命令中执行，PTY 不读取时命令阻塞。入队在写端阻塞期间立即返回，放行后按顺序写完。
    #[test]
    fn input_is_queued_while_the_pty_blocks_and_written_in_order() {
        let (release, wait) = std::sync::mpsc::channel();
        let (dropped, gone) = std::sync::mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let input = spawn_writer(
            "t1".into(),
            Box::new(Probe {
                release: Some(wait),
                written: written.clone(),
                fail: false,
                dropped,
            }),
        );
        input.queue.send("a".into()).unwrap();
        input.queue.send("b".repeat(1024 * 1024)).unwrap();
        input.queue.send("c".into()).unwrap();
        assert!(written.lock().is_empty());

        release.send(()).unwrap();
        let expected = 1024 * 1024 + 2;
        let deadline = Instant::now() + THREAD_EXIT;
        while written.lock().len() < expected && Instant::now() < deadline {
            std::thread::yield_now();
        }
        // 未置停止标记时释放发送端：队列已写完，写线程退出并释放写端。
        drop(input);
        gone.recv_timeout(THREAD_EXIT).expect("写线程未退出");
        let written = written.lock();
        assert_eq!(written.len(), expected);
        assert_eq!(written.first(), Some(&b'a'));
        assert_eq!(written.last(), Some(&b'c'));
    }

    #[test]
    fn a_failed_write_ends_the_thread_and_later_input_is_rejected() {
        let (dropped, gone) = std::sync::mpsc::channel();
        let input = spawn_writer(
            "t1".into(),
            Box::new(Probe {
                release: None,
                written: Arc::default(),
                fail: true,
                dropped,
            }),
        );
        input.queue.send("a".into()).unwrap();
        gone.recv_timeout(THREAD_EXIT).expect("写线程未退出");
        assert!(input.queue.send("b".into()).is_err());
    }

    #[test]
    fn chunks_stay_within_the_limit_and_never_split_a_character() {
        let text = format!("a{}", "中".repeat(5));
        let parts: Vec<&str> = char_chunks(&text, 4).collect();
        assert_eq!(parts, ["a中", "中", "中", "中", "中"]);
        assert!(char_chunks("", 4).next().is_none());
    }

    /// 写端：通知开始写入，然后阻塞到 `gate` 收到信号，与 shell 不读取输入时管道写满相同。
    struct Blocked {
        entered: std::sync::mpsc::Sender<()>,
        gate: std::sync::mpsc::Receiver<()>,
        written: Arc<Mutex<Vec<u8>>>,
        dropped: std::sync::mpsc::Sender<()>,
    }

    impl Write for Blocked {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.entered.send(());
            let _ = self.gate.recv();
            self.written.lock().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for Blocked {
        fn drop(&mut self) {
            let _ = self.dropped.send(());
        }
    }

    #[derive(Debug)]
    struct FakeKiller(std::sync::mpsc::Sender<()>);

    impl ChildKiller for FakeKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            let _ = self.0.send(());
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(FakeKiller(self.0.clone()))
        }
    }

    /// PTY 主端：释放时阻塞到 `release` 收到信号或发送端全部释放，与 conhost 未退出时的
    /// ClosePseudoConsole 相同。
    struct FakeMaster {
        release: std::sync::mpsc::Receiver<()>,
    }

    impl MasterPty for FakeMaster {
        fn resize(&self, _: PtySize) -> anyhow::Result<()> {
            Ok(())
        }

        fn get_size(&self) -> anyhow::Result<PtySize> {
            Ok(PtySize::default())
        }

        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
            anyhow::bail!("测试替身不提供读端")
        }

        fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
            anyhow::bail!("测试替身不提供写端")
        }

        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<libc::pid_t> {
            None
        }

        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<std::os::unix::io::RawFd> {
            None
        }

        #[cfg(unix)]
        fn tty_name(&self) -> Option<PathBuf> {
            None
        }
    }

    impl Drop for FakeMaster {
        fn drop(&mut self) {
            let _ = self.release.recv();
        }
    }

    /// PTY 读端：阻塞到 `eof` 收到信号或发送端全部释放，然后读到 EOF，与宿主进程退出后相同。
    struct FakeReader(std::sync::mpsc::Receiver<()>);

    impl Read for FakeReader {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            let _ = self.0.recv();
            Ok(0)
        }
    }

    /// 一个会话及其观察点。释放 PTY 主端只在终止宿主进程之后完成。
    struct Fixture {
        session: Session,
        /// 写端进入第一次写入时收到消息。
        entered: std::sync::mpsc::Receiver<()>,
        /// 放行写端正在进行的写入。
        gate: std::sync::mpsc::Sender<()>,
        written: Arc<Mutex<Vec<u8>>>,
        writer_gone: std::sync::mpsc::Receiver<()>,
        killed: std::sync::mpsc::Receiver<()>,
        forced: std::sync::mpsc::Receiver<()>,
        /// 读线程的输出回调。读线程退出时回调随之释放，接收端断开。
        output: std::sync::mpsc::Receiver<Output>,
    }

    fn fixture(created_seq: u64) -> Fixture {
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (gate, gate_rx) = std::sync::mpsc::channel();
        let (dropped, writer_gone) = std::sync::mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let input = spawn_writer(
            "t1".into(),
            Box::new(Blocked {
                entered: entered_tx,
                gate: gate_rx,
                written: written.clone(),
                dropped,
            }),
        );
        let (kill_tx, killed) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel();
        let (eof, eof_rx) = std::sync::mpsc::channel();
        let (forced_tx, forced) = std::sync::mpsc::channel();
        let backlog = Arc::new(Mutex::new(Backlog::default()));
        let (output_tx, output) = std::sync::mpsc::channel();
        spawn_reader(
            "t1".into(),
            created_seq,
            Box::new(FakeReader(eof_rx)),
            backlog.clone(),
            move |out| {
                let _ = output_tx.send(out);
            },
        );
        let session = Session {
            workspace_id: "w".into(),
            created_seq,
            master: Box::new(FakeMaster { release: held }),
            input,
            killer: Box::new(FakeKiller(kill_tx)),
            console: Some(Box::new(move || {
                let _ = forced_tx.send(());
                let _ = release.send(());
                let _ = eof.send(());
            })),
            backlog,
        };
        Fixture {
            session,
            entered,
            gate,
            written,
            writer_gone,
            killed,
            forced,
            output,
        }
    }

    /// 原始失败形状：shell 不读取输入、写端阻塞且队列中仍有 1 MB 时关闭会话，释放 PTY 主端不返回，
    /// 关闭命令随之阻塞主线程。关闭须立即返回、表项已移除、同一 id 可以立即重新打开，
    /// 队列中尚未写入的输入丢弃，写线程与读线程最终退出。
    #[test]
    fn closing_with_queued_input_returns_at_once_and_the_threads_finish() {
        let f = fixture(1);
        f.session.input.queue.send("a".into()).unwrap();
        f.session.input.queue.send("b".repeat(1024 * 1024)).unwrap();
        f.entered.recv_timeout(THREAD_EXIT).expect("写线程未开始写入");
        let state = Arc::new(TerminalHandle::default());
        state.0.lock().insert("t1".to_owned(), f.session);

        let (done, returned) = std::sync::mpsc::channel();
        let closing = state.clone();
        std::thread::spawn(move || {
            close(&closing, "t1", Duration::from_millis(20));
            let _ = done.send(());
        });
        returned
            .recv_timeout(Duration::from_millis(500))
            .expect("关闭调用在 500 ms 内没有返回");
        assert!(!state.0.lock().contains_key("t1"));

        // 旧会话的收尾尚未完成时以同一 id 重新打开。
        let reopened = fixture(2);
        state.0.lock().insert("t1".to_owned(), reopened.session);

        f.killed.recv_timeout(THREAD_EXIT).expect("子进程未被终止");
        f.forced.recv_timeout(THREAD_EXIT).expect("宿主进程未被终止");
        // 正在进行的一块写入放行之后，队列中剩余的输入不再写入。
        f.gate.send(()).unwrap();
        f.writer_gone.recv_timeout(THREAD_EXIT).expect("写线程未退出");
        assert_eq!(f.written.lock().as_slice(), b"a");
        assert!(matches!(
            f.output.recv_timeout(THREAD_EXIT),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        ));
        assert_eq!(
            state.0.lock().get("t1").map(|s| s.created_seq),
            Some(2),
            "旧会话的收尾不得移除重新打开的会话"
        );
        // 替身的主端在其宿主进程被终止之前不释放，因此经同一收尾路径移除，不在测试线程中直接释放。
        let reopened = state.0.lock().remove("t1").expect("重新打开的会话");
        retire(reopened, Duration::ZERO)
            .recv_timeout(THREAD_EXIT)
            .expect("重新打开的会话未完成收尾");
    }

    /// 应用退出：在时限内返回，表项全部移除，每个会话的子进程与宿主进程都已终止。
    #[test]
    fn shutdown_returns_within_the_limit_and_terminates_every_session() {
        let state = TerminalHandle::default();
        let mut watched = Vec::new();
        for (id, seq) in [("t1", 1), ("t2", 2)] {
            let f = fixture(seq);
            f.session.input.queue.send("b".repeat(1024 * 1024)).unwrap();
            f.entered.recv_timeout(THREAD_EXIT).expect("写线程未开始写入");
            state.0.lock().insert(id.to_owned(), f.session);
            watched.push((f.killed, f.forced, f.gate, f.writer_gone, f.output));
        }
        let started = Instant::now();
        shutdown(&state);
        assert!(started.elapsed() < EXIT_LIMIT + Duration::from_secs(1));
        assert!(state.0.lock().is_empty());
        for (killed, forced, gate, writer_gone, output) in watched {
            killed.recv_timeout(THREAD_EXIT).expect("子进程未被终止");
            forced.recv_timeout(THREAD_EXIT).expect("宿主进程未被终止");
            gate.send(()).unwrap();
            writer_gone.recv_timeout(THREAD_EXIT).expect("写线程未退出");
            assert!(matches!(
                output.recv_timeout(THREAD_EXIT),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            ));
        }
    }
}
