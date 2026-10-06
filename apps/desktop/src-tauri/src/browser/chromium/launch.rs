//! 查找本机的 Chromium 系浏览器，以专用 profile 启动它，并读取其调试端点。
//!
//! 只认可固定清单中的安装位置，不按 `PATH` 查找：`PATH` 上的同名程序可能是其他包装脚本，
//! 而宿主要按找到的浏览器类型决定 profile 的位置。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 等待浏览器写出 `DevToolsActivePort` 的上限。与 Windows 新建页面时等待首个文档的上限取同一值。
const PORT_FILE_WAIT: Duration = Duration::from_secs(20);
const PORT_FILE_POLL: Duration = Duration::from_millis(100);

/// 找到的浏览器。
pub struct Found {
    pub exe: PathBuf,
    /// snap 包的浏览器：其 `home` 接口不允许访问家目录下的隐藏目录，profile 必须换到其他位置。
    pub snap: bool,
}

/// 按偏好排序的安装位置。Linux 上 snap 版排在最后：其沙箱限制 profile 的位置。
#[cfg(target_os = "linux")]
const CANDIDATES: &[&str] = &[
    "/opt/google/chrome/chrome",
    "/opt/microsoft/msedge/msedge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
];

#[cfg(target_os = "macos")]
const CANDIDATES: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/// 查找第一个存在的浏览器。非 snap 版一律排在 snap 版之前。
pub fn discover() -> Option<Found> {
    let mut snap = None;
    for candidate in CANDIDATES {
        let exe = PathBuf::from(candidate);
        if !exe.is_file() {
            continue;
        }
        if is_snap(&exe) {
            snap.get_or_insert(Found { exe, snap: true });
            continue;
        }
        return Some(Found { exe, snap: false });
    }
    snap
}

/// 判定该入口是否为 snap 包：其本身或其链接目标位于 `/snap/` 下，或是转而执行 `/snap/` 下
/// 程序的脚本（Ubuntu 的 `chromium-browser` 过渡包即为此类脚本）。
///
/// 不要改为按 `canonicalize` 判定：`/snap/bin/chromium` 是指向 `/usr/bin/snap` 的链接，
/// 完全解析后不在 `/snap/` 下。
fn is_snap(exe: &Path) -> bool {
    if exe.starts_with("/snap/")
        || std::fs::read_link(exe).is_ok_and(|target| target.starts_with("/snap/"))
    {
        return true;
    }
    let mut head = [0u8; 4096];
    let read = std::fs::File::open(exe)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    let head = &head[..read];
    head.starts_with(b"#!") && head.windows(6).any(|w| w == b"/snap/")
}

/// profile 目录。规则与 Windows 相同：数据根下的 `browser/profiles/default`；
/// snap 版的数据根改为 `~/snap/chromium/common/qywork`，该位置是其沙箱中唯一可写的家目录位置。
pub fn profile_dir(found: &Found) -> Option<PathBuf> {
    if !found.snap {
        return super::super::profile::profile_dir();
    }
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("snap/chromium/common/qywork")
            .join("browser")
            .join("profiles")
            .join("default"),
    )
}

/// 一个已经写出调试端点的浏览器进程。
pub struct Launched {
    pub child: Child,
    pub port: u16,
    pub path: String,
}

/// 以专用 profile 启动浏览器。
///
/// `--no-startup-window`：启动时不打开窗口，宿主新建第一个页面时才出现窗口；用户关闭
/// 最后一个窗口时进程不退出，之后新建页面时再打开窗口。`--remote-debugging-port=0`：由浏览器
/// 自行选择端口并写入 profile 目录的 `DevToolsActivePort`。
pub fn launch(found: &Found, profile: &Path) -> Result<Launched, String> {
    let port_file = profile.join("DevToolsActivePort");
    // 必须先删除上一个进程留下的端口文件：不删除时，下方读取到的是已停止监听的端口。
    match std::fs::remove_file(&port_file) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("无法删除旧的调试端口文件：{e}")),
    }
    let mut command = Command::new(&found.exe);
    command
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--remote-debugging-port=0")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--no-startup-window")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    exit_with_parent(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 {}：{e}", found.exe.display()))?;
    let started = Arc::new(AtomicBool::new(false));
    if let Some(stderr) = child.stderr.take() {
        relay_stderr(stderr, Arc::clone(&started));
    }
    let deadline = Instant::now() + PORT_FILE_WAIT;
    loop {
        if let Ok(text) = std::fs::read_to_string(&port_file) {
            if let Some((port, path)) = read_active_port(&text) {
                started.store(true, Ordering::Relaxed);
                return Ok(Launched { child, port, path });
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("浏览器进程启动后退出：{status}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "浏览器在 {} 秒内未写出调试端点",
                PORT_FILE_WAIT.as_secs()
            ));
        }
        std::thread::sleep(PORT_FILE_POLL);
    }
}

/// 启动期间的 stderr 写入日志，启动失败的原因记录于此；启动完成后只读取不记录，浏览器运行期间的
/// 输出与 qywork 无关。
fn relay_stderr(stderr: std::process::ChildStderr, started: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !started.load(Ordering::Relaxed) {
                log::info!("浏览器输出：{line}");
            }
        }
    });
}

/// 外壳被强制终止时浏览器随之收到 SIGTERM。只有 Linux 提供此选项；它按启动子进程的线程
/// 判定父进程是否存活，因此只能在运行至外壳退出的监督线程中启动。
#[cfg(target_os = "linux")]
fn exit_with_parent(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    const PR_SET_PDEATHSIG: i32 = 1;
    const SIGTERM: i32 = 15;
    extern "C" {
        fn prctl(option: i32, ...) -> i32;
    }
    // SAFETY: 闭包在 fork 之后、exec 之前执行，只调用一个异步信号安全的系统调用。
    unsafe {
        command.pre_exec(|| {
            if prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// macOS 没有父进程退出信号。外壳正常退出时由宿主关闭浏览器；外壳被强制终止时浏览器继续运行，
/// 下一次以同一 profile 启动的进程会把请求转交给它后退出，宿主按启动失败退避，
/// 达到上限即停止重启，并报告浏览器控制不可用。
#[cfg(target_os = "macos")]
fn exit_with_parent(_command: &mut Command) {}

/// 解析 `DevToolsActivePort`：第一行为端口，第二行为浏览器级 WebSocket 路径。
/// 浏览器先创建文件再写入内容，内容不完整的文件按未写出处理。
pub fn read_active_port(text: &str) -> Option<(u16, String)> {
    let mut lines = text.lines();
    let port = lines.next()?.trim().parse::<u16>().ok().filter(|p| *p != 0)?;
    let path = lines.next()?.trim();
    path.starts_with("/devtools/browser/").then(|| (port, path.to_owned()))
}

/// 从 `Browser.getVersion` 的 `product` 中取版本号：`Chrome/154.0.8037.57` → `154.0.8037.57`。
/// Edge 在该字段中同样报告 Chromium 的版本。
pub fn product_version(product: &str) -> String {
    product.split_once('/').map_or(product, |(_, v)| v).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_file_needs_both_lines() {
        assert_eq!(
            read_active_port("36233\n/devtools/browser/646e207d\n"),
            Some((36233, "/devtools/browser/646e207d".to_owned()))
        );
        assert_eq!(read_active_port("36233\n"), None, "只写入端口的不完整文件");
        assert_eq!(read_active_port(""), None);
        assert_eq!(read_active_port("0\n/devtools/browser/x"), None);
        assert_eq!(read_active_port("36233\n/json/version"), None);
    }

    #[test]
    fn product_names_reduce_to_the_version_number() {
        assert_eq!(product_version("Chrome/154.0.8037.57"), "154.0.8037.57");
        assert_eq!(product_version("Edg/153.0.3000.1"), "153.0.3000.1");
        assert_eq!(product_version("154.0"), "154.0");
    }

    /// snap 的过渡包是一段转而执行 `/snap/bin` 的脚本，不能作为原生安装选中。
    #[test]
    fn a_wrapper_script_into_snap_counts_as_snap() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp/cargo-tests")
            .join(format!("chromium-discover-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wrapper = dir.join("chromium-browser");
        std::fs::write(&wrapper, "#!/bin/sh\nexec /snap/bin/chromium \"$@\"\n").unwrap();
        let native = dir.join("chromium");
        std::fs::write(&native, "#!/bin/sh\nexec /usr/lib/chromium/chromium \"$@\"\n").unwrap();
        assert!(is_snap(&wrapper));
        assert!(!is_snap(&native));
        assert!(is_snap(Path::new("/snap/bin/chromium")), "按字面路径判定，不解析链接");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snap_profiles_live_under_the_snap_writable_home() {
        let found = Found { exe: PathBuf::from("/snap/bin/chromium"), snap: true };
        let dir = profile_dir(&found).expect("设置了 HOME 时必有结果");
        assert!(dir.ends_with("snap/chromium/common/qywork/browser/profiles/default"), "{}", dir.display());
    }
}
