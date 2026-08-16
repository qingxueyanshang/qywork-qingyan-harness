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

#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub token: String,
    pub port: u16,
    pub base: String,
}

/// 子进程句柄。放进 Tauri 的 state，退出时由 `shutdown` 收走。
#[derive(Default)]
pub struct SidecarHandle(pub Arc<Mutex<Option<CommandChild>>>);

/// 启动 sidecar 并等它报出令牌与端口。
///
/// `--port 0` 让内核挑空闲端口：写死端口会在用户同时开两个工作区时直接撞车。
pub async fn spawn(app: &AppHandle, workspace: &str) -> Result<SidecarInfo> {
    let (mut rx, child) = app
        .shell()
        .sidecar("qy")
        .map_err(|e| anyhow!("找不到 qy sidecar：{e}"))?
        .args([
            "serve",
            "--port",
            "0",
            // 只绑本机：局域网访问由用户在应用内显式开启（扫码配对），
            // 不能一启动就把工作区暴露在整个 Wi-Fi 上。
            "--host",
            "127.0.0.1",
            "--print-token",
            // 让 sidecar 自己盯着我们：`shutdown` 只在正常退出路径上跑，
            // 崩溃或被强杀时不会触发（实测 Stop-Process 就会留下孤儿 qy，
            // 它占着端口和 SQLite 的 WAL 锁，下次启动直接起不来）。
            "--parent-pid",
            &std::process::id().to_string(),
        ])
        // 空字符串 = 「没有可用的上次工作区」，这时**不传 --cwd**：
        // 传的话服务端会把外壳的启动目录登记成项目（安装目录 / src-tauri），
        // 那是一个谁也没要过的项目。不传则由服务端自己决定——账本里有项目就用
        // 最近打开的，一个都没有才建默认工作区（见 server.ts 的 bootstrapWorkspace）。
        .args(if workspace.is_empty() {
            Vec::new()
        } else {
            vec!["--cwd", workspace]
        })
        .spawn()
        .map_err(|e| anyhow!("启动 qy serve 失败：{e}"))?;

    let handle = app.state::<SidecarHandle>();
    *handle.0.lock() = Some(child);

    let mut token: Option<String> = None;
    let mut port: Option<u16> = None;

    /*
     * 握手要有上限。
     *
     * **不能写成裸的 `while rx.recv().await`**：那样只有拿到两个 KV、进程
     * Terminated、或流关闭才退出。qy 起来了却卡在打印令牌之前（server 初始化阻塞、
     * 端口探测挂住）时，这个循环**永远不返回**——而主窗口是在它之后才建的
     * （`lib.rs` 的 `build_main_window`）。表现是 qywork.exe 和 qy.exe 都在后台
     * 活着、桌面上什么都没有，任务管理器里就是那条「qy.exe 常驻」。
     *
     * 20 秒：冷启动要读配置、开 SQLite、可能还要预热扩展，给得比感觉上宽一些；
     * 判错的代价（把一次很慢的启动掐掉）比判漏（无声挂死）小得多。
     */
    let handshake = async {
        // 握手输出格式固定为两行 KEY=VALUE，见 cli 的 --print-token。
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
                    // sidecar 的人读输出走 stderr（启动横幅、二维码）。原样转发到
                    // 宿主终端，方便 `tauri dev` 时排查。
                    eprint!("{}", String::from_utf8_lossy(&line));
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
    };

    match tokio::time::timeout(std::time::Duration::from_secs(20), handshake).await {
        Ok(result) => result,
        Err(_) => {
            // 超时了就把它收掉再报错，别留一个既不干活又占着端口的进程。
            shutdown_handle(&handle);
            Err(anyhow!("qy serve 启动超过 20 秒仍未报出令牌，已终止"))
        }
    }
}

/// 收掉子进程。退出路径上必须调用，且要能被重复调用而不出错。
pub fn shutdown(app: &AppHandle) {
    shutdown_handle(&app.state::<SidecarHandle>());
}

/// 同上，但直接拿句柄——握手超时那条路径上还没有可用的 app state 引用。
fn shutdown_handle(handle: &SidecarHandle) {
    let child = handle.0.lock().take();
    if let Some(c) = child {
        // kill 失败只能记日志——此时进程可能已经自己退了，
        // 不该因此阻断应用退出。
        if let Err(e) = c.kill() {
            eprintln!("[qywork] 停止 qy serve 失败：{e}");
        }
    }
}

/// 从环境变量读取开发期外挂的 sidecar（`bun run serve` 手动起的那个）。
///
/// 开发时通常已经有一个 `qy serve` 在跑；再让 Tauri 拉一个会撞端口、
/// 撞 SQLite 锁。设了这两个变量就直接复用。
pub fn from_env() -> Option<SidecarInfo> {
    let token = std::env::var("QYWORK_TOKEN").ok()?;
    let port: u16 = std::env::var("QYWORK_PORT").ok()?.parse().ok()?;

    // **必须探活。** 这两个变量是开发时手动 export 的，很容易在那个 qy 早就退出之后
    // 还留在 shell 环境里；打包版从这样的 shell 启动，就会拿着一个死端口直接开窗口，
    // 界面连不上任何东西。而唯一的提示是 `eprintln!`——release 没有控制台，看不见。
    //
    // 探不通就**当作没有这个变量**，落回正常的 spawn 路径。自愈比报一个看不见的错好；
    // 也正因为会自愈，这里不需要再对用户说什么。
    if std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(300),
    )
    .is_err()
    {
        eprintln!("[qywork] QYWORK_PORT={port} 上没有在监听的服务，忽略这两个环境变量");
        return None;
    }

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
/// `current_dir()` 或家目录——用户会以为切换没保存。
///
/// 存成一行纯文本而不是 JSON：它只有一个值，加一层结构只会让手动修正变麻烦。
fn last_workspace_file() -> Option<PathBuf> {
    let dir = std::env::var("QYWORK_HOME")
        .map(PathBuf::from)
        .ok()
        .or_else(|| dirs_home().map(|h| h.join(".qywork")))?;
    Some(dir.join("last-workspace"))
}

pub fn read_last_workspace() -> Option<PathBuf> {
    let p = std::fs::read_to_string(last_workspace_file()?).ok()?;
    // 去掉 BOM。这个文件是给人看、也允许人手改的，而 Windows 记事本存 UTF-8
    // 默认就带 BOM——不剥的话路径里会多出一个不可见字符，`is_dir()` 判假，
    // 于是静默回落到 cwd。表现是「我明明改了这个文件，它就是不认」，
    // 而且完全没有任何提示。实测踩到过（用 PowerShell 的 Set-Content -Encoding utf8）。
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
        eprintln!("[qywork] 记录工作区失败：{e}");
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}
