//! 交互式终端：每个会话对应一个 PTY，输出以事件推送给 WebView。
//!
//! **本层例外地持有状态。** lib.rs 文件头规定「外壳不持有业务状态、WebView 直接连接
//! sidecar」，该规定针对会话、账本、权限等**两端都应具备**的状态。PTY 不属于此类：
//! 它是真实的本机子进程与一对操作系统句柄，无法跨网络传递，手机端也不可能具备。
//! 放入 sidecar 等于把「在本机运行任意命令」开放到局域网（CLAUDE.md E）。
//! 因此终端是桌面端独有能力，在握手之外由 `isDesktopShell()` 判定，其他端不显示入口。
//!
//! 会话不随面板切换而销毁：用户切换到文件视图或收起整个面板时，命令仍需继续运行。
//! 只在显式关闭（页签上的 ×）、子进程自行退出与应用退出时销毁。
//!
//! 每个 id 对应一个会话，前端可同时打开多个（页签由 `panelTabs` 管理）。每个会话记录其所属的
//! 工作区：前端按工作区分别显示页签，切换工作区不关闭任何会话。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

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

struct Session {
    /// 会话所属的工作区。**创建后不再修改**：id 与 PTY 一一对应，
    /// 修改归属等于把一个正在运行的 shell 记到另一个工作区名下。
    workspace_id: String,
    /// 外壳进程中的创建序号，与浏览器页共用一个计数器。界面按它排列页签栏。
    created_seq: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 最近输出的原样副本，供前端重新接入时回放。
    ///
    /// **前端的 xterm 实例随页面存在**：整页刷新后它是新的空白屏幕，而 shell
    /// 仍在运行；不回放时，用户重新接入后只能看到空白屏幕。
    /// 保存原始字节序列（含转义序列）而不是渲染后的文本：回放即把这段字节重新写入
    /// xterm 解析，模式、颜色、光标位置随之恢复。
    backlog: Arc<Mutex<String>>,
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

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
    /// 退出码。无法取得（被信号终止、平台不报告）时为 `None`，不要伪造为 0：
    /// 「正常结束」与「结束方式未知」对用户是两种不同的情况。
    code: Option<u32>,
}

/// 打开一个会话，**返回需要回放的输出**。
///
/// 已存在的 id 不报错，直接返回其回放缓冲：前端在面板重新挂载时会无条件
/// 调用一次，报错会使已打开的终端显示「已存在」错误。新建的会话
/// 没有可回放的内容，返回空串。
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
) -> Result<String, String> {
    if let Some(session) = state.0.lock().get(&id) {
        if session.workspace_id != workspace_id {
            return Err("该终端属于另一个项目".to_owned());
        }
        return Ok(session.backlog.lock().clone());
    }

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("无法打开 PTY：{e}"))?;

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

    let backlog = Arc::new(Mutex::new(String::new()));
    state.0.lock().insert(
        id.clone(),
        Session {
            workspace_id,
            // 重新接入已存在的 id 时在函数开头已返回，序号只在此处分配一次。
            created_seq: crate::next_created_seq(),
            master: pair.master,
            writer,
            killer,
            backlog: backlog.clone(),
        },
    );

    spawn_reader(app.clone(), id.clone(), reader, backlog);

    // 等待回收子进程的线程。**不能与读线程合并**：读端需等待 EOF，而 EOF 之后
    // 还需取得退出码；分开后两者各自阻塞在自己的句柄上，到达顺序不影响结果。
    //
    // **先把会话从表中移除，再上报退出。** 保留时该 id 永远「已存在」，
    // 用户点击「重开」时 `terminal_open` 直接返回成功，但不会启动新的 shell。
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        app.state::<TerminalHandle>().0.lock().remove(&id);
        let _ = app.emit("terminal:exit", Exit { id, code });
    });

    Ok(String::new())
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
#[tauri::command]
pub fn terminal_write(state: State<TerminalHandle>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock();
    let session = map.get_mut(&id).ok_or("终端会话已不存在")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
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

/// 关闭一个会话：终止 shell 并从表中移除。
///
/// **不存在的 id 直接返回成功。** 子进程可能已自行退出（回收线程已将其移除），
/// 用户随后点击页签上的 × 时若报「会话已不存在」，该页签将无法关闭。
///
/// 终止后回收线程仍会 emit 一次 `terminal:exit`。前端在终止之前已移除该 id
/// 的监听（见 `apps/web/src/lib/terminal.ts` 的 `closeTerminal`），
/// 因此该事件到达即被丢弃，不会写入已销毁的 xterm。
#[tauri::command]
pub fn terminal_close(state: State<TerminalHandle>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().remove(&id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 应用退出时终止全部会话。理由与 sidecar 相同：Windows 上父进程退出不会终止子进程，
/// 残留的 shell 会持有工作区中的文件句柄。
pub fn shutdown(state: &TerminalHandle) {
    for (_, mut session) in state.0.lock().drain() {
        let _ = session.killer.kill();
    }
}

/// 读线程：PTY → 事件。
///
/// **不能对每个 chunk 直接调用 `from_utf8_lossy`。** 一个汉字占三个字节，读取的块可能
/// 在字符中间断开，逐块解码会把断点两侧各变成一个替换字符，使中文输出出现乱码。
/// 因此不完整的尾部字节保留在 `carry` 中，等待下一块。
fn spawn_reader(
    app: AppHandle,
    id: String,
    mut reader: Box<dyn Read + Send>,
    backlog: Arc<Mutex<String>>,
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
                push_backlog(&mut backlog.lock(), &text);
                let _ = app.emit(
                    "terminal:output",
                    Output {
                        id: id.clone(),
                        data: text,
                    },
                );
            }
        }
    });
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

/// 取出 `carry` 开头完整的 UTF-8 部分，不完整的字符保留在原处。
///
/// 确实非法的字节（不是尚未读完，而是本身不是 UTF-8）须丢弃并换成替换字符，
/// 否则它会永远停滞在缓冲区头部，后续所有输出都无法发出。
fn take_valid(carry: &mut Vec<u8>) -> String {
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let out = s.to_owned();
            carry.clear();
            out
        }
        Err(e) => {
            let good = e.valid_up_to();
            let mut out = String::from_utf8_lossy(&carry[..good]).into_owned();
            match e.error_len() {
                Some(bad) => {
                    out.push('\u{FFFD}');
                    carry.drain(..good + bad);
                }
                None => {
                    carry.drain(..good);
                }
            }
            out
        }
    }
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
