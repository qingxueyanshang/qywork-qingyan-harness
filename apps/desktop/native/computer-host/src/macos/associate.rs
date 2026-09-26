//! AX 窗口与 CGWindowList 窗口的对应关系、对不上的窗口怎么编号，以及按层叠序判遮挡。
//!
//! 三条规则：
//!
//! 1. **窗口清单以 AX 为准。** 标题取 AX 的 `AXTitle`：CG 的窗口名要屏幕录制授权才给。
//!    CGWindowList 只提供层叠序、遮挡判定与取图要用的 CGWindowID。
//! 2. **进程号相同、且 AX 的位置尺寸与 CG 矩形按整点相等，两个方向都唯一才算对应上。**
//!    对应上的窗口以 CGWindowID 编号；对不上的以身份表编号的相反数编号，只给控件树与后台
//!    语义动作，不给图像与坐标动作。不要改用私有的 `_AXUIElementGetWindow`。
//! 3. **遮挡要证据。** 读不出矩形时按没盖住报。
//!
//! 本模块不调用任何接口，事实由调用方读好交进来。

use crate::geometry::{fully_covered, ScreenRect};

/// CGWindowList 里的一个窗口。清单按从前到后的层叠序排列。
#[derive(Debug, Clone)]
pub struct CgWindow {
    pub number: u32,
    pub pid: i32,
    /// 0 是普通应用窗口；菜单栏、程序坞与浮动面板在更高的层。
    pub layer: i32,
    /// 点，原点是主显示器左上角，已取整。
    pub bounds: Option<ScreenRect>,
    pub on_screen: bool,
    pub alpha: f64,
    /// 所属应用的名称。不要屏幕录制授权。
    pub owner: String,
    /// 窗口名。没有屏幕录制授权时为空。
    pub name: String,
}

/// 一个 AX 窗口里参与对应的事实。
#[derive(Debug, Clone, Copy)]
pub struct AxSide {
    pub pid: i32,
    /// `AXPosition` 与 `AXSize` 取整后的矩形。
    pub frame: Option<ScreenRect>,
}

/// 一个 CG 窗口没有对应上 AX 窗口的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unmatched {
    None,
    /// 同一进程里同位置同尺寸的窗口不止一个，给出的是这一侧的候选数。
    Ambiguous(usize),
}

fn compatible(ax: &AxSide, cg: &CgWindow) -> bool {
    cg.layer == 0 && ax.pid == cg.pid && ax.frame.is_some() && ax.frame == cg.bounds
}

/// `cgs[target]` 唯一对应的 AX 窗口在 `axs` 里的下标。
pub fn ax_of(target: usize, axs: &[AxSide], cgs: &[CgWindow]) -> Result<usize, Unmatched> {
    let cg = &cgs[target];
    let candidates: Vec<usize> = (0..axs.len())
        .filter(|i| compatible(&axs[*i], cg))
        .collect();
    let ax = match candidates.as_slice() {
        [] => return Err(Unmatched::None),
        [only] => *only,
        many => return Err(Unmatched::Ambiguous(many.len())),
    };
    let rivals = cgs.iter().filter(|c| compatible(&axs[ax], c)).count();
    if rivals == 1 {
        Ok(ax)
    } else {
        Err(Unmatched::Ambiguous(rivals))
    }
}

/// `axs[target]` 唯一对应的 CG 窗口在 `cgs` 里的下标。
pub fn cg_of(target: usize, axs: &[AxSide], cgs: &[CgWindow]) -> Option<usize> {
    let mut candidates = (0..cgs.len()).filter(|i| compatible(&axs[target], &cgs[*i]));
    let cg = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    (ax_of(cg, axs, cgs) == Ok(target)).then_some(cg)
}

/// 没有对应 CG 窗口的 AX 窗口在窗口清单里的编号：身份表编号的相反数。
///
/// 负数不会与 CGWindowID 撞上；身份表编号从 1 起递增，经 JSON 交给 JavaScript 仍是精确整数。
pub fn unassociated_window(identity: u64) -> i64 {
    -i64::try_from(identity).unwrap_or(i64::MAX)
}

/// 负数窗口编号对应的身份表编号。非负编号是 CGWindowID，交回 `None`。
pub fn identity_of_window(window: i64) -> Option<u64> {
    (window < 0).then(|| window.unsigned_abs())
}

/// `windows[at]` 此刻在屏幕上是否一点都看不见：不在屏幕上（最小化、隐藏、在别的桌面空间），
/// 或矩形被层叠序在它前面、在屏幕上且不全透明的窗口完全盖住。`windows` 从前到后排列。
pub fn covered(at: usize, windows: &[CgWindow]) -> bool {
    let target = &windows[at];
    if !target.on_screen {
        return true;
    }
    let Some(bounds) = target.bounds else {
        return false;
    };
    let covers: Vec<ScreenRect> = windows[..at]
        .iter()
        .filter(|w| w.on_screen && w.alpha > 0.0)
        .filter_map(|w| w.bounds)
        .collect();
    fully_covered(bounds, &covers)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: ScreenRect = ScreenRect {
        x: 100,
        y: 80,
        width: 800,
        height: 600,
    };

    fn cg(number: u32, pid: i32, bounds: ScreenRect) -> CgWindow {
        CgWindow {
            number,
            pid,
            layer: 0,
            bounds: Some(bounds),
            on_screen: true,
            alpha: 1.0,
            owner: "访达".to_owned(),
            name: String::new(),
        }
    }

    fn ax(pid: i32, frame: ScreenRect) -> AxSide {
        AxSide {
            pid,
            frame: Some(frame),
        }
    }

    #[test]
    fn a_window_matches_by_pid_and_frame() {
        let cgs = [cg(41, 10, FRAME), cg(42, 11, FRAME)];
        let axs = [ax(11, FRAME)];
        assert_eq!(cg_of(0, &axs, &cgs), Some(1));
        assert_eq!(ax_of(1, &axs, &cgs), Ok(0));
        assert_eq!(ax_of(0, &axs, &cgs), Err(Unmatched::None));
        let moved = ScreenRect { x: 101, ..FRAME };
        assert_eq!(cg_of(0, &[ax(11, moved)], &cgs), None);
    }

    /// 同一进程两个同位置同尺寸的窗口（原生标签页）：哪个对哪个判不出来，两个都不对应。
    #[test]
    fn two_identical_windows_of_one_process_stay_unassociated() {
        let cgs = [cg(41, 10, FRAME), cg(42, 10, FRAME)];
        let axs = [ax(10, FRAME), ax(10, FRAME)];
        assert_eq!(cg_of(0, &axs, &cgs), None);
        assert_eq!(cg_of(1, &axs, &cgs), None);
        assert_eq!(ax_of(0, &axs, &cgs), Err(Unmatched::Ambiguous(2)));
    }

    /// 一个 AX 窗口对上两个 CG 窗口同样不算，哪怕从 CG 一侧看每个都只有一个候选。
    #[test]
    fn one_ax_window_against_two_cg_windows_is_ambiguous() {
        let cgs = [cg(41, 10, FRAME), cg(42, 10, FRAME)];
        let axs = [ax(10, FRAME)];
        assert_eq!(ax_of(0, &axs, &cgs), Err(Unmatched::Ambiguous(2)));
        assert_eq!(cg_of(0, &axs, &cgs), None);
    }

    /// 菜单栏、程序坞这类非 0 层窗口不参与对应；读不出位置尺寸的 AX 窗口也不参与。
    #[test]
    fn only_layer_zero_windows_with_a_frame_take_part() {
        let mut bar = cg(41, 10, FRAME);
        bar.layer = 24;
        assert_eq!(cg_of(0, &[ax(10, FRAME)], &[bar]), None);
        let blind = AxSide {
            pid: 10,
            frame: None,
        };
        assert_eq!(cg_of(0, &[blind], &[cg(41, 10, FRAME)]), None);
    }

    #[test]
    fn unassociated_numbers_are_negative_and_round_trip() {
        assert_eq!(unassociated_window(1), -1);
        assert_eq!(identity_of_window(unassociated_window(4711)), Some(4711));
        assert_eq!(identity_of_window(42), None);
        assert_eq!(identity_of_window(0), None);
    }

    /// 被前面的窗口完全盖住、或不在屏幕上都算看不见；露出一条边就不算。
    #[test]
    fn covered_needs_the_windows_in_front() {
        let target = cg(42, 10, FRAME);
        let cover = cg(
            41,
            11,
            ScreenRect {
                x: 0,
                y: 0,
                width: 1000,
                height: 1000,
            },
        );
        assert!(covered(1, &[cover.clone(), target.clone()]));
        // 同一个窗口排在后面就不遮挡它。
        assert!(!covered(0, &[target.clone(), cover.clone()]));
        let partial = cg(
            41,
            11,
            ScreenRect {
                x: 0,
                y: 0,
                width: 850,
                height: 1000,
            },
        );
        assert!(!covered(1, &[partial, target.clone()]));
        // 全透明的窗口不算遮挡。
        let glass = CgWindow {
            alpha: 0.0,
            ..cover
        };
        assert!(!covered(1, &[glass, target.clone()]));
        let hidden = CgWindow {
            on_screen: false,
            ..target
        };
        assert!(covered(0, &[hidden]));
    }
}
