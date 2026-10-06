//! 外壳启动的子进程退出后的重启退避。电脑控制 worker 与 macOS / Linux 的浏览器进程共用本实现。
//!
//! 启动后立即退出的进程不能被无限重启：连续短时退出达到上限即停止重启，对应能力发布为不可用；
//! 运行超过 `HEALTHY_RUN_MS` 才视为本次启动成功，计数归零。

use std::time::Duration;

/// 重启退避的起点与上界。
const RESTART_BASE_MS: u64 = 500;
const RESTART_MAX_MS: u64 = 15_000;
/// 连续失败达到该次数后不再重启。
const RESTART_MAX_ATTEMPTS: u32 = 5;
/// 运行超过该时长即视为本次启动成功，下一次失败从头开始退避。
const HEALTHY_RUN_MS: u128 = 60_000;

/// 第 `attempt` 次重启前的等待时长。`None` 表示已达上限，不再重启。
pub fn restart_delay(attempt: u32) -> Option<Duration> {
    if attempt >= RESTART_MAX_ATTEMPTS {
        return None;
    }
    let ms = RESTART_BASE_MS
        .checked_shl(attempt)
        .unwrap_or(RESTART_MAX_MS)
        .min(RESTART_MAX_MS);
    Some(Duration::from_millis(ms))
}

/// 进程运行 `ran_for` 后退出时，返回下一次重启的序号。
pub fn next_attempt(attempt: u32, ran_for: Duration) -> u32 {
    if ran_for.as_millis() >= HEALTHY_RUN_MS {
        0
    } else {
        attempt + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_backs_off_and_then_gives_up() {
        assert_eq!(restart_delay(0), Some(Duration::from_millis(500)));
        assert_eq!(restart_delay(1), Some(Duration::from_millis(1_000)));
        assert_eq!(restart_delay(2), Some(Duration::from_millis(2_000)));
        assert_eq!(restart_delay(3), Some(Duration::from_millis(4_000)));
        assert_eq!(restart_delay(4), Some(Duration::from_millis(8_000)));
        assert_eq!(restart_delay(RESTART_MAX_ATTEMPTS), None);
        assert_eq!(restart_delay(99), None);
    }

    /// 启动即崩溃的进程退避到上限即停止；运行超过一分钟的一次启动使计数归零，
    /// 否则每天崩溃一次的进程也会在第五次之后永久停止重启。
    #[test]
    fn a_healthy_run_resets_the_backoff() {
        assert_eq!(next_attempt(0, Duration::from_millis(80)), 1);
        assert_eq!(next_attempt(4, Duration::from_millis(80)), 5);
        assert_eq!(next_attempt(4, Duration::from_secs(60)), 0);
        assert_eq!(next_attempt(4, Duration::from_secs(3_600)), 0);
    }
}
