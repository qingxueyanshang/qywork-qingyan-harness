//! 存下的 restore token：用户在授权框里勾了「记住」之后，下一次建会话不再弹框。
//!
//! 三条边界：
//!
//! 1. **只存一个，只用一次。** portal 收到 token 即作废，同意之后在回答里交回新的；取出来用的
//!    那一刻就从磁盘上删掉，新的到了再写。中途失败时磁盘上没有 token，下一次照常弹框。
//! 2. **放在应用数据目录里，与其余本机状态同一处、同一种保护。** 目录是 `QYWORK_HOME`，没有时是
//!    家目录下的 `.qywork`，与外壳的日志目录同一条规则；文件只给本用户读写。它是这台机器上
//!    本用户的授权，换一台机器没有对应的授权记录，拷过去不起作用。
//! 3. **会话被结束时作废。** 用户在系统里停止共享之后，下一次要重新经用户同意；留着它的话，
//!    下一次建会话不弹框就恢复了共享。

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

/// portal 只收 UUID 形状的 token，别的形状会让整次请求失败。
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

/// 取出存下的 token 并删掉文件。没有、读不出或形状不对时交回 `None`。
pub fn take() -> Option<String> {
    let path = path()?;
    let text = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    text.map(|t| t.trim().to_owned()).filter(|t| plausible(t))
}

/// 存下新的 token。写不进去只记一行 stderr：少了它下一次多弹一次授权框，不影响这一次。
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
        eprintln!("存 Wayland 共享授权的 restore token 失败：{e}");
    }
}

/// 作废存下的 token，见本模块第 3 条。
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
