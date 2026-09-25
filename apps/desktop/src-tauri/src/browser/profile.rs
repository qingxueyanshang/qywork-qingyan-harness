//! 浏览器配置目录与它的本机占用锁。
//!
//! 同一份用户数据目录一次只能由一个 qywork 进程打开。这把锁必须由 qywork 自己持有：
//! 同 UDF 加同 options 的第二个 WebView2 environment 会合流进同一个会话（跨宿主进程亦然），
//! 同一份 `--user-data-dir` 的第二个 Chromium 进程会把请求转交给第一个后退出，
//! 两种引擎本身都不会拒绝。
//!
//! 被占用时报错退出这条能力，**不换目录**——换目录等于把用户的登录状态丢在
//! 另一份 profile 里，而界面上看不出发生过这件事。

use std::path::{Path, PathBuf};

/// 配置根。`QYWORK_HOME` 的解析只有 `logfile::data_dir()` 一处，不另算一遍。
pub fn profile_dir() -> Option<PathBuf> {
    Some(crate::logfile::data_dir()?.join("browser").join("profiles").join("default"))
}

pub struct ProfileLock {
    /// 互斥体句柄的原始值。`HANDLE` 自身不是 `Send`，而这把锁要跟着宿主跨线程存活；
    /// 句柄本身与线程无关，关它只需要原始值。
    #[cfg(windows)]
    handle: isize,
    /// 持有 `flock` 的文件。锁跟着描述符走，进程退出由内核释放。
    #[cfg(unix)]
    _file: std::fs::File,
    dir: PathBuf,
}

impl ProfileLock {
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

#[cfg(windows)]
impl Drop for ProfileLock {
    fn drop(&mut self) {
        // SAFETY: 句柄由本结构独占，`lock` 成功时才构造，且只在这里关一次。
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(
                windows::Win32::Foundation::HANDLE(self.handle as *mut core::ffi::c_void),
            );
        }
    }
}

/// 互斥体名里不能出现路径分隔符，所以按规范化路径取一个稳定摘要。
/// FNV-1a：这里只需要「同一个目录得到同一个名字」，不需要抗碰撞。
#[cfg(windows)]
fn digest(path: &Path) -> String {
    let text = path.to_string_lossy().to_lowercase().replace('/', "\\");
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 占用一份 profile 目录。已被另一个进程占用时返回用户可读的原因。
#[cfg(windows)]
pub fn lock(dir: &Path) -> Result<ProfileLock, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    std::fs::create_dir_all(dir).map_err(|e| format!("建不出浏览器配置目录：{e}"))?;
    // 会话命名空间：同一台机器上的另一个登录用户有自己的 profile 目录，不该被这把锁拦住。
    let name = HSTRING::from(format!("Local\\qywork-browser-{}", digest(dir)));
    let handle = unsafe { CreateMutexW(None, true, &name) }
        .map_err(|e| format!("建不出浏览器配置占用锁：{e}"))?;
    let taken = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if taken {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err("该浏览器配置不可打开".to_owned());
    }
    Ok(ProfileLock { handle: handle.0 as isize, dir: dir.to_path_buf() })
}

/// 同一把锁在 unix 上用 `flock` 的非阻塞独占锁。锁文件放在目录旁边，不混进浏览器的用户数据。
#[cfg(unix)]
pub fn lock(dir: &Path) -> Result<ProfileLock, String> {
    use std::os::fd::AsRawFd;

    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }

    std::fs::create_dir_all(dir).map_err(|e| format!("建不出浏览器配置目录：{e}"))?;
    let mut name = dir.as_os_str().to_owned();
    name.push(".lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(PathBuf::from(name))
        .map_err(|e| format!("打不开浏览器配置占用锁：{e}"))?;
    // SAFETY: fd 来自上面这个仍然存活的 File，操作码是 flock 定义的常量。
    if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } != 0 {
        return Err("该浏览器配置不可打开".to_owned());
    }
    Ok(ProfileLock { _file: file, dir: dir.to_path_buf() })
}

#[cfg(test)]
mod tests {
    use super::{lock, profile_dir};
    use std::path::PathBuf;

    #[cfg(windows)]
    #[test]
    fn digest_is_stable_across_separator_and_case() {
        use super::digest;
        let a = digest(&PathBuf::from("C:\\Users\\X\\.qywork\\browser\\profiles\\default"));
        let b = digest(&PathBuf::from("c:/users/x/.qywork/browser/profiles/default"));
        assert_eq!(a, b);
        assert_ne!(a, digest(&PathBuf::from("C:\\Users\\Y\\.qywork\\browser\\profiles\\default")));
    }

    #[test]
    fn profile_dir_sits_under_the_configured_home() {
        std::env::set_var("QYWORK_HOME", "qywork-home");
        let dir = profile_dir().expect("设了 QYWORK_HOME 就必须有结果");
        std::env::remove_var("QYWORK_HOME");
        assert_eq!(dir, PathBuf::from("qywork-home").join("browser").join("profiles").join("default"));
    }

    /// 第二次占用必须被拒绝，而不是静默换一个目录。
    ///
    /// `flock` 在同一进程内对两个独立打开的描述符同样互斥，所以单进程测得出来。
    #[test]
    fn second_lock_on_the_same_directory_is_refused() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp/cargo-tests")
            .join(format!("profile-lock-{}", std::process::id()));
        let first = lock(&dir).expect("第一次占用应当成功");
        let second = lock(&dir);
        assert_eq!(second.err().as_deref(), Some("该浏览器配置不可打开"));
        drop(first);
        // 释放之后同一目录可以再次占用。
        let third = lock(&dir).expect("释放后应当可以再占用");
        drop(third);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(dir.with_extension("lock"));
    }
}
