//! 窗口与进程的身份查询：句柄当前所属的进程、该进程的启动时刻与可执行文件名，以及该进程是否属于本应用。
//!
//! 边界：窗口句柄与 pid 都会被 OS 复用，**单独作为长期身份不成立**。派发动作之前必须用
//! pid 实时查询一次启动时刻，与观察时记录的一致才视为同一个进程。任一项无法取得时返回
//! `None`，调用方据此拒绝派发，不要回退到只比较句柄。
//!
//! 句柄 → pid 只有 Windows 在此处实时查询：其他平台上窗口的所属进程只有 worker 的窗口清单这一个来源。

/// 进程的身份。`app` 是可执行文件名，界面显示正在操作的应用时使用该值。
pub struct ProcessIdentity {
    pub started_at_ms: i64,
    pub app: String,
}

/// 窗口句柄当前所属的进程。句柄已失效时返回 `None`。
#[cfg(windows)]
pub fn window_pid(handle: i64) -> Option<u32> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    let hwnd = HWND(handle as *mut core::ffi::c_void);
    // SAFETY: 两个调用都只读取窗口属性；句柄失效时 IsWindow 返回 false，之后不再使用该句柄。
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

    // PROCESS_QUERY_LIMITED_INFORMATION 是供低权限进程查询高权限进程的访问级别：
    // 能读取提权窗口的身份；动作是否被 UIPI 拒绝是另一个问题，由 worker 的调用结果决定。
    // SAFETY: 句柄由本函数独占，两次查询都只读，在出口处只关闭一次。
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

/// FILETIME 是自 1601-01-01 起的 100 纳秒计数，Unix 纪元比它晚 11644473600 秒。
#[cfg(windows)]
fn filetime_to_unix_ms(high: u32, low: u32) -> i64 {
    const EPOCH_DIFF_100NS: i64 = 11_644_473_600 * 10_000_000;
    let ticks = ((u64::from(high) << 32) | u64::from(low)) as i64;
    (ticks - EPOCH_DIFF_100NS) / 10_000
}

/// Linux 的进程启动时刻需要两个值才能计算：`/proc/<pid>/stat` 的第 22 项是自开机起的
/// 时钟滴答数，`/proc/stat` 的 `btime` 是开机时刻的 Unix 秒数。
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

/// `sysconf(_SC_CLK_TCK)` 的值。Linux 的 `/proc` 接口按 100 定义该换算，与内核
/// 编译时的 `CONFIG_HZ` 无关，不要改为读取 `CONFIG_HZ`。
#[cfg(any(target_os = "linux", test))]
const CLOCK_TICKS_PER_SEC: i64 = 100;

/// 取 `/proc/<pid>/stat` 的第 22 项。
///
/// 必须从**最后一个**右括号之后切分：第 2 项是可执行文件名，它带括号且可以包含空格与括号，
/// 按空格切分会使全部字段号错位。
#[cfg(any(target_os = "linux", test))]
fn parse_start_ticks(stat: &str) -> Option<i64> {
    let tail = &stat[stat.rfind(')')? + 1..];
    // 切除的两项是 pid 与 comm，因此第 22 项在剩余部分中是第 20 项。
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
/// 结构体布局使用 `libc` 的定义，不要改为手写 `kinfo_proc`：布局错误不会报错，读取的是无效值。
/// 调用返回的字节数不等于结构体大小时视为无法识别，不把不完整的结构体用作身份。
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
    // SAFETY: 调用写入了整个结构体；未写入的字节也已清零。
    let info = unsafe { info.assume_init() };
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: 缓冲区长度如实给出，返回值是写入的字节数。
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

/// WebView2 进程的可执行文件名。本应用的页面以及页面弹出的下拉框、右键菜单由这些进程绘制。
#[cfg(any(windows, test))]
const WEBVIEW_EXE: &str = "msedgewebview2.exe";

/// 沿父进程链向上查找的层数上限。WebView2 的进程树为两层（浏览器进程与其子进程）。
#[cfg(any(windows, test))]
const MAX_WEBVIEW_DEPTH: usize = 8;

/// 进程是否属于本应用：本进程，或本进程启动的 WebView 进程。无法判定时返回 `None`，调用方按属于处理。
///
/// `app` 是该进程的可执行文件名（`process_identity` 的结果），不是 WebView 进程时不查询进程树。
/// 本应用终端中启动的程序不属于本应用，即使其父进程链经过本进程：它们是用户的程序，不是本应用的界面。
/// 只有 Windows 的 WebView 运行在独立的进程中并拥有顶层窗口；其他平台上本应用的窗口都属于本进程。
pub fn is_self_process(pid: u32, app: &str) -> Option<bool> {
    let me = std::process::id();
    if pid == me {
        return Some(true);
    }
    #[cfg(windows)]
    if app.eq_ignore_ascii_case(WEBVIEW_EXE) {
        let table = process_table()?;
        return spawned_webview(pid, me, |p| {
            let (parent, exe) = table.get(&p)?;
            Some(ProcessEntry {
                parent: *parent,
                exe: exe.clone(),
                started_at_ms: process_identity(p)?.started_at_ms,
            })
        });
    }
    #[cfg(not(windows))]
    let _ = app;
    Some(false)
}

/// 进程树中的一项：父进程、可执行文件名与启动时刻。
#[cfg(any(windows, test))]
struct ProcessEntry {
    parent: u32,
    exe: String,
    started_at_ms: i64,
}

/// `pid` 是否为 `me` 启动的 WebView 进程：沿父进程链向上，到达 `me` 之前经过的都是 WebView 进程。
///
/// 父进程号会被复用，因此每一级都核对父进程的启动时刻不晚于子进程；不成立表示原父进程已经退出、
/// 该号码已属于另一个进程，判为不属于。`lookup` 无法给出某一级时返回 `None`。
#[cfg(any(windows, test))]
fn spawned_webview(
    pid: u32,
    me: u32,
    lookup: impl Fn(u32) -> Option<ProcessEntry>,
) -> Option<bool> {
    let mut child = lookup(pid)?;
    for _ in 0..MAX_WEBVIEW_DEPTH {
        if !child.exe.eq_ignore_ascii_case(WEBVIEW_EXE) {
            return Some(false);
        }
        let parent_pid = child.parent;
        let parent = lookup(parent_pid)?;
        if parent.started_at_ms > child.started_at_ms {
            return Some(false);
        }
        if parent_pid == me {
            return Some(true);
        }
        child = parent;
    }
    Some(false)
}

/// 全部进程的父进程与可执行文件名，按 pid 索引。快照无法取得时返回 `None`。
#[cfg(windows)]
pub(crate) fn process_table() -> Option<std::collections::HashMap<u32, (u32, String)>> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: 快照句柄由本函数独占，遍历只读，在出口处只关闭一次；`dwSize` 如实给出结构体大小。
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut table = std::collections::HashMap::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let name = &entry.szExeFile;
        let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        table.insert(
            entry.th32ProcessID,
            (entry.th32ParentProcessID, String::from_utf16_lossy(&name[..len])),
        );
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    (!table.is_empty()).then_some(table)
}

/// 路径的最后一段。分隔符由调用方按平台传入，不使用 `Path`：此处处理的是目标进程的路径字符串，
/// 与本进程运行的平台无关。
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

    /// 可执行文件名中带空格与右括号时，按空格切分会使全部字段号错位。
    #[test]
    fn proc_stat_is_parsed_after_the_last_parenthesis() {
        // ) 之后依次是 state 与 ppid…itrealvalue，共 19 项，第 20 项是 starttime。
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
        // 自 1601-01-01 起经过 11644473600 秒即为 1970-01-01。
        let ticks = 11_644_473_600_u64 * 10_000_000;
        assert_eq!(
            filetime_to_unix_ms((ticks >> 32) as u32, ticks as u32),
            0
        );
    }

    /// 本进程的身份必定可以读取，且两次读取的启动时刻相同，才能用作身份。
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    #[test]
    fn this_process_has_a_stable_identity() {
        let pid = std::process::id();
        let first = process_identity(pid).expect("必须能读取本进程的身份");
        let second = process_identity(pid).expect("必须能读取本进程的身份");
        assert_eq!(first.started_at_ms, second.started_at_ms);
        assert!(first.started_at_ms > 1_500_000_000_000, "{}", first.started_at_ms);
        // 测试可执行文件是 cargo 编译生成的 `qywork_lib-<哈希>`。
        assert!(first.app.starts_with("qywork_lib-"), "{}", first.app);
        #[cfg(windows)]
        assert!(first.app.ends_with(".exe"), "{}", first.app);
    }

    /// 不存在的 pid 不得返回编造的身份：否则句柄复用检查将始终通过。
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

    /// 本进程创建的顶层窗口属于本应用；销毁之后句柄不再有所属进程，派发前的身份核对随之拒绝。
    /// 窗口不显示，也不接收任何输入。
    #[cfg(windows)]
    #[test]
    fn a_window_of_this_process_belongs_to_the_app_until_it_is_destroyed() {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_OVERLAPPED,
        };

        // SAFETY: 系统预定义的 STATIC 窗口类；窗口由本测试创建并销毁。
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("qywork-identity-test"),
                WS_OVERLAPPED,
                0,
                0,
                10,
                10,
                None,
                None,
                None,
                None,
            )
        }
        .expect("必须能创建测试窗口");
        let handle = hwnd.0 as i64;
        let pid = window_pid(handle).expect("本进程的窗口必须有所属进程");
        assert_eq!(pid, std::process::id());
        let app = process_identity(pid).expect("必须能读取本进程的身份").app;
        assert_eq!(is_self_process(pid, &app), Some(true));

        unsafe { DestroyWindow(hwnd) }.expect("必须能销毁测试窗口");
        assert_eq!(window_pid(handle), None);
    }

    /// 其他进程的窗口不属于本应用：桌面窗口属于系统进程。
    #[cfg(windows)]
    #[test]
    fn a_window_of_another_process_does_not_belong_to_the_app() {
        use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

        let handle = unsafe { GetDesktopWindow() }.0 as i64;
        let pid = window_pid(handle).expect("桌面窗口必须有所属进程");
        assert_ne!(pid, std::process::id());
        let app = process_identity(pid).map_or_else(String::new, |p| p.app);
        assert_eq!(is_self_process(pid, &app), Some(false));
    }

    fn entry(parent: u32, exe: &str, started_at_ms: i64) -> ProcessEntry {
        ProcessEntry {
            parent,
            exe: exe.to_owned(),
            started_at_ms,
        }
    }

    /// 本进程 1 启动 WebView 浏览器进程 2，2 启动渲染进程 3；本进程还启动了终端程序 4，
    /// 4 启动了另一个应用 5，5 又启动了它自己的 WebView 进程 6；7 是另一个应用 8 的 WebView 进程。
    fn tree(pid: u32) -> Option<ProcessEntry> {
        Some(match pid {
            1 => entry(0, "qywork.exe", 100),
            2 => entry(1, "msedgewebview2.exe", 110),
            3 => entry(2, "msedgewebview2.exe", 120),
            4 => entry(1, "powershell.exe", 130),
            5 => entry(4, "app.exe", 140),
            6 => entry(5, "msedgewebview2.exe", 150),
            7 => entry(8, "msedgewebview2.exe", 160),
            8 => entry(0, "teams.exe", 90),
            _ => return None,
        })
    }

    #[test]
    fn webview_processes_started_by_this_process_belong_to_the_app() {
        assert_eq!(spawned_webview(2, 1, tree), Some(true));
        assert_eq!(spawned_webview(3, 1, tree), Some(true));
    }

    /// 本应用终端中启动的程序及其 WebView 进程属于用户；其他应用的 WebView 进程同样不属于本应用。
    #[test]
    fn webview_processes_of_other_programs_do_not_belong_to_the_app() {
        assert_eq!(spawned_webview(6, 1, tree), Some(false));
        assert_eq!(spawned_webview(7, 1, tree), Some(false));
        assert_eq!(spawned_webview(5, 1, tree), Some(false));
    }

    /// 记录的父进程号已被本进程复用（本进程晚于该 WebView 进程启动）时不属于本应用。
    #[test]
    fn a_reused_parent_pid_does_not_make_a_webview_process_ours() {
        let reused = |pid: u32| match pid {
            1 => Some(entry(0, "qywork.exe", 500)),
            2 => Some(entry(1, "msedgewebview2.exe", 110)),
            _ => None,
        };
        assert_eq!(spawned_webview(2, 1, reused), Some(false));
    }

    /// 进程树中缺少某一级时无法判定，调用方按属于本应用处理。
    #[test]
    fn an_unreadable_chain_is_undetermined() {
        let broken = |pid: u32| match pid {
            2 => Some(entry(1, "msedgewebview2.exe", 110)),
            _ => None,
        };
        assert_eq!(spawned_webview(2, 1, broken), None);
        assert_eq!(spawned_webview(9, 1, tree), None);
    }
}
