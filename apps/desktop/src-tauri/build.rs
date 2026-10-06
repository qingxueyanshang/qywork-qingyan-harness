use std::path::{Path, PathBuf};
use std::process::Command;

/// 应用自定义命令的清单。
///
/// 登记到 ACL 后，这些命令必须由 capability 显式授权才能调用；不登记时它们绕过
/// 整个 ACL，任何 WebView 都能调用，包括附加在主窗口下的外部网页子视图。
///
/// 新增命令时必须同时修改此处与 `capabilities/default.json`；漏改时
/// 前端调用被拒绝，不会静默放行。
const APP_COMMANDS: &[&str] = &[
    "app_update",
    "pick_workspace",
    "pick_files",
    "save_session_export",
    "reveal_workspace",
    "reveal_file",
    "desktop_open_settings",
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
    "browser_activate",
    "browser_layout",
];

/// computer-host worker 的 `externalBin` 条目名。打包时查找
/// `bin/<名称>-<目标三元组>[.exe]`。
const WORKER: &str = "qy-computer-host";

/// 编译 worker 并放入 `bin/`。
///
/// **不要把这一步移到调用方。** worker 是独立 crate，产物随外壳一起分发；由调用方各自
/// 先运行编译脚本时，`tauri dev` 自身触发的重启、`cargo run`、`cargo check` 都不会
/// 编译它，外壳旁的 worker 仍是上一次编译的产物。
/// 放在此处时，编译外壳本身即保证旁边的 worker 来自同一份源码。
///
/// 必须在 `tauri_build` 之前执行完毕：`externalBin` 声明的文件在该步骤中必须已存在。
fn build_worker(manifest_dir: &Path, target: &str) {
    let desktop = manifest_dir.parent().expect("src-tauri 的上级目录");
    let root = desktop.parent().and_then(Path::parent).expect("仓库根目录");
    let crate_dir = desktop.join("native").join("computer-host");
    // 使用独立的构建目录。与外层共用时，若两者的目标三元组与 profile 一致，会使用同一个
    // `<三元组>/<profile>/.cargo-lock`：嵌套构建等待外层释放锁，外层等待本构建脚本返回。
    // 实测现象是 `cargo build --release --target <三元组>` 停滞在 Compiling 一行。
    let target_dir = root.join(".tmp").join("cargo-target").join("computer-host");
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let outfile: PathBuf = manifest_dir
        .join("bin")
        .join(format!("{WORKER}-{target}{suffix}"));

    for path in ["src", "build.rs", "Cargo.toml", "Cargo.lock"] {
        println!("cargo:rerun-if-changed={}", crate_dir.join(path).display());
    }
    // 产物本身也登记：`bin/` 不纳入版本库，删除后下一次外壳构建必须能重新生成它。
    println!("cargo:rerun-if-changed={}", outfile.display());

    // 一律按 release 编译，不跟随外壳的 profile：worker 的 debug 构建会启用
    // `cfg(debug_assertions)` 下的诊断（`windows/capture.rs`、`windows/mod.rs`），跟随外壳 profile 时
    // 开发环境的 worker 与安装包中的 worker 行为不同。
    let mut cargo = Command::new(std::env::var_os("CARGO").expect("CARGO 由 cargo 为构建脚本设置"));
    cargo
        .args(["build", "--release", "--locked", "--manifest-path"])
        .arg(crate_dir.join("Cargo.toml"))
        .args(["--target", target])
        .arg("--target-dir")
        .arg(&target_dir);
    // 外层 cargo 为构建脚本设置的这两组变量会改变嵌套构建：rustflags 会原样应用到 worker；
    // jobserver 被嵌套 cargo 继承后，它等待的令牌需要外层释放，而外层在等待本构建脚本返回。
    for name in [
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTFLAGS",
        "CARGO_MAKEFLAGS",
        "MAKEFLAGS",
    ] {
        cargo.env_remove(name);
    }
    let status = cargo.status().expect("启动 cargo 编译 computer-host 失败");
    assert!(status.success(), "编译 computer-host 失败：{status}");

    let built = target_dir
        .join(target)
        .join("release")
        .join(format!("{WORKER}{suffix}"));
    std::fs::create_dir_all(outfile.parent().expect("bin 目录"))
        .expect("创建 externalBin 的 bin 目录失败");
    std::fs::copy(&built, &outfile).unwrap_or_else(|e| {
        panic!(
            "复制 {} 到 {} 失败：{e}。目标文件被占用时，先结束仍在运行的桌面端外壳与 worker。",
            built.display(),
            outfile.display()
        )
    });
}

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let target = std::env::var("TARGET").expect("TARGET");
    build_worker(&manifest_dir, &target);

    println!("cargo:rerun-if-env-changed=QYWORK_UPDATER_PUBLIC_KEY");
    // tauri_build 不为图标声明 rerun-if-changed。缺少此行时，修改 icons/ 不会触发构建脚本重新运行，
    // exe 资源段中仍是上次编译时嵌入的 icon.ico。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("构建 Tauri 上下文失败")
}
