//! 壳自己的日志文件：`<数据目录>/logs/qywork.log`，超过上限改名成 `.1` 后重开。
//!
//! 数据目录的解析也在这里：日志文件与 `last-workspace` 都挂在同一个根下，
//! 两处各算一遍的话，某次改 `QYWORK_HOME` 会让它们落在两个地方。
//!
//! sidecar 的日志由它自己写（`qy.log`），壳不替它写：两个进程不共写一个文件。

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "qywork.log";
const MAX_BYTES: u64 = 5 * 1024 * 1024;

static WRITE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// `QYWORK_HOME`，没有就是家目录下的 `.qywork`。两者都拿不到时返回 `None`，
/// 调用方按「没有可落盘的位置」处理，不报错。
pub fn data_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("QYWORK_HOME") {
        return Some(PathBuf::from(v));
    }
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|h| PathBuf::from(h).join(".qywork"))
}

/// 追加一行。写失败静默：日志本身不能成为壳报错的原因，而 stderr 那份已经写过了。
pub fn append(line: &str) {
    let Some(dir) = data_dir().map(|d| d.join("logs")) else {
        return;
    };
    let path = dir.join(FILE);
    let _guard = WRITE_LOCK.lock();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() + line.len() as u64 > MAX_BYTES {
            // 只留上一份，与 sidecar 的轮转口径一致。
            let _ = std::fs::rename(&path, dir.join(format!("{FILE}.1")));
        }
    }
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

/// 当前 UTC 时间，`2026-09-12T01:02:03.004Z`，与 sidecar 的行格式一致。
/// 不引时间库：只需要把 1970-01-01 起的秒数换算成公历日期。
pub fn utc_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3_600,
        (sod % 3_600) / 60,
        sod % 60
    )
}

#[cfg(test)]
mod tests {
    use super::utc_now;

    #[test]
    fn utc_now_has_iso_shape() {
        let s = utc_now();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}
