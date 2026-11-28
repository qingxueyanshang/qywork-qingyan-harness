//! `qy serve` 的生命周期托管。
//!
//! 桌面端不实现任何业务逻辑，只负责三件事：启动 sidecar、把令牌与端口交给
//! WebView、在退出时确保子进程被完全终止。
//!
//! 两个易错点：
//!
//! 1. **必须等待 sidecar 输出令牌后再创建主窗口。** 等待期间显示可取消的启动窗口。
//!    否则业务 WebView 先加载且无法取得令牌，
//!    会先短暂显示「未配对」再自行恢复，与启动失败无法区分。
//! 2. **退出时必须确实终止子进程。** Windows 上父进程结束不会终止子进程；
//!    残留的 `qy serve` 会占用端口和 SQLite 的 WAL 锁，导致下次无法启动。
//!    正常退出与安装更新先请求 sidecar 自行停止，限时后再终止，见 `STOP_GRACE`。

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc::Receiver;
use tokio::sync::watch;

const STDERR_TAIL_BYTES: usize = 8 * 1024;
/// 启动失败对话框中附带的 stderr 长度。远小于 `STDERR_TAIL_BYTES`：MessageBox 不支持滚动，
/// 文本超出屏幕高度时无法点击确定按钮。取尾部：退出前最后输出的内容即错误本身。
const FATAL_STDERR_TAIL_BYTES: usize = 1024;

/// 请求 sidecar 停止的指令，经标准输入写入一行，与 cli 的 `watchStopRequest` 一致。
const STOP_LINE: &[u8] = b"stop\n";

/// 请求停止之后等待 sidecar 自行退出的上限，超过即终止进程。
///
/// 取值依据（Windows 实测）：空闲时停止约 20 ms，带两个 MCP 服务约 0.35 s，MCP 服务仍在初始化握手时约 0.22 s，
/// 每个运行中的命令另需约 0.25 s 终止其进程树。开发脚本的 `STOP_GRACE_MS`（`scripts/stop-sidecar.ts`）取同一值。
const STOP_GRACE: Duration = Duration::from_secs(5);

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

/// 一个 sidecar 进程：句柄与退出信号。
struct Child {
    process: CommandChild,
    /// 观察到进程退出后为 true，见 `watch_exit`。
    exited: watch::Receiver<bool>,
}

#[derive(Default)]
struct SidecarState {
    child: Option<Child>,
    /** 正常退出与异常终止的唯一判据。置位后监督循环不再启动进程。 */
    stopping: bool,
}

/// 子进程句柄与生命周期终态。存放在 Tauri state 中，由退出流程与监督循环共用。
#[derive(Default)]
pub struct SidecarHandle(Arc<Mutex<SidecarState>>);

/// `qy serve` 的参数。凭据不在其中：命令行对本机其他进程可见。
fn serve_args(script: &Path, port: u16, workspace: &str) -> Vec<String> {
    let mut args = vec![
        script.to_string_lossy().into_owned(),
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
        "--credentials-stdin".to_string(),
    ];
    if !workspace.is_empty() {
        args.push("--cwd".to_string());
        args.push(workspace.to_string());
    }
    args
}

/// 写入 sidecar 标准输入的一行 JSON：三项凭据与上次退出的信息，字段名与 cli 的 `parseCredentials` 一致。
/// 值为空的凭据不写入，sidecar 按未传入处理；没有上次退出的信息（首次启动）时不写 `previousExit`。
///
/// 不要改为环境变量：环境块由 sidecar 启动的全部子进程继承，包括外部 CLI、git 钩子与插件，而 stderr 尾部
/// 可能含有任意输出。整行由 serde_json 序列化，尾部中的换行与控制字符写为转义序列，因此始终是一行。
/// 恢复时 `token` 必须是原令牌：已加载的 WebView 以原令牌连接同一端口，换用新令牌会使其被永久判定为
/// unauthorized。宿主凭据同一份用于浏览器与电脑控制两条路径，恢复时同样复用，否则宿主无法重新连接。
fn credentials_line(
    token: Option<&str>,
    host_key: Option<&str>,
    update_key: &str,
    previous_exit: Option<&PreviousExit>,
) -> String {
    let mut fields = serde_json::Map::new();
    for (name, value) in [
        ("token", token),
        ("hostKey", host_key),
        ("updateKey", Some(update_key)),
    ] {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            fields.insert(name.to_owned(), serde_json::Value::from(value));
        }
    }
    // 字段与取值类型同 `server/process-exit.ts` 的 `processExitObservationOf`：缺少值的退出码与信号写 null。
    if let Some(exit) = previous_exit {
        fields.insert(
            "previousExit".to_owned(),
            serde_json::json!({
                "kind": exit.kind,
                "observedAtMs": exit.observed_at_ms,
                "code": exit.code,
                "signal": exit.signal,
                "stderrTail": exit.stderr_tail,
            }),
        );
    }
    format!("{}\n", serde_json::Value::Object(fields))
}

/// sidecar 使用的两个资源路径：入口脚本与 Office 执行程序目录。
///
/// 资源目录取自经 `canonicalize` 的可执行文件路径，Windows 上带 `\\?\` 前缀，必须去掉：cmd.exe 以带前缀的路径
/// 作为工作目录时按 UNC 路径处理并改用 Windows 目录，运行环境的安装命令按相对路径读取依赖清单，随之无法找到文件。
/// 去掉前缀后超过 MAX_PATH 等无法安全去掉的路径原样保留。
fn resource_paths(resources: &Path) -> (PathBuf, PathBuf) {
    let root = dunce::simplified(resources);
    (root.join("sidecar").join("index.js"), root.join("office"))
}

/// sidecar 的 PATH：继承值之后追加 `registry` 中有而继承值中没有的目录，继承值中的目录与顺序不变。
///
/// 外壳的环境取自启动它的进程，此后安装的程序写入系统与用户环境变量的目录不在其中。sidecar 探测与调用外部程序
/// 都只读取启动时的 PATH（Bun 在启动时缓存环境），不追加时从旧终端启动的 QyWork 重启后仍无法找到这些程序。
/// 目录按不区分大小写、忽略末尾分隔符比较。
fn merged_path(inherited: &str, registry: &[String]) -> String {
    let key = |dir: &str| dir.trim_end_matches(['\\', '/']).to_lowercase();
    let mut seen: std::collections::HashSet<String> = inherited
        .split(';')
        .filter(|d| !d.is_empty())
        .map(key)
        .collect();
    let mut out = inherited.trim_end_matches(';').to_string();
    for dir in registry.iter().flat_map(|v| v.split(';')) {
        if dir.trim().is_empty() || !seen.insert(key(dir)) {
            continue;
        }
        if !out.is_empty() {
            out.push(';');
        }
        out.push_str(dir);
    }
    out
}

/// 注册表中系统与用户环境变量的 `Path`，按新登录进程的顺序（系统在前）。`REG_EXPAND_SZ` 中的变量
/// 由 `RegGetValueW` 展开；读取失败的一项跳过。
#[cfg(windows)]
fn registry_path() -> Vec<String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };
    let read = |root: HKEY, key: PCWSTR| -> Option<String> {
        let mut size = 0u32;
        unsafe {
            RegGetValueW(
                root,
                key,
                w!("Path"),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            )
        }
        .ok()
        .ok()?;
        let mut buf = vec![0u16; (size as usize).div_ceil(2)];
        unsafe {
            RegGetValueW(
                root,
                key,
                w!("Path"),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        }
        .ok()
        .ok()?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    };
    [
        (
            HKEY_LOCAL_MACHINE,
            w!(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ),
        (HKEY_CURRENT_USER, w!("Environment")),
    ]
    .into_iter()
    .filter_map(|(root, key)| read(root, key))
    .collect()
}

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
) -> Result<(Receiver<CommandEvent>, Child)> {
    // `qy` 是 Bun 运行时，第一个参数必须是入口脚本。脚本目录经 `tauri.conf.json` 的 `resources`
    // 随包分发；macOS 上资源目录与可执行文件不在同一目录，因此不按可执行文件的位置拼接。
    // Office 执行程序位于同一资源目录的 office/ 下，显式交给 sidecar，原因相同。
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| anyhow!("无法定位资源目录：{e}"))?;
    let (script, office) = resource_paths(&resources);

    let command = app
        .shell()
        .sidecar("qy")
        .map_err(|e| anyhow!("未找到 qy sidecar：{e}"))?
        .args(serve_args(&script, port, workspace))
        .env("QYWORK_OFFICE_DIR", office);
    #[cfg(windows)]
    let command = {
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        command.env(
            "PATH",
            merged_path(&inherited.to_string_lossy(), &registry_path()),
        )
    };
    let (rx, mut process) = command.spawn().map_err(|source| -> anyhow::Error {
        // 使用 shell 插件解析实际路径，诊断不另行推导安装目录。
        let executable = app.shell().sidecar("qy").ok().map(|command| {
            let command: std::process::Command = command.into();
            PathBuf::from(command.get_program())
        });
        crate::startup::LaunchError { executable, source }.into()
    })?;
    let line = credentials_line(
        token,
        host_key,
        &app.state::<crate::updater::UpdateOwner>().key,
        previous_exit,
    );
    if let Err(error) = process.write(line.as_bytes()) {
        let _ = process.kill();
        return Err(anyhow!("向 qy serve 交付凭据失败：{error}"));
    }
    let (rx, exited) = watch_exit(rx);
    Ok((rx, Child { process, exited }))
}

/// 转发进程事件，观察到 `Terminated` 或事件通道结束时置位退出信号。
///
/// 握手期间事件由 `await_handshake` 读取，之后由 `supervise` 读取，停止流程在两个阶段都要等待进程退出，
/// 因此退出信号不放在任何一个消费者中。先置位再转发：消费者收到 `Terminated` 时信号已经置位。
fn watch_exit(mut events: Receiver<CommandEvent>) -> (Receiver<CommandEvent>, watch::Receiver<bool>) {
    let (forward, rx) = tokio::sync::mpsc::channel(1);
    let (exited, signal) = watch::channel(false);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if matches!(event, CommandEvent::Terminated(_)) {
                let _ = exited.send(true);
            }
            // 消费者已释放接收端时继续读取，插件的读线程不因通道写满而阻塞。
            let _ = forward.send(event).await;
        }
        let _ = exited.send(true);
    });
    (rx, signal)
}

/** 把当前子进程交给生命周期 state；退出已开始时立即终止新进程。 */
fn hold_child(handle: &SidecarHandle, child: Child) -> bool {
    let mut state = handle.0.lock();
    if state.stopping {
        drop(state);
        let _ = child.process.kill();
        return false;
    }
    state.child = Some(child);
    true
}

/** 只终止当前进程，不把整个监督器置为停止。用于启动失败后的下一次重试。 */
fn kill_current(handle: &SidecarHandle) {
    let child = handle.0.lock().child.take();
    if let Some(child) = child {
        let _ = child.process.kill();
    }
}

/// 停止一个进程：经 `request` 请求其自行退出，`grace` 内观察到退出即返回 false；
/// 请求失败或超时则经 `kill` 终止并返回 true。
async fn stop_or_kill<P>(
    mut process: P,
    exited: &mut watch::Receiver<bool>,
    grace: Duration,
    request: impl FnOnce(&mut P) -> Result<(), String>,
    kill: impl FnOnce(P),
) -> bool {
    match request(&mut process) {
        Ok(()) => {
            if let Ok(Ok(_)) = tokio::time::timeout(grace, exited.wait_for(|done| *done)).await {
                return false;
            }
            log::warn!("qy serve 未在 {grace:?} 内退出，终止进程");
        }
        Err(error) => log::warn!("向 qy serve 发送停止指令失败：{error}"),
    }
    kill(process);
    true
}

/// 请求 sidecar 停止，限时等待其退出，超时后终止。
///
/// sidecar 收到指令后执行 `handle.stop()`：结束运行中的命令进程树、MCP、插件与外部 CLI。直接终止进程时
/// 这些都不执行。已退出的命令留下的后代进程不在其列，正常停止时同样保留。
async fn stop_child(child: Child) {
    let Child { process, mut exited } = child;
    stop_or_kill(
        process,
        &mut exited,
        STOP_GRACE,
        |process| process.write(STOP_LINE).map_err(|e| e.to_string()),
        |process| {
            // 终止失败只记录日志：此时进程可能已自行退出，不应因此阻断应用退出。
            if let Err(e) = process.kill() {
                log::error!("停止 qy serve 失败：{e}");
            }
        },
    )
    .await;
}

/// 从 sidecar 固定格式的两行输出中取得实际开始监听后的端点。
///
/// stderr 在转发的同时累积到 `tail`：握手失败时这段输出是唯一能说明原因的证据，
/// 而 release 下没有控制台，转发的输出不可见。
async fn await_handshake(
    rx: &mut Receiver<CommandEvent>,
    tail: &mut String,
) -> Result<SidecarInfo> {
    let mut token: Option<String> = None;
    let mut port: Option<u16> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                for raw in text.lines() {
                    if let Some(v) = raw
                        .trim()
                        .strip_prefix("QYWORK_TOKEN=")
                        .filter(|v| !v.is_empty())
                    {
                        token = Some(v.to_string());
                    }
                    if let Some(v) = raw.trim().strip_prefix("QYWORK_PORT=") {
                        port = v.parse::<u16>().ok().filter(|p| *p != 0);
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
        // 重启退避与放弃条件与电脑控制 worker、浏览器进程共用 `restart.rs`：连续短时退出达到上限即停止，
        // 显示启动报告并退出应用。无限重启时，退出原因不会显示在任何位置。
        let mut attempt = 0_u32;
        let mut started = std::time::Instant::now();
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
                    let _ = child.process.kill();
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

            loop {
                attempt = crate::restart::next_attempt(attempt, started.elapsed());
                let Some(delay) = crate::restart::restart_delay(attempt) else {
                    give_up(&app, attempt, &previous_exit, &stderr_tail);
                    return;
                };
                tokio::time::sleep(delay).await;
                while crate::updater::installing(&app) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                if handle.0.lock().stopping {
                    return;
                }

                started = std::time::Instant::now();
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
                        match await_handshake(&mut next_rx, &mut stderr_tail).await {
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
            }
        }
    });
}

/// 连续启动失败后停止重启：显示启动报告并退出应用。
///
/// 报告附带最后输出的 stderr 尾部，与首次启动失败的报告相同（`spawn`）：退出原因只在其中。
/// 退出经由 `AppHandle::exit`，终端、浏览器等子进程按正常退出路径终止。
fn give_up(app: &AppHandle, attempts: u32, previous_exit: &PreviousExit, stderr_tail: &str) {
    let tail = tail_of(stderr_tail.trim_end(), FATAL_STDERR_TAIL_BYTES);
    let error = anyhow!(
        "qy serve 连续 {attempts} 次启动后退出，已停止重启（kind={} code={:?}）\n\n{tail}",
        previous_exit.kind,
        previous_exit.code,
    );
    log::error!("{error}");
    crate::startup::report_and_show(error.as_ref());
    app.exit(1);
}

/// 启动 sidecar 并等待其输出令牌与端口。
///
/// `--port 0` 由内核选择空闲端口：固定端口会在用户同时打开两个工作区时发生冲突。
pub async fn spawn(
    app: &AppHandle,
    workspace: &str,
    host_key: Option<&str>,
) -> Result<SidecarInfo> {
    let started_at = std::time::Instant::now();
    log::info!("开始启动 qy serve，等待就绪回执");
    let (mut rx, child) = spawn_process(app, 0, None, workspace, None, host_key)?;
    let pid = child.process.pid();

    let handle = app.state::<SidecarHandle>();
    if !hold_child(&handle, child) {
        return Err(anyhow!("应用已经开始退出，取消启动 qy serve"));
    }

    // 后台就绪回执是唯一成功判据；慢启动不等于失败，不能按固定时长终止仍在启动的进程。
    // lib.rs 在等待之前创建可关闭的启动窗口，并保持事件循环运行；关闭时通过 shutdown
    // 终止子进程。真实失败仍由退出事件、读取错误或通道关闭立即报告。
    let mut tail = String::new();
    match await_handshake(&mut rx, &mut tail).await {
        Ok(info) => {
            log::info!(
                "qy serve 已就绪 pid={pid} port={} elapsedMs={}",
                info.port,
                started_at.elapsed().as_millis()
            );
            supervise(app.clone(), info.clone(), rx, host_key.map(str::to_owned));
            Ok(info)
        }
        Err(error) => {
            // 首次启动失败同样有可见终态：终止子进程后由 lib.rs 弹出启动失败对话框。
            // 错误本身只能说明「在输出令牌前退出」，退出原因位于 sidecar 的 stderr，
            // 因此一并附带 stderr 尾部：对话框是界面上唯一显示该输出的位置。
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

/// 立即终止子进程并置为停止终态。用于取消启动、启动失败与进程退出前的最后一步：取消启动与启动失败时
/// sidecar 尚未开始服务，没有需要结束的命令。必须支持重复调用而不出错。
pub fn shutdown(app: &AppHandle) {
    shutdown_handle(&app.state::<SidecarHandle>());
}

/// 正常退出：置为停止终态，请求 sidecar 自行停止并等待其退出，超过 `STOP_GRACE` 即终止。
/// 没有运行中的进程时立即返回。由退出的后台任务调用（`exit.rs`）。
pub async fn stop(app: &AppHandle) {
    let child = take_for_shutdown(&app.state::<SidecarHandle>());
    if let Some(child) = child {
        stop_child(child).await;
    }
}

/// 启动取消与进程监督共用同一终态，取消后不再创建主窗口或显示失败对话框。
pub fn stopping(app: &AppHandle) -> bool {
    app.state::<SidecarHandle>().0.lock().stopping
}

/// 安装更新之前请求 sidecar 停止并等待其退出。安装期间由更新所有者禁止恢复；安装启动失败后仍复用原监督器。
pub async fn stop_for_update(app: &AppHandle) {
    let child = app.state::<SidecarHandle>().0.lock().child.take();
    if let Some(child) = child {
        stop_child(child).await;
    }
}

/// 置为停止终态并取出当前进程，退出与取消启动共用。
fn take_for_shutdown(handle: &SidecarHandle) -> Option<Child> {
    let mut state = handle.0.lock();
    state.stopping = true;
    state.child.take()
}

/// 同 `shutdown`，但直接接收句柄。
fn shutdown_handle(handle: &SidecarHandle) {
    if let Some(child) = take_for_shutdown(handle) {
        // kill 失败只记录日志：此时进程可能已自行退出，
        // 不应因此阻断应用退出。
        if let Err(e) = child.process.kill() {
            log::error!("停止 qy serve 失败：{e}");
        }
    }
}

/// dev.ts 经环境变量交给开发构建外壳的启动参数。
pub struct DevLaunch {
    /// sidecar 端点。页面来自 Vite 源码，后端必须是从同一源码树启动的进程。
    pub sidecar: Option<SidecarInfo>,
    /// 宿主连接的凭据，见 `lib.rs` 的 `host_key`。
    pub host_key: Option<String>,
}

/// 读取 dev.ts 交给外壳的启动参数，并把两项凭据（`QYWORK_TOKEN`、`QYWORK_HOST_KEY`）从本进程的环境中移除：
/// 环境块由之后启动的全部子进程继承，包括终端中的 shell 与 computer-host。只在 devUrl 模式下调用，
/// 且必须在启动任何线程之前调用：多线程下修改环境与其他线程读取环境不安全。
///
/// 端点不做存活探测。端口上暂时没有进程监听（dev.ts 正在重启 sidecar）时，由 WebView 的连接层
/// 重连处理；探测失败即改用其他后端，会把源码页面绑定到预编译的 `bin/qy`。
pub fn take_dev_launch() -> DevLaunch {
    let token = std::env::var("QYWORK_TOKEN").ok();
    let host_key = std::env::var("QYWORK_HOST_KEY").ok().filter(|v| !v.is_empty());
    std::env::remove_var("QYWORK_TOKEN");
    std::env::remove_var("QYWORK_HOST_KEY");
    let port: Option<u16> = std::env::var("QYWORK_PORT").ok().and_then(|p| p.parse().ok());
    let sidecar = token.zip(port).map(|(token, port)| SidecarInfo {
        token,
        port,
        base: format!("http://127.0.0.1:{port}"),
    });
    DevLaunch { sidecar, host_key }
}

/// 主窗口页面的源，与 Tauri 为 `WebviewUrl::App` 解析出的地址一致：开发构建为 devUrl 的源，
/// 发布构建为资源协议的源。
pub fn app_origin(app: &AppHandle) -> String {
    let dev_url = if tauri::is_dev() {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    origin_of(dev_url)
}

/// 资源协议的源按平台而定：Windows 上是 `http://tauri.localhost`，macOS 与 Linux 上是 `tauri://localhost`。
/// 不要对后者调用 `Url::origin`：非特殊 scheme 的源按规范序列化为 `null`，与页面的 `location.origin` 不一致。
fn origin_of(dev_url: Option<&tauri::Url>) -> String {
    match dev_url {
        Some(url) => url.origin().ascii_serialization(),
        None if cfg!(windows) => "http://tauri.localhost".to_owned(),
        None => "tauri://localhost".to_owned(),
    }
}

/// 供主窗口页面读取的注入脚本。
///
/// 使用初始化脚本而不是 Tauri 命令：WebView 中的连接层在首帧即需要令牌，
/// 异步命令返回较晚，会先渲染出「未配对」。
///
/// 只在顶层且源为 `app_origin` 的文档中定义：Windows 上初始化脚本同样注入子框架，主窗口导航到其他源时
/// 也会再次执行，不加判断时插件工作台、预览中的页面与外部页面都能读取令牌。
pub fn init_script(info: &SidecarInfo, app_origin: &str) -> String {
    let literal = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
    format!(
        "if (window.top === window && location.origin === {}) {{ globalThis.__QYWORK__ = {{ token: {}, base: {} }}; }}",
        literal(app_origin),
        literal(&info.token),
        literal(&info.base),
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
    use super::{
        append_stderr_tail, await_handshake, credentials_line, init_script, merged_path, origin_of,
        resource_paths, take_dev_launch, serve_args, shutdown_handle, stop_or_kill, watch_exit,
        PreviousExit, SidecarHandle, SidecarInfo, STDERR_TAIL_BYTES, STOP_GRACE, STOP_LINE,
    };
    use std::time::Duration;
    use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};
    use tokio::sync::{mpsc, watch};

    /// 资源目录按 Tauri 的取法得到（`canonicalize`，Windows 上带 `\\?\` 前缀）。以交给 sidecar 的 Office 目录
    /// 作为工作目录启动 cmd.exe，必须能按相对路径读取其中的依赖清单：运行环境安装文档库的窗口即如此执行 pip。
    #[cfg(windows)]
    #[test]
    fn cmd_started_in_the_office_dir_reads_the_manifest_by_relative_path() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp/cargo-tests")
            .join(format!("sidecar-resources-{}", std::process::id()));
        std::fs::create_dir_all(root.join("office")).expect("必须能创建临时目录");
        std::fs::write(root.join("office").join("requirements.txt"), "pip\r\n")
            .expect("必须能写入依赖清单");
        let resources = root.canonicalize().expect("临时目录必须存在");
        assert!(resources.to_string_lossy().starts_with(r"\\?\"));

        let (script, office) = resource_paths(&resources);
        assert!(!office.to_string_lossy().starts_with(r"\\?\"));
        assert!(script.ends_with("sidecar/index.js"));
        let out = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "type", "requirements.txt"])
            .current_dir(&office)
            .output()
            .expect("必须能启动 cmd.exe");
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "pip");
    }

    /// 注册表中新增的目录追加在继承值之后；已有的目录不重复，比较不区分大小写与末尾分隔符。
    #[test]
    fn registry_directories_missing_from_the_inherited_path_are_appended() {
        let registry = [r"C:\b;C:\Tools\rg;".to_string(), r"c:\a\;D:\Bin".to_string()];
        assert_eq!(
            merged_path(r"C:\A;C:\B\;", &registry),
            r"C:\A;C:\B\;C:\Tools\rg;D:\Bin"
        );
        assert_eq!(merged_path("", &registry), r"C:\b;C:\Tools\rg;c:\a\;D:\Bin");
        assert_eq!(merged_path(r"C:\A", &[]), r"C:\A");
    }

    /// 读取的是展开后的值：系统 `Path` 以 `%SystemRoot%` 书写 System32，进程无法按未展开的目录查找程序。
    #[cfg(windows)]
    #[test]
    fn registry_path_is_read_with_variables_expanded() {
        let dirs = super::registry_path().join(";").to_lowercase();
        assert!(dirs.contains(r"\system32"), "{dirs}");
        assert!(!dirs.contains("%systemroot%"), "{dirs}");
    }

    /// 测试用进程：记录收到的停止指令与终止。
    #[derive(Default)]
    struct Probe {
        requests: Vec<Vec<u8>>,
        killed: bool,
    }

    /// 以 `STOP_GRACE` 停止一个 `Probe`，返回它的最终记录与是否执行了终止。
    fn stop_probe(
        exited: watch::Receiver<bool>,
        request_fails: bool,
    ) -> tokio::task::JoinHandle<(Probe, bool)> {
        tokio::spawn(async move {
            let mut exited = exited;
            let record = std::sync::Arc::new(parking_lot::Mutex::new(Probe::default()));
            let kept = record.clone();
            let killed = stop_or_kill(
                (),
                &mut exited,
                STOP_GRACE,
                |_| {
                    if request_fails {
                        return Err("管道已关闭".into());
                    }
                    record.lock().requests.push(STOP_LINE.to_vec());
                    Ok(())
                },
                |_| record.lock().killed = true,
            )
            .await;
            let probe = std::mem::take(&mut *kept.lock());
            (probe, killed)
        })
    }

    /// 原始失败形状：退出时直接终止 sidecar，`handle.stop()` 不执行。请求停止后在时限内退出，不终止。
    #[tokio::test(start_paused = true)]
    async fn exit_within_the_grace_period_is_not_killed() {
        let (exit, exited) = watch::channel(false);
        let stopping = stop_probe(exited, false);
        tokio::task::yield_now().await;
        tokio::time::advance(STOP_GRACE - Duration::from_millis(1)).await;
        assert!(!stopping.is_finished());
        exit.send(true).unwrap();
        let (probe, killed) = stopping.await.unwrap();
        assert_eq!(probe.requests, vec![STOP_LINE.to_vec()]);
        assert!(!killed);
        assert!(!probe.killed);
    }

    #[tokio::test(start_paused = true)]
    async fn no_exit_within_the_grace_period_is_killed() {
        let (_exit, exited) = watch::channel(false);
        let stopping = stop_probe(exited, false);
        tokio::task::yield_now().await;
        tokio::time::advance(STOP_GRACE).await;
        let (probe, killed) = stopping.await.unwrap();
        assert_eq!(probe.requests.len(), 1);
        assert!(killed);
        assert!(probe.killed);
    }

    /// 停止指令写入失败时不等待：进程通常已退出，或标准输入已不可用。
    #[tokio::test(start_paused = true)]
    async fn a_failed_request_kills_without_waiting() {
        let (_exit, exited) = watch::channel(false);
        let (probe, killed) = stop_probe(exited, true).await.unwrap();
        assert!(probe.requests.is_empty());
        assert!(killed && probe.killed);
    }

    /// 退出信号在转发 `Terminated` 之前置位，事件按原顺序转发。
    #[tokio::test]
    async fn exit_signal_is_set_before_terminated_is_forwarded() {
        let (tx, rx) = mpsc::channel(1);
        let (mut forwarded, exited) = watch_exit(rx);
        tx.send(CommandEvent::Stdout(b"QYWORK_PORT=1".to_vec()))
            .await
            .unwrap();
        assert!(matches!(forwarded.recv().await, Some(CommandEvent::Stdout(_))));
        assert!(!*exited.borrow());
        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(0),
            signal: None,
        }))
        .await
        .unwrap();
        assert!(matches!(
            forwarded.recv().await,
            Some(CommandEvent::Terminated(_))
        ));
        assert!(*exited.borrow());
    }

    #[tokio::test(start_paused = true)]
    async fn slow_start_waits_for_both_ready_fields_instead_of_killing_after_twenty_seconds() {
        let (tx, mut rx) = mpsc::channel(8);
        let waiting =
            tokio::spawn(async move { await_handshake(&mut rx, &mut String::new()).await });
        tokio::time::advance(std::time::Duration::from_secs(45)).await;
        assert!(!waiting.is_finished(), "慢启动仍应等待后台就绪");
        tx.send(CommandEvent::Stdout(b"QYWORK_TOKEN=test-token".to_vec()))
            .await
            .unwrap();
        tokio::time::advance(std::time::Duration::from_secs(45)).await;
        assert!(!waiting.is_finished(), "令牌与端口缺一不可");
        tx.send(CommandEvent::Stdout(b"QYWORK_PORT=56884".to_vec()))
            .await
            .unwrap();
        let info = waiting.await.unwrap().unwrap();
        assert_eq!(info.token, "test-token");
        assert_eq!(info.port, 56884);
    }

    #[tokio::test]
    async fn invalid_or_incomplete_endpoint_is_not_ready() {
        for output in [
            "QYWORK_TOKEN=\nQYWORK_PORT=56884",
            "QYWORK_TOKEN=t\nQYWORK_PORT=0",
            "QYWORK_TOKEN=t\nQYWORK_PORT=bad",
            "QYWORK_TOKEN=t",
        ] {
            let (tx, mut rx) = mpsc::channel(1);
            tx.send(CommandEvent::Stdout(output.as_bytes().to_vec()))
                .await
                .unwrap();
            drop(tx);
            assert!(await_handshake(&mut rx, &mut String::new()).await.is_err());
        }
    }

    #[tokio::test]
    async fn real_exit_fails_immediately_and_keeps_stderr() {
        let (tx, mut rx) = mpsc::channel(3);
        tx.send(CommandEvent::Stderr("账本打开失败".as_bytes().to_vec()))
            .await
            .unwrap();
        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(1),
            signal: None,
        }))
        .await
        .unwrap();
        let mut tail = String::new();
        let error = await_handshake(&mut rx, &mut tail).await.unwrap_err();
        assert!(error.to_string().contains("code=Some(1)"));
        assert_eq!(tail, "账本打开失败");
    }

    #[tokio::test]
    async fn output_error_is_a_failure_even_if_process_has_not_exited() {
        let (tx, mut rx) = mpsc::channel(1);
        tx.send(CommandEvent::Error("pipe closed".into()))
            .await
            .unwrap();
        let error = await_handshake(&mut rx, &mut String::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("pipe closed"));
    }

    #[test]
    fn cancellation_is_terminal_and_idempotent() {
        let handle = SidecarHandle::default();
        shutdown_handle(&handle);
        shutdown_handle(&handle);
        assert!(handle.0.lock().stopping);
        assert!(handle.0.lock().child.is_none());
    }

    /// 端口上没有进程监听时也不能改用其他后端：外壳可能在 dev.ts 重启 sidecar 的间隙中启动。
    /// 读取之后两项凭据从环境中移除，之后启动的子进程不再继承它们。
    #[test]
    fn the_dev_launch_keeps_the_given_port_and_removes_the_credentials() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        std::env::set_var("QYWORK_TOKEN", "t");
        std::env::set_var("QYWORK_HOST_KEY", "k");
        std::env::set_var("QYWORK_PORT", port.to_string());
        let launch = take_dev_launch();
        let token_left = std::env::var_os("QYWORK_TOKEN");
        let key_left = std::env::var_os("QYWORK_HOST_KEY");
        std::env::remove_var("QYWORK_PORT");

        assert_eq!(token_left, None);
        assert_eq!(key_left, None);
        assert_eq!(launch.host_key.as_deref(), Some("k"));
        let info = launch.sidecar.expect("两个变量均已设置时必须返回端点");
        assert_eq!(info.port, port);
        assert_eq!(info.token, "t");
        assert_eq!(info.base, format!("http://127.0.0.1:{port}"));
    }

    /// 凭据只经标准输入交付：参数中带读取标志，写入的是 cli 按行读取的一个 JSON 对象。
    #[test]
    fn credentials_go_through_stdin_as_one_json_line() {
        let args = serve_args(std::path::Path::new("index.js"), 0, "");
        assert!(args.iter().any(|a| a == "--credentials-stdin"));

        let line = credentials_line(Some("tok"), Some("host"), "update", None);
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let parsed: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!({ "token": "tok", "hostKey": "host", "updateKey": "update" })
        );
    }

    /// 首次启动不指定令牌，非 Windows 平台的更新凭据为空串：缺省项不写入，sidecar 按未传入处理。
    /// 首次启动没有上次退出的信息，不写 `previousExit`。
    #[test]
    fn absent_or_empty_credentials_are_omitted() {
        assert_eq!(credentials_line(None, None, "", None), "{}\n");
        assert_eq!(
            credentials_line(Some(""), Some("host"), "", None),
            "{\"hostKey\":\"host\"}\n"
        );
    }

    /// 恢复重启时上次退出的信息随同一行交付，字段与 `packages/cli/src/serve-startup.test.ts` 交给真实
    /// `qy serve` 的样例逐项一致：`{ kind, observedAtMs, code, signal, stderrTail }`，缺少的信号为 null。
    #[test]
    fn the_previous_exit_travels_in_the_same_line() {
        let exit = PreviousExit {
            kind: "terminated",
            code: Some(3),
            signal: None,
            observed_at_ms: 1234,
            stderr_tail: "panic-1".to_owned(),
        };
        let line = credentials_line(Some("tok"), Some("host"), "update", Some(&exit));
        let parsed: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!({
                "token": "tok",
                "hostKey": "host",
                "updateKey": "update",
                "previousExit": {
                    "kind": "terminated",
                    "observedAtMs": 1234,
                    "code": 3,
                    "signal": null,
                    "stderrTail": "panic-1",
                },
            })
        );

        let closed = PreviousExit {
            kind: "output_channel_closed",
            code: None,
            signal: None,
            observed_at_ms: 5,
            stderr_tail: String::new(),
        };
        let parsed: serde_json::Value =
            serde_json::from_str(credentials_line(None, None, "", Some(&closed)).trim_end()).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!({
                "previousExit": {
                    "kind": "output_channel_closed",
                    "observedAtMs": 5,
                    "code": null,
                    "signal": null,
                    "stderrTail": "",
                },
            })
        );
    }

    /// stderr 尾部含换行、引号、反斜杠、控制字符与非 ASCII 字符时，整行仍是一行合法的 JSON，取回的尾部与原文相同。
    #[test]
    fn a_stderr_tail_with_newlines_and_quotes_stays_on_one_line() {
        let tail = "error: \"bad\" path C:\\x\n第二行 ✓\r\n\u{1b}[31m红色\u{1b}[0m\t\u{2028}末尾\n";
        let exit = PreviousExit {
            kind: "terminated",
            code: None,
            signal: Some(9),
            observed_at_ms: 1,
            stderr_tail: tail.to_owned(),
        };
        let line = credentials_line(Some("tok"), None, "", Some(&exit));
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(!line.contains('\r'));
        let parsed: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(parsed["previousExit"]["stderrTail"], tail);
        assert_eq!(parsed["previousExit"]["signal"], 9);
        assert_eq!(parsed["previousExit"]["code"], serde_json::Value::Null);
    }

    #[test]
    fn init_script_defines_token_only_in_top_level_app_page() {
        let info = SidecarInfo {
            token: "tok".into(),
            port: 7717,
            base: "http://127.0.0.1:7717".into(),
        };
        assert_eq!(
            init_script(&info, "http://tauri.localhost"),
            "if (window.top === window && location.origin === \"http://tauri.localhost\") \
             { globalThis.__QYWORK__ = { token: \"tok\", base: \"http://127.0.0.1:7717\" }; }"
        );
    }

    #[test]
    fn app_origin_matches_the_page_origin() {
        let dev: tauri::Url = "http://localhost:5180/".parse().unwrap();
        assert_eq!(origin_of(Some(&dev)), "http://localhost:5180");
        let packaged = origin_of(None);
        if cfg!(windows) {
            assert_eq!(packaged, "http://tauri.localhost");
        } else {
            assert_eq!(packaged, "tauri://localhost");
        }
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
