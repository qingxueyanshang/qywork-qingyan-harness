//! 宿主凭据：本次启动有效的 32 字节随机数，以十六进制字符串交给 sidecar。
//!
//! 同一份凭据用于浏览器与电脑控制两条宿主路径，具体路径由 URL 路径判定。
//!
//! 边界：无法取得系统随机源时返回空串。调用方必须据此不发布任何依赖它的能力。
//! 不要改用时间戳或进程号：凭据是该回环连接唯一的身份判据。

/// 凭据所在的请求头。与 `packages/core/src/protocol/native-host.ts` 的常量逐字一致。
pub const KEY_HEADER: &str = "x-qywork-host-key";

/// 生成一份随机凭据。同一次进程内可多次调用，每次都是新值。
pub fn new_host_key() -> String {
    match fill_random() {
        Some(raw) => raw.iter().map(|b| format!("{b:02x}")).collect(),
        None => String::new(),
    }
}

#[cfg(windows)]
fn fill_random() -> Option<[u8; 32]> {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

    let mut raw = [0u8; 32];
    // SAFETY: 缓冲区长度与传入的字节数一致；系统首选 RNG 无需算法句柄。
    let status = unsafe { BCryptGenRandom(None, &mut raw, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status.is_err() {
        log::error!("获取系统随机数失败，不启用宿主连接：{status:?}");
        return None;
    }
    Some(raw)
}

/// macOS 与 Linux 均从 `/dev/urandom` 读取：它是两个平台的系统 CSPRNG 接口，
/// 无需为 32 字节另行引入随机数 crate。
#[cfg(not(windows))]
fn fill_random() -> Option<[u8; 32]> {
    use std::io::Read;

    let mut raw = [0u8; 32];
    match std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut raw)) {
        Ok(()) => Some(raw),
        Err(e) => {
            log::error!("获取系统随机数失败，不启用宿主连接：{e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::new_host_key;

    #[test]
    fn host_key_is_long_hex_and_differs_per_call() {
        let a = new_host_key();
        let b = new_host_key();
        assert_eq!(a.len(), 64, "{a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
