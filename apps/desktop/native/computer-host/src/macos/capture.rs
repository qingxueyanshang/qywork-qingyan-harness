//! 按窗口取图：ScreenCaptureKit 的 `SCScreenshotManager` 取目标窗口自己的内容（被遮挡也取得到），
//! 画进一块已知排法的位图读出像素，按请求裁剪、缩放并编码成 PNG。
//!
//! 四条边界：
//!
//! 1. **`SCScreenshotManager` 从 macOS 14 起才有**，ScreenCaptureKit 本身从 12.3 起才有，worker 对它
//!    弱链接（`build.rs`）。取图前先查这个类在不在，不在即拒绝，一个 ScreenCaptureKit 的方法都不调：
//!    绑定库按名字找类，找不到时终止进程。
//! 2. **屏幕录制授权先查 `CGPreflightScreenCaptureAccess`**，没有授权即拒绝，不调 ScreenCaptureKit：
//!    没有授权时调它会以 worker 的名义弹出授权框，授权由外壳的设置页引导。
//! 3. **图的尺寸按窗口的像素矩形要**（`screen::Placed`），不按 ScreenCaptureKit 自己的比例，取回的图
//!    因此与控件包围盒、按图定位的落点是同一套像素。不取窗口阴影，部分在屏幕外的窗口不裁。
//! 4. 不置前台、不设焦点、不动指针。两次完成回调在 ScreenCaptureKit 自己的线程上跑：Objective-C
//!    对象只在回调里用，跨线程交回的只有 `CGImage`。

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::AnyClass;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    kCGColorSpaceSRGB, CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, CGPreflightScreenCaptureAccess,
};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{
    SCCaptureResolutionType, SCContentFilter, SCScreenshotManager, SCShareableContent,
    SCStreamConfiguration,
};

use super::screen::Placed;
use crate::backend::CaptureRequest;
use crate::geometry::{crop_for, generation_matches, Crop, Geometry};
use crate::png;
use crate::protocol::{base64, now_ms, Image};

/// 采集方式。图像观察如实带上它。
pub const SOURCE: &str = "screencapturekit";

/// 系统里有没有按窗口取图的接口。
pub fn available() -> bool {
    AnyClass::get(c"SCScreenshotManager").is_some()
}

/// 本进程有没有屏幕录制授权。只查不申请。
pub fn permitted() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// 采一张窗口 `number` 的图。`placed` 是它此刻的几何。返回 `Err(原因)` 时没有交出任何像素。
pub fn capture(number: u32, placed: &Placed, req: &CaptureRequest<'_>) -> Result<Image, String> {
    let generation = placed.frame.generation();
    if !generation_matches(req.expect_generation, &generation) {
        return Err(format!(
            "geometry_changed: 窗口几何已经变了（{} → {generation}），请重新采图",
            req.expect_generation.unwrap_or_default()
        ));
    }
    let area = placed.frame.visible;
    let (Ok(width), Ok(height)) = (usize::try_from(area.width), usize::try_from(area.height))
    else {
        return Err("window_zero_size: 窗口尺寸为零，采不到内容".to_owned());
    };
    if width == 0 || height == 0 {
        return Err("window_zero_size: 窗口尺寸为零，采不到内容".to_owned());
    }
    let image = shot(number, width, height, req.budget)?;
    let got = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
    // 取整误差以内的差别照收，裁剪按取回的实际尺寸算；差得更多说明图没有铺满窗口矩形，
    // 图上的位置对不上屏幕坐标。
    if got.0.abs_diff(width) > 1 || got.1.abs_diff(height) > 1 {
        return Err(format!(
            "capture_failed: 取回的图是 {}×{}，窗口是 {width}×{height} 像素",
            got.0, got.1
        ));
    }
    let crop = crop_for(
        (area.x, area.y),
        u32::try_from(got.0).unwrap_or(u32::MAX),
        u32::try_from(got.1).unwrap_or(u32::MAX),
        req.region,
        req.max_edge,
    )
    .ok_or_else(|| {
        format!(
            "region_outside_window: 要采的区域与窗口覆盖的 {},{} {}×{} 没有交集",
            area.x, area.y, area.width, area.height
        )
    })?;
    let mut rgb = cut(&image, got, &crop)?;
    if (crop.image_width, crop.image_height) != (crop.width, crop.height) {
        rgb = png::scale(
            &rgb,
            crop.width,
            crop.height,
            crop.image_width,
            crop.image_height,
        );
    }
    let bytes = png::encode(&rgb, crop.image_width, crop.image_height);
    if bytes.len() > req.max_bytes as usize {
        return Err(format!(
            "image_too_large: 编码后 {} 字节，上限 {}，改小区域再试",
            bytes.len(),
            req.max_bytes
        ));
    }
    Ok(Image {
        window: i64::from(number),
        captured_at: now_ms(),
        source: SOURCE,
        geometry: Geometry {
            image_width: crop.image_width,
            image_height: crop.image_height,
            screen: crop.screen,
            dpi: placed.frame.dpi,
            generation,
        },
        mime: "image/png",
        bytes: base64(&bytes),
    })
}

type Reply = Arc<Mutex<Option<Sender<Result<CFRetained<CGImage>, String>>>>>;

/// 交出结果。只有第一次交得出去：两个回调各自的失败路径都会走到这里。
fn deliver(reply: &Reply, result: Result<CFRetained<CGImage>, String>) {
    if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
        // 主路径可能已经等到期限放弃了。
        let _ = tx.send(result);
    }
}

/// 一次 ScreenCaptureKit 调用失败的原文。
fn failure(step: &str, error: *mut NSError) -> String {
    // SAFETY: 回调给的错误指针要么为空，要么在回调期间指向有效的 NSError。
    let text = unsafe { error.as_ref() }.map_or_else(
        || "没有错误信息".to_owned(),
        |e| format!("{}（{}）", e.localizedDescription(), e.code()),
    );
    format!("capture_failed: {step}失败：{text}")
}

/// 按窗口取一张 `width × height` 像素的 CGImage。
///
/// 先取可取内容的清单找到这个窗口，再按「独立窗口」过滤器取图。两步都是异步回调，在 `budget`
/// 内等不到即以 `capture_timeout` 拒绝；迟到的回调交不出结果，直接丢弃。
fn shot(
    number: u32,
    width: usize,
    height: usize,
    budget: Duration,
) -> Result<CFRetained<CGImage>, String> {
    let (tx, rx) = mpsc::channel();
    let reply: Reply = Arc::new(Mutex::new(Some(tx)));
    let listed = Arc::clone(&reply);
    let found = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: 回调期间内容指针要么为空，要么指向有效的对象。
            let Some(content) = (unsafe { content.as_ref() }) else {
                return deliver(&listed, Err(failure("读可取的窗口清单", error)));
            };
            // SAFETY: 清单在回调期间有效；窗口号是只读属性。
            let windows = unsafe { content.windows() }.to_vec();
            let Some(window) = windows.iter().find(|w| unsafe { w.windowID() } == number) else {
                return deliver(
                    &listed,
                    Err("target_lost: ScreenCaptureKit 的窗口清单里没有这个窗口".to_owned()),
                );
            };
            // SAFETY: 窗口对象来自上面的清单；过滤器与配置只在这个回调里建与设。
            let (filter, config) = unsafe {
                let filter = SCContentFilter::initWithDesktopIndependentWindow(
                    SCContentFilter::alloc(),
                    window,
                );
                let config = SCStreamConfiguration::new();
                config.setWidth(width);
                config.setHeight(height);
                config.setScalesToFit(true);
                config.setShowsCursor(false);
                config.setCaptureResolution(SCCaptureResolutionType::Best);
                config.setIgnoreShadowsSingleWindow(true);
                config.setIgnoreGlobalClipSingleWindow(true);
                (filter, config)
            };
            let shot = Arc::clone(&listed);
            let delivered = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                let result = match NonNull::new(image) {
                    // SAFETY: 回调给的是有效的 CGImage；持有一次引用之后在回调返回后仍然有效。
                    Some(image) => Ok(unsafe { CFRetained::retain(image) }),
                    None => Err(failure("取图", error)),
                };
                deliver(&shot, result);
            });
            // SAFETY: 过滤器、配置与回调块都是有效对象，调用方法期间由系统持有。
            unsafe {
                SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                    &filter,
                    &config,
                    Some(&delivered),
                );
            }
        },
    );
    // SAFETY: 回调块是有效对象，调用期间由系统持有。
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, false, &found,
        );
    }
    match rx.recv_timeout(budget) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(format!(
            "capture_timeout: ScreenCaptureKit 在 {} ms 内没有交回图像",
            budget.as_millis()
        )),
        Err(RecvTimeoutError::Disconnected) => {
            Err("capture_failed: ScreenCaptureKit 没有交回结果".to_owned())
        }
    }
}

/// 把整张图画进一块 sRGB、每像素 4 字节（R、G、B、空）的位图，再按 `crop` 取出那一块的 RGB。
///
/// 不要改成读 CGImage 自己的数据：它的排法由系统定（BGRA、带预乘、各种色彩空间都有），
/// 画进这块位图之后排法与色彩空间都是这里指定的那一种。
fn cut(image: &CGImage, (width, height): (usize, usize), crop: &Crop) -> Result<Vec<u8>, String> {
    let stride = width * 4;
    let mut data = vec![0u8; stride * height];
    // SAFETY: 系统导出的常量。
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
        .ok_or_else(|| "capture_failed: 建不了 sRGB 色彩空间".to_owned())?;
    // SAFETY: 缓冲区按 `stride × height` 分配，调用期间与位图同在；位图在这个函数返回前释放。
    let context = unsafe {
        CGBitmapContextCreate(
            data.as_mut_ptr().cast::<c_void>(),
            width,
            height,
            8,
            stride,
            Some(&space),
            CGImageAlphaInfo::NoneSkipLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )
    }
    .ok_or_else(|| "capture_failed: 建不了位图".to_owned())?;
    let whole = CGRect {
        origin: CGPoint { x: 0.0, y: 0.0 },
        size: CGSize {
            width: width as f64,
            height: height as f64,
        },
    };
    CGContext::draw_image(Some(&context), whole, Some(image));
    drop(context);
    let (x, y) = (crop.x as usize, crop.y as usize);
    let (w, h) = (crop.width as usize, crop.height as usize);
    let mut rgb = Vec::with_capacity(w * h * 3);
    for row in data[y * stride..(y + h) * stride].chunks_exact(stride) {
        for px in row[x * 4..(x + w) * 4].chunks_exact(4) {
            rgb.extend_from_slice(&px[..3]);
        }
    }
    Ok(rgb)
}
