//! `qy serve` 的生命周期托管。
//!
//! 桌面端不实现任何业务逻辑，它只做三件事：把 sidecar 拉起来、把令牌和端口交给
//! WebView、在退出时确保子进程被收干净。
//!
//! 两条容易出事的地方：
//!
//! 1. **必须等 sidecar 打印出令牌再建窗口。** 否则 WebView 先加载、拿不到令牌，
//!    会先闪一个「未配对」再自己恢复——看起来像启动失败。
//! 2. **退出时必须真的杀掉子进程。** Windows 上父进程结束不会带走子进程；
//!    残留的 `qy serve` 会占着端口和 SQLite 的 WAL 锁，下次启动直接起不来。

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
/// 启动失败对话框里带多少 stderr。比 `STDERR_TAIL_BYTES` 小得多：MessageBox 不滚动，
/// 文本撑出屏幕高度时确定按钮就点不到了。取尾部——退出前最后打印的那段就是错误本身。
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

/** 尾部至多 `max` 字节，按 UTF-8 字符边界切。 */
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

/** 只留退出前最后 8 KiB；上限同时避免撑满 Windows 环境块。 */
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
    /** 正常退出与异常终止的唯一分界。置上后监督循环绝不再拉起进程。 */
    stopping: bool,
}

/// 子进程句柄与生命周期终态。放进 Tauri state，退出与监督循环共用这一份。
#[derive(Default)]
pub struct SidecarHandle(Arc<Mutex<SidecarState>>);

/**
 * 拉起一份 qy serve。首次启动允许内核选择端口与令牌；异常恢复固定复用原值，
 * 这样已经加载的 WebView 和手机端都不需要第二套端点更新协议。
 */
fn spawn_process(
    app: &AppHandle,
    port: u16,
    token: Option<&str>,
    workspace: &str,
    previous_exit: Option<&PreviousExit>,
    browser_key: Option<&str>,
) -> Result<(Receiver<CommandEvent>, CommandChild)> {
    let mut args = vec![
        "serve".to_string(),
        "--port".to_string(),
        port.to_string(),
        // 只绑本机：局域网访问由用户在应用内显式开启（扫码配对），
        // 不能一启动就把工作区暴露在整个 Wi-Fi 上。
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--print-token".to_string(),
        // 宿主异常退出时 sidecar 自己收场，不留 SQLite 锁与监听端口。
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
        .map_err(|e| anyhow!("找不到 qy sidecar：{e}"))?
        .args(args);
    if let Some(value) = token {
        // CLI 的 serve 以这一变量作为显式令牌。恢复时必须复用，否则旧 WebView
        // 会拿原令牌连到同一端口，再被永久判成 unauthorized。
        command = command.env("QYWORK_TOKEN", value);
    }
    if let Some(value) = browser_key {
        // 浏览器宿主连接的凭据。只交给这一个子进程：它不注入页面、不进命令行参数、
        // 不落盘，也不传给插件。恢复时复用同一份，否则宿主连不回新起的 sidecar。
        command = command.env("QYWORK_BROWSER_KEY", value);
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

/** 把当前子进程交给生命周期 state；退出已经开始时，当场收掉新进程。 */
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

/** 只收当前进程，不把整个监督器置成停止。用于启动失败后的下一次重试。 */
fn kill_current(handle: &SidecarHandle) {
    let child = handle.0.lock().child.take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

/// 从 sidecar 的稳定两行输出中取回真正开始监听后的端点。
///
/// stderr 边转发边攒进 `tail`：握手失败时那一段是唯一说得出原因的证据，
/// 而 release 下没有控制台，转发出去的那份谁也看不见。
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
                    "qy serve 在报出令牌前退出，code={:?}",
                    payload.code
                ));
            }
            _ => {}
        }
    }
    Err(anyhow!("qy serve 输出结束但未报出令牌"))
}

async fn handshake_with_timeout(
    rx: &mut Receiver<CommandEvent>,
    tail: &mut String,
) -> Result<SidecarInfo> {
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, await_handshake(rx, tail)).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("qy serve 启动超过 20 秒仍未报出令牌")),
    }
}

/**
 * 持续消费进程事件并监督异常退出。
 *
 * 以前握手一完成就丢掉 receiver，也再没人观察 CommandEvent::Terminated：长任务里
 * sidecar 一旦退出，前端只会永远重连旧端口。现在恢复仍复用同一端口与令牌；新的
 * streamId 会让连接层走已有的 resync，全量从账本重建会话。
 */
fn supervise(
    app: AppHandle,
    info: SidecarInfo,
    mut rx: Receiver<CommandEvent>,
    browser_key: Option<String>,
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
                // Terminated 后句柄只是一份已结束进程的所有权；通道异常关闭时也先
                // kill，避免一份失联进程与新进程同时争同一端口。
                if let Some(child) = state.child.take() {
                    let _ = child.kill();
                }
            }
            // 尾部原样带上：这是 sidecar 退出原因唯一留在壳这边的记录。续行缩进四格，
            // 与 sidecar 自己的日志行格式一致。
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

                match spawn_process(
                    &app,
                    info.port,
                    Some(&info.token),
                    "",
                    Some(&previous_exit),
                    browser_key.as_deref(),
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
                    Err(error) => log::error!("qy serve 重新拉起失败：{error}"),
                }

                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms * 2).min(RESTART_MAX_DELAY_MS);
            }
        }
    });
}

/// 启动 sidecar 并等它报出令牌与端口。
///
/// `--port 0` 让内核挑空闲端口：写死端口会在用户同时开两个工作区时直接撞车。
pub async fn spawn(
    app: &AppHandle,
    workspace: &str,
    browser_key: Option<&str>,
) -> Result<SidecarInfo> {
    let (mut rx, child) = spawn_process(app, 0, None, workspace, None, browser_key)?;
    let pid = child.pid();

    let handle = app.state::<SidecarHandle>();
    if !hold_child(&handle, child) {
        return Err(anyhow!("应用已经开始退出，取消启动 qy serve"));
    }

    /*
     * 握手要有上限。
     *
     * **不能写成裸的 `while rx.recv().await`**：那样只有拿到两个 KV、进程
     * Terminated、或流关闭才退出。qy 起来了却卡在打印令牌之前（server 初始化阻塞、
     * 端口探测挂住）时，这个循环**永远不返回**——而主窗口是在它之后才建的
     * （`lib.rs` 的 `build_main_window`）。表现是 qywork.exe 和 qy.exe 都在后台
     * 都在运行、桌面上没有窗口，任务管理器里只剩一条常驻的 qy.exe。
     *
     * 20 秒：冷启动需读取配置、打开 SQLite、并可能预热扩展，因此留出比预估更宽裕的时间。；
     * 判错的代价（把一次很慢的启动掐掉）比判漏（无声挂死）小得多。
     */
    let mut tail = String::new();
    match handshake_with_timeout(&mut rx, &mut tail).await {
        Ok(info) => {
            log::info!("qy serve 已拉起 pid={pid} port={}", info.port);
            supervise(app.clone(), info.clone(), rx, browser_key.map(str::to_owned));
            Ok(info)
        }
        Err(error) => {
            // 首次启动仍然是可见终态：收干净后让 lib.rs 弹启动失败对话框。
            // 错误本身只说得出「在报出令牌前退出」，退出的原因在 sidecar 的 stderr 里，
            // 所以把尾巴一并带上——对话框是用户唯一能看到的输出。
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

/// 收掉子进程。退出路径上必须调用，且要能被重复调用而不出错。
pub fn shutdown(app: &AppHandle) {
    shutdown_handle(&app.state::<SidecarHandle>());
}

/// 同上，但直接拿句柄——握手超时那条路径上还没有可用的 app state 引用。
fn shutdown_handle(handle: &SidecarHandle) {
    let child = {
        let mut state = handle.0.lock();
        state.stopping = true;
        state.child.take()
    };
    if let Some(c) = child {
        // kill 失败只能记日志——此时进程可能已经自己退了，
        // 不该因此阻断应用退出。
        if let Err(e) = c.kill() {
            log::error!("停止 qy serve 失败：{e}");
        }
    }
}

/// 读取 dev.ts 交给外壳的 sidecar 端点。只在 devUrl 模式下调用：页面来自 Vite 源码，
/// 后端必须是同一棵源码树里起的那个。
///
/// 不探活。端口上暂时没有进程在听（dev.ts 正在换代 sidecar）由 WebView 的连接层
/// 重连处理；探不通就改用别的后端，会把源码页面绑到预编译的 `bin/qy` 上。
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
/// 走初始化脚本而不是 Tauri 命令：WebView 里的连接层在首帧就要拿到令牌，
/// 走异步命令会晚一拍，导致先渲染出「未配对」。
pub fn init_script(info: &SidecarInfo) -> String {
    format!(
        "globalThis.__QYWORK__ = {{ token: {}, base: {} }};",
        serde_json::to_string(&info.token).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&info.base).unwrap_or_else(|_| "\"\"".into()),
    )
}

/// 记住上次打开的工作区。
///
/// 没有这个的话，「切换工作区」只在本次运行有效，下次从开始菜单启动又回到
/// `current_dir()` 或家目录——界面上等同于切换没保存。
///
/// 存成一行纯文本而不是 JSON：它只有一个值，加一层结构只会让手动修正变麻烦。
fn last_workspace_file() -> Option<PathBuf> {
    Some(crate::logfile::data_dir()?.join("last-workspace"))
}

pub fn read_last_workspace() -> Option<PathBuf> {
    let p = std::fs::read_to_string(last_workspace_file()?).ok()?;
    // 去掉 BOM。这个文件是给人看、也允许人手改的，而 Windows 记事本存 UTF-8
    // 默认就带 BOM——不剥的话路径里会多出一个不可见字符，`is_dir()` 判假，
    // 因此静默回落到 cwd。现象是改了这个文件却不生效，且没有任何提示。
    // 实测复现方式：PowerShell 的 Set-Content -Encoding utf8。
    let path = PathBuf::from(p.trim_start_matches('\u{feff}').trim());
    // 记下的目录可能已经被删掉或改名了。存在性检查放在这里而不是调用方，
    // 因为「记录失效」的正确反应是**回落到下一级优先级**，不是报错。
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
    // 写失败只记日志：记不住上次的工作区是体验问题，不该让切换本身失败。
    if let Err(e) = std::fs::write(&file, path) {
        log::error!("记录工作区失败：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{append_stderr_tail, from_env, STDERR_TAIL_BYTES};

    /// 端口上没有进程在听也不能改用别的后端：外壳可能在 dev.ts 换代 sidecar 的间隙里启动。
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

        let info = info.expect("两个变量都设了就必须返回端点");
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
