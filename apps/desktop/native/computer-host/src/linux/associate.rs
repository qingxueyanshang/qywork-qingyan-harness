//! AT-SPI frame 与 X11 顶层窗口的对应关系。AT-SPI 不提供窗口号，只能按标题与矩形识别。
//!
//! 三条规则：
//!
//! 1. **标题必须相同，两侧都能读取矩形时矩形必须一致。** 矩形一致指 frame 的屏幕矩形等于
//!    X 窗口的客户区或外框：Qt 上报客户区，GTK 3 上报含窗口管理器边框的外框。
//! 2. **进程号只作为优先条件。** 候选中有进程号一致的窗口时只保留这些窗口，没有时不按进程号排除：
//!    flatpak 应用的 `_NET_WM_PID` 是沙箱内的进程号，与总线上看到的不同。
//! 3. **两个方向都唯一才视为对应。** 一个 X 窗口只匹配一个 frame，且该 frame 也只匹配这一个
//!    X 窗口；否则该 X 窗口不提供控件树，相关 frame 以自身编号单独列出，只提供控件树，
//!    不提供图像与坐标动作。
//!
//! 本模块不调用任何接口，事实由调用方读取后传入。

use crate::geometry::ScreenRect;

/// X11 顶层窗口中参与对应判定的事实。
#[derive(Debug, Clone, Copy)]
pub struct XSide<'a> {
    pub title: &'a str,
    /// 0 表示没有 `_NET_WM_PID`。
    pub pid: u32,
    pub client: Option<ScreenRect>,
    pub outer: Option<ScreenRect>,
}

/// AT-SPI frame 中参与对应判定的事实。
#[derive(Debug, Clone, Copy)]
pub struct FrameSide<'a> {
    pub title: &'a str,
    /// 总线连接的进程号。0 表示无法读取。
    pub pid: u32,
    pub rect: Option<ScreenRect>,
}

/// X 窗口未能对应 frame 的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unmatched {
    /// 没有同名、同位置的 frame。
    None,
    /// 同名、同位置的 frame 或 X 窗口不止一个，值为该侧的候选数。
    Ambiguous(usize),
}

fn compatible(x: &XSide<'_>, f: &FrameSide<'_>) -> bool {
    if x.title.is_empty() || x.title != f.title {
        return false;
    }
    match f.rect {
        Some(rect) if x.client.is_some() || x.outer.is_some() => {
            x.client == Some(rect) || x.outer == Some(rect)
        }
        _ => true,
    }
}

/// 进程号一致的候选非空时只保留这些候选。
fn prefer_pid(candidates: Vec<usize>, pid: u32, pid_of: impl Fn(usize) -> u32) -> Vec<usize> {
    if pid == 0 {
        return candidates;
    }
    let same: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|i| pid_of(*i) == pid)
        .collect();
    if same.is_empty() {
        candidates
    } else {
        same
    }
}

/// 为 `windows[target]` 查找唯一对应的 frame，返回其在 `frames` 中的下标。
pub fn resolve(
    target: usize,
    windows: &[XSide<'_>],
    frames: &[FrameSide<'_>],
) -> Result<usize, Unmatched> {
    let x = &windows[target];
    let candidates: Vec<usize> = (0..frames.len())
        .filter(|i| compatible(x, &frames[*i]))
        .collect();
    let candidates = prefer_pid(candidates, x.pid, |i| frames[i].pid);
    let frame = match candidates.as_slice() {
        [] => return Err(Unmatched::None),
        [only] => *only,
        many => return Err(Unmatched::Ambiguous(many.len())),
    };
    let f = &frames[frame];
    let rivals: Vec<usize> = (0..windows.len())
        .filter(|i| compatible(&windows[*i], f))
        .collect();
    let rivals = prefer_pid(rivals, f.pid, |i| windows[i].pid);
    match rivals.as_slice() {
        [only] if *only == target => Ok(frame),
        // 按进程号，该 frame 归属于其他 X 窗口。
        many if !many.contains(&target) => Err(Unmatched::None),
        many => Err(Unmatched::Ambiguous(many.len())),
    }
}

/// 未对应任何 X 窗口的 frame 的下标。窗口清单将其单独列出。
pub fn unclaimed(windows: &[XSide<'_>], frames: &[FrameSide<'_>]) -> Vec<usize> {
    let claimed: Vec<usize> = (0..windows.len())
        .filter_map(|w| resolve(w, windows, frames).ok())
        .collect();
    (0..frames.len()).filter(|f| !claimed.contains(f)).collect()
}

/// 未对应 X 窗口的 frame 在窗口清单中的编号：由对象字符串计算出的负数。
///
/// 负数不会与 X11 窗口号冲突；绝对值在 2^52 以内，经 JSON 交给 JavaScript 仍是精确整数。
/// 同一 frame 每次计算出相同编号，应用重启后编号改变。
pub fn frame_window(key: &str) -> i64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    -1 - i64::try_from(hash & 0x000f_ffff_ffff_ffff).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLIENT: ScreenRect = ScreenRect {
        x: 101,
        y: 100,
        width: 520,
        height: 760,
    };
    const OUTER: ScreenRect = ScreenRect {
        x: 100,
        y: 80,
        width: 522,
        height: 785,
    };

    fn x(title: &str, pid: u32) -> XSide<'_> {
        XSide {
            title,
            pid,
            client: Some(CLIENT),
            outer: Some(OUTER),
        }
    }

    fn f(title: &str, pid: u32, rect: Option<ScreenRect>) -> FrameSide<'_> {
        FrameSide { title, pid, rect }
    }

    /// GTK 3 上报外框，Qt 上报客户区，两者都能匹配。
    #[test]
    fn a_frame_matches_by_title_and_either_the_client_or_the_outer_rect() {
        let windows = [x("form", 10)];
        assert_eq!(resolve(0, &windows, &[f("form", 10, Some(OUTER))]), Ok(0));
        assert_eq!(resolve(0, &windows, &[f("form", 10, Some(CLIENT))]), Ok(0));
        let moved = ScreenRect { x: 500, ..CLIENT };
        assert_eq!(
            resolve(0, &windows, &[f("form", 10, Some(moved))]),
            Err(Unmatched::None)
        );
        assert_eq!(
            resolve(0, &windows, &[f("other", 10, Some(OUTER))]),
            Err(Unmatched::None)
        );
    }

    /// 无法读取 frame 的矩形时只比较标题。
    #[test]
    fn a_frame_without_extents_matches_by_title_alone() {
        assert_eq!(resolve(0, &[x("form", 10)], &[f("form", 10, None)]), Ok(0));
    }

    /// flatpak 情形：X 侧为沙箱内的进程号，总线侧为宿主进程号。进程号不一致时不排除候选。
    #[test]
    fn a_sandbox_pid_does_not_prevent_the_match() {
        assert_eq!(
            resolve(0, &[x("form", 2)], &[f("form", 4711, Some(OUTER))]),
            Ok(0)
        );
    }

    /// 同名同位置的两个 frame，能按进程号区分时按进程号区分。
    #[test]
    fn the_pid_breaks_a_tie_between_identical_frames() {
        let frames = [f("form", 10, Some(OUTER)), f("form", 11, Some(OUTER))];
        let windows = [x("form", 11)];
        assert_eq!(resolve(0, &windows, &frames), Ok(1));
    }

    /// 同一进程的两个同名同位置窗口：无法判定 X 窗口与 frame 的对应关系，两侧均不对应，
    /// 两个 frame 都单独列出。
    #[test]
    fn two_identical_windows_of_one_process_stay_unassociated() {
        let windows = [x("Untitled", 10), x("Untitled", 10)];
        let frames = [
            f("Untitled", 10, Some(OUTER)),
            f("Untitled", 10, Some(OUTER)),
        ];
        assert_eq!(resolve(0, &windows, &frames), Err(Unmatched::Ambiguous(2)));
        assert_eq!(resolve(1, &windows, &frames), Err(Unmatched::Ambiguous(2)));
        assert_eq!(unclaimed(&windows, &frames), vec![0, 1]);
    }

    /// 一个 frame 匹配两个 X 窗口时同样不视为对应，即使从 X 窗口一侧看只有一个候选。
    #[test]
    fn a_frame_claimed_by_two_windows_is_ambiguous() {
        let windows = [x("form", 0), x("form", 0)];
        let frames = [f("form", 10, None)];
        assert_eq!(resolve(0, &windows, &frames), Err(Unmatched::Ambiguous(2)));
        assert_eq!(unclaimed(&windows, &frames), vec![0]);
    }

    /// 进程号一致的 X 窗口认领该 frame，另一个同名同位置的窗口不对应。
    #[test]
    fn the_pid_decides_which_window_owns_the_frame() {
        let windows = [x("form", 0), x("form", 10)];
        let frames = [f("form", 10, Some(OUTER))];
        assert_eq!(resolve(0, &windows, &frames), Err(Unmatched::None));
        assert_eq!(resolve(1, &windows, &frames), Ok(0));
        assert!(unclaimed(&windows, &frames).is_empty());
    }

    #[test]
    fn frames_that_match_nothing_are_listed_and_matched_ones_are_not() {
        let windows = [x("form", 10)];
        let frames = [f("form", 10, Some(OUTER)), f("wayland only", 12, None)];
        assert_eq!(unclaimed(&windows, &frames), vec![1]);
    }

    /// 标题为空的 X 窗口不参与对应：空标题的 frame 大多是弹出菜单。
    #[test]
    fn an_untitled_window_matches_nothing() {
        assert_eq!(
            resolve(0, &[x("", 10)], &[f("", 10, Some(OUTER))]),
            Err(Unmatched::None)
        );
    }

    #[test]
    fn a_frame_window_number_is_negative_stable_and_safe_for_javascript() {
        let a = frame_window(":1.2/org/a11y/atspi/accessible/7");
        assert_eq!(a, frame_window(":1.2/org/a11y/atspi/accessible/7"));
        assert_ne!(a, frame_window(":1.3/org/a11y/atspi/accessible/7"));
        for key in ["", ":1.2/x", ":1.99/org/a11y/atspi/accessible/2147483653"] {
            let n = frame_window(key);
            assert!(n < 0 && n >= -(1i64 << 52), "{key} → {n}");
        }
    }
}
