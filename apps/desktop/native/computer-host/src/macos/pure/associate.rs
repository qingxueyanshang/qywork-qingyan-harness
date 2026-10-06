//! AX 窗口与 CGWindowList 窗口的对应关系、未对应窗口的编号方式，以及按层叠序判定遮挡与落点命中。
//!
//! 四条规则：
//!
//! 1. **窗口清单以 AX 为准。** 标题取 AX 的 `AXTitle`：CG 的窗口名需要屏幕录制授权才提供。
//!    CGWindowList 只提供层叠序、遮挡判定与采图所需的 CGWindowID。
//! 2. **进程号相同、AX 的位置尺寸与 CG 矩形按整点相等，且两个方向都唯一时才视为对应。**
//!    已对应的窗口以 CGWindowID 编号；未对应的以身份表编号的相反数编号，只提供控件树与后台
//!    语义动作，不提供图像与坐标动作。不要改用私有的 `_AXUIElementGetWindow`。
//! 3. **遮挡需要证据。** 无法读取矩形时报告为未遮挡。
//! 4. **落点命中分两步**：落点属于哪个应用由 AX 的系统范围命中测试给出，该测试按窗口服务器实际的
//!    命中规则判定，鼠标可穿透的覆盖窗口不计入；同一个应用的多个窗口中由哪一个接收本次点击由层叠序决定。
//!
//! 本模块不调用任何接口，事实由调用方读取后传入。

use crate::geometry::{fully_covered, ScreenPoint, ScreenRect};

/// CGWindowList 中的一个窗口。清单按从前到后的层叠序排列。
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
    /// 所属应用的名称。无需屏幕录制授权。
    pub owner: String,
    /// 窗口名。没有屏幕录制授权时为空。
    pub name: String,
}

/// AX 窗口中参与对应的事实。
#[derive(Debug, Clone, Copy)]
pub struct AxSide {
    pub pid: i32,
    /// `AXPosition` 与 `AXSize` 取整后的矩形。
    pub frame: Option<ScreenRect>,
}

/// CG 窗口未能对应 AX 窗口的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unmatched {
    None,
    /// 同一进程中位置与尺寸相同的窗口不止一个，值为这一侧的候选数。
    Ambiguous(usize),
}

fn compatible(ax: &AxSide, cg: &CgWindow) -> bool {
    cg.layer == 0 && ax.pid == cg.pid && ax.frame.is_some() && ax.frame == cg.bounds
}

/// `cgs[target]` 唯一对应的 AX 窗口在 `axs` 中的下标。
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

/// `axs[target]` 唯一对应的 CG 窗口在 `cgs` 中的下标。
pub fn cg_of(target: usize, axs: &[AxSide], cgs: &[CgWindow]) -> Option<usize> {
    let mut candidates = (0..cgs.len()).filter(|i| compatible(&axs[target], &cgs[*i]));
    let cg = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    (ax_of(cg, axs, cgs) == Ok(target)).then_some(cg)
}

/// 没有对应 CG 窗口的 AX 窗口在窗口清单中的编号：身份表编号的相反数。
///
/// 负数不会与 CGWindowID 冲突；身份表编号从 1 起递增，经 JSON 交给 JavaScript 仍是精确整数。
pub fn unassociated_window(identity: u64) -> i64 {
    -i64::try_from(identity).unwrap_or(i64::MAX)
}

/// 负数窗口编号对应的身份表编号。非负编号是 CGWindowID，返回 `None`。
pub fn identity_of_window(window: i64) -> Option<u64> {
    (window < 0).then(|| window.unsigned_abs())
}

/// `windows[at]` 当前在屏幕上是否完全不可见：不在屏幕上（最小化、隐藏、位于其他桌面空间），
/// 或矩形被层叠序在其之前、位于屏幕上且非完全透明的窗口完全遮挡。`windows` 从前到后排列。
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

/// 落点 `at`（点）处接收指针的窗口编号：`windows` 中从前到后第一个属于进程 `pid`、位于屏幕上、
/// 非完全透明、矩形包含该点的窗口。`pid` 是 AX 命中测试确定的应用，见文件头第 4 条。
pub fn hit(at: (f64, f64), windows: &[CgWindow], pid: i32) -> Option<u32> {
    let point = ScreenPoint {
        x: at.0.floor() as i32,
        y: at.1.floor() as i32,
    };
    windows
        .iter()
        .filter(|w| w.pid == pid && w.on_screen && w.alpha > 0.0)
        .find(|w| w.bounds.is_some_and(|b| b.contains(point)))
        .map(|w| w.number)
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

    /// 同一进程中两个位置与尺寸相同的窗口（原生标签页）：无法判定对应关系，两个都不对应。
    #[test]
    fn two_identical_windows_of_one_process_stay_unassociated() {
        let cgs = [cg(41, 10, FRAME), cg(42, 10, FRAME)];
        let axs = [ax(10, FRAME), ax(10, FRAME)];
        assert_eq!(cg_of(0, &axs, &cgs), None);
        assert_eq!(cg_of(1, &axs, &cgs), None);
        assert_eq!(ax_of(0, &axs, &cgs), Err(Unmatched::Ambiguous(2)));
    }

    /// 一个 AX 窗口匹配两个 CG 窗口时同样不视为对应，即使从 CG 一侧看每个都只有一个候选。
    #[test]
    fn one_ax_window_against_two_cg_windows_is_ambiguous() {
        let cgs = [cg(41, 10, FRAME), cg(42, 10, FRAME)];
        let axs = [ax(10, FRAME)];
        assert_eq!(ax_of(0, &axs, &cgs), Err(Unmatched::Ambiguous(2)));
        assert_eq!(cg_of(0, &axs, &cgs), None);
    }

    /// 菜单栏、程序坞等非 0 层窗口不参与对应；无法读取位置尺寸的 AX 窗口也不参与。
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

    /// 被前方的窗口完全遮挡或不在屏幕上均视为不可见；露出一条边即不视为不可见。
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
        // 同一个覆盖窗口排在目标之后时不遮挡目标。
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
        // 完全透明的窗口不视为遮挡。
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

    /// 接收落点的是该应用在层叠序中最上层、矩形包含落点的窗口；其他应用的窗口不计入，
    /// 即使其排在更前方：AX 已判定落点属于该应用。
    #[test]
    fn a_hit_takes_the_frontmost_window_of_the_hit_application() {
        let overlay = CgWindow {
            layer: 25,
            ..cg(40, 99, FRAME)
        };
        let sheet = cg(
            41,
            10,
            ScreenRect {
                x: 300,
                y: 100,
                width: 200,
                height: 150,
            },
        );
        let window = cg(42, 10, FRAME);
        let stack = [overlay, sheet, window];
        assert_eq!(hit((350.5, 120.0), &stack, 10), Some(41));
        assert_eq!(hit((120.0, 90.0), &stack, 10), Some(42));
        assert_eq!(hit((120.0, 90.0), &stack, 99), Some(40));
        // 矩形外、其他进程、不可见的窗口均不接收落点。
        assert_eq!(hit((10.0, 10.0), &stack, 10), None);
        assert_eq!(hit((120.0, 90.0), &stack, 11), None);
        let gone = CgWindow {
            on_screen: false,
            ..cg(42, 10, FRAME)
        };
        let glass = CgWindow {
            alpha: 0.0,
            ..cg(43, 10, FRAME)
        };
        assert_eq!(hit((120.0, 90.0), &[gone, glass], 10), None);
        // 右边界与下边界在矩形之外。
        assert_eq!(hit((900.0, 90.0), &[cg(42, 10, FRAME)], 10), None);
        assert_eq!(hit((899.9, 90.0), &[cg(42, 10, FRAME)], 10), Some(42));
    }
}
