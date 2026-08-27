//! qywork 桌面外壳。
//!
//! **这一层不持有任何业务状态。** 会话、账本、权限、缓存全在 `qy serve` 里；
//! Tauri 只负责原生窗口、文件监听，以及 sidecar 的生死。
//!
//! 坑：不要为了省一次 localhost 往返在这一层放数据库或缓存。外壳一存状态就是
//! 第二本账，两本账迟早漂移，而且漂移了很难发现。
//!
//! WebView 也不通过 Tauri IPC 拿业务数据，它直连 `qy serve` 的 WebSocket，
//! 和手机端走完全相同的协议。这样「桌面能做手机做不了」的能力漂移在结构上就不存在。
//!
//! **例外只有一个：终端（`terminal.rs`）。** 它走 IPC 不是图方便——PTY 是本机进程
//! 和一对操作系统句柄，跨不过网络，手机端不可能有；放进 sidecar 等于把「在这台
//! 机器上跑任意命令」开到局域网上。再要开例外，先说清楚为什么这件事**在结构上**
//! 到不了另一端，而不只是这边实现起来更简单。

mod sidecar;
mod terminal;
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

/// 选文件，可多选。
///
/// 与 `pick_workspace` 分成两条命令而不是加参数：目录选择器和文件选择器在
/// 三个平台上是两个不同的系统对话框，调用方读不出它选的是哪一种。
///
/// **必须是多选**：浏览器那条 `<input multiple>` 本来就能一次选好几个，
/// 桌面端给单选就是同一个按钮在两端行为不一样。取消返回空数组——取消不是错误。
#[tauri::command]
async fn pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_files(move |files| {
        let _ = tx.blocking_send(files);
    });
    let mut rx = rx;
    let picked = rx.recv().await.flatten().unwrap_or_default();
    Ok(picked.into_iter().map(|p| p.to_string()).collect())
}

/// 窗口控制。
///
/// 关掉系统装饰之后，最小化 / 最大化 / 关闭三个动作没有别的入口了，
/// 必须由前端调回来。**只做这三个**——还原、置顶、透明度那些系统标题栏
/// 本来也没有，不趁机加。
///
/// 走 Tauri 命令而不是前端引 `@tauri-apps/api`：这个项目的前端是
/// 桌面与手机共用的同一份代码，多引一个只有桌面能用的包，
/// 手机端的构建里就会多出一段永远不执行的代码。
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
/// 启动和切工作区都要建这个窗口，外壳属性必须逐字一致。分成两处写的代价：
/// 切工作区那条漏掉 `decorations(false)` 时，换完工作区系统标题栏回来，和前端
/// 画的顶栏叠成上下两条。这种漂移不会报错，只出现在其中一条路径上。
///
/// `decorations(false)`：标题栏由前端自己画。
///
/// 系统标题栏的底色由 Windows 决定，应用改不了——而应用内顶栏是灰的，
/// 因此窗口顶部出现两条颜色不同的带子，比全用系统的更难看。
///
/// 代价说清楚：关掉装饰后**拖动与双击最大化要前端自己接**
/// （`data-tauri-drag-region`），窗口按钮也要自己画。
/// 系统的贴边分屏（Win+方向键 / 拖到屏幕边缘）仍然可用，
/// 因为窗口本身还是普通窗口，只是不画非客户区。
///
/// `shadow(false)`：**投影和那道边框线在 tao 里由同一个开关控制**，所以它只能
/// 用来去线，投影得另外要回来（下面那个函数）。细节见 `extend_frame_for_shadow`。
fn build_main_window(app: &AppHandle, script: &str) -> tauri::Result<()> {
    let _window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("qywork")
        .decorations(false)
        .shadow(false)
        .inner_size(1280.0, 820.0)
        // 最窄宽度 = 左栏 232（`--sidebar-w`）+ 会话区 510（`--chat-min`）
        // + 右侧面板 337（`PANEL_MIN`），即三列同时拿到各自下限所需的宽度。
        // 窗口再窄不会排坏（会话区会先让到 `--chat-hard-min`，见 shell.css 的
        // `--chat-floor`），但 `--chat-min` 就不再成立。那三个数改了，这里跟着改。
        .min_inner_size(1079.0, 480.0)
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
/// WebView 盖住，看不见。这是「有投影、没有边框线」的唯一走法。
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
    // SAFETY: 两个字符串在调用期间都有效；hwnd 传 None = 无父窗口的模态框。
    unsafe {
        MessageBoxW(None, &text, &caption, MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_fatal(message: &str) {
    // 非 Windows 上有控制台，stderr 就够了。
    eprintln!("[qywork] {message}");
}

/// 在系统文件管理器里定位一个目录。
///
/// 走 Rust 侧的 `OpenerExt`，**不是**给 WebView 授 `opener:*` 权限。
/// ACL 只拦 IPC 层，Rust 直调不过那一层——所以 `capabilities/default.json`
/// 保持两条权限不变（同 `pick_workspace` 用 dialog 的做法）。
///
/// 只接受本机已存在的目录（CLAUDE.md E）：路径来自本机账本里的项目行，
/// 但仍然当外部输入校验一次——不存在时明确报错，不静默什么也不做。
#[tauri::command]
fn reveal_workspace(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("不是一个目录：{path}"));
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 把文件监听改到另一个项目的目录上。
///
/// 换项目**不再重启 sidecar**（服务端一次服务多个项目），所以这里只剩
/// 「监听哪一个目录」这一件事需要外壳出手：notify 的句柄在 Rust 侧，Web 端够不着。
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
     * **别再往 capability 里加 `shell:allow-spawn`、`dialog:allow-open/save`、
     * `opener:allow-open-url`、devtools 切换这类条目**：它们一条都没有前端调用方
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
        .manage(terminal::TerminalHandle::default())
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            pick_files,
            reveal_workspace,
            watch_workspace,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_is_maximized,
            terminal::terminal_open,
            terminal::terminal_list,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
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
                    // 空串 = 没有显式指定，让服务端自己决定挂哪个项目。
                    None => {
                        let arg = workspace
                            .as_ref()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        sidecar::spawn(&handle, &arg).await?
                    }
                };

                // 没有显式工作区时不起监听：起了也不知道该盯哪个目录。
                // 前端拿到服务端解析出的那个项目之后会调 `watch_workspace` 补上。
                if let Some(dir) = workspace.as_ref() {
                    if let Err(e) =
                        watcher::start(&handle, dir, &handle.state::<watcher::WatcherHandle>())
                    {
                        // 监听起不来只影响实时刷新，不该阻断启动。
                        eprintln!("[qywork] 文件监听未启用：{e}");
                    }
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
             * **不能用 `.expect(...)`**：release 下 `panic = "abort"` 且
             * `windows_subsystem = "windows"`（没有控制台），因此 sidecar 缺失、
             * 损坏、或在报出令牌前退出时，进程无声消失——没有窗口、没有对话框、
             * 没有任何可见输出。用户唯一的感知是「双击没反应」，而这是
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
                // 终端里的 shell 也是子进程，同一条理由要显式杀掉：留下来会持有
                // 工作区里的文件句柄，用户下一次删目录会被拒。
                terminal::shutdown(&app.state::<terminal::TerminalHandle>());
                sidecar::shutdown(app);
            }
        });
}

/// 决定打开哪个工作区。
///
/// 优先级：命令行参数 > 环境变量 > 当前目录 > 用户主目录。
/// 前两级是为了让 `qywork /path/to/repo` 和从终端直接启动都符合直觉。
///
/// **最后一级不能省。** 从开始菜单快捷方式启动时，
/// `current_dir()` 是安装目录（perMachine 安装下就是 `C:\Program Files\qywork`）——
/// 那里既不是用户的代码，又是只读的。只跑 `cargo check` 不打包时这条路径走不到，
/// 而它的现象是「装完一打开，工作区里全是程序自身的文件，写任何文件都 EPERM」。
/// 启动时**显式**指定过的工作区。没有就回 `None`，交给服务端决定。
///
/// **不要回落到 cwd / 家目录**：那把「没指定」静默变成「就用启动目录」，而桌面端的
/// 启动目录是安装目录或 `src-tauri`，会被登记成一个用户从未打开过的项目。
///
/// 没指定就是没指定：`server.ts` 的 `bootstrapWorkspace` 会用最近打开的那个，
/// 一个都没有才建默认工作区。**「首次挂哪儿」的判断只留一处。**
fn resolve_workspace() -> Option<PathBuf> {
    if let Some(arg) = std::env::args().nth(1) {
        let p = PathBuf::from(arg);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(v) = std::env::var("QYWORK_WORKSPACE") {
        let p = PathBuf::from(v);
        if p.is_dir() {
            return Some(p);
        }
    }
    // 上次在应用里选的那个。排在环境变量之后：环境变量是显式指定，优先级更高。
    sidecar::read_last_workspace()
}

