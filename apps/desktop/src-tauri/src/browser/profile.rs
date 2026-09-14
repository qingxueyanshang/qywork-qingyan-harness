//! 浏览器配置目录与它的本机占用锁。
//!
//! 同一份 WebView2 用户数据目录一次只能由一个 qywork 进程打开。这把锁必须由
//! qywork 自己持有：同 UDF 加同 options 的第二个 environment 会合流进同一个
//! WebView2 会话（跨宿主进程亦然），引擎本身不会拒绝。
//!
//! 被占用时报错退出这条能力，**不换目录**——换目录等于把用户的登录状态丢在
//! 另一份 profile 里，而界面上看不出发生过这件事。

use std::path::{Path, PathBuf};

/// 配置根。`QYWORK_HOME` 的解析只有 `logfile::data_dir()` 一处，不另算一遍。
pub fn profile_dir() -> Option<PathBuf> {
    Some(crate::logfile::data_dir()?.join("browser").join("profiles").join("default"))
}

/// 互斥体名里不能出现路径分隔符，所以按规范化路径取一个稳定摘要。
/// FNV-1a：这里只需要「同一个目录得到同一个名字」，不需要抗碰撞。
fn digest(path: &Path) -> String {
    let text = path.to_string_lossy().to_lowercase().replace('/', "\\");
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub struct ProfileLock {
    /// 互斥体句柄的原始值。`HANDLE` 自身不是 `Send`，而这把锁要跟着宿主跨线程存活；
    /// 句柄本身与线程无关，关它只需要原始值。
    handle: isize,
    dir: PathBuf,
}

impl ProfileLock {
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

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

/// 占用一份 profile 目录。已被另一个进程占用时返回用户可读的原因。
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

#[cfg(test)]
mod tests {
    use super::{digest, lock, profile_dir};
    use std::path::PathBuf;

    #[test]
    fn digest_is_stable_across_separator_and_case() {
        let a = digest(&PathBuf::from("C:\\Users\\X\\.qywork\\browser\\profiles\\default"));
        let b = digest(&PathBuf::from("c:/users/x/.qywork/browser/profiles/default"));
        assert_eq!(a, b);
        assert_ne!(a, digest(&PathBuf::from("C:\\Users\\Y\\.qywork\\browser\\profiles\\default")));
    }

    #[test]
    fn profile_dir_sits_under_the_configured_home() {
        std::env::set_var("QYWORK_HOME", "C:\\tmp\\qywork-home");
        let dir = profile_dir().expect("设了 QYWORK_HOME 就必须有结果");
        std::env::remove_var("QYWORK_HOME");
        assert!(dir.ends_with("browser\\profiles\\default"), "{}", dir.display());
    }

    /// 第二次占用必须被拒绝，而不是静默换一个目录。
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
    }
}
