use std::path::{Path, PathBuf};
use std::process::Command;

/// 应用自定义命令的清单。
///
/// 登记进 ACL 之后这些命令必须由 capability 显式授权才调得到；不登记的话它们绕过
/// 整个 ACL，任何 WebView 都能调——包括挂在主窗口底下的外部网页子视图。
///
/// 加一条命令就要同时改这里与 `capabilities/default.json`，漏改的表现是
/// 前端调用被拒，不是静默放行。
const APP_COMMANDS: &[&str] = &[
    "app_update",
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
    "browser_activate",
    "browser_layout",
];

/// computer-host worker 的 `externalBin` 条目名。打包时找的是
/// `bin/<名字>-<目标三元组>[.exe]`。
const WORKER: &str = "qy-computer-host";

/// 编译 worker 并放进 `bin/`。
///
/// **这一步不要挪回调用方。** worker 是独立 crate，产物随外壳一起分发；由调用方各自
/// 先跑一个编译脚本的话，`tauri dev` 自己触发的重启、`cargo run`、`cargo check` 都编
/// 不到它，外壳旁边留着的是上一次编出来的那个 worker。
/// 放在这里，「编外壳」本身就保证旁边那个 worker 来自同一份源码。
///
/// 必须在 `tauri_build` 之前跑完：`externalBin` 声明的文件在那一步就要存在。
fn build_worker(manifest_dir: &Path, target: &str) {
    let desktop = manifest_dir.parent().expect("src-tauri 的上级目录");
    let root = desktop.parent().and_then(Path::parent).expect("仓库根目录");
    let crate_dir = desktop.join("native").join("computer-host");
    // 独立的构建目录。与外层共用一个时，两边的目标三元组与 profile 一致就会落到同一个
    // `<三元组>/<profile>/.cargo-lock`：嵌套的这次等外层放锁，外层等这个构建脚本返回。
    // 实测形状是 `cargo build --release --target <三元组>` 停在 Compiling 那一行不再动。
    let target_dir = root.join(".tmp").join("cargo-target").join("computer-host");
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let outfile: PathBuf = manifest_dir
        .join("bin")
        .join(format!("{WORKER}-{target}{suffix}"));

    for path in ["src", "Cargo.toml", "Cargo.lock"] {
        println!("cargo:rerun-if-changed={}", crate_dir.join(path).display());
    }
    // 产物本身也登记：`bin/` 不入库，删掉之后下一次外壳构建要能把它补回来。
    println!("cargo:rerun-if-changed={}", outfile.display());

    // 一律按 release 编，不跟外壳的 profile 走：worker 的 debug 构建打开
    // `cfg(debug_assertions)` 的那几条诊断（`windows/capture.rs`、`windows/mod.rs`），跟着走会让
    // 开发态的 worker 与安装包里的那个行为不同。
    let mut cargo = Command::new(std::env::var_os("CARGO").expect("CARGO 由 cargo 设给构建脚本"));
    cargo
        .args(["build", "--release", "--locked", "--manifest-path"])
        .arg(crate_dir.join("Cargo.toml"))
        .args(["--target", target])
        .arg("--target-dir")
        .arg(&target_dir);
    // 外层 cargo 设给构建脚本的这两组变量会改变嵌套构建：rustflags 被原样套到 worker 上；
    // jobserver 被嵌套 cargo 继承后它等的令牌要等外层放，而外层在等这个构建脚本返回。
    for name in [
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTFLAGS",
        "CARGO_MAKEFLAGS",
        "MAKEFLAGS",
    ] {
        cargo.env_remove(name);
    }
    let status = cargo.status().expect("拉起 cargo 编译 computer-host 失败");
    assert!(status.success(), "编译 computer-host 失败：{status}");

    let built = target_dir
        .join(target)
        .join("release")
        .join(format!("{WORKER}{suffix}"));
    std::fs::create_dir_all(outfile.parent().expect("bin 目录"))
        .expect("建 externalBin 的 bin 目录失败");
    std::fs::copy(&built, &outfile).unwrap_or_else(|e| {
        panic!(
            "复制 {} 到 {} 失败：{e}。目标文件被占用时先结束仍在运行的桌面壳与 worker。",
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
    // tauri_build 不为图标声明 rerun-if-changed。缺这一行时改 icons/ 不会触发构建脚本重跑，
    // exe 资源段里的仍是上次编译时嵌入的 icon.ico。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("构建 Tauri 上下文失败")
}
