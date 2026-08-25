//! 交互式终端：一条会话一个 PTY，输出按事件推给 WebView。
//!
//! **为什么这一层破例持有状态。** lib.rs 顶上写着「外壳不持业务状态、WebView 直连
//! sidecar」——那条针对的是会话、账本、权限这些**两端都该有**的状态。PTY 不是：
//! 它是一个真实的本机子进程和一对操作系统句柄，跨不过网络，手机端也不可能有。
//! 放进 sidecar 就等于把「在这台机器上跑任意命令」开到局域网上（CLAUDE.md E）。
//! 所以终端是桌面独有能力，握手之外由 `isDesktopShell()` 判定，别的端不显示入口。
//!
//! 会话不随面板切换销毁：用户切去看文件、甚至把整块面板收起来，命令还得在跑。
//! 销毁只发生在显式关闭（页签上的 ×、换项目）、子进程自己退出、以及应用退出时。
//!
//! 一条 id 一条会话，前端可以同时开几条（页签由 `panelTabs` 管）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// 一次读取的上限。太小会让长输出被切成大量事件（每个事件一次 IPC 序列化），
/// 太大则拖长首字节延迟——8K 是 ConPTY 与 pty 常见的一次写入量级。
const READ_CHUNK: usize = 8 * 1024;

/// 回放缓冲的上限。**这是屏幕重建用的，不是滚动历史**：够装下一屏全屏 TUI 的
/// 重绘（清屏 + 定位 + 满屏字符，几十 K 量级）并留出余量即可，翻历史归 xterm
/// 自己的 5000 行回滚管。再大就是拿常驻内存换一段谁也不会去看的字节。
const BACKLOG_CAP: usize = 256 * 1024;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 最近这些输出的原样副本，供前端重新接上来时回放。
    ///
    /// **前端那块 xterm 是随页面走的**：整页刷新之后它是全新的一块空屏，而 shell
    /// 还在原地跑——不回放的话，用户接回来看到的是一片黑，敲一下才看得出它仍在运行。
    /// 存原始字节序列（含转义序列）而不是渲染后的文本：回放就是把这段重新写回
    /// xterm 重新解析，模式、颜色、光标位置都跟着一起回来。
    backlog: Arc<Mutex<String>>,
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

/// 开一条会话，**返回要回放的那段输出**。
///
/// 已经存在的 id 不报错，直接把它的回放缓冲交出去：前端在面板重新挂载时会无条件
/// 调一次，报错的话用户看到的是一个开着的终端配一句「已存在」的红字。新起的会话
/// 没有可回放的，回空串。
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<TerminalHandle>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    if let Some(session) = state.0.lock().get(&id) {
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
        .map_err(|e| format!("打不开 PTY：{e}"))?;

    let mut cmd = CommandBuilder::new(default_shell());
    // 目录不存在就交给系统默认，不要直接失败：账本里的项目可能已经被用户挪走，
    // 那种情况下开一个家目录的终端比开不出来有用。
    let dir = PathBuf::from(&cwd);
    if dir.is_dir() {
        cmd.cwd(dir);
    }
    // 不声明的话大量程序会退化成最基础的输出（无色、无光标定位），
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

    let backlog = Arc::new(Mutex::new(String::new()));
    state.0.lock().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
            backlog: backlog.clone(),
        },
    );

    spawn_reader(app.clone(), id.clone(), reader, backlog);

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

    Ok(String::new())
}

/// 现在还开着哪几条会话。
///
/// **前端的页签是这张表的镜像。** 镜像会因为前端整个重建被清空（整页重载、
/// 开发期热更换掉那个模块都算），而 shell 还在跑——不对一次账，那条会话就没有
/// 任何界面碰得到它，只能等应用退出时被 `shutdown` 收掉。
#[tauri::command]
pub fn terminal_list(state: State<TerminalHandle>) -> Vec<String> {
    state.0.lock().keys().cloned().collect()
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

/// 关掉一条会话：杀掉 shell 并从表里摘掉。
///
/// **不存在的 id 直接返回成功。** 子进程可能自己先退了（收尸线程已经把它摘掉），
/// 而用户随后点了页签上的 ×——那时报「会话不在了」，界面上就是一颗关不掉页签的按钮。
///
/// 杀掉之后收尸线程会照常 emit 一次 `terminal:exit`。前端那一侧在杀之前就把这个 id
/// 的监听摘了（见 `apps/web/src/lib/terminal.ts` 的 `closeTerminal`），
/// 所以那条事件落地即丢，不会打到一个已经销毁的 xterm 上。
#[tauri::command]
pub fn terminal_close(state: State<TerminalHandle>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().remove(&id) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 应用退出时收干净。同 sidecar 那条理由：Windows 上父进程退出不带走子进程，
/// 留下的 shell 会持有工作区里的文件句柄。
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

/// 往回放缓冲里追加，超出上限就从头切。
///
/// **切点必须落在字符边界上**，否则缓冲里会留下半个字符，回放时那个位置是替换字符。
/// 从头切必然会把某条转义序列切成两半，回放的第一行可能带几个乱码字符——
/// 不为它加对齐逻辑：全屏程序下一次重绘就盖掉了，而普通输出多的是换行。
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

/// 取出 `carry` 前面那段完整的 UTF-8，剩下的半个字符留在原地。
///
/// 真正非法的字节（不是「还没读全」，而是本来就不是 UTF-8）要丢弃并换成替换字符，
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
