//! 下载暂存目录里的文件搬到它该去的地方。
//!
//! CDP 只能按浏览器上下文设一个下载目录，逐次下载的落点由宿主在完成后搬出：
//! 暂存目录里的文件名就是下载的 guid，路径因此由宿主确定，不依赖浏览器报的文件路径。

use std::io;
use std::path::{Path, PathBuf};

/// profile 目录下的暂存目录名。浏览器每次拉起前清空，残留只可能来自上一个进程。
pub const DIR: &str = "qywork-downloads";

/// `rename` 跨文件系统时的 errno，Linux 与 macOS 相同。
const EXDEV: i32 = 18;

/// 把暂存文件搬到 `to`。目标已存在时拒绝，不覆盖；上级目录缺席时建出。
///
/// 跨文件系统时改为复制后删除：`rename` 只在同一文件系统内成立，授权路径可以落在任何挂载点上。
pub fn move_to(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "目标文件已存在"));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Err(e) if e.raw_os_error() == Some(EXDEV) => {
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)
        }
        other => other,
    }
}

/// 用户下载目录里一个不与现有文件重名的路径：`a.bin` 已在时依次取 `a (1).bin`、`a (2).bin`。
///
/// 名字取站点建议名的最后一段：建议名来自网页，不能让它带着路径分隔符跳出下载目录。
pub fn free_name(dir: &Path, suggested: &str, fallback: &str) -> PathBuf {
    let name = Path::new(suggested)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback);
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|e| e.to_str());
    (1..)
        .map(|n| match ext {
            Some(ext) => dir.join(format!("{stem} ({n}).{ext}")),
            None => dir.join(format!("{stem} ({n})")),
        })
        .find(|candidate| !candidate.exists())
        .expect("编号无上限，总能找到空位")
}

/// 用户的下载目录，与浏览器默认下载目录同一个判据：Linux 取 XDG 用户目录里的
/// `XDG_DOWNLOAD_DIR`，缺席时是 `~/Downloads`；macOS 是 `~/Downloads`。
pub fn user_downloads() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    #[cfg(target_os = "linux")]
    {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        if let Ok(text) = std::fs::read_to_string(config.join("user-dirs.dirs")) {
            if let Some(dir) = xdg_download_dir(&text, &home) {
                return Some(dir);
            }
        }
    }
    Some(home.join("Downloads"))
}

/// 从 `user-dirs.dirs` 的正文里取下载目录。格式是 shell 赋值：`XDG_DOWNLOAD_DIR="$HOME/下载"`。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn xdg_download_dir(text: &str, home: &Path) -> Option<PathBuf> {
    let value = text
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("XDG_DOWNLOAD_DIR="))?
        .trim_matches('"');
    let path = match value.strip_prefix("$HOME") {
        Some(rest) => home.join(rest.trim_start_matches('/')),
        None => PathBuf::from(value),
    };
    path.is_absolute().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::{free_name, move_to, xdg_download_dir};
    use std::path::{Path, PathBuf};

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp/cargo-tests")
            .join(format!("staging-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_staged_file_moves_into_a_missing_directory_but_never_over_a_file() {
        let dir = scratch("move");
        let staged = dir.join("guid-1");
        std::fs::write(&staged, b"new").unwrap();
        let target = dir.join("out/nested/a.bin");
        move_to(&staged, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert!(!staged.exists());

        std::fs::write(&staged, b"again").unwrap();
        assert!(move_to(&staged, &target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"new", "已有文件不被覆盖");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn free_names_count_up_and_stay_inside_the_directory() {
        let dir = scratch("names");
        assert_eq!(free_name(&dir, "a.bin", "g"), dir.join("a.bin"));
        std::fs::write(dir.join("a.bin"), b"").unwrap();
        assert_eq!(free_name(&dir, "a.bin", "g"), dir.join("a (1).bin"));
        std::fs::write(dir.join("a (1).bin"), b"").unwrap();
        assert_eq!(free_name(&dir, "a.bin", "g"), dir.join("a (2).bin"));
        assert_eq!(free_name(&dir, "../../etc/passwd", "g"), dir.join("passwd"));
        assert_eq!(free_name(&dir, "", "guid-7"), dir.join("guid-7"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_xdg_download_directory_expands_home() {
        let home = Path::new("/home/u");
        let text = "# comment\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOWNLOAD_DIR=\"$HOME/下载\"\n";
        assert_eq!(xdg_download_dir(text, home), Some(PathBuf::from("/home/u/下载")));
        assert_eq!(
            xdg_download_dir("XDG_DOWNLOAD_DIR=\"/data/dl\"", home),
            Some(PathBuf::from("/data/dl"))
        );
        assert_eq!(xdg_download_dir("XDG_DESKTOP_DIR=\"$HOME/Desktop\"", home), None);
    }
}
