//! 外壳拉起的子进程退出后的重启退避。电脑控制 worker 与 macOS / Linux 的浏览器进程共用这一份。
//!
//! 一启动就退出的进程不能被无限拉起：连续短命退出到上限即停止重启，对应能力发布为不可用；
//! 活过 `HEALTHY_RUN_MS` 才算这一次启动成功，计数归零。

use std::time::Duration;

/// 重启退避的起点与上界。
const RESTART_BASE_MS: u64 = 500;
const RESTART_MAX_MS: u64 = 15_000;
/// 连续失败多少次之后不再重启。
const RESTART_MAX_ATTEMPTS: u32 = 5;
/// 活过这个时长即认为这次启动是成功的，下一次失败从头退避。
const HEALTHY_RUN_MS: u128 = 60_000;

/// 第 `attempt` 次重启等多久。`None` = 到达上限，不再重启。
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

/// 这一次进程活了 `ran_for` 之后退出，下一次重启算第几次。
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

    /// 一启动就崩的进程退避到上限即停；活过一分钟的那一次让计数归零，
    /// 否则跑了一整天才崩一次的进程也会在第五次之后永远不再起来。
    #[test]
    fn a_healthy_run_resets_the_backoff() {
        assert_eq!(next_attempt(0, Duration::from_millis(80)), 1);
        assert_eq!(next_attempt(4, Duration::from_millis(80)), 5);
        assert_eq!(next_attempt(4, Duration::from_secs(60)), 0);
        assert_eq!(next_attempt(4, Duration::from_secs(3_600)), 0);
    }
}
