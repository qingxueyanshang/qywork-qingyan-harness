//! 图像几何：一张交给模型的图覆盖屏幕上的哪一块，以及区域请求怎么落到采集帧的像素上。
//!
//! 本模块不调用任何 OS 接口，判定都能在没有图形会话的环境里测试。
//!
//! 三条边界：
//!
//! 1. **坐标一律是屏幕物理像素**，原点是虚拟桌面原点。主显示器左上角为 `(0,0)`，
//!    它左侧或上方的显示器给出负坐标，因此坐标是有符号的。
//! 2. **`screen` 说的是这张图覆盖的矩形，`image_width` / `image_height` 说的是缩放之后
//!    交给模型的像素数**。两者不相等时比例由它们的商决定，调用方不要另取 DPI 去换算。
//! 3. **`dpi` 是窗口所在显示器的缩放读数，不是换算因子**。96 是 100%。它进几何是为了让
//!    调用方判得出「这张图是在哪一档缩放下采的」，代际变化由 `generation` 表达。

use serde::{Deserialize, Serialize};

/// 屏幕物理像素矩形。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 屏幕物理像素点。指针落点与拖拽终点都按它表达。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPoint {
    pub x: i32,
    pub y: i32,
}

impl ScreenRect {
    pub const fn right(&self) -> i32 {
        self.x + self.width
    }

    pub const fn bottom(&self) -> i32 {
        self.y + self.height
    }

    /// 矩形中心。按控件包围盒派发指针时落在这里。
    pub const fn center(&self) -> ScreenPoint {
        ScreenPoint {
            x: self.x + self.width / 2,
            y: self.y + self.height / 2,
        }
    }

    /// 这个点在不在矩形里。右边界与下边界不算在内，与 `intersect` 同一套半开区间。
    pub const fn contains(&self, point: ScreenPoint) -> bool {
        point.x >= self.x && point.y >= self.y && point.x < self.right() && point.y < self.bottom()
    }

    /// 两个矩形的交。不相交时返回 `None`，不返回零尺寸矩形——零尺寸的图采不出来，
    /// 让调用方在这里就拿到明确的失败。
    pub fn intersect(&self, other: &Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        (right > x && bottom > y).then_some(Self {
            x,
            y,
            width: right - x,
            height: bottom - y,
        })
    }

    /// 从本矩形里去掉 `cut`，剩下的部分拆成至多四个互不重叠的矩形。
    pub fn subtract(&self, cut: &Self) -> Vec<Self> {
        let Some(hole) = self.intersect(cut) else {
            return vec![*self];
        };
        let pieces = [
            (self.x, self.y, self.width, hole.y - self.y),
            (self.x, hole.bottom(), self.width, self.bottom() - hole.bottom()),
            (self.x, hole.y, hole.x - self.x, hole.height),
            (hole.right(), hole.y, self.right() - hole.right(), hole.height),
        ];
        pieces
            .into_iter()
            .filter(|&(_, _, width, height)| width > 0 && height > 0)
            .map(|(x, y, width, height)| Self { x, y, width, height })
            .collect()
    }
}

/// `target` 是否被 `covers` 合起来完全盖住。
pub fn fully_covered(target: ScreenRect, covers: &[ScreenRect]) -> bool {
    let mut left = vec![target];
    for cover in covers {
        left = left.iter().flat_map(|r| r.subtract(cover)).collect();
        if left.is_empty() {
            return true;
        }
    }
    left.is_empty()
}

/// 绝对指针坐标的满量程。`SendInput` 把 0 到这个数铺在虚拟桌面的宽高上。
const ABSOLUTE_SPAN: i32 = 65_535;

/// 屏幕物理像素点 → `SendInput` 的绝对指针坐标。
///
/// 三条约束，换错任一条指针都会落在别处：
///
/// 1. **铺的是虚拟桌面矩形，不是主显示器矩形**，因此事件要带
///    `MOUSEEVENTF_VIRTUALDESK`；虚拟桌面原点在主显示器左侧或上方有显示器时是负数。
/// 2. **分母取宽高减一**：最后一个像素要落在满量程上，用宽高本身会整体差一格。
/// 3. 结果夹在 0 与满量程之间：桌面外的点没有对应的绝对坐标。
pub fn to_absolute(point: ScreenPoint, desktop: ScreenRect) -> (i32, i32) {
    let span = |value: i32, origin: i32, size: i32| -> i32 {
        let range = f64::from((size - 1).max(1));
        let scaled = (f64::from(value - origin) * f64::from(ABSOLUTE_SPAN) / range).round();
        (scaled as i32).clamp(0, ABSOLUTE_SPAN)
    };
    (
        span(point.x, desktop.x, desktop.width),
        span(point.y, desktop.y, desktop.height),
    )
}

/// 一张图的几何。交给模型的每一张图都带一份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    /// 交给模型的图像像素尺寸，缩放之后的那一个。
    pub image_width: u32,
    pub image_height: u32,
    /// 这张图覆盖的屏幕物理像素矩形。
    pub screen: ScreenRect,
    /// 窗口所在显示器的 DPI。96 = 100%。
    pub dpi: u32,
    /// 窗口矩形与显示器的代际。窗口移动、缩放、换显示器或 DPI 变化之后它就不同，
    /// 按图定位的请求据此在派发前被拒。
    pub generation: String,
}

/// 窗口此刻的几何事实，由平台层读出来。代际与几何都由它算。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowFrame {
    /// `GetWindowRect` 给的窗口矩形。
    pub window: ScreenRect,
    /// DWM 的可见边框。WGC 帧的原点是它，不是 `window`。
    pub visible: ScreenRect,
    pub dpi: u32,
    /// 窗口所在显示器的标识。同一个矩形换到另一台显示器时靠它分得开。
    pub monitor: i64,
}

impl WindowFrame {
    /// 窗口矩形与显示器的代际。
    ///
    /// 四项都进：移动与缩放改矩形，换显示器改 `monitor`，改缩放比例改 `dpi`。
    /// 可见边框不进——它随窗口矩形一起变，多一项不会多挡住任何一种变化。
    pub fn generation(&self) -> String {
        let r = self.window;
        format!(
            "{},{},{},{}@{}#{}",
            r.x,
            r.y,
            r.width,
            r.height,
            self.dpi,
            self.monitor
        )
    }
}

/// 这次请求带的代际还成不成立。
///
/// 缺席表示调用方没有按图定位，不核对；给了就必须与窗口此刻的代际一模一样。
/// **不做前缀或近似比较**：窗口挪了一个像素，上一张图里的那块矩形指的就是另一块界面。
pub fn generation_matches(expected: Option<&str>, actual: &str) -> bool {
    expected.is_none_or(|want| want == actual)
}

/// 一次采集要从帧里裁哪一块，以及裁出来之后缩到多大。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crop {
    /// 相对采集帧左上角的裁剪原点与尺寸，单位是帧的物理像素。
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// 裁出来这一块覆盖的屏幕矩形。
    pub screen: ScreenRect,
    /// 缩放之后的图像尺寸。
    pub image_width: u32,
    pub image_height: u32,
}

/// 按长边上限等比缩小。已经在上限内的原样返回——放大没有信息增益，只多占字节。
pub fn fit(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if max_edge == 0 || longest <= max_edge {
        return (width, height);
    }
    let scale = f64::from(max_edge) / f64::from(longest);
    let w = (f64::from(width) * scale).round() as u32;
    let h = (f64::from(height) * scale).round() as u32;
    (w.max(1), h.max(1))
}

/// 把一次请求落到采集帧的像素上。
///
/// `frame_origin` 是采集帧左上角对应的屏幕坐标，`frame_width` / `frame_height` 是帧的
/// 物理像素尺寸。`region` 缺席表示整帧；给出时按屏幕坐标与帧的覆盖范围求交，
/// **不相交即返回 `None`**——把一个界外矩形夹到边上会让调用方拿到一张不是它要的图。
pub fn crop_for(
    frame_origin: (i32, i32),
    frame_width: u32,
    frame_height: u32,
    region: Option<ScreenRect>,
    max_edge: u32,
) -> Option<Crop> {
    if frame_width == 0 || frame_height == 0 {
        return None;
    }
    let covered = ScreenRect {
        x: frame_origin.0,
        y: frame_origin.1,
        width: i32::try_from(frame_width).ok()?,
        height: i32::try_from(frame_height).ok()?,
    };
    let screen = match region {
        None => covered,
        Some(region) => covered.intersect(&region)?,
    };
    let (image_width, image_height) = fit(
        u32::try_from(screen.width).ok()?,
        u32::try_from(screen.height).ok()?,
        max_edge,
    );
    Some(Crop {
        x: u32::try_from(screen.x - covered.x).ok()?,
        y: u32::try_from(screen.y - covered.y).ok()?,
        width: u32::try_from(screen.width).ok()?,
        height: u32::try_from(screen.height).ok()?,
        screen,
        image_width,
        image_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn point(x: i32, y: i32) -> ScreenPoint {
        ScreenPoint { x, y }
    }

    #[test]
    fn a_window_under_one_bigger_window_is_fully_covered() {
        assert!(fully_covered(rect(100, 100, 800, 600), &[rect(0, 0, 1920, 1040)]));
    }

    /// 两个窗口各盖一半、合起来盖满，同样算完全盖住；留一条缝就不算。
    #[test]
    fn covers_add_up_and_any_visible_strip_counts() {
        let target = rect(0, 0, 100, 100);
        assert!(fully_covered(target, &[rect(0, 0, 60, 100), rect(50, 0, 60, 100)]));
        assert!(!fully_covered(target, &[rect(0, 0, 60, 100), rect(61, 0, 60, 100)]));
        assert!(!fully_covered(target, &[rect(10, 10, 80, 80)]));
        assert!(!fully_covered(target, &[]));
    }

    #[test]
    fn subtracting_a_hole_leaves_the_frame_around_it() {
        let pieces = rect(0, 0, 10, 10).subtract(&rect(2, 3, 4, 5));
        let area: i32 = pieces.iter().map(|r| r.width * r.height).sum();
        assert_eq!(area, 100 - 20);
        assert_eq!(rect(0, 0, 10, 10).subtract(&rect(20, 20, 5, 5)), vec![rect(0, 0, 10, 10)]);
    }

    /// 单屏：左上角落在 0，右下角那个像素落在满量程上。
    #[test]
    fn absolute_coordinates_span_the_whole_desktop() {
        let desktop = rect(0, 0, 2560, 1440);
        assert_eq!(to_absolute(point(0, 0), desktop), (0, 0));
        assert_eq!(to_absolute(point(2559, 1439), desktop), (65_535, 65_535));
        assert_eq!(to_absolute(point(1280, 720), desktop), (32_780, 32_790));
    }

    /// 负原点：主显示器左上方还有一台时，虚拟桌面原点是负的，换算要从那里起算。
    #[test]
    fn a_negative_desktop_origin_is_the_zero_of_the_absolute_range() {
        let desktop = rect(-1920, -200, 4480, 1640);
        assert_eq!(to_absolute(point(-1920, -200), desktop), (0, 0));
        assert_eq!(to_absolute(point(2559, 1439), desktop), (65_535, 65_535));
        // 主显示器左上角落在虚拟桌面中间偏左：1920 / 4479 与 200 / 1639 的满量程比例。
        assert_eq!(to_absolute(point(0, 0), desktop), (28_093, 7_997));
    }

    /// 桌面外的点夹在量程两端，不绕回另一侧。
    #[test]
    fn a_point_outside_the_desktop_is_clamped_to_the_range() {
        let desktop = rect(0, 0, 2560, 1440);
        assert_eq!(to_absolute(point(-10, -10), desktop), (0, 0));
        assert_eq!(to_absolute(point(9999, 9999), desktop), (65_535, 65_535));
    }

    /// 单像素宽的桌面不会让分母变成 0。
    #[test]
    fn a_one_pixel_desktop_does_not_divide_by_zero() {
        assert_eq!(to_absolute(point(0, 0), rect(0, 0, 1, 1)), (0, 0));
    }

    #[test]
    fn a_rect_gives_its_center_and_tells_what_it_covers() {
        let r = rect(100, 200, 80, 24);
        assert_eq!(r.center(), point(140, 212));
        assert!(r.contains(point(100, 200)));
        assert!(r.contains(point(179, 223)));
        // 右边界与下边界在矩形之外，与 `intersect` 的半开区间一致。
        assert!(!r.contains(point(180, 212)));
        assert!(!r.contains(point(140, 224)));
        assert!(!r.contains(point(99, 212)));
    }

    #[test]
    fn fitting_leaves_an_image_inside_the_limit_untouched() {
        assert_eq!(fit(800, 600, 1568), (800, 600));
        assert_eq!(fit(1568, 900, 1568), (1568, 900));
        // 上限为 0 表示不限。
        assert_eq!(fit(4000, 3000, 0), (4000, 3000));
    }

    #[test]
    fn fitting_scales_the_long_edge_and_keeps_the_ratio() {
        assert_eq!(fit(3840, 2160, 1568), (1568, 882));
        assert_eq!(fit(2160, 3840, 1568), (882, 1568));
        // 极扁的图缩到长边上限之后短边不能变成 0。
        assert_eq!(fit(4000, 1, 1568), (1568, 1));
    }

    #[test]
    fn a_region_inside_the_frame_keeps_its_screen_origin() {
        let crop = crop_for((100, 200), 800, 600, Some(rect(300, 250, 200, 100)), 1568)
            .expect("区域在帧里，应当裁得出来");
        assert_eq!((crop.x, crop.y, crop.width, crop.height), (200, 50, 200, 100));
        assert_eq!(crop.screen, rect(300, 250, 200, 100));
        assert_eq!((crop.image_width, crop.image_height), (200, 100));
    }

    /// 负原点：左侧那台显示器上的窗口，裁剪原点仍然是正的帧内偏移。
    #[test]
    fn a_frame_on_a_negative_origin_monitor_crops_from_a_positive_offset() {
        let crop = crop_for((-1920, -200), 1920, 1080, Some(rect(-1800, -100, 400, 300)), 1568)
            .expect("负原点上的区域同样裁得出来");
        assert_eq!((crop.x, crop.y), (120, 100));
        assert_eq!(crop.screen, rect(-1800, -100, 400, 300));
    }

    /// 区域超出帧边界时按交集裁，屏幕矩形跟着收窄——不是把请求的矩形照抄回去。
    #[test]
    fn a_region_reaching_past_the_frame_is_clipped_to_what_was_captured() {
        let crop = crop_for((0, 0), 800, 600, Some(rect(700, 500, 400, 400)), 1568)
            .expect("与帧有交集就裁得出来");
        assert_eq!((crop.x, crop.y, crop.width, crop.height), (700, 500, 100, 100));
        assert_eq!(crop.screen, rect(700, 500, 100, 100));
    }

    #[test]
    fn a_region_outside_the_frame_is_refused_rather_than_clamped() {
        assert!(crop_for((0, 0), 800, 600, Some(rect(900, 0, 100, 100)), 1568).is_none());
        assert!(crop_for((0, 0), 800, 600, Some(rect(0, 600, 100, 100)), 1568).is_none());
        // 零尺寸的交集同样不成立。
        assert!(crop_for((0, 0), 800, 600, Some(rect(800, 0, 10, 10)), 1568).is_none());
    }

    #[test]
    fn a_zero_sized_frame_has_no_crop() {
        assert!(crop_for((0, 0), 0, 600, None, 1568).is_none());
        assert!(crop_for((0, 0), 800, 0, None, 1568).is_none());
    }

    /// 整帧请求覆盖整张帧，且缩图之后的尺寸就是交给模型的那一个。
    #[test]
    fn a_whole_frame_request_covers_the_frame_and_records_the_scaled_size() {
        let crop = crop_for((10, 20), 3840, 2160, None, 1568).expect("整帧一定裁得出来");
        assert_eq!((crop.x, crop.y, crop.width, crop.height), (0, 0, 3840, 2160));
        assert_eq!(crop.screen, rect(10, 20, 3840, 2160));
        assert_eq!((crop.image_width, crop.image_height), (1568, 882));
    }

    /// 代际把移动、缩放、换显示器与改 DPI 四种变化都分得开。
    #[test]
    fn the_generation_changes_on_move_resize_dpi_and_monitor() {
        let base = WindowFrame {
            window: rect(100, 100, 800, 600),
            visible: rect(107, 100, 786, 593),
            dpi: 96,
            monitor: 7,
        };
        let same = WindowFrame { ..base };
        assert_eq!(base.generation(), same.generation());

        let moved = WindowFrame {
            window: rect(101, 100, 800, 600),
            ..base
        };
        let resized = WindowFrame {
            window: rect(100, 100, 801, 600),
            ..base
        };
        let scaled = WindowFrame { dpi: 144, ..base };
        let other_monitor = WindowFrame { monitor: 8, ..base };
        for changed in [moved, resized, scaled, other_monitor] {
            assert_ne!(base.generation(), changed.generation());
        }

        // 可见边框自己变不算代际变化：它跟着窗口矩形走。
        let shadow = WindowFrame {
            visible: rect(108, 100, 784, 593),
            ..base
        };
        assert_eq!(base.generation(), shadow.generation());
    }

    /// 按图定位的请求带代际，整窗采集不带；带了就必须一模一样。
    #[test]
    fn a_generation_is_compared_whole_or_not_at_all() {
        let now = "100,100,800,600@96#7";
        assert!(generation_matches(None, now));
        assert!(generation_matches(Some(now), now));
        assert!(!generation_matches(Some("100,101,800,600@96#7"), now));
        assert!(!generation_matches(Some("100,100,800,600@144#7"), now));
        assert!(!generation_matches(Some("100,100,800,600@96#8"), now));
        // 前缀相同不算相同：窗口从 800 宽变成 8000 宽也是换了一块界面。
        assert!(!generation_matches(Some("100,100,800,600@96#70"), now));
        assert!(!generation_matches(Some(""), now));
    }
}
