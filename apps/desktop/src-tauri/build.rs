/// 应用自定义命令的清单。
///
/// 登记进 ACL 之后这些命令必须由 capability 显式授权才调得到；不登记的话它们绕过
/// 整个 ACL，任何 WebView 都能调——包括挂在主窗口底下的外部网页子视图。
///
/// 加一条命令就要同时改这里与 `capabilities/default.json`，漏改的表现是
/// 前端调用被拒，不是静默放行。
const APP_COMMANDS: &[&str] = &[
    "pick_workspace",
    "pick_files",
    "save_session_export",
    "reveal_workspace",
    "remember_workspace",
    "window_minimize",
    "window_toggle_maximize",
    "window_close",
    "window_is_maximized",
    "terminal_open",
    "terminal_list",
    "terminal_write",
    "terminal_resize",
    "terminal_close",
    "browser_tabs",
    "browser_open",
    "browser_close",
    "browser_navigate",
    "browser_layout",
];

fn main() {
    // tauri_build 不为图标声明 rerun-if-changed。缺这一行时改 icons/ 不会触发构建脚本重跑，
    // exe 资源段里的仍是上次编译时嵌入的 icon.ico。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("构建 Tauri 上下文失败")
}
