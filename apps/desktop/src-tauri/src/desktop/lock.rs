//! 桌面执行权的本机互斥：一台机器的一个登录会话里只有一个 qywork 进程能操作桌面。
//!
//! 物理桌面只有一个，两个 qywork 进程各自认为独占它就会互相打断动作序列。拿不到这把锁
//! 的进程如实发布电脑控制不可用，**不换一个作用域继续操作**——换作用域等于两个进程都在
//! 动同一个桌面，而界面上看不出发生过这件事。
//!
//! 锁随进程退出由 OS 释放，不落盘、不留标记：留一份文件状态就要处理崩溃后的残留，
//! 而残留会把下一次启动永久挡在门外。

/// 生产环境的作用域名。同一个登录会话里的所有 qywork 进程争这一个。
const SCOPE: &str = "qywork-desktop";

/// 持有中的桌面执行权。丢弃它即释放。
pub struct DesktopLock {
    #[cfg(windows)]
    handle: isize,
    #[cfg(unix)]
    _file: std::fs::File,
}

#[cfg(windows)]
impl Drop for DesktopLock {
    fn drop(&mut self) {
        // SAFETY: 句柄由本结构独占，`acquire_scoped` 成功时才构造，且只在这里关一次。
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.handle as *mut core::ffi::c_void,
            ));
        }
    }
}

/// 占用桌面执行权。已被本会话的另一个 qywork 进程占用时返回原因。
pub fn acquire() -> Result<DesktopLock, String> {
    acquire_scoped(SCOPE)
}

#[cfg(windows)]
fn acquire_scoped(scope: &str) -> Result<DesktopLock, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    // 会话命名空间：同一台机器上的另一个登录用户有自己的交互桌面，不该被这把锁拦住。
    let name = HSTRING::from(format!("Local\\{scope}"));
    // SAFETY: 名字是本函数构造的合法宽字符串；失败路径上关掉已建出的句柄。
    let handle = unsafe { CreateMutexW(None, true, &name) }
        .map_err(|e| format!("建不出桌面执行权互斥体：{e}"))?;
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err("本机已有另一个 qywork 进程持有桌面执行权".to_owned());
    }
    Ok(DesktopLock {
        handle: handle.0 as isize,
    })
}

/// Unix 用 `flock` 的非阻塞独占锁：它跟着打开的文件描述符走，进程退出由内核释放，
/// 不像锁文件那样会在崩溃后留下挡住下一次启动的残留。
#[cfg(unix)]
fn acquire_scoped(scope: &str) -> Result<DesktopLock, String> {
    use std::os::fd::AsRawFd;

    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }

    let dir = crate::logfile::data_dir().ok_or("取不到配置根目录")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不出配置根目录：{e}"))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(dir.join(format!("{scope}.lock")))
        .map_err(|e| format!("打不开桌面执行权锁文件：{e}"))?;
    // SAFETY: fd 来自上面这个仍然存活的 File，操作码是 flock 定义的常量。
    if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } != 0 {
        return Err("本机已有另一个 qywork 进程持有桌面执行权".to_owned());
    }
    Ok(DesktopLock { _file: file })
}

#[cfg(all(test, windows))]
mod tests {
    use super::acquire_scoped;

    /// 第二次占用必须被拒绝，而不是静默让两个进程都认为自己独占桌面。
    ///
    /// 作用域名带 pid：用生产那一个的话，本机正开着 qywork 时这条用例就会失败。
    #[test]
    fn a_second_acquire_in_the_same_session_is_refused() {
        let scope = format!("qywork-desktop-test-{}", std::process::id());
        let first = acquire_scoped(&scope).expect("第一次占用应当成功");
        assert!(acquire_scoped(&scope).is_err());
        drop(first);
        let again = acquire_scoped(&scope).expect("释放后应当可以再占用");
        drop(again);
    }
}
