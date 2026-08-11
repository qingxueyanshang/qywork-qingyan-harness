//! 交互式终端。
//!
//! **为什么 PTY 在 Rust 侧而不在 Bun sidecar 里**：Bun v1.3.5 起内建了 PTY，
//! 但只支持 POSIX——Windows 没有 ConPTY 实现。而 Windows 是本项目的主开发平台，
//! 所以交互式终端只能由 Rust 的 `portable-pty` 承担（它在三个平台上分别走
//! ConPTY / openpty，行为一致）。
//!
//! 这也划出了一条能力边界：**手机端没有终端**。PTY 在 Tauri 进程里，
//! 网络那头够不着，所以握手时能力声明里 `pty: false`——与其让手机上出现一个
//! 点了没反应的入口，不如根本不显示。
//!
//! agent 自己执行命令走的是 sidecar 里的管道（`Bun.spawn`），与这里无关：
//! 那是给模型用的，不需要终端语义，也不该占用交互式会话。

use anyhow::Result;
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// 只保留 master 端。slave 在 spawn 之后必须立刻丢掉——留着它，子进程退出时
/// master 的读端收不到 EOF，读线程会永远挂着。所以这里存不下整个 PtyPair。
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

#[derive(Default)]
pub struct PtyRegistry(pub Arc<Mutex<HashMap<String, PtySession>>>);

#[derive(serde::Serialize, Clone)]
struct PtyOutput {
    id: String,
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct PtyExit {
    id: String,
}

/// 开一个终端会话。返回会话 id，后续读写都按它寻址。
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    registry: tauri::State<'_, PtyRegistry>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    open_inner(&app, &registry, id.clone(), cwd, cols, rows).map_err(|e| e.to_string())?;
    Ok(id)
}

fn open_inner(
    app: &AppHandle,
    registry: &tauri::State<'_, PtyRegistry>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let sys = NativePtySystem::default();
    let pair = sys.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(default_shell());
    cmd.cwd(cwd);
    // 明确声明终端能力：不设的话很多 CLI 会退化成无色无光标的哑终端模式。
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let PtyPairParts { master, slave } = split(pair);
    let mut child = slave.spawn_command(cmd)?;
    // slave 交给子进程后必须在父进程这边丢掉：留着它，子进程退出时 master
    // 读端收不到 EOF，下面的读线程会永远挂着。
    drop(slave);

    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;

    let app_for_read = app.clone();
    let id_for_read = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // 用 from_utf8_lossy：PTY 的字节流可能在多字节字符中间被切开，
                    // 严格解码会在中文输出上随机报错。
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_read.emit(
                        "pty:data",
                        PtyOutput {
                            id: id_for_read.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        let _ = app_for_read.emit("pty:exit", PtyExit { id: id_for_read });
    });

    registry.0.lock().insert(id, PtySession { master, writer });
    Ok(())
}

/// 把 PtyPair 拆成两半。
///
/// 直接 `drop(pair.slave)` 会部分移动 pair，之后就不能再整体使用它；
/// 显式拆开让「master 留下、slave 丢掉」这件事在类型层面成立。
struct PtyPairParts {
    master: Box<dyn MasterPty + Send>,
    slave: Box<dyn portable_pty::SlavePty + Send>,
}

fn split(pair: portable_pty::PtyPair) -> PtyPairParts {
    PtyPairParts {
        master: pair.master,
        slave: pair.slave,
    }
}

#[tauri::command]
pub fn pty_write(
    registry: tauri::State<'_, PtyRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut map = registry.0.lock();
    let session = map.get_mut(&id).ok_or("终端会话不存在")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    registry: tauri::State<'_, PtyRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = registry.0.lock();
    let session = map.get(&id).ok_or("终端会话不存在")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_close(registry: tauri::State<'_, PtyRegistry>, id: String) -> Result<(), String> {
    registry.0.lock().remove(&id);
    Ok(())
}

/// 关闭全部会话。应用退出时调用，避免留下孤儿 shell 进程。
pub fn close_all(registry: &PtyRegistry) {
    registry.0.lock().clear();
}

fn default_shell() -> String {
    if cfg!(windows) {
        // PowerShell 优先；没有就退回 cmd。不用 pwsh 是因为它不一定装了。
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}
