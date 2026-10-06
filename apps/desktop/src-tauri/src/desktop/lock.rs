//! 桌面执行权的本机互斥：一台机器的一个登录会话中只有一个 qywork 进程能操作桌面。
//!
//! 物理桌面只有一个，两个 qywork 进程各自认为独占桌面时会互相打断动作序列。无法取得该锁
//! 的进程如实上报电脑控制不可用，不更换作用域继续操作：更换作用域等于两个进程同时
//! 操作同一个桌面，而界面上无法察觉。
//!
//! 锁随进程退出由 OS 释放，不写入磁盘、不留下标记：保留文件状态就必须处理崩溃后的残留，
//! 而残留会使下一次启动永久无法取得锁。

/// 生产环境的作用域名。同一个登录会话中的所有 qywork 进程争用该作用域。
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
        // SAFETY: 句柄由本结构独占，仅在 `acquire_scoped` 成功时构造，且只在此处关闭一次。
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

    // 使用会话命名空间：同一台机器上的其他登录用户有各自的交互桌面，不应被该锁拦截。
    let name = HSTRING::from(format!("Local\\{scope}"));
    // SAFETY: 名称是本函数构造的合法宽字符串；失败路径上关闭已创建的句柄。
    let handle = unsafe { CreateMutexW(None, true, &name) }
        .map_err(|e| format!("无法创建桌面执行权互斥体：{e}"))?;
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

/// Unix 使用 `flock` 的非阻塞独占锁：锁与打开的文件描述符绑定，进程退出时由内核释放，
/// 不会像锁文件那样在崩溃后留下阻止下一次启动的残留。
#[cfg(unix)]
fn acquire_scoped(scope: &str) -> Result<DesktopLock, String> {
    use std::os::fd::AsRawFd;

    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }

    let dir = crate::logfile::data_dir().ok_or("无法取得配置根目录")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置根目录：{e}"))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(dir.join(format!("{scope}.lock")))
        .map_err(|e| format!("无法打开桌面执行权锁文件：{e}"))?;
    // SAFETY: fd 来自上方仍然有效的 File，操作码是 flock 定义的常量。
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
    /// 作用域名包含 pid：使用生产环境的作用域名时，本机正在运行的 qywork 会使该用例失败。
    #[test]
    fn a_second_acquire_in_the_same_session_is_refused() {
        let scope = format!("qywork-desktop-test-{}", std::process::id());
        let first = acquire_scoped(&scope).expect("第一次占用应当成功");
        assert!(acquire_scoped(&scope).is_err());
        drop(first);
        let again = acquire_scoped(&scope).expect("释放后应当可以再次占用");
        drop(again);
    }
}
