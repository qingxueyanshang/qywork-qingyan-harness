//! qywork 桌面外壳。
//!
//! **这一层不持有任何业务状态。** 会话、账本、权限、缓存全在 `qy serve` 里；
//! Tauri 只负责原生窗口、托盘、PTY、文件监听，以及 sidecar 的生死。
//!
//! 这是刻意与 Codex 桌面版拉开的一点：它的 Electron 主进程自己揣了一个
//! better-sqlite3 库，和外挂的 Rust CLI 是两本账。两本账迟早会漂移，
//! 而且漂移了很难发现——所以这里宁可多一次 localhost 往返，也不留第二份状态。
//!
//! WebView 也不通过 Tauri IPC 拿业务数据，它直连 `qy serve` 的 WebSocket，
//! 和手机端走完全相同的协议。这样「桌面能做手机做不了」的能力漂移在结构上就不存在。

mod pty;
mod sidecar;
mod watcher;

use std::path::PathBuf;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn sidecar_info(
    state: tauri::State<'_, sidecar::CurrentSidecar>,
) -> Result<sidecar::SidecarInfo, String> {
    state.get().ok_or_else(|| "sidecar 尚未就绪".to_string())
}

/// 选一个目录当工作区。
///
/// 目录选择器只能在这一层做：WebView 里没有真实文件系统，
/// 而「新建项目」的本质就是挑一个已经存在的目录。
#[tauri::command]
async fn pick_workspace(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.blocking_send(folder);
    });
    let mut rx = rx;
    let picked = rx.recv().await.flatten();
    Ok(picked.map(|p| p.to_string()))
}

/// 切换工作区 = **换掉整个 sidecar**。
///
/// 不是让一个进程同时服务多个工作区根（ROADMAP §34.1 否掉了那条路：
/// 工作区不只是分表用的 id，它是 `workspaceRoot`——工具的路径约束、文件树、
/// git 状态、权限硬边界全都以它为根，改成会话属性会牵动三条链路）。
///
/// 重启式的代价是**正在跑的那一轮会被打断**，这一点必须由界面提前说明，
/// 而不是让用户按下去之后才发现。
///
/// 窗口是**重建**而不是 reload：令牌走 `initialization_script` 注入，
/// 而初始化脚本在每次导航时都会重跑——直接 reload 会把旧令牌又写回去，
/// 表现成「切换后连的还是旧工作区」。
#[tauri::command]
async fn switch_workspace(app: AppHandle, path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("不是一个目录：{path}"));
    }

    // 顺序要紧：先停监听再停 sidecar。反过来的话监听器会在 sidecar 已经没了的
    // 情况下继续往一个死掉的 bus 上推事件。
    watcher::stop(&app.state::<watcher::WatcherHandle>());
    pty::close_all(&app.state::<pty::PtyRegistry>());
    sidecar::shutdown(&app);

    let info = sidecar::spawn(&app, &path)
        .await
        .map_err(|e| format!("在新工作区启动 qy serve 失败：{e}"))?;

    if let Err(e) = watcher::start(&app, &dir, &app.state::<watcher::WatcherHandle>()) {
        eprintln!("[qywork] 文件监听未启用：{e}");
    }

    app.state::<sidecar::CurrentSidecar>().set(info.clone());
    sidecar::write_last_workspace(&path);

    let script = sidecar::init_script(&info);
    if let Some(win) = app.get_webview_window("main") {
        win.close().map_err(|e| e.to_string())?;
    }
    WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .title("qywork")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sidecar::SidecarHandle::default())
        .manage(sidecar::CurrentSidecar::default())
        .manage(pty::PtyRegistry::default())
        .manage(watcher::WatcherHandle::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_info,
            pick_workspace,
            switch_workspace,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let workspace = resolve_workspace();

            tauri::async_runtime::block_on(async move {
                // 开发时通常已经手动起了一个 qy serve；再拉一个会撞端口和 SQLite 锁。
                let info = match sidecar::from_env() {
                    Some(existing) => {
                        eprintln!("[qywork] 复用外部 sidecar :{}", existing.port);
                        existing
                    }
                    None => sidecar::spawn(&handle, &workspace.to_string_lossy()).await?,
                };

                if let Err(e) = watcher::start(
                    &handle,
                    &workspace,
                    &handle.state::<watcher::WatcherHandle>(),
                ) {
                    // 监听起不来只影响实时刷新，不该阻断启动。
                    eprintln!("[qywork] 文件监听未启用：{e}");
                }

                // 令牌走初始化脚本注入，而不是等前端来调命令：
                // 连接层在首帧就要用它，晚一拍就会先渲染出「未配对」。
                //
                // 窗口只在这里创建，tauri.conf.json 的 `app.windows` 必须留空——
                // 两处都声明会得到 "a webview with label `main` already exists" 的 panic，
                // 而 panic 会绕过退出清理，把 qy sidecar 留成孤儿进程。
                let script = sidecar::init_script(&info);
                handle.state::<sidecar::CurrentSidecar>().set(info);

                WebviewWindowBuilder::new(&handle, "main", WebviewUrl::default())
                    .title("qywork")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(720.0, 480.0)
                    .center()
                    .initialization_script(&script)
                    .build()?;

                Ok::<(), Box<dyn std::error::Error>>(())
            })?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 qywork 失败")
        .run(|app, event| {
            // Windows 上父进程退出不会带走子进程：残留的 qy serve 会占着端口和
            // SQLite 的 WAL 锁，下次启动直接起不来。所以退出路径必须显式收干净。
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                watcher::stop(&app.state::<watcher::WatcherHandle>());
                pty::close_all(&app.state::<pty::PtyRegistry>());
                sidecar::shutdown(app);
            }
        });
}

/// 决定打开哪个工作区。
///
/// 优先级：命令行参数 > 环境变量 > 当前目录 > 用户主目录。
/// 前两级是为了让 `qywork /path/to/repo` 和从终端直接启动都符合直觉。
///
/// **最后一级是打包之后才发现必须有的。** 从开始菜单快捷方式启动时，
/// `current_dir()` 是安装目录（perMachine 安装下就是 `C:\Program Files\qywork`）——
/// 那里既不是用户的代码，又是只读的。之前只跑 `cargo check` 不打包，
/// 这条路径一次都没走到过，表现会是「装完一打开，工作区是一堆程序自己的文件，
/// 而且写任何东西都 EPERM」。
fn resolve_workspace() -> PathBuf {
    if let Some(arg) = std::env::args().nth(1) {
        let p = PathBuf::from(arg);
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(v) = std::env::var("QYWORK_WORKSPACE") {
        let p = PathBuf::from(v);
        if p.is_dir() {
            return p;
        }
    }
    // 上次在应用里选的那个。排在环境变量之后、cwd 之前：
    // 环境变量是显式指定（`tauri dev` 用它钉到仓库根），优先级更高；
    // 而 cwd 在打包安装之后基本没有意义，不该压过用户自己选过的目录。
    if let Some(p) = sidecar::read_last_workspace() {
        return p;
    }
    if let Ok(cwd) = std::env::current_dir() {
        if is_usable_workspace(&cwd) {
            return cwd;
        }
    }
    home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 当前目录能不能当工作区。
///
/// 两条否决：**它是不是程序自己待的地方**，以及**能不能往里写**。
/// 可写性只能实地试一次——Windows 上的 ACL 判断不出来，`Program Files` 在
/// 提权进程里反而是可写的，光看路径会得出相反的结论。
fn is_usable_workspace(dir: &std::path::Path) -> bool {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if dir.starts_with(exe_dir) {
                return false;
            }
        }
    }
    let probe = dir.join(".qywork-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn home_dir() -> Option<PathBuf> {
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(v) = std::env::var(key) {
            let p = PathBuf::from(v);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}
