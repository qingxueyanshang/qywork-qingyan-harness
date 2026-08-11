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
use std::io::{BufRead, BufReader};
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

/// 当前 sidecar 的连接信息。
///
/// 用 `Mutex` 而不是直接 `manage(SidecarInfo)`：切换工作区要换掉整个 sidecar，
/// 端口和令牌都会变。Tauri 的 `manage` 每个类型只认第一次，切换后再 `manage`
/// 是静默的 no-op——那会让 `sidecar_info` 一直回旧端口，表现成「切换后连不上」。
#[derive(Default)]
pub struct CurrentSidecar(pub Arc<Mutex<Option<SidecarInfo>>>);

impl CurrentSidecar {
    pub fn get(&self) -> Option<SidecarInfo> {
        self.0.lock().clone()
    }
    pub fn set(&self, info: SidecarInfo) {
        *self.0.lock() = Some(info);
    }
}

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
            "--cwd",
            workspace,
            "--print-token",
            // 让 sidecar 自己盯着我们：`shutdown` 只在正常退出路径上跑，
            // 崩溃或被强杀时不会触发（实测 Stop-Process 就会留下孤儿 qy，
            // 它占着端口和 SQLite 的 WAL 锁，下次启动直接起不来）。
            "--parent-pid",
            &std::process::id().to_string(),
        ])
        .spawn()
        .map_err(|e| anyhow!("启动 qy serve 失败：{e}"))?;

    let handle = app.state::<SidecarHandle>();
    *handle.0.lock() = Some(child);

    let mut token: Option<String> = None;
    let mut port: Option<u16> = None;

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
}

/// 收掉子进程。退出路径上必须调用，且要能被重复调用而不出错。
pub fn shutdown(app: &AppHandle) {
    let handle = app.state::<SidecarHandle>();
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

/// 读取 BufReader 的一行，超时由调用方控制。仅用于非 Tauri 上下文的测试。
#[allow(dead_code)]
pub fn read_kv_line<R: std::io::Read>(reader: &mut BufReader<R>) -> Option<(String, String)> {
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let (k, v) = line.trim().split_once('=')?;
    Some((k.to_string(), v.to_string()))
}
