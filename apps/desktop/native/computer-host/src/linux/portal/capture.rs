//! 从共享的流里取一张窗口的图。
//!
//! 图像几何按流的逻辑坐标给（见上级模块第 4 条）：`screen` 的原点是窗口左上角，交给模型的
//! 像素数按帧的像素算，两者之比就是缩放比。`dpi` 是这个缩放比的读数，96 是 100%。

use crate::png;
use super::{ledger, pipewire, Grant};
use crate::backend::CaptureRequest;
use crate::geometry::{crop_for, fit, generation_matches, Geometry, ScreenRect};
use crate::protocol::{base64, now_ms, Image};

/// 采集方式。图像观察如实带上它。
pub const SOURCE_SCREEN_CAST: &str = "portal_screen_cast";

/// 采一张图。`generation` 是这个窗口此刻的几何代际，见 `super::generation`。
pub fn capture(
    grant: &Grant,
    generation: String,
    req: &CaptureRequest<'_>,
) -> Result<Image, String> {
    if !generation_matches(req.expect_generation, &generation) {
        return Err(format!(
            "geometry_changed: 窗口几何已经变了（{} → {generation}），请重新采图",
            req.expect_generation.unwrap_or_default()
        ));
    }
    let coverage = &grant.coverage;
    let remote = grant.bus().pipewire_remote(&coverage.session)?;
    let frame = pipewire::pull(remote, coverage.node, req.budget)?;
    let logical = ledger::logical_size(frame.crop, frame.video, coverage.size);
    let (Ok(lw), Ok(lh)) = (u32::try_from(logical.0), u32::try_from(logical.1)) else {
        return Err("window_zero_size: 窗口尺寸为零，采不到内容".to_owned());
    };
    let area = crop_for((0, 0), lw, lh, req.region, 0).ok_or_else(|| {
        format!("region_outside_window: 要采的区域与窗口覆盖的 0,0 {lw}×{lh} 没有交集")
    })?;
    let pixels = pixel_rect(area.screen, logical, frame.crop);
    let rgb = cut(&frame.rgb, frame.crop.0, pixels);
    let (image_width, image_height) = fit(
        pixels.width.unsigned_abs(),
        pixels.height.unsigned_abs(),
        req.max_edge,
    );
    let rgb = if (image_width, image_height)
        == (pixels.width.unsigned_abs(), pixels.height.unsigned_abs())
    {
        rgb
    } else {
        png::scale(
            &rgb,
            pixels.width.unsigned_abs(),
            pixels.height.unsigned_abs(),
            image_width,
            image_height,
        )
    };
    let bytes = png::encode(&rgb, image_width, image_height);
    if bytes.len() > req.max_bytes as usize {
        return Err(format!(
            "image_too_large: 编码后 {} 字节，上限 {}，改小区域再试",
            bytes.len(),
            req.max_bytes
        ));
    }
    Ok(Image {
        window: req.window,
        captured_at: now_ms(),
        source: SOURCE_SCREEN_CAST,
        geometry: Geometry {
            image_width,
            image_height,
            screen: area.screen,
            dpi: dpi(frame.crop.0, logical.0),
            generation,
        },
        mime: "image/png",
        bytes: base64(&bytes),
    })
}

/// 缩放比的读数：每个逻辑像素对应几个帧像素，乘以 96。
fn dpi(pixels: u32, logical: i32) -> u32 {
    if logical <= 0 {
        return 96;
    }
    (f64::from(pixels) * 96.0 / f64::from(logical)).round() as u32
}

/// 逻辑坐标里的一块换到帧像素里，夹在裁剪区之内。
fn pixel_rect(area: ScreenRect, logical: (i32, i32), crop: (u32, u32)) -> ScreenRect {
    let to_pixels = |v: i32, logical: i32, pixels: u32| -> i32 {
        if logical <= 0 {
            return v;
        }
        (f64::from(v) * f64::from(pixels) / f64::from(logical)).round() as i32
    };
    let max_w = i32::try_from(crop.0).unwrap_or(i32::MAX);
    let max_h = i32::try_from(crop.1).unwrap_or(i32::MAX);
    let x = to_pixels(area.x, logical.0, crop.0).clamp(0, max_w - 1);
    let y = to_pixels(area.y, logical.1, crop.1).clamp(0, max_h - 1);
    let right = to_pixels(area.right(), logical.0, crop.0).clamp(x + 1, max_w);
    let bottom = to_pixels(area.bottom(), logical.1, crop.1).clamp(y + 1, max_h);
    ScreenRect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    }
}

/// 从 RGB 帧（每行 `width` 个像素）里取出一块。`rect` 已经夹在帧里。
fn cut(rgb: &[u8], width: u32, rect: ScreenRect) -> Vec<u8> {
    let stride = width as usize * 3;
    let (x, y, w, h) = (
        rect.x.unsigned_abs() as usize,
        rect.y.unsigned_abs() as usize,
        rect.width.unsigned_abs() as usize,
        rect.height.unsigned_abs() as usize,
    );
    if x == 0 && w * 3 == stride {
        return rgb[y * stride..(y + h) * stride].to_vec();
    }
    let mut out = Vec::with_capacity(w * h * 3);
    for row in y..y + h {
        out.extend_from_slice(&rgb[row * stride + x * 3..row * stride + (x + w) * 3]);
    }
    out
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

    /// 缩放比 1：逻辑坐标就是帧像素；缩放比 2：翻倍，读数 192。
    #[test]
    fn a_logical_area_maps_onto_frame_pixels_by_the_stream_scale() {
        assert_eq!(
            pixel_rect(rect(36, 258, 340, 60), (412, 389), (412, 389)),
            rect(36, 258, 340, 60)
        );
        assert_eq!(
            pixel_rect(rect(36, 258, 340, 60), (412, 389), (824, 778)),
            rect(72, 516, 680, 120)
        );
        assert_eq!(dpi(412, 412), 96);
        assert_eq!(dpi(824, 412), 192);
        // 越出裁剪区的部分夹掉，不越界读帧。
        assert_eq!(
            pixel_rect(rect(400, 380, 50, 50), (412, 389), (412, 389)),
            rect(400, 380, 12, 9)
        );
    }

    #[test]
    fn a_sub_rectangle_is_cut_out_row_by_row() {
        // 3×2 的 RGB 帧，每个像素的三个字节都是它的序号。
        let rgb: Vec<u8> = (0u8..6).flat_map(|i| [i, i, i]).collect();
        assert_eq!(
            cut(&rgb, 3, rect(1, 0, 2, 2)),
            vec![1, 1, 1, 2, 2, 2, 4, 4, 4, 5, 5, 5]
        );
        assert_eq!(
            cut(&rgb, 3, rect(0, 1, 3, 1)),
            vec![3, 3, 3, 4, 4, 4, 5, 5, 5]
        );
    }
}
