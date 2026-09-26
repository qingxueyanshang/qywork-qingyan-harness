//! 窗口与进程的身份查询：句柄此刻属于哪个进程、那个进程什么时候启动、可执行文件叫什么。
//!
//! 边界：窗口句柄与 pid 都会被 OS 复用，**单独作为长期身份不成立**。派发动作之前要用
//! pid 现问一次启动时刻，与观察时记下的一致才算还是同一个进程。任一项取不到时返回
//! `None`，调用方据此拒绝派发，不要回落到只比句柄。
//!
//! 句柄 → pid 只有 Windows 在这里现问：别的平台窗口的归属进程只有 worker 的窗口清单一个来源。

/// 一个进程的身份。`app` 是可执行文件名，界面上「正在操作哪个应用」显示的就是它。
pub struct ProcessIdentity {
    pub started_at_ms: i64,
    pub app: String,
}

/// 这个窗口句柄此刻属于哪个进程。句柄已经失效时返回 `None`。
#[cfg(windows)]
pub fn window_pid(handle: i64) -> Option<u32> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    let hwnd = HWND(handle as *mut core::ffi::c_void);
    // SAFETY: 两个调用都只读窗口属性；句柄失效时 IsWindow 返回假，后面不再用它。
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }
        let mut pid = 0u32;
        let thread = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (thread != 0 && pid != 0).then_some(pid)
    }
}

#[cfg(windows)]
pub fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // PROCESS_QUERY_LIMITED_INFORMATION 是给低权限进程查高权限进程用的那一档：
    // 提权窗口的身份读得到，动作会不会被 UIPI 拒绝是另一件事，由 worker 的调用结果说。
    // SAFETY: 句柄由本函数独占，两次查询都只读，出口处只关一次。
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let times =
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
    let mut raw = [0u16; 260];
    let mut written = raw.len() as u32;
    let name = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(raw.as_mut_ptr()),
            &mut written,
        )
    };
    unsafe {
        let _ = CloseHandle(process);
    }
    times.ok()?;
    name.ok()?;
    let path = String::from_utf16_lossy(&raw[..written as usize]);
    Some(ProcessIdentity {
        started_at_ms: filetime_to_unix_ms(creation.dwHighDateTime, creation.dwLowDateTime),
        app: file_name(&path, '\\'),
    })
}

/// FILETIME 是 1601-01-01 起的 100 纳秒数，Unix 纪元比它晚 11644473600 秒。
#[cfg(windows)]
fn filetime_to_unix_ms(high: u32, low: u32) -> i64 {
    const EPOCH_DIFF_100NS: i64 = 11_644_473_600 * 10_000_000;
    let ticks = ((u64::from(high) << 32) | u64::from(low)) as i64;
    (ticks - EPOCH_DIFF_100NS) / 10_000
}

/// Linux 的进程启动时刻要两个数才算得出来：`/proc/<pid>/stat` 的第 22 项是自开机起的
/// 时钟滴答，`/proc/stat` 的 `btime` 是开机时刻的 Unix 秒。
#[cfg(target_os = "linux")]
pub fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks = parse_start_ticks(&stat)?;
    let btime = parse_btime(&std::fs::read_to_string("/proc/stat").ok()?)?;
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    Some(ProcessIdentity {
        started_at_ms: btime * 1_000 + ticks * 1_000 / CLOCK_TICKS_PER_SEC,
        app: file_name(&exe.to_string_lossy(), '/'),
    })
}

/// `sysconf(_SC_CLK_TCK)` 的值。Linux 的 `/proc` 接口按 100 定义这个换算，与内核
/// 编译时的 `CONFIG_HZ` 无关，不要改成读 `CONFIG_HZ`。
#[cfg(any(target_os = "linux", test))]
const CLOCK_TICKS_PER_SEC: i64 = 100;

/// 取 `/proc/<pid>/stat` 的第 22 项。
///
/// 必须从**最后一个**右括号往后切：第 2 项是可执行文件名，它带括号且可以含空格与括号，
/// 按空格切会把字段号全错开。
#[cfg(any(target_os = "linux", test))]
fn parse_start_ticks(stat: &str) -> Option<i64> {
    let tail = &stat[stat.rfind(')')? + 1..];
    // 切掉的两项是 pid 与 comm，所以第 22 项在剩下这段里是第 20 个。
    tail.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(any(target_os = "linux", test))]
fn parse_btime(stat: &str) -> Option<i64> {
    stat.lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()
}

/// macOS 的进程启动时刻取 `proc_pidinfo(PROC_PIDTBSDINFO)` 的 `pbi_start_tvsec` /
/// `pbi_start_tvusec`，可执行文件名取 `proc_pidpath` 的最后一段。
///
/// 结构体布局用 `libc` 的定义，不要改成手写 `kinfo_proc`：布局写错不报错，读出的是无效值。
/// 调用交回的字节数不等于结构体大小即认不出，不拿半个结构体当身份。
#[cfg(target_os = "macos")]
pub fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: 缓冲区是一个 `proc_bsdinfo`，长度如实给出。
    let got =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    if got != size {
        return None;
    }
    // SAFETY: 调用写满了整个结构体；未写的字节也已清零。
    let info = unsafe { info.assume_init() };
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: 缓冲区长度如实给出，交回的是写入的字节数。
    let len = unsafe {
        libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32)
    };
    let len = usize::try_from(len).ok().filter(|n| *n > 0)?;
    let seconds = i64::try_from(info.pbi_start_tvsec).ok()?;
    let micros = i64::try_from(info.pbi_start_tvusec).ok()?;
    Some(ProcessIdentity {
        started_at_ms: seconds * 1_000 + micros / 1_000,
        app: file_name(&String::from_utf8_lossy(&path[..len]), '/'),
    })
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn process_identity(_pid: u32) -> Option<ProcessIdentity> {
    None
}

/// 路径的最后一段。分隔符按平台给，不用 `Path`：这里处理的是目标进程的路径字符串，
/// 与本进程跑在哪个平台无关。
fn file_name(path: &str, separator: char) -> String {
    path.rsplit(separator).next().unwrap_or(path).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_name_is_the_last_path_segment() {
        assert_eq!(file_name(r"C:\Windows\System32\notepad.exe", '\\'), "notepad.exe");
        assert_eq!(file_name("/usr/bin/gedit", '/'), "gedit");
        assert_eq!(file_name("gedit", '/'), "gedit");
    }

    /// 可执行文件名里带空格和右括号时，按空格切会把全部字段号错开一位。
    #[test]
    fn proc_stat_is_parsed_after_the_last_parenthesis() {
        // ) 之后依次是 state 与 ppid…itrealvalue 共 19 项，第 20 项才是 starttime。
        let stat = "1234 (my )weird( app) S 1 1234 1234 0 -1 4194304 \
            111 222 333 444 555 666 777 888 999 20 0 0 999999 0 0 0";
        assert_eq!(parse_start_ticks(stat), Some(999_999));
    }

    #[test]
    fn boot_time_comes_from_the_btime_line() {
        let stat = "cpu  1 2 3\nintr 9\nbtime 1700000000\nprocesses 42\n";
        assert_eq!(parse_btime(stat), Some(1_700_000_000));
        assert_eq!(parse_btime("cpu 1 2 3\n"), None);
    }

    #[test]
    fn linux_start_time_adds_boot_time_to_the_tick_offset() {
        let ticks = 250_i64;
        let btime = 1_700_000_000_i64;
        assert_eq!(
            btime * 1_000 + ticks * 1_000 / CLOCK_TICKS_PER_SEC,
            1_700_000_002_500
        );
    }

    #[cfg(windows)]
    #[test]
    fn filetime_zero_point_maps_to_the_unix_epoch() {
        // 1601-01-01 起 11644473600 秒正好是 1970-01-01。
        let ticks = 11_644_473_600_u64 * 10_000_000;
        assert_eq!(
            filetime_to_unix_ms((ticks >> 32) as u32, ticks as u32),
            0
        );
    }

    /// 本进程的身份一定读得到，且两次读到同一个启动时刻——它要能当身份用。
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    #[test]
    fn this_process_has_a_stable_identity() {
        let pid = std::process::id();
        let first = process_identity(pid).expect("本进程的身份必须读得到");
        let second = process_identity(pid).expect("本进程的身份必须读得到");
        assert_eq!(first.started_at_ms, second.started_at_ms);
        assert!(first.started_at_ms > 1_500_000_000_000, "{}", first.started_at_ms);
        // 测试可执行文件是 cargo 编出的 `qywork_lib-<哈希>`。
        assert!(first.app.starts_with("qywork_lib-"), "{}", first.app);
        #[cfg(windows)]
        assert!(first.app.ends_with(".exe"), "{}", first.app);
    }

    /// 不存在的 pid 不能返回一个编造的身份：那会让句柄复用检查永远通过。
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    #[test]
    fn an_unknown_process_has_no_identity() {
        assert!(process_identity(0x3fff_fff0).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn an_invalid_window_handle_has_no_owner() {
        assert_eq!(window_pid(1), None);
    }
}
