//! 找本机的 Chromium 系浏览器，按专用 profile 拉起它，读出它的调试端点。
//!
//! 只认固定清单里的安装位置，不按 `PATH` 找：`PATH` 上同名的可能是别的包装脚本，
//! 而宿主要按找到的是哪一种决定 profile 放在哪里。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 等浏览器写出 `DevToolsActivePort` 的上限。与 Windows 建页等首个文档的上限取同一个数。
const PORT_FILE_WAIT: Duration = Duration::from_secs(20);
const PORT_FILE_POLL: Duration = Duration::from_millis(100);

/// 重启退避的起点与上界，与电脑控制 worker 的重启同一套数。
const RESTART_BASE_MS: u64 = 500;
const RESTART_MAX_MS: u64 = 15_000;
/// 连续多少次短命退出之后不再重启。到达上限即浏览器控制发布为不可用。
const RESTART_MAX_ATTEMPTS: u32 = 5;
/// 活过这个时长即认为这次启动是成功的，下一次退出从头退避。
const HEALTHY_RUN_MS: u128 = 60_000;

/// 找到的浏览器。
pub struct Found {
    pub exe: PathBuf,
    /// snap 包的浏览器：它的 `home` 接口不放行家目录下的隐藏目录，profile 要换位置。
    pub snap: bool,
}

/// 按偏好排的安装位置。Linux 上 snap 版排最后：它的沙箱限制 profile 的位置。
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

/// 找第一个存在的浏览器。非 snap 的一律排在 snap 之前。
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

/// 这个入口是不是 snap 包：本身或它指向的链接落在 `/snap/` 下，或是转去执行 `/snap/` 下
/// 程序的脚本（Ubuntu 的 `chromium-browser` 过渡包就是这种脚本）。
///
/// 不要改成按 `canonicalize` 判：`/snap/bin/chromium` 是指向 `/usr/bin/snap` 的链接，
/// 解析到底就不在 `/snap/` 下了。
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

/// profile 目录。规则与 Windows 同一条：数据根下的 `browser/profiles/default`；
/// snap 版的数据根换成 `~/snap/chromium/common/qywork`，那是它的沙箱里唯一可写的家目录位置。
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

/// 按专用 profile 拉起浏览器。
///
/// `--no-startup-window`：起来时不开窗口，第一个页由宿主建出时才出现窗口；用户关掉
/// 最后一个窗口时进程不退出，之后建页再开一个窗口。`--remote-debugging-port=0` 由浏览器
/// 自己挑端口并写进 profile 目录的 `DevToolsActivePort`。
pub fn launch(found: &Found, profile: &Path) -> Result<Launched, String> {
    let port_file = profile.join("DevToolsActivePort");
    // 上一个进程留下的端口文件必须先删：不删的话下面读到的是一个已经不在监听的端口。
    match std::fs::remove_file(&port_file) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删不掉旧的调试端口文件：{e}")),
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
        .map_err(|e| format!("拉不起 {}：{e}", found.exe.display()))?;
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
                "浏览器在 {} 秒内没有写出调试端点",
                PORT_FILE_WAIT.as_secs()
            ));
        }
        std::thread::sleep(PORT_FILE_POLL);
    }
}

/// 启动期间的 stderr 转进日志，启动失败时原因在这里；起来之后只读不记，浏览器运行期的
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

/// 外壳被强杀时浏览器随之收到 SIGTERM。只有 Linux 有这个开关；它按拉起子进程的线程
/// 计算父进程存活，所以只能在活到外壳退出的那个监督线程里拉起。
#[cfg(target_os = "linux")]
fn exit_with_parent(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    const PR_SET_PDEATHSIG: i32 = 1;
    const SIGTERM: i32 = 15;
    extern "C" {
        fn prctl(option: i32, ...) -> i32;
    }
    // SAFETY: 闭包在 fork 之后、exec 之前执行，只调一个异步信号安全的系统调用。
    unsafe {
        command.pre_exec(|| {
            if prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// macOS 没有父进程退出信号。外壳正常退出时由宿主关掉浏览器；外壳被强杀时浏览器留下，
/// 下一次对同一份 profile 拉起的进程会把请求转交给它后退出，宿主按启动失败退避，
/// 到上限即停止重启，浏览器控制发布为不可用。
#[cfg(target_os = "macos")]
fn exit_with_parent(_command: &mut Command) {}

/// 解析 `DevToolsActivePort`：第一行端口，第二行浏览器级 WebSocket 路径。
/// 浏览器先建文件再写内容，半截的文件按没写出处理。
pub fn read_active_port(text: &str) -> Option<(u16, String)> {
    let mut lines = text.lines();
    let port = lines.next()?.trim().parse::<u16>().ok().filter(|p| *p != 0)?;
    let path = lines.next()?.trim();
    path.starts_with("/devtools/browser/").then(|| (port, path.to_owned()))
}

/// `Browser.getVersion` 的 `product` 取版本号：`Chrome/154.0.8037.57` → `154.0.8037.57`。
/// Edge 在这个字段里同样报 Chromium 的版本。
pub fn product_version(product: &str) -> String {
    product.split_once('/').map_or(product, |(_, v)| v).to_owned()
}

/// 第 `attempt` 次重启等多久。`None` = 到达上限，不再重启。
pub fn restart_delay(attempt: u32) -> Option<Duration> {
    if attempt >= RESTART_MAX_ATTEMPTS {
        return None;
    }
    let ms = RESTART_BASE_MS
        .checked_shl(attempt)
        .unwrap_or(RESTART_MAX_MS)
        .min(RESTART_MAX_MS);
    Some(Duration::from_millis(ms))
}

/// 这一次浏览器活了 `ran_for` 之后退出，下一次重启算第几次。
pub fn next_attempt(attempt: u32, ran_for: Duration) -> u32 {
    if ran_for.as_millis() >= HEALTHY_RUN_MS {
        0
    } else {
        attempt + 1
    }
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
        assert_eq!(read_active_port("36233\n"), None, "只写了端口的半截文件");
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

    #[test]
    fn restart_backs_off_and_then_gives_up() {
        assert_eq!(restart_delay(0), Some(Duration::from_millis(500)));
        assert_eq!(restart_delay(1), Some(Duration::from_millis(1_000)));
        assert_eq!(restart_delay(4), Some(Duration::from_millis(8_000)));
        assert_eq!(restart_delay(RESTART_MAX_ATTEMPTS), None);
        assert_eq!(next_attempt(0, Duration::from_millis(80)), 1);
        assert_eq!(next_attempt(4, Duration::from_secs(60)), 0);
    }

    /// snap 的过渡包是一段转去 `/snap/bin` 的脚本，不能当成原生安装挑中。
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
        assert!(is_snap(Path::new("/snap/bin/chromium")), "按字面路径判，不解析链接");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snap_profiles_live_under_the_snap_writable_home() {
        let found = Found { exe: PathBuf::from("/snap/bin/chromium"), snap: true };
        let dir = profile_dir(&found).expect("有 HOME 就有结果");
        assert!(dir.ends_with("snap/chromium/common/qywork/browser/profiles/default"), "{}", dir.display());
    }
}
