//! qywork 桌面外壳。
//!
//! **这一层不持有任何业务状态。** 会话、账本、权限、缓存全在 `qy serve` 里；
//! Tauri 只负责原生窗口、文件监听，以及 sidecar 的生死。
//!
//! 这是刻意与 Codex 桌面版拉开的一点：它的 Electron 主进程自己揣了一个
//! better-sqlite3 库，和外挂的 Rust CLI 是两本账。两本账迟早会漂移，
//! 而且漂移了很难发现——所以这里宁可多一次 localhost 往返，也不留第二份状态。
//!
//! WebView 也不通过 Tauri IPC 拿业务数据，它直连 `qy serve` 的 WebSocket，
//! 和手机端走完全相同的协议。这样「桌面能做手机做不了」的能力漂移在结构上就不存在。

mod sidecar;
mod watcher;

use std::path::PathBuf;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

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

/// 窗口控制。
///
/// 关掉系统装饰之后，最小化 / 最大化 / 关闭三个动作没有别的入口了，
/// 必须由前端调回来。**只做这三个**——还原、置顶、透明度那些系统标题栏
/// 本来也没有，不趁机加。
///
/// 走 Tauri 命令而不是前端引 `@tauri-apps/api`：这个项目的前端是
/// 桌面与手机共用的同一份代码，多引一个只有桌面能用的包，
/// 手机端的构建里就会多出一坨永远不执行的东西。
#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(!maximized)
}

#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    // close() 走正常退出路径，RunEvent::ExitRequested 会触发 sidecar 清理。
    // 直接 destroy() 会绕过它，把 qy 留成孤儿进程。
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// 主窗口的**唯一**构造点。
///
/// 启动和切工作区都要建这个窗口，外壳属性必须逐字一致。分开写过一次，代价是
/// 切工作区那条漏了 `decorations(false)`——换完工作区系统标题栏自己回来，和前端
/// 画的顶栏叠成上下两条。这种漂移不会报错，只会长在某一条路径上。
///
/// `decorations(false)`：标题栏由前端自己画。
///
/// 系统标题栏的底色由 Windows 决定，应用改不了——而应用内顶栏是灰的，
/// 于是窗口顶部出现两条颜色不同的带子，比全用系统的更难看。
///
/// 代价说清楚：关掉装饰后**拖动与双击最大化要前端自己接**
/// （`data-tauri-drag-region`），窗口按钮也要自己画。
/// 系统的贴边分屏（Win+方向键 / 拖到屏幕边缘）仍然可用，
/// 因为窗口本身还是普通窗口，只是不画非客户区。
///
/// `shadow(false)`：**投影和那道边框线在 tao 里是同一块东西**，所以这个开关只能
/// 用来去线，投影得另外要回来（下面那个函数）。细节见 `extend_frame_for_shadow`。
fn build_main_window(app: &AppHandle, script: &str) -> tauri::Result<()> {
    let _window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("qywork")
        .decorations(false)
        .shadow(false)
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .initialization_script(script)
        .build()?;

    #[cfg(windows)]
    extend_frame_for_shadow(&_window);

    Ok(())
}

/// 把投影还给窗口，但**不**把那道边框线一起还回来。
///
/// tao 的「无装饰 + 投影」是这么实现的：`WM_NCCALCSIZE` 里给左、右、下各留
/// `SM_CXSIZEFRAME + SM_CXPADDEDBORDER` 像素的非客户区，交给系统去画。投影是这块
/// 非客户区画出来的，那道 1px 的系统边框色细线也是——**同一块像素，一个开关**。
/// 上边留 0（`calculate_insets_for_dpi` 的 Win10 分支 `top_inset = 0`，Win11 才非零），
/// 所以线只出现在左、右、下三条边。这正是肉眼看到的形状。
///
/// `shadow(false)` 让 `WM_NCCALCSIZE` 不再留这块非客户区，客户区铺满整个窗口矩形：
/// 线没了，投影也一起没了。tao 全程没有调过 `DwmExtendFrameIntoClientArea`，
/// 所以在它那一层没有第二条路。
///
/// 这里补的就是它没走的那条：客户区已经铺满，再手动把 DWM 的窗口框向客户区内扩 1px。
/// DWM 只要看见窗口有被扩进来的框就会画投影，而那 1px 落在客户区内、被不透明的
/// WebView 盖住，看不见。Chromium 用的就是这个 margin——Codex 是 Electron，
/// 它「有投影、没有边框线」正是走的这条路。
///
/// **只编译在 Windows**：macOS 与 Linux 的无装饰窗口本来就自带投影。
/// 失败只影响投影，不拦启动——为了一圈阴影让应用起不来是本末倒置。
#[cfg(windows)]
fn extend_frame_for_shadow(window: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
    use windows::Win32::UI::Controls::MARGINS;

    let Ok(hwnd) = window.hwnd() else {
        eprintln!("[qywork] 拿不到窗口句柄，投影未启用");
        return;
    };
    let margins = MARGINS {
        cxLeftWidth: 0,
        cxRightWidth: 0,
        cyTopHeight: 1,
        cyBottomHeight: 0,
    };
    if let Err(e) = unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) } {
        eprintln!("[qywork] 窗口投影未启用：{e}");
    }
}

/// 启动失败时把原因说出来。
///
/// **不能靠 stderr**：release 是 `windows_subsystem = "windows"`，没有控制台，
/// 那行字谁也看不见。也不能用 Tauri 的对话框插件——它要 app handle，
/// 而这条路径正是「app 没建起来」。所以直接走系统 MessageBox。
#[cfg(windows)]
fn show_fatal(message: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let text = HSTRING::from(message);
    let caption = HSTRING::from("qywork 启动失败");
    // SAFETY: 两个字符串在调用期间都活着；hwnd 传 None = 无父窗口的模态框。
    unsafe {
        MessageBoxW(None, &text, &caption, MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_fatal(message: &str) {
    // 非 Windows 上有控制台，stderr 就够了。
    eprintln!("[qywork] {message}");
}

/// 把文件监听改到另一个项目的目录上。
///
/// 换项目**不再重启 sidecar**（服务端一次服务多个项目，见
/// `docs/plans/2026-08-12-多项目并存.md`），所以这里只剩「监听哪一个目录」这一件事
/// 需要外壳出手：notify 的句柄在 Rust 侧，Web 端够不着。
///
/// 一次只监听一个目录，不是每个项目各挂一个：用户同一时刻只看得见一个项目，
/// 而每个监听器都是一组真实的 OS 句柄。切过去先停再起，顺序不能反——
/// 反过来会有一小段时间两个监听器同时往同一条 bus 上推。
#[tauri::command]
fn watch_workspace(app: AppHandle, path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("不是一个目录：{path}"));
    }
    let handle = app.state::<watcher::WatcherHandle>();
    watcher::stop(&handle);
    watcher::start(&app, &dir, &handle).map_err(|e| e.to_string())?;
    sidecar::write_last_workspace(&path);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * 这三个插件是给 **Rust 侧**用的，不给 WebView 里的 JS 用。
     *
     * `capabilities/default.json` 里因此只留了 `core:default` 和拖动标题栏那一条。
     * 曾经还授过 `shell:allow-spawn`、`dialog:allow-open/save`、
     * `opener:allow-open-url`、devtools 切换——**它们一条都没有前端调用方**
     * （`apps/web` 里连 `@tauri-apps` 的依赖都没有，只经 `__TAURI_INTERNALS__`
     * 调本 crate 自己注册的那几个命令），唯一用得上它们的主体是被注入的脚本。
     * 其中 `shell:allow-spawn` 的 `--host` 校验放行 `0.0.0.0`、`--cwd` 校验是 `.+`，
     * 一次 XSS 就能再起一个把任意目录暴露到局域网的 qy。
     *
     * 删掉授权不影响这里：ACL 只拦 IPC 层（插件的 `commands.rs`），
     * `ShellExt::sidecar()` 与 `app.dialog()` 都是 Rust 直调，不过那一层。
     */
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sidecar::SidecarHandle::default())
        .manage(watcher::WatcherHandle::default())
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            watch_workspace,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_is_maximized,
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

                build_main_window(&handle, &script)?;

                Ok::<(), Box<dyn std::error::Error>>(())
            })?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            /*
             * **起不来也要有终态。**
             *
             * 这里原来是 `.expect(...)`。release 下 `panic = "abort"` 且
             * `windows_subsystem = "windows"`（没有控制台），于是 sidecar 缺失、
             * 损坏、或在报出令牌前退出时，进程无声消失——没有窗口、没有对话框、
             * 没有任何可见输出。用户唯一的感知是「双击没反应」，而这恰恰是
             * 最常见的一类启动故障（`bin/qy-*.exe` 没构建、被杀毒删了）。
             *
             * 弹一个系统对话框再退。它不依赖 WebView，正好覆盖「窗口还没建出来」
             * 这段时间。
             */
            let msg = format!(
                "qywork 启动失败：{e}\n\n\
                 常见原因是 sidecar 可执行文件缺失或被安全软件拦截\
                 （apps/desktop/src-tauri/bin/qy-*.exe）。"
            );
            eprintln!("[qywork] {msg}");
            show_fatal(&msg);
            std::process::exit(1);
        })
        .run(|app, event| {
            // Windows 上父进程退出不会带走子进程：残留的 qy serve 会占着端口和
            // SQLite 的 WAL 锁，下次启动直接起不来。所以退出路径必须显式收干净。
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                watcher::stop(&app.state::<watcher::WatcherHandle>());
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
///
/// 「程序自己待的地方」是**双向**的，这一点第一版只写了一半，代价是真实的：
/// `tauri dev` 的 cwd 是 `apps/desktop/src-tauri`，而那次运行的 exe 在它下面的
/// `target/debug/`——包含关系正好反过来，于是单向判断放行，`src-tauri` 被当成
/// 一个项目记进了账本，和用户真正的项目并排显示在左栏里。
/// 两个方向问的是同一件事：这个目录和程序自己是不是套在一起的。
fn is_usable_workspace(dir: &std::path::Path) -> bool {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if dir.starts_with(exe_dir) || exe_dir.starts_with(dir) {
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
