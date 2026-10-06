//! `qy serve` 的生命周期托管。
//!
//! 桌面端不实现任何业务逻辑，只负责三件事：启动 sidecar、把令牌与端口交给
//! WebView、在退出时确保子进程被完全终止。
//!
//! 两个易错点：
//!
//! 1. **必须等 sidecar 输出令牌后再创建窗口。** 否则 WebView 先加载且无法取得令牌，
//!    会先短暂显示「未配对」再自行恢复，与启动失败无法区分。
//! 2. **退出时必须确实终止子进程。** Windows 上父进程结束不会终止子进程；
//!    残留的 `qy serve` 会占用端口和 SQLite 的 WAL 锁，导致下次无法启动。

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc::Receiver;

const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const RESTART_MAX_DELAY_MS: u64 = 15_000;
const STDERR_TAIL_BYTES: usize = 8 * 1024;
/// 启动失败对话框中附带的 stderr 长度。远小于 `STDERR_TAIL_BYTES`：MessageBox 不支持滚动，
/// 文本超出屏幕高度时无法点击确定按钮。取尾部：退出前最后输出的内容即错误本身。
const FATAL_STDERR_TAIL_BYTES: usize = 1024;

#[derive(Debug, Clone)]
struct PreviousExit {
    kind: &'static str,
    code: Option<i32>,
    signal: Option<i32>,
    observed_at_ms: u64,
    stderr_tail: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/** 尾部至多 `max` 字节，按 UTF-8 字符边界截取。 */
fn tail_of(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut cut = text.len() - max;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    &text[cut..]
}

/** 只保留退出前最后 8 KiB；该上限同时避免占满 Windows 环境块。 */
fn append_stderr_tail(tail: &mut String, text: &str) {
    tail.push_str(text);
    let keep = tail_of(tail, STDERR_TAIL_BYTES).len();
    if keep < tail.len() {
        tail.drain(..tail.len() - keep);
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub token: String,
    pub port: u16,
    pub base: String,
}

#[derive(Default)]
struct SidecarState {
    child: Option<CommandChild>,
    /** 正常退出与异常终止的唯一判据。置位后监督循环不再启动进程。 */
    stopping: bool,
}

/// 子进程句柄与生命周期终态。存放在 Tauri state 中，由退出流程与监督循环共用。
#[derive(Default)]
pub struct SidecarHandle(Arc<Mutex<SidecarState>>);

/**
 * 启动一个 qy serve。首次启动时端口与令牌不预先指定；异常恢复时固定复用原值，
 * 使已加载的 WebView 与手机端都无需另一套端点更新协议。
 */
fn spawn_process(
    app: &AppHandle,
    port: u16,
    token: Option<&str>,
    workspace: &str,
    previous_exit: Option<&PreviousExit>,
    host_key: Option<&str>,
) -> Result<(Receiver<CommandEvent>, CommandChild)> {
    let mut args = vec![
        "serve".to_string(),
        "--port".to_string(),
        port.to_string(),
        // 只绑定本机地址：局域网访问由用户在应用内显式开启（扫码配对），
        // 不能在启动时就把工作区暴露给整个 Wi-Fi 网络。
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--print-token".to_string(),
        // 宿主异常退出时 sidecar 自行退出，不遗留 SQLite 锁与监听端口。
        "--parent-pid".to_string(),
        std::process::id().to_string(),
    ];
    if !workspace.is_empty() {
        args.push("--cwd".to_string());
        args.push(workspace.to_string());
    }

    let mut command = app
        .shell()
        .sidecar("qy")
        .map_err(|e| anyhow!("未找到 qy sidecar：{e}"))?
        .args(args);
    // Office 执行程序位于安装资源目录的 office/ 下，显式交给 sidecar。macOS 上资源目录是
    // Contents/Resources，与可执行文件不在同一目录，sidecar 按自身位置无法找到。
    if let Ok(dir) = app.path().resource_dir() {
        command = command.env("QYWORK_OFFICE_DIR", dir.join("office"));
    }
    command = command.env(
        "QYWORK_UPDATE_KEY",
        &app.state::<crate::updater::UpdateOwner>().key,
    );
    if let Some(value) = token {
        // CLI 的 serve 以该变量作为显式令牌。恢复时必须复用，否则旧 WebView
        // 会以原令牌连接同一端口，并被永久判定为 unauthorized。
        command = command.env("QYWORK_TOKEN", value);
    }
    if let Some(value) = host_key {
        // 原生宿主连接的凭据，同一份用于浏览器与电脑控制两条路径。只交给该子进程：
        // 凭据不注入页面、不进入命令行参数、不落盘，也不传给插件。恢复时复用同一份，
        // 否则宿主无法重新连接新启动的 sidecar。
        command = command.env("QYWORK_HOST_KEY", value);
    }
    if let Some(exit) = previous_exit {
        command = command
            .env("QYWORK_PREVIOUS_EXIT_KIND", exit.kind)
            .env(
                "QYWORK_PREVIOUS_EXIT_AT_MS",
                exit.observed_at_ms.to_string(),
            )
            .env(
                "QYWORK_PREVIOUS_EXIT_CODE",
                exit.code.map(|v| v.to_string()).unwrap_or_default(),
            )
            .env(
                "QYWORK_PREVIOUS_EXIT_SIGNAL",
                exit.signal.map(|v| v.to_string()).unwrap_or_default(),
            )
            .env("QYWORK_PREVIOUS_STDERR_TAIL", &exit.stderr_tail);
    }
    command
        .spawn()
        .map_err(|e| anyhow!("启动 qy serve 失败：{e}"))
}

/** 把当前子进程交给生命周期 state；退出已开始时立即终止新进程。 */
fn hold_child(handle: &SidecarHandle, child: CommandChild) -> bool {
    let mut state = handle.0.lock();
    if state.stopping {
        drop(state);
        let _ = child.kill();
        return false;
    }
    state.child = Some(child);
    true
}

/** 只终止当前进程，不把整个监督器置为停止。用于启动失败后的下一次重试。 */
fn kill_current(handle: &SidecarHandle) {
    let child = handle.0.lock().child.take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

/// 从 sidecar 固定格式的两行输出中取得实际开始监听后的端点。
///
/// stderr 在转发的同时累积到 `tail`：握手失败时这段输出是唯一能说明原因的证据，
/// 而 release 下没有控制台，转发的输出不可见。
async fn await_handshake(rx: &mut Receiver<CommandEvent>, tail: &mut String) -> Result<SidecarInfo> {
    let mut token: Option<String> = None;
    let mut port: Option<u16> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                for raw in text.lines() {
                    if let Some(v) = raw.trim().strip_prefix("QYWORK_TOKEN=") {
                        token = Some(v.to_string());
                    }
                    if let Some(v) = raw.trim().strip_prefix("QYWORK_PORT=") {
                        port = v.parse().ok();
                    }
                }
                if let (Some(t), Some(p)) = (&token, port) {
                    return Ok(SidecarInfo {
                        token: t.clone(),
                        port: p,
                        base: format!("http://127.0.0.1:{p}"),
                    });
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                eprint!("{text}");
                append_stderr_tail(tail, &text);
            }
            CommandEvent::Error(error) => {
                return Err(anyhow!("读取 qy serve 输出失败：{error}"));
            }
            CommandEvent::Terminated(payload) => {
                return Err(anyhow!(
                    "qy serve 在输出令牌前退出，code={:?}",
                    payload.code
                ));
            }
            _ => {}
        }
    }
    Err(anyhow!("qy serve 输出结束但未输出令牌"))
}

async fn handshake_with_timeout(
    rx: &mut Receiver<CommandEvent>,
    tail: &mut String,
) -> Result<SidecarInfo> {
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, await_handshake(rx, tail)).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("qy serve 启动超过 20 秒仍未输出令牌")),
    }
}

/**
 * 持续消费进程事件并监督异常退出。
 *
 * 握手完成后不能丢弃 receiver：没有代码观察 CommandEvent::Terminated 时，
 * sidecar 退出后前端会无限重连旧端口。恢复时复用同一端口与令牌；新的
 * streamId 使连接层执行已有的 resync，从账本全量重建会话。
 */
fn supervise(
    app: AppHandle,
    info: SidecarInfo,
    mut rx: Receiver<CommandEvent>,
    host_key: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        let mut stderr_tail = String::new();
        loop {
            let previous_exit = loop {
                match rx.recv().await {
                    Some(CommandEvent::Stderr(line)) => {
                        let text = String::from_utf8_lossy(&line);
                        eprint!("{text}");
                        append_stderr_tail(&mut stderr_tail, &text);
                    }
                    Some(CommandEvent::Error(error)) => {
                        log::error!("读取 qy serve 输出失败：{error}");
                        append_stderr_tail(
                            &mut stderr_tail,
                            &format!("[sidecar output error] {error}\n"),
                        );
                    }
                    Some(CommandEvent::Terminated(payload)) => {
                        break PreviousExit {
                            kind: "terminated",
                            code: payload.code,
                            signal: payload.signal,
                            observed_at_ms: now_ms(),
                            stderr_tail: stderr_tail.clone(),
                        };
                    }
                    Some(_) => {}
                    None => {
                        break PreviousExit {
                            kind: "output_channel_closed",
                            code: None,
                            signal: None,
                            observed_at_ms: now_ms(),
                            stderr_tail: stderr_tail.clone(),
                        };
                    }
                }
            };

            let handle = app.state::<SidecarHandle>();
            {
                let mut state = handle.0.lock();
                if state.stopping {
                    return;
                }
                // Terminated 后句柄仅代表已结束进程的所有权；通道异常关闭时同样先
                // kill，避免失去联系的进程与新进程争用同一端口。
                if let Some(child) = state.child.take() {
                    let _ = child.kill();
                }
            }
            // 原样附带尾部输出：这是外壳侧唯一保留的 sidecar 退出原因记录。第二行起缩进四格，
            // 与 sidecar 自身的日志行格式一致。
            log::error!(
                "qy serve 异常终止（kind={} code={:?} signal={:?}），准备恢复\n    {}",
                previous_exit.kind,
                previous_exit.code,
                previous_exit.signal,
                previous_exit.stderr_tail.trim_end().replace('\n', "\n    ")
            );

            let mut delay_ms = 400_u64;
            loop {
                if handle.0.lock().stopping {
                    return;
                }
                if crate::updater::installing(&app) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }

                match spawn_process(
                    &app,
                    info.port,
                    Some(&info.token),
                    "",
                    Some(&previous_exit),
                    host_key.as_deref(),
                ) {
                    Ok((mut next_rx, child)) => {
                        if !hold_child(&handle, child) {
                            return;
                        }
                        match handshake_with_timeout(&mut next_rx, &mut stderr_tail).await {
                            Ok(next) if next.port == info.port && next.token == info.token => {
                                log::info!("qy serve 已在原端点恢复 :{}", info.port);
                                rx = next_rx;
                                stderr_tail.clear();
                                break;
                            }
                            Ok(next) => {
                                log::error!(
                                    "qy serve 恢复端点不一致：期望 :{}，实际 :{}",
                                    info.port,
                                    next.port
                                );
                                kill_current(&handle);
                            }
                            Err(error) => {
                                log::error!("qy serve 恢复失败：{error}");
                                kill_current(&handle);
                            }
                        }
                    }
                    Err(error) => log::error!("qy serve 重新启动失败：{error}"),
                }

                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms * 2).min(RESTART_MAX_DELAY_MS);
            }
        }
    });
}

/// 启动 sidecar 并等待其输出令牌与端口。
///
/// `--port 0` 由内核选择空闲端口：固定端口会在用户同时打开两个工作区时发生冲突。
pub async fn spawn(
    app: &AppHandle,
    workspace: &str,
    host_key: Option<&str>,
) -> Result<SidecarInfo> {
    let (mut rx, child) = spawn_process(app, 0, None, workspace, None, host_key)?;
    let pid = child.pid();

    let handle = app.state::<SidecarHandle>();
    if !hold_child(&handle, child) {
        return Err(anyhow!("应用已经开始退出，取消启动 qy serve"));
    }

    /*
     * 握手必须设置时限。
     *
     * **不能写成不带时限的 `while rx.recv().await`**：该循环只在取得两个 KV、进程
     * Terminated 或流关闭时退出。qy 已启动但停滞在输出令牌之前（server 初始化阻塞、
     * 端口探测无响应）时，该循环**永不返回**，而主窗口在它之后才创建
     * （`lib.rs` 的 `build_main_window`），因此 qywork.exe 与 qy.exe 均在后台
     * 运行而桌面上没有窗口。
     *
     * 20 秒：冷启动需读取配置、打开 SQLite、并可能预热扩展，因此留出比预估更宽裕的时间；
     * 误判的代价（中止一次很慢的启动）远小于漏判的代价（无提示地停滞）。
     */
    let mut tail = String::new();
    match handshake_with_timeout(&mut rx, &mut tail).await {
        Ok(info) => {
            log::info!("qy serve 已启动 pid={pid} port={}", info.port);
            supervise(app.clone(), info.clone(), rx, host_key.map(str::to_owned));
            Ok(info)
        }
        Err(error) => {
            // 首次启动失败同样有可见终态：终止子进程后由 lib.rs 弹出启动失败对话框。
            // 错误本身只能说明「在输出令牌前退出」，退出原因位于 sidecar 的 stderr，
            // 因此一并附带 stderr 尾部：对话框是用户唯一能看到的输出。
            kill_current(&handle);
            let tail = tail_of(tail.trim_end(), FATAL_STDERR_TAIL_BYTES);
            Err(if tail.is_empty() {
                error
            } else {
                anyhow!("{error}\n\n{tail}")
            })
        }
    }
}

/// 终止子进程。退出路径上必须调用，且必须支持重复调用而不出错。
pub fn shutdown(app: &AppHandle) {
    shutdown_handle(&app.state::<SidecarHandle>());
}

/// 安装期间由更新所有者禁止恢复；安装启动失败后仍复用原监督器。
pub fn stop_for_update(app: &AppHandle) {
    kill_current(&app.state::<SidecarHandle>());
}

/// 同上，但直接接收句柄：握手超时路径上尚无可用的 app state 引用。
fn shutdown_handle(handle: &SidecarHandle) {
    let child = {
        let mut state = handle.0.lock();
        state.stopping = true;
        state.child.take()
    };
    if let Some(c) = child {
        // kill 失败只记录日志：此时进程可能已自行退出，
        // 不应因此阻断应用退出。
        if let Err(e) = c.kill() {
            log::error!("停止 qy serve 失败：{e}");
        }
    }
}

/// 读取 dev.ts 交给外壳的 sidecar 端点。只在 devUrl 模式下调用：页面来自 Vite 源码，
/// 后端必须是从同一源码树启动的进程。
///
/// 不做存活探测。端口上暂时没有进程监听（dev.ts 正在重启 sidecar）时，由 WebView 的连接层
/// 重连处理；探测失败即改用其他后端，会把源码页面绑定到预编译的 `bin/qy`。
pub fn from_env() -> Option<SidecarInfo> {
    let token = std::env::var("QYWORK_TOKEN").ok()?;
    let port: u16 = std::env::var("QYWORK_PORT").ok()?.parse().ok()?;
    Some(SidecarInfo {
        token,
        port,
        base: format!("http://127.0.0.1:{port}"),
    })
}

/// 供前端读取的注入脚本。
///
/// 使用初始化脚本而不是 Tauri 命令：WebView 中的连接层在首帧即需要令牌，
/// 异步命令返回较晚，会先渲染出「未配对」。
pub fn init_script(info: &SidecarInfo) -> String {
    format!(
        "globalThis.__QYWORK__ = {{ token: {}, base: {} }};",
        serde_json::to_string(&info.token).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&info.base).unwrap_or_else(|_| "\"\"".into()),
    )
}

/// 记录上次打开的工作区。
///
/// 没有该记录时，切换工作区只在本次运行中有效。
///
/// 保存为一行纯文本而不是 JSON：只有一个值，增加结构只会使手动修改更困难。
fn last_workspace_file() -> Option<PathBuf> {
    Some(crate::logfile::data_dir()?.join("last-workspace"))
}

pub fn read_last_workspace() -> Option<PathBuf> {
    let p = std::fs::read_to_string(last_workspace_file()?).ok()?;
    // 去除 BOM。该文件允许手动修改，而 Windows 记事本保存 UTF-8 时
    // 默认带 BOM：不剥离时路径中多出一个不可见字符，`is_dir()` 返回 false，
    // 修改后的记录静默失效。
    // 复现方式：PowerShell 的 Set-Content -Encoding utf8。
    let path = PathBuf::from(p.trim_start_matches('\u{feff}').trim());
    // 记录的目录可能已被删除或重命名。存在性检查放在此处而不是调用方，
    // 因为记录失效时的正确处理是**回退到下一级优先级**，而不是报错。
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

pub fn write_last_workspace(path: &str) {
    let Some(file) = last_workspace_file() else {
        return;
    };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 写入失败只记录日志：无法记录上次的工作区只影响体验，不应使切换本身失败。
    if let Err(e) = std::fs::write(&file, path) {
        log::error!("记录工作区失败：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{append_stderr_tail, from_env, STDERR_TAIL_BYTES};

    /// 端口上没有进程监听时也不能改用其他后端：外壳可能在 dev.ts 重启 sidecar 的间隙中启动。
    #[test]
    fn from_env_keeps_the_given_port_even_when_nothing_listens() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        std::env::set_var("QYWORK_TOKEN", "t");
        std::env::set_var("QYWORK_PORT", port.to_string());
        let info = from_env();
        std::env::remove_var("QYWORK_TOKEN");
        std::env::remove_var("QYWORK_PORT");

        let info = info.expect("两个变量均已设置时必须返回端点");
        assert_eq!(info.port, port);
        assert_eq!(info.token, "t");
        assert_eq!(info.base, format!("http://127.0.0.1:{port}"));
    }

    #[test]
    fn stderr_tail_is_bounded_and_keeps_utf8_boundary() {
        let mut tail = "早期日志".repeat(STDERR_TAIL_BYTES);
        append_stderr_tail(&mut tail, "\npanic: 最后一条根因\n");

        assert!(tail.len() <= STDERR_TAIL_BYTES);
        assert!(tail.ends_with("panic: 最后一条根因\n"));
        assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
    }
}
