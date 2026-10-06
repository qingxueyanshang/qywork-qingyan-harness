//! 已保存的 restore token：用户在授权框中勾选「记住」之后，下一次创建会话时不再弹出授权框。
//!
//! 三条边界：
//!
//! 1. **只保存一个，只使用一次。** portal 收到 token 即作废，用户同意之后在响应中返回新的 token；
//!    取出使用时即从磁盘删除，收到新的 token 后再写入。中途失败时磁盘上没有 token，下一次照常弹出授权框。
//! 2. **存放在应用数据目录中，与其余本机状态位置相同、保护方式相同。** 目录是 `QYWORK_HOME`，
//!    未设置时是家目录下的 `.qywork`，与外壳的日志目录规则相同；文件只允许本用户读写。它是本机
//!    本用户的授权，其他机器上没有对应的授权记录，复制过去不起作用。
//! 3. **会话被结束时作废。** 用户在系统中停止共享之后，下一次需要重新经用户同意；保留该 token
//!    会使下一次创建会话时不弹出授权框即恢复共享。

use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

const FILE: &str = "wayland-portal-token";

fn path() -> Option<PathBuf> {
    let root = std::env::var_os("QYWORK_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".qywork")))?;
    Some(root.join("desktop").join(FILE))
}

/// portal 只接受 UUID 格式的 token，其他格式会使整次请求失败。
fn plausible(token: &str) -> bool {
    token.len() == 36
        && token.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// 取出已保存的 token 并删除文件。文件不存在、无法读取或格式不符时返回 `None`。
pub fn take() -> Option<String> {
    let path = path()?;
    let text = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    text.map(|t| t.trim().to_owned()).filter(|t| plausible(t))
}

/// 保存新的 token。写入失败时只在 stderr 记录一行：缺少 token 时下一次多弹出一次授权框，不影响本次。
pub fn store(token: &str) {
    let Some(path) = path() else { return };
    let written = (|| -> std::io::Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| std::io::Error::other("没有上级目录"))?;
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let staged = path.with_extension("tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&staged)?;
        file.write_all(token.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&staged, &path)
    })();
    if let Err(e) = written {
        eprintln!("保存 Wayland 共享授权的 restore token 失败：{e}");
    }
}

/// 作废已保存的 token，见本模块第 3 条。
pub fn discard() {
    if let Some(path) = path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::plausible;

    #[test]
    fn only_a_uuid_shaped_token_is_sent_back() {
        assert!(plausible("7c0f3b1e-0000-4000-8000-000000000001"));
        for bad in [
            "",
            "7c0f3b1e",
            "7c0f3b1e-0000-4000-8000-00000000000g",
            "7c0f3b1e00000-4000-8000-000000000001",
        ] {
            assert!(!plausible(bad), "{bad}");
        }
    }
}
