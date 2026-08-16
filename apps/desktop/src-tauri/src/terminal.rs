//! 交互式终端：一条会话一个 PTY，输出按事件推给 WebView。
//!
//! **为什么这一层破例持有状态。** lib.rs 顶上写着「外壳不持业务状态、WebView 直连
//! sidecar」——那条针对的是会话、账本、权限这些**两端都该有**的东西。PTY 不是：
//! 它是一个真实的本机子进程和一对操作系统句柄，跨不过网络，手机端也不可能有。
//! 放进 sidecar 就等于把「在这台机器上跑任意命令」开到局域网上（CLAUDE.md E）。
//! 所以终端是桌面独有能力，握手之外由 `isDesktopShell()` 判定，别的端不显示入口。
//!
//! 会话不随面板切换销毁：用户切去看文件再切回来，命令还得在跑。销毁只发生在
//! 显式关闭、子进程自己退出、以及应用退出时。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// 一次读取的上限。太小会让长输出被切成大量事件（每个事件一次 IPC 序列化），
/// 太大则拖长首字节延迟——8K 是 ConPTY 与 pty 常见的一次写入量级。
const READ_CHUNK: usize = 8 * 1024;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalHandle(Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
    /// 退出码。拿不到（被信号杀掉、平台不报）时是 `None`，不要伪造成 0——
    /// 「正常结束」和「不知道怎么结束的」对用户是两件事。
    code: Option<u32>,
}

/// 开一条会话。
///
/// 已经存在的 id 直接返回成功：前端在面板重新挂载时会无条件调一次，
/// 报错的话用户看到的是一个开着的终端配一句「已存在」的红字。
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<TerminalHandle>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if state.0.lock().contains_key(&id) {
        return Ok(());
    }

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("打不开 PTY：{e}"))?;

    let mut cmd = CommandBuilder::new(default_shell());
    // 目录不存在就交给系统默认，不要直接失败：账本里的项目可能已经被用户挪走，
    // 那种情况下开一个家目录的终端比开不出来有用。
    let dir = PathBuf::from(&cwd);
    if dir.is_dir() {
        cmd.cwd(dir);
    }
    // 不声明的话大量程序会退化成最笨的输出（无色、无光标定位），
    // 而 xterm.js 这一侧是按 256 色终端渲染的。
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("起不了 shell：{e}"))?;
    // slave 端必须在这里就地丢掉。留着它的话读端永远等不到 EOF——
    // 子进程退出了，读线程还挂在 read() 上，界面表现是「命令结束了但终端没反应」。
    drop(pair.slave);

    let killer = child.clone_killer();
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("拿不到写端：{e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("拿不到读端：{e}"))?;

    state.0.lock().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );

    spawn_reader(app.clone(), id.clone(), reader);

    // 等子进程收尸的线程。**不能和读线程合并**：读端要等 EOF，而 EOF 之后
    // 还得知道退出码；分开之后两件事各自阻塞在自己的句柄上，谁先到都不误事。
    //
    // **先把会话从表里摘掉再报退出。** 留着的话这个 id 就永远「已存在」，
    // 用户按「重开」时 `terminal_open` 直接返回成功却什么也没起——
    // 界面上是一个点了没反应的按钮。
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        app.state::<TerminalHandle>().0.lock().remove(&id);
        let _ = app.emit("terminal:exit", Exit { id, code });
    });

    Ok(())
}

/// 键盘输入。原样写进 PTY，不做任何解释——回车、Ctrl-C、方向键都是字节，
/// 由 shell 自己去认。
#[tauri::command]
pub fn terminal_write(state: State<TerminalHandle>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock();
    let session = map.get_mut(&id).ok_or("这条终端会话已经不在了")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

/// 改尺寸。**必须真的告诉 PTY**：只改 xterm 那一侧的话，`less`、`vim`、
/// 任何按 COLUMNS 换行的程序都会按旧宽度排版，看起来像是自己乱折行。
#[tauri::command]
pub fn terminal_resize(
    state: State<TerminalHandle>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock();
    let session = map.get(&id).ok_or("这条终端会话已经不在了")?;
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

/// 应用退出时收干净。同 sidecar 那条理由：Windows 上父进程退出不带走子进程，
/// 留下的 shell 会攥着工作区里的文件句柄。
pub fn shutdown(state: &TerminalHandle) {
    for (_, mut session) in state.0.lock().drain() {
        let _ = session.killer.kill();
    }
}

/// 读线程：PTY → 事件。
///
/// **不能按 chunk 直接 `from_utf8_lossy`。** 一个中文字是三个字节，读到的块随时可能
/// 从字中间断开，逐块解码会把断口两侧各变成一个替换字符——中文输出会稳定地长出乱码。
/// 所以未完成的尾巴留在 `carry` 里等下一块。
fn spawn_reader(app: AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
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

/// 取出 `carry` 前面那段完整的 UTF-8，剩下的半个字符留在原地。
///
/// 真正非法的字节（不是「还没读全」，而是本来就不是 UTF-8）要吃掉并换成替换字符，
/// 否则它会永远卡在缓冲区头部，后面所有输出都发不出去。
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

/// 用哪个 shell。
///
/// Windows 上是 PowerShell 而不是 Git Bash：这一格是**用户自己的终端**，
/// 该给系统默认的那个。agent 侧优先 Git Bash 是另一回事——那是为了让模型写的
/// POSIX 组合命令能跑（见 `packages/tools/src/shell.ts`），和人手敲命令的预期相反。
fn default_shell() -> String {
    if cfg!(windows) {
        // 写死 powershell.exe，不读 COMSPEC——那个变量指的是 cmd.exe，
        // 它是「批处理解释器」而不是这台机器上的默认交互 shell。
        "powershell.exe".to_owned()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned())
    }
}
