//! qywork 桌面外壳。
//!
//! **这一层不持有任何业务状态。** 会话、账本、权限、缓存全部位于 `qy serve`；
//! Tauri 只负责原生窗口与 sidecar 的生命周期。
//!
//! 易错点：不要为节省一次 localhost 往返而在本层放置数据库或缓存。外壳一旦保存状态即形成
//! 第二本账，两本账会逐渐不一致，且不一致难以发现。
//!
//! WebView 同样不通过 Tauri IPC 获取业务数据，而是直接连接 `qy serve` 的 WebSocket，
//! 与手机端使用完全相同的协议，因此在结构上不会出现桌面端支持而手机端不支持的能力差异。
//!
//! **本机进程能力通过 IPC 提供。** 终端（`terminal.rs`）的 PTY 是本机进程
//! 与一对操作系统句柄，无法跨网络传递，手机端不可能具备；放入 sidecar 等于把「在本机
//! 运行任意命令」开放到局域网。新增此类例外前，须说明该能力为何**在结构上**
//! 无法提供给另一端，而不只是在本层实现更简单。
//! 安装更新（`updater.rs`）由外壳校验安装包并退出当前进程，远程 Web 不提供此入口。

mod browser;
/// 对外可见：端到端夹具（`examples/desktop-host.rs`）必须链接本宿主实现。
/// 测试一份副本等于测试另一段代码。
pub mod desktop;
mod hostkey;
mod logfile;
mod restart;
mod sidecar;
mod terminal;
mod updater;
mod ws;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// 浏览器页与终端会话共用的创建序号。
///
/// 界面的页签栏由这两份清单合并生成，两份清单各自异步返回；跨类型可比较的创建顺序
/// 只有本进程能够提供，`bt_N` 与 `terminal-N` 是两个互不相关的计数。
static CREATED_SEQ: AtomicU64 = AtomicU64::new(0);

/// 分配一个创建序号，从 1 开始，本进程内不重复。
///
/// **只在资源首次创建时分配。** 已存在的 id 重新接入时序号不变：序号表示创建顺序，
/// 而不是本次接入的顺序。
pub(crate) fn next_created_seq() -> u64 {
    CREATED_SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

/// 运行时日志写入 stderr 与 `logs/qywork.log`，最后一条 error 保留给启动失败对话框。
///
/// tauri 运行时把窗口创建失败只写入 `log::error!` 后仍按成功返回（`build()` 仍为 Ok），
/// 没有 logger 时该日志丢失：进程只保留托盘图标运行，不出现任何窗口。
///
/// release 使用 `windows_subsystem = "windows"`，stderr 不可见；日志文件是唯一保留下来的记录。
struct ShellLog;

static LOGGER: ShellLog = ShellLog;
static LAST_ERROR: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

impl log::Log for ShellLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:<5} [{}] {}",
            logfile::utc_now(),
            record.level(),
            record.target(),
            record.args()
        );
        eprintln!("{line}");
        if record.level() == log::Level::Error {
            *LAST_ERROR.lock() = Some(format!("{}: {}", record.target(), record.args()));
        }
        logfile::append(&line);
    }

    fn flush(&self) {}
}

/// 选择一个目录作为工作区。
///
/// 目录选择器只能在本层实现：WebView 中没有真实文件系统，
/// 而新建项目即选择一个已存在的目录。
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

/// 选择文件，支持多选。
///
/// 与 `pick_workspace` 分为两条命令而不是增加参数：目录选择器与文件选择器在
/// 三个平台上是两个不同的系统对话框，调用方无法从结果判断使用的是哪一种。
///
/// **必须支持多选**：浏览器端的 `<input multiple>` 可一次选择多个文件，
/// 桌面端只支持单选会使同一个按钮在两端行为不一致。取消时返回空数组：取消不是错误。
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

/// 通过系统保存对话框写入一份会话诊断文件。
///
/// 会话内容由 sidecar 的 HTTP 接口生成；外壳只接收已生成的字节并由用户决定
/// 保存位置，不读取数据库，也不持有第二份会话状态。取消不是错误，返回 `None`。
#[cfg(desktop)]
#[tauri::command]
async fn save_session_export(
    app: AppHandle,
    file_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter("QyWork 会话诊断", &["json"])
        .set_file_name(file_name)
        .save_file(move |file| {
            let _ = tx.blocking_send(file);
        });
    let mut rx = rx;
    let Some(file) = rx.recv().await.flatten() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| format!("写入失败：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 手机端不经由 Tauri 外壳保存，前端使用浏览器下载；保留同名命令仅为使移动端构建完整。
#[cfg(mobile)]
#[tauri::command]
async fn save_session_export(
    _app: AppHandle,
    _file_name: String,
    _contents: String,
) -> Result<Option<String>, String> {
    Err("移动端请使用浏览器下载".into())
}

/// 窗口控制。
///
/// 关闭系统装饰后，最小化 / 最大化 / 关闭三个操作没有其他入口，
/// 必须由前端调用。**只实现这三个**：还原、置顶、透明度等操作系统标题栏
/// 同样不提供，不在此增加。
///
/// 使用 Tauri 命令而不是在前端引入 `@tauri-apps/api`：本项目的前端是
/// 桌面与手机共用的同一份代码，引入一个仅桌面可用的包，
/// 会使手机端构建中多出一段永不执行的代码。
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
    // close() 触发 `WindowEvent::CloseRequested`，由 `run()` 中的处理把窗口隐藏到托盘。
    // 不要改为 hide()：它会使关闭按钮与 Alt+F4 经由两条不同的路径。
    // 也不要改为 destroy()：它绕过 CloseRequested，直接销毁窗口。
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// 主窗口的**唯一**构造点。
///
/// 启动与切换工作区都要创建该窗口，外壳属性必须完全一致。分两处编写时，
/// 任一处遗漏 `decorations(false)` 都会使系统标题栏与前端渲染的顶栏同时出现，
/// 且不会报错，只出现在其中一条路径上。
///
/// `decorations(false)`：标题栏由前端渲染。
///
/// 系统标题栏的底色由 Windows 决定，应用无法修改，而应用内顶栏为灰色，
/// 保留系统标题栏会在窗口顶部形成两条颜色不同的横条。
///
/// 代价：关闭装饰后，**拖动与双击最大化须由前端实现**
/// （`data-tauri-drag-region`），窗口按钮也由前端渲染。
/// 系统的贴边分屏（Win+方向键 / 拖动到屏幕边缘）仍然可用，
/// 因为窗口本身仍是普通窗口，只是不绘制非客户区。
///
/// `shadow(false)`：**投影与边框线在 tao 中由同一个开关控制**，因此该开关只能
/// 用于去除边框线，投影须另行恢复，见 `extend_frame_for_shadow`。
fn build_main_window(app: &AppHandle, script: &str) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("qywork")
        .decorations(false)
        .shadow(false)
        .inner_size(1280.0, 820.0)
        // 最窄宽度 = 左栏 232（`--sidebar-w`）+ 会话区 510（`--chat-min`）
        // + 右侧面板 337（`PANEL_MIN`），即三列同时取得各自下限所需的宽度。
        // 窗口更窄时布局不会错乱（会话区先收缩到 `--chat-hard-min`，见 shell.css 的
        // `--chat-floor`），但 `--chat-min` 不再成立。上述三个数值修改时，须同步修改此处。
        .min_inner_size(1079.0, 480.0)
        .center()
        .initialization_script(script);

    // 保留 wry 默认禁用项；语音识别使用既有服务端点，以避免新服务的连接失败。
    // 开发构建下由 `QYWORK_WEBVIEW_DEBUG_PORT` 为主窗口开启调试端口，自动化测试经 CDP 连接。
    // 发布构建（`tauri build` 启用 `custom-protocol`）经条件编译不包含此段。
    // 不能改用 WebView2 的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量：此处已经由接口传入参数，该环境变量会被忽略。
    #[cfg(windows)]
    let window = {
        let args = String::from(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msSpeechRecognitionServiceUseCetoService",
        );
        #[cfg(not(feature = "custom-protocol"))]
        let args = match std::env::var("QYWORK_WEBVIEW_DEBUG_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
        {
            Some(port) => format!("{args} --remote-debugging-port={port}"),
            None => args,
        };
        window.additional_browser_args(&args)
    };
    let window = window.build()?;

    // `build()` 返回 Ok 不代表窗口存在：运行时把创建失败写入日志后仍返回 Ok。
    // 任一 getter 返回错误即表示窗口未创建，原因见 `ShellLog` 保留的日志。
    if window.is_visible().is_err() {
        let reason = LAST_ERROR
            .lock()
            .take()
            .unwrap_or_else(|| "运行时未给出原因".to_owned());
        return Err(anyhow::anyhow!("主窗口创建失败：{reason}").into());
    }

    // 无装饰窗口四边的缩放边框由 Tauri 在创建主 WebView 时添加，但 `unstable` 特性下主
    // WebView 按子视图创建，该分支不添加。`set_resizable` 的处理对无装饰窗口会补加，
    // 已添加时直接返回。不要删除这一行：删除后窗口四边无法拖动，且不报任何错误。
    #[cfg(windows)]
    if let Err(e) = window.set_resizable(true) {
        log::warn!("窗口缩放边框未添加：{e}");
    }

    #[cfg(windows)]
    extend_frame_for_shadow(&window);

    Ok(())
}

/// 托盘图标。关闭按钮只隐藏主窗口，进程经由托盘退出。
///
/// 左键单击与菜单「打开」都只显示已存在的主窗口，不重建窗口。
/// 「退出」调用 `app.exit(0)`，它触发 `RunEvent::ExitRequested`，sidecar 与终端的清理
/// 在该事件中执行。不要改为 `std::process::exit`：它会绕过清理，使 qy 成为孤儿进程。
#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("tauri.conf.json 的 bundle.icon 为空，托盘没有图标"))?;
    let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("qywork")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
    // 必须按窗口获取，不能按 webview window 获取：浏览器宿主为主窗口添加子 webview 后，
    // 同一窗口下的 webview label 不再唯一，`get_webview_window` 恒返回 None。
    let Some(window) = app.get_window("main") else {
        return;
    };
    log::info!("主窗口从托盘打开");
    let shown = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus());
    if let Err(e) = shown {
        log::error!("主窗口显示失败：{e}");
    }
}

/// 为窗口恢复投影，但**不**恢复边框线。
///
/// tao 对「无装饰 + 投影」的实现：在 `WM_NCCALCSIZE` 中为左、右、下各保留
/// `SM_CXSIZEFRAME + SM_CXPADDEDBORDER` 像素的非客户区，由系统绘制。投影与 1px 的
/// 系统边框色细线都由这块非客户区绘制，二者共用同一块像素与同一个开关。
/// 上边保留 0（`calculate_insets_for_dpi` 的 Win10 分支 `top_inset = 0`，Win11 为非零），
/// 因此细线只出现在左、右、下三条边。
///
/// `shadow(false)` 使 `WM_NCCALCSIZE` 不再保留这块非客户区，客户区覆盖整个窗口矩形，
/// 细线与投影同时消失。tao 从未调用 `DwmExtendFrameIntoClientArea`，
/// 因此在 tao 层没有其他实现方式。
///
/// 本函数在客户区已覆盖整个窗口的前提下，手动把 DWM 的窗口框向客户区内扩展 1px。
/// 窗口存在扩展进客户区的框时 DWM 即绘制投影，而该 1px 位于客户区内，被不透明的
/// WebView 覆盖，不可见。这是实现「有投影、无边框线」的唯一方式。
///
/// **仅在 Windows 上编译**：macOS 与 Linux 的无装饰窗口自带投影。
/// 失败只影响投影，不阻止启动：投影不应成为应用启动的前提。
#[cfg(windows)]
fn extend_frame_for_shadow(window: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
    use windows::Win32::UI::Controls::MARGINS;

    let Ok(hwnd) = window.hwnd() else {
        log::warn!("无法取得窗口句柄，投影未启用");
        return;
    };
    let margins = MARGINS {
        cxLeftWidth: 0,
        cxRightWidth: 0,
        cyTopHeight: 1,
        cyBottomHeight: 0,
    };
    if let Err(e) = unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) } {
        log::warn!("窗口投影未启用：{e}");
    }
}

/// 启动失败时显示原因。
///
/// **不能依赖 stderr**：release 使用 `windows_subsystem = "windows"`，没有控制台，
/// 输出不可见。也不能使用 Tauri 的对话框插件：它需要 app handle，
/// 而此路径正是 app 未能创建的情形。因此直接调用系统 MessageBox。
#[cfg(windows)]
fn show_fatal(message: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let text = HSTRING::from(message);
    let caption = HSTRING::from("qywork 启动失败");
    // SAFETY: 两个字符串在调用期间都有效；hwnd 传 None 表示无父窗口的模态框。
    unsafe {
        MessageBoxW(None, &text, &caption, MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_fatal(message: &str) {
    // 非 Windows 平台有控制台，使用 stderr 即可。
    eprintln!("[qywork] {message}");
}

/// 启动失败的唯一终态：弹出对话框，再以非 0 退出码结束进程。
///
/// **setup 钩子中的错误必须在钩子内部交给本函数，不能返回 `Err`。** tauri 收到 `Err`
/// 即执行 `panic!("Failed to setup app")`，而 release 下 `panic = "abort"` 且
/// `windows_subsystem = "windows"`（没有控制台）：进程无提示地退出，
/// 而 sidecar 缺失、被安全软件删除、在输出令牌前退出正是最常见的
/// 一类启动故障。对话框不依赖 WebView，覆盖窗口创建之前的阶段。
fn fatal_exit(error: &dyn std::fmt::Display) -> ! {
    let msg = format!("qywork 启动失败：{error}");
    log::error!("{msg}");
    show_fatal(&msg);
    std::process::exit(1);
}

/// 在系统文件管理器中定位一个目录。
///
/// 使用 Rust 侧的 `OpenerExt`，**不**向 WebView 授予 `opener:*` 权限。
/// ACL 只拦截 IPC 层，Rust 直接调用不经过该层，因此 `capabilities/default.json`
/// 的两条权限保持不变（与 `pick_workspace` 使用 dialog 的做法相同）。
///
/// 只接受本机已存在的目录（CLAUDE.md E）：路径来自本机账本中的项目记录，
/// 但仍按外部输入校验一次：不存在时明确报错，不静默忽略。
#[tauri::command]
fn reveal_workspace(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("不是目录：{path}"));
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 在系统文件管理器中选中已存在的文件，不启动文件关联的程序。
#[tauri::command]
fn reveal_file(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = PathBuf::from(&path);
    if !file.is_absolute() {
        return Err("需要文件的绝对路径".to_string());
    }
    if !file.is_file() {
        return Err(format!("文件不存在或不是普通文件：{path}"));
    }
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|e| e.to_string())
}

/// 打开系统设置中授予电脑控制某项前提条件的页面。`grant` 是 worker 上报的缺失项名称。
///
/// 页面地址由此处按名称查表，不接受前端提供的地址：允许 WebView 使本进程打开任意 URL，等于
/// 允许它启动任意 URL scheme 的处理程序。只有 macOS 有对应的设置页，其他平台一律报错。
#[tauri::command]
fn desktop_open_settings(app: AppHandle, grant: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let pane = match grant.as_str() {
        "accessibility" if cfg!(target_os = "macos") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        "screen_recording" if cfg!(target_os = "macos") => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        _ => return Err(format!("{grant} 没有对应的系统设置页")),
    };
    app.opener()
        .open_url(pane, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 记录最后打开的项目。
///
/// 该 IPC 只做路径校验与落盘。不要在此加入递归文件监听：Web 端没有
/// 对应事件的消费方，启动监听只会在大目录上递归扫描全部文件。
#[tauri::command]
fn remember_workspace(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("不是目录：{path}"));
    }
    sidecar::write_last_workspace(&path);
    Ok(())
}

/// 宿主连接的凭据，同一份用于浏览器与电脑控制两条路径。
///
/// 发布版由本进程生成，并经环境变量交给本进程启动的 sidecar；开发版的 sidecar 由
/// `scripts/dev.ts` 启动，凭据由该脚本生成，此处只接收。两种模式使用同一条宿主路径。
///
/// 三个平台都需要：桌面宿主与浏览器宿主均不限平台。
fn host_key() -> Option<String> {
    if tauri::is_dev() {
        std::env::var("QYWORK_HOST_KEY").ok().filter(|v| !v.is_empty())
    } else {
        Some(hostkey::new_host_key()).filter(|v| !v.is_empty())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 只能安装一次；安装失败（已有其他 logger）时沿用已有的 logger。
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    log::info!("qywork 启动 version={} pid={}", env!("CARGO_PKG_VERSION"), std::process::id());

    /*
     * 这三个插件供 **Rust 侧**使用，不供 WebView 中的 JS 使用。
     *
     * 因此 `capabilities/default.json` 中只保留 `core:default` 与拖动标题栏一条。
     * **不要向 capability 中添加 `shell:allow-spawn`、`dialog:allow-open/save`、
     * `opener:allow-open-url`、devtools 切换等条目**：它们都没有前端调用方
     * （`apps/web` 中没有 `@tauri-apps` 依赖，只经由 `__TAURI_INTERNALS__`
     * 调用本 crate 注册的命令），唯一能使用它们的主体是被注入的脚本。
     * 其中 `shell:allow-spawn` 的 `--host` 校验放行 `0.0.0.0`、`--cwd` 校验为 `.+`，
     * 一次 XSS 即可另行启动一个把任意目录暴露到局域网的 qy。
     *
     * 删除授权不影响此处：ACL 只拦截 IPC 层（插件的 `commands.rs`），
     * `ShellExt::sidecar()` 与 `app.dialog()` 都是 Rust 直接调用，不经过该层。
     */
    tauri::Builder::default()
        .manage(updater::owner())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sidecar::SidecarHandle::default())
        .manage(terminal::TerminalHandle::default())
        .invoke_handler(tauri::generate_handler![
            updater::app_update,
            pick_workspace,
            pick_files,
            save_session_export,
            reveal_workspace,
            reveal_file,
            desktop_open_settings,
            remember_workspace,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_is_maximized,
            terminal::terminal_open,
            terminal::terminal_list,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            browser::commands::browser_tabs,
            browser::commands::browser_open,
            browser::commands::browser_close,
            browser::commands::browser_navigate,
            browser::commands::browser_activate,
            browser::commands::browser_layout,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let workspace = resolve_workspace();

            let host_key = host_key();
            let started = tauri::async_runtime::block_on(async move {
                // 后端与页面必须来自同一次构建。devUrl 模式下页面是 Vite 中的源码，
                // 后端只能是 dev.ts 从同一源码树启动的进程；`bin/qy` 是上一次
                // build:agent 的产物，在此处 spawn 它会使源码页面连接上一次构建的后端。
                // release 下页面与 `bin/qy` 由 tauri:build 一次生成，只 spawn，不读取环境变量。
                let info = if tauri::is_dev() {
                    let existing = sidecar::from_env().ok_or_else(|| {
                        anyhow::anyhow!(
                            "开发模式缺少 QYWORK_TOKEN / QYWORK_PORT，请通过 bun run dev 启动"
                        )
                    })?;
                    log::info!("复用 dev.ts 的 sidecar :{}", existing.port);
                    existing
                } else {
                    // 空串表示未显式指定，由服务端决定打开哪个项目。
                    let arg = workspace
                        .as_ref()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    sidecar::spawn(&handle, &arg, host_key.as_deref()).await?
                };

                // 令牌经由初始化脚本注入，而不是等待前端调用命令：
                // 连接层在首帧即需要令牌，延迟取得会先渲染出「未配对」。
                //
                // 窗口只在此处创建，tauri.conf.json 的 `app.windows` 必须为空：
                // 两处都声明会触发 "a webview with label `main` already exists" 的 panic，
                // 而 panic 会绕过退出清理，使 qy sidecar 成为孤儿进程。
                let script = sidecar::init_script(&info);
                updater::start(&handle, &info);

                build_main_window(&handle, &script)?;
                #[cfg(desktop)]
                build_tray(&handle)?;

                // 宿主必须在主窗口之后启动：Windows 的浏览器宿主把子 WebView 附加在主窗口下。
                if let Some(key) = host_key {
                    #[cfg(desktop)]
                    browser::start(&handle, info.port, key.clone());
                    desktop::start(&handle, info.port, key);
                }

                Ok::<(), Box<dyn std::error::Error>>(())
            });

            // 错误就地转为对话框：返回 Err 会导致 tauri panic，见 `fatal_exit`。
            if let Err(e) = started {
                fatal_exit(&e);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭即隐藏到托盘。关闭按钮（`window_close` 的 `close()`）与 Alt+F4 都进入此处；
            // 进程只经由托盘菜单「退出」结束。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                log::info!("主窗口隐藏到托盘");
                if let Err(e) = window.hide() {
                    log::error!("主窗口隐藏失败：{e}");
                }
            }
        })
        // 插件初始化、上下文生成等失败经由 build() 的 Result 返回；不能使用 `.expect(...)`，
        // 理由与 setup 钩子相同，见 `fatal_exit`。
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| fatal_exit(&e))
        .run(|app, event| {
            // Windows 上父进程退出不会结束子进程：残留的 qy serve 会占用端口与
            // SQLite 的 WAL 锁，导致下次无法启动。因此退出路径必须显式清理。
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                // 终端中的 shell 也是子进程，出于同一理由必须显式终止：残留的 shell 会持有
                // 工作区中的文件句柄，导致用户删除目录被拒绝。
                terminal::shutdown(&app.state::<terminal::TerminalHandle>());
                #[cfg(desktop)]
                browser::shutdown();
                // 先结算桌面端进行中的请求，再停止 sidecar：收尾回执须经由宿主 WS 发出，
                // sidecar 退出后服务端只能等待超时。
                desktop::shutdown();
                sidecar::shutdown(app);
            }
        });
}

/// 决定打开哪个工作区。
///
/// 优先级：命令行参数 > 环境变量 `QYWORK_WORKSPACE` > 上次在应用中选择的工作区。
/// 均未指定时返回 `None`，由服务端决定。
///
/// **不要回退到 cwd 或家目录**：这会把「未指定」静默变为「使用启动目录」，而桌面端的
/// 启动目录是安装目录或 `src-tauri`，会被登记为用户从未打开过的项目。
///
/// 未指定时，`server.ts` 的 `bootstrapWorkspace` 选用最近打开的工作区，
/// 没有任何记录时才创建默认工作区。首次打开哪个工作区只在该处判定。
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
    // 上次在应用中选择的工作区。排在环境变量之后：环境变量是显式指定，优先级更高。
    sidecar::read_last_workspace()
}
