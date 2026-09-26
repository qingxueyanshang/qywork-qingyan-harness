//! 点与屏幕物理像素之间的换算。AX 与 CoreGraphics 给的是点，原点是主显示器左上角、y 向下；
//! 协议里的矩形、落点与图像几何是屏幕物理像素。
//!
//! 四条规则：
//!
//! 1. **一个窗口只用一套换算**：窗口所在显示器的那一套。所在显示器是与窗口矩形相交面积最大的
//!    那一台，都不相交时取主显示器。窗口矩形、控件包围盒、图像几何与指针落点都按这一套换算，
//!    跨显示器的窗口伸到另一台上的那部分也按它算，同一个窗口里的坐标因此前后一致、能原样换回点。
//! 2. **像素 = 显示器原点像素 + (点 − 显示器原点) × 这台显示器的每点像素数**。显示器原点像素是
//!    它的原点乘以全部显示器里最大的每点像素数：每台显示器的像素矩形落在它的点矩形按这个最大
//!    比例放大后的范围里，点矩形互不重叠，像素矩形因此也互不重叠。主显示器的原点是 (0,0)，
//!    只有一台显示器时像素就是点乘它的每点像素数。
//! 3. **矩形按四条边分别取整**：相邻的两个矩形换算之后仍然相邻。
//! 4. `dpi` 按 96 × 每点像素数报，与其他平台「96 是 100%」同一个读法；代际里的显示器标识是
//!    CGDirectDisplayID。显示器排列或每点像素数变化时像素矩形随之变化，代际跟着变。
//!
//! 本模块不调用任何接口，显示器清单由调用方读好交进来。

use super::facts::Frame;
use crate::geometry::{ScreenPoint, ScreenRect, WindowFrame};

/// 一台显示器。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Display {
    /// CGDirectDisplayID。
    pub id: u32,
    /// 全局坐标里的矩形，单位是点。
    pub bounds: Frame,
    /// 每点多少个物理像素：显示模式的像素宽度除以点宽度。
    pub scale: f64,
}

impl Display {
    fn usable(&self) -> bool {
        self.scale.is_finite()
            && self.scale > 0.0
            && self.bounds.width > 0.0
            && self.bounds.height > 0.0
    }
}

/// 一个窗口的点与像素之间的换算，见文件头第 1、2 条。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mapping {
    display: u32,
    origin: (f64, f64),
    pixel_origin: (f64, f64),
    scale: f64,
}

impl Mapping {
    /// 点 → 像素，不取整。
    pub fn pixel(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.pixel_origin.0 + (x - self.origin.0) * self.scale,
            self.pixel_origin.1 + (y - self.origin.1) * self.scale,
        )
    }

    /// 像素点 → 点。`pixel` 的逆运算。
    pub fn point(&self, at: ScreenPoint) -> (f64, f64) {
        (
            self.origin.0 + (f64::from(at.x) - self.pixel_origin.0) / self.scale,
            self.origin.1 + (f64::from(at.y) - self.pixel_origin.1) / self.scale,
        )
    }

    /// 像素长度 → 点。
    pub fn points(&self, pixels: i32) -> f64 {
        f64::from(pixels) / self.scale
    }

    /// 点矩形 → 像素矩形，四条边分别取整。
    pub fn rect(&self, frame: Frame) -> ScreenRect {
        let at = |v: f64| v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
        let (left, top) = self.pixel(frame.x, frame.y);
        let (right, bottom) = self.pixel(frame.x + frame.width, frame.y + frame.height);
        ScreenRect {
            x: at(left),
            y: at(top),
            width: at(right) - at(left),
            height: at(bottom) - at(top),
        }
    }

    pub fn dpi(&self) -> u32 {
        (96.0 * self.scale).round() as u32
    }
}

/// 一个窗口此刻的几何：点矩形、它用的那一套换算，以及按像素算的窗口事实。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    /// 窗口矩形，单位是点。
    pub bounds: Frame,
    pub mapping: Mapping,
    /// 窗口矩形与可见边框都是像素化之后的窗口矩形：按窗口取的图覆盖的就是这一块，不含阴影。
    pub frame: WindowFrame,
}

/// 按窗口矩形挑显示器、定换算。显示器清单里没有可用的显示器时缺席。
pub fn place(displays: &[Display], bounds: Frame) -> Option<Placed> {
    let usable: Vec<&Display> = displays.iter().filter(|d| d.usable()).collect();
    let widest = usable.iter().map(|d| d.scale).fold(0.0_f64, f64::max);
    let host = usable
        .iter()
        .map(|d| (overlap(&d.bounds, &bounds), *d))
        .filter(|(area, _)| *area > 0.0)
        // 面积相同取清单里靠前的那一台：`max_by` 在相等时取后者，所以倒着找。
        .rev()
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, d)| d)
        .or_else(|| {
            usable
                .iter()
                .find(|d| d.bounds.x == 0.0 && d.bounds.y == 0.0)
                .or(usable.first())
                .copied()
        })?;
    let mapping = Mapping {
        display: host.id,
        origin: (host.bounds.x, host.bounds.y),
        pixel_origin: (host.bounds.x * widest, host.bounds.y * widest),
        scale: host.scale,
    };
    let rect = mapping.rect(bounds);
    Some(Placed {
        bounds,
        mapping,
        frame: WindowFrame {
            window: rect,
            visible: rect,
            dpi: mapping.dpi(),
            monitor: i64::from(mapping.display),
        },
    })
}

/// 两个点矩形相交的面积。
fn overlap(a: &Frame, b: &Frame) -> f64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width > 0.0 && height > 0.0 {
        width * height
    } else {
        0.0
    }
}

/// CGWindowList 给的整点矩形换回点矩形。
pub fn frame_of(rect: ScreenRect) -> Frame {
    Frame {
        x: f64::from(rect.x),
        y: f64::from(rect.y),
        width: f64::from(rect.width),
        height: f64::from(rect.height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame {
            x,
            y,
            width,
            height,
        }
    }

    fn rect(x: i32, y: i32, width: i32, height: i32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    /// 内建 Retina 屏：1512×982 点，每点 2 个像素。
    const BUILT_IN: Display = Display {
        id: 1,
        bounds: Frame {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        },
        scale: 2.0,
    };

    /// 接在右侧、顶边高出 200 点的 1080p 外接屏，每点 1 个像素。
    const EXTERNAL: Display = Display {
        id: 2,
        bounds: Frame {
            x: 1512.0,
            y: -200.0,
            width: 1920.0,
            height: 1080.0,
        },
        scale: 1.0,
    };

    /// 单台 Retina 屏：像素就是点乘 2，dpi 报 192，代际里是这台显示器。
    #[test]
    fn a_retina_window_doubles_its_points() {
        let placed = place(&[BUILT_IN], frame(100.0, 50.0, 800.0, 600.0)).expect("有显示器");
        assert_eq!(placed.frame.window, rect(200, 100, 1600, 1200));
        assert_eq!(placed.frame.visible, placed.frame.window);
        assert_eq!(placed.frame.dpi, 192);
        assert_eq!(placed.frame.monitor, 1);
        assert_eq!(placed.frame.generation(), "200,100,1600,1200@192#1");
    }

    /// 像素换回点再换回像素是原值：按图给的落点要能原样落回屏幕上的那个位置。
    #[test]
    fn pixels_convert_back_to_the_same_points() {
        for display in [BUILT_IN, EXTERNAL] {
            let placed = place(&[BUILT_IN, EXTERNAL], display.bounds).expect("有显示器");
            let m = placed.mapping;
            for (x, y) in [(0, 0), (123, 457), (-3, 9001), (3111, -401)] {
                let (px, py) = m.point(ScreenPoint { x, y });
                assert_eq!(m.pixel(px, py), (f64::from(x), f64::from(y)));
            }
            assert_eq!(m.points(300), 300.0 / display.scale);
        }
    }

    /// 两台显示器：外接屏的像素原点是它的点原点乘最大比例 2，它自己按每点 1 个像素换算。
    #[test]
    fn a_window_on_the_external_display_uses_that_displays_scale() {
        let placed =
            place(&[BUILT_IN, EXTERNAL], frame(1600.0, 0.0, 800.0, 600.0)).expect("有显示器");
        assert_eq!(placed.frame.window, rect(3112, -200, 800, 600));
        assert_eq!(placed.frame.dpi, 96);
        assert_eq!(placed.frame.monitor, 2);
    }

    /// 两台显示器各自的像素矩形互不重叠，哪怕低比例的那台排在高比例那台的右边或左边。
    #[test]
    fn display_pixel_rects_never_overlap() {
        let left = Display {
            id: 3,
            bounds: frame(-1920.0, 100.0, 1920.0, 1080.0),
            scale: 1.0,
        };
        let right_retina = Display {
            id: 4,
            bounds: frame(3432.0, 0.0, 2560.0, 1440.0),
            scale: 2.0,
        };
        for layout in [
            vec![BUILT_IN, EXTERNAL],
            vec![BUILT_IN, left],
            vec![EXTERNAL, right_retina, left, BUILT_IN],
        ] {
            let rects: Vec<ScreenRect> = layout
                .iter()
                .map(|d| place(&layout, d.bounds).expect("有显示器").frame.window)
                .collect();
            for (i, a) in rects.iter().enumerate() {
                for b in &rects[i + 1..] {
                    assert!(a.intersect(b).is_none(), "{a:?} 与 {b:?} 重叠");
                }
            }
        }
    }

    /// 跨两台显示器的窗口归相交面积大的那一台，整窗按它换算。
    #[test]
    fn a_straddling_window_belongs_to_the_display_it_mostly_covers() {
        let mostly_external = frame(1400.0, 0.0, 800.0, 600.0);
        let placed = place(&[BUILT_IN, EXTERNAL], mostly_external).expect("有显示器");
        assert_eq!(placed.frame.monitor, 2);
        // 伸到内建屏上的那 112 点也按外接屏的每点 1 个像素算。
        assert_eq!(placed.frame.window, rect(2912, -200, 800, 600));
        let mostly_built_in = frame(1000.0, 0.0, 800.0, 600.0);
        assert_eq!(
            place(&[BUILT_IN, EXTERNAL], mostly_built_in)
                .expect("有显示器")
                .frame
                .monitor,
            1
        );
    }

    /// 不与任何显示器相交的窗口按主显示器换算；面积相同时取清单里靠前的那一台。
    #[test]
    fn an_offscreen_window_falls_back_to_the_main_display() {
        let lost = frame(-9000.0, -9000.0, 100.0, 100.0);
        assert_eq!(
            place(&[EXTERNAL, BUILT_IN], lost)
                .expect("有显示器")
                .frame
                .monitor,
            1
        );
        let twin = Display { id: 9, ..BUILT_IN };
        assert_eq!(
            place(&[BUILT_IN, twin], frame(0.0, 0.0, 10.0, 10.0))
                .expect("有显示器")
                .frame
                .monitor,
            1
        );
    }

    /// 没有可用的显示器时不给换算：比例为零或非有限的显示器不算。
    #[test]
    fn without_a_usable_display_there_is_no_mapping() {
        assert!(place(&[], frame(0.0, 0.0, 10.0, 10.0)).is_none());
        let broken = Display {
            scale: f64::NAN,
            ..BUILT_IN
        };
        let blank = Display {
            scale: 0.0,
            ..BUILT_IN
        };
        assert!(place(&[broken, blank], frame(0.0, 0.0, 10.0, 10.0)).is_none());
    }

    /// 四条边分别取整：半点边界在每点 1 个像素时，相邻的两个矩形换算之后仍然相邻。
    #[test]
    fn adjacent_frames_stay_adjacent_after_rounding() {
        let placed = place(&[EXTERNAL], EXTERNAL.bounds).expect("有显示器");
        let a = placed.mapping.rect(frame(1600.0, 0.0, 10.5, 20.0));
        let b = placed.mapping.rect(frame(1610.5, 0.0, 10.5, 20.0));
        assert_eq!(a.right(), b.x);
    }

    /// 窗口换到另一台显示器、或者显示器的比例变了，代际都变。
    #[test]
    fn the_generation_follows_the_display_and_its_scale() {
        let bounds = frame(100.0, 100.0, 400.0, 300.0);
        let base = place(&[BUILT_IN], bounds)
            .expect("有显示器")
            .frame
            .generation();
        let scaled = Display {
            scale: 1.0,
            ..BUILT_IN
        };
        assert_ne!(
            place(&[scaled], bounds)
                .expect("有显示器")
                .frame
                .generation(),
            base
        );
        let renamed = Display { id: 7, ..BUILT_IN };
        assert_ne!(
            place(&[renamed], bounds)
                .expect("有显示器")
                .frame
                .generation(),
            base
        );
    }
}
