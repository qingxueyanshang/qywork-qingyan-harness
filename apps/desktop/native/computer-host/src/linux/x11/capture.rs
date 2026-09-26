//! X11 取图：Composite 取窗口自己的内容，窗口被盖住或部分在屏幕外也取得到。
//!
//! 四条边界：
//!
//! 1. **按窗口取，不取屏再裁。** 取的是窗口在根窗口下那一层祖先（窗口管理器的外框）的
//!    pixmap，再按客户区裁；客户区外面是窗口管理器画的边框与标题栏。
//! 2. **重定向用 automatic。** 服务器照常把窗口画到屏幕上；不要改成 manual，那会让窗口从
//!    屏幕上消失，直到有合成器去画它。重定向随本进程的 X 连接存续，连接断开时服务器撤销。
//! 3. **本进程新重定向的窗口，重定向那一刻被盖住或在屏幕外的部分是屏幕上别的内容**：服务器
//!    按屏幕上的像素初始化 pixmap，再让应用重绘那几块。等 Damage 报的区域盖满它们才取；预算内
//!    没盖满即撤销重定向并拒绝，不交一张混着别的窗口的图。已经重定向过的窗口（合成器或本进程
//!    之前的采集）直接取。
//! 4. 不置前台、不设焦点、不动指针。

use std::time::{Duration, Instant};

use x11rb::connection::Connection as _;
use x11rb::errors::ReplyError;
use x11rb::protocol::composite::{ConnectionExt as _, Redirect};
use x11rb::protocol::damage::{ConnectionExt as _, ReportLevel};
use x11rb::protocol::xproto::{
    ConnectionExt as _, ImageFormat, ImageOrder, MapState, Pixmap, Window, WindowClass,
};
use x11rb::protocol::{ErrorKind, Event};

use super::{Display, Top};
use crate::backend::CaptureRequest;
use crate::geometry::{crop_for, fully_covered, generation_matches, Geometry, ScreenRect};
use crate::png;
use crate::protocol::{base64, now_ms, Image};

/// 采集方式。图像观察如实带上它。
pub const SOURCE_COMPOSITE: &str = "x11_composite";

impl Display {
    /// 采一张窗口的图。返回 `Err(原因)` 时没有交出任何像素。
    pub fn capture(&self, window: Window, req: &CaptureRequest<'_>) -> Result<Image, String> {
        let client = self
            .client(window)
            .ok_or_else(|| "target_lost: 窗口已经不在".to_owned())?;
        if client.hidden {
            return Err("window_minimized: 窗口已最小化，采不到内容".to_owned());
        }
        let frame = self.frame(&client)?;
        let generation = frame.generation();
        if !generation_matches(req.expect_generation, &generation) {
            return Err(format!(
                "geometry_changed: 窗口几何已经变了（{} → {generation}），请重新采图",
                req.expect_generation.unwrap_or_default()
            ));
        }
        let area = frame.visible;
        if area.width <= 0 || area.height <= 0 {
            return Err("window_zero_size: 窗口尺寸为零，采不到内容".to_owned());
        }
        let crop = crop_for(
            (area.x, area.y),
            area.width.unsigned_abs(),
            area.height.unsigned_abs(),
            req.region,
            req.max_edge,
        )
        .ok_or_else(|| {
            format!(
                "region_outside_window: 要采的区域与窗口覆盖的 {},{} {}×{} 没有交集",
                area.x, area.y, area.width, area.height
            )
        })?;
        let top = client
            .top
            .ok_or_else(|| "target_lost: 读不出窗口几何".to_owned())?;
        self.negotiate()?;
        let pixmap = self.pixmap(top, crop.screen, req.budget)?;
        let rgb = self.read(top, pixmap, crop.screen);
        let _ = self.conn.free_pixmap(pixmap);
        let _ = self.conn.flush();
        let mut rgb = rgb?;
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
            window: req.window,
            captured_at: now_ms(),
            source: SOURCE_COMPOSITE,
            geometry: Geometry {
                image_width: crop.image_width,
                image_height: crop.image_height,
                screen: crop.screen,
                dpi: frame.dpi,
                generation,
            },
            mime: "image/png",
            bytes: base64(&bytes),
        })
    }

    /// 与服务器协商 Composite 与 Damage 的版本。每条连接只做一次，扩展缺席即拒绝取图。
    fn negotiate(&self) -> Result<(), String> {
        self.extensions
            .get_or_init(|| {
                let composite = self
                    .conn
                    .composite_query_version(0, 4)
                    .map_err(|e| e.to_string())
                    .and_then(|c| c.reply().map_err(|e| e.to_string()));
                let damage = self
                    .conn
                    .damage_query_version(1, 1)
                    .map_err(|e| e.to_string())
                    .and_then(|c| c.reply().map_err(|e| e.to_string()));
                match (composite, damage) {
                    (Ok(_), Ok(_)) => Ok(()),
                    (Err(e), _) => Err(format!(
                        "capture_unavailable: X 服务器没有 Composite 扩展（{e}）"
                    )),
                    (_, Err(e)) => Err(format!(
                        "capture_unavailable: X 服务器没有 Damage 扩展（{e}）"
                    )),
                }
            })
            .clone()
    }

    /// 取 `top` 的 pixmap，必要时先重定向它并等重绘，见本模块第 3 条。
    fn pixmap(&self, top: Top, need: ScreenRect, budget: Duration) -> Result<Pixmap, String> {
        if let Some(pixmap) = self.name_pixmap(top.window)? {
            return Ok(pixmap);
        }
        let unseen = self.unseen(top.window, need);
        let damage = if unseen.is_empty() {
            None
        } else {
            Some(self.watch_damage(top.window)?)
        };
        self.conn
            .composite_redirect_window(top.window, Redirect::AUTOMATIC)
            .map_err(|e| e.to_string())
            .and_then(|c| c.check().map_err(|e| e.to_string()))
            .map_err(|e| format!("capture_failed: 重定向窗口失败 {e}"))?;
        if let Some(damage) = damage {
            let repainted = self.await_repaint(damage, top, &unseen, budget);
            let _ = self.conn.damage_destroy(damage);
            if !repainted {
                let _ = self
                    .conn
                    .composite_unredirect_window(top.window, Redirect::AUTOMATIC);
                let _ = self.conn.flush();
                return Err(format!(
                    "capture_incomplete: 窗口被盖住或在屏幕外的部分在 {} ms 内没有重绘完，没有取图",
                    budget.as_millis()
                ));
            }
        }
        self.name_pixmap(top.window)?
            .ok_or_else(|| "capture_failed: 重定向之后仍取不到窗口的 pixmap".to_owned())
    }

    /// 取窗口的 pixmap。窗口没有被重定向时服务器回 `BadMatch`，交回 `None`。
    fn name_pixmap(&self, window: Window) -> Result<Option<Pixmap>, String> {
        let pixmap = self
            .conn
            .generate_id()
            .map_err(|e| format!("capture_failed: 分配资源号失败 {e}"))?;
        let named = self
            .conn
            .composite_name_window_pixmap(window, pixmap)
            .map_err(|e| format!("capture_failed: {e}"))?
            .check();
        match named {
            Ok(()) => Ok(Some(pixmap)),
            Err(ReplyError::X11Error(e)) if e.error_kind == ErrorKind::Match => Ok(None),
            Err(e) => Err(format!("capture_failed: 取窗口 pixmap 失败 {e}")),
        }
    }

    /// `need` 里此刻看不见的部分：在屏幕外，或被层叠序在 `top` 上面、已映射的窗口盖住。
    ///
    /// 盖在上面的窗口按矩形算，形状窗口透明的角也算盖住。按根窗口的子窗口算而不按
    /// `_NET_CLIENT_LIST_STACKING`：弹出菜单这类不归窗口管理器管理的窗口只在前者里。
    fn unseen(&self, top: Window, need: ScreenRect) -> Vec<ScreenRect> {
        let mut out = need.subtract(&self.screen);
        let Some(inside) = need.intersect(&self.screen) else {
            return out;
        };
        let Ok(tree) = self
            .conn
            .query_tree(self.root)
            .map_err(|e| e.to_string())
            .and_then(|c| c.reply().map_err(|e| e.to_string()))
        else {
            return out;
        };
        // 请求先全部发出再收回执，一次往返读完所有兄弟窗口。
        let cookies: Vec<_> = tree
            .children
            .iter()
            .skip_while(|w| **w != top)
            .skip(1)
            .map(|w| {
                (
                    self.conn.get_window_attributes(*w),
                    self.conn.get_geometry(*w),
                )
            })
            .collect();
        for (attributes, geometry) in cookies {
            let (Ok(Ok(a)), Ok(Ok(g))) =
                (attributes.map(|c| c.reply()), geometry.map(|c| c.reply()))
            else {
                continue;
            };
            if a.map_state != MapState::VIEWABLE || a.class == WindowClass::INPUT_ONLY {
                continue;
            }
            let border = i32::from(g.border_width) * 2;
            let rect = ScreenRect {
                x: i32::from(g.x),
                y: i32::from(g.y),
                width: i32::from(g.width) + border,
                height: i32::from(g.height) + border,
            };
            if let Some(covered) = rect.intersect(&inside) {
                out.push(covered);
            }
        }
        out
    }

    fn watch_damage(&self, window: Window) -> Result<u32, String> {
        let damage = self
            .conn
            .generate_id()
            .map_err(|e| format!("capture_failed: 分配资源号失败 {e}"))?;
        self.conn
            .damage_create(damage, window, ReportLevel::RAW_RECTANGLES)
            .map_err(|e| e.to_string())
            .and_then(|c| c.check().map_err(|e| e.to_string()))
            .map_err(|e| format!("capture_failed: 建 Damage 失败 {e}"))?;
        Ok(damage)
    }

    /// 等应用重绘的区域盖满 `unseen`。Damage 报的矩形以 `top` 边框内的左上角为原点。
    fn await_repaint(
        &self,
        damage: u32,
        top: Top,
        unseen: &[ScreenRect],
        budget: Duration,
    ) -> bool {
        let origin = (top.outer.x + top.border, top.outer.y + top.border);
        let mut painted: Vec<ScreenRect> = Vec::new();
        self.wait_event(Instant::now() + budget, |event| {
            if let Event::DamageNotify(e) = event {
                if e.damage == damage {
                    painted.push(ScreenRect {
                        x: origin.0 + i32::from(e.area.x),
                        y: origin.1 + i32::from(e.area.y),
                        width: i32::from(e.area.width),
                        height: i32::from(e.area.height),
                    });
                }
            }
            unseen.iter().all(|r| fully_covered(*r, &painted))
        })
    }

    /// 从 pixmap 读出 `area` 那一块并换成 RGB。pixmap 的原点是外框（含 X 边框）的左上角。
    fn read(&self, top: Top, pixmap: Pixmap, area: ScreenRect) -> Result<Vec<u8>, String> {
        let layout = self.layout(top.window)?;
        let fail = |e: String| format!("capture_failed: 读窗口像素失败 {e}");
        let reply = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                pixmap,
                i16::try_from(area.x - top.outer.x).map_err(|e| fail(e.to_string()))?,
                i16::try_from(area.y - top.outer.y).map_err(|e| fail(e.to_string()))?,
                u16::try_from(area.width).map_err(|e| fail(e.to_string()))?,
                u16::try_from(area.height).map_err(|e| fail(e.to_string()))?,
                !0,
            )
            .map_err(|e| fail(e.to_string()))?
            .reply()
            .map_err(|e| fail(e.to_string()))?;
        layout.rgb(
            &reply.data,
            area.width.unsigned_abs() as usize,
            area.height.unsigned_abs() as usize,
        )
    }

    /// 窗口像素在 ZPixmap 里的排法：每像素位数、行对齐、字节序与三个颜色通道的掩码。
    fn layout(&self, window: Window) -> Result<Layout, String> {
        let unsupported = |why: String| format!("unsupported_pixel_format: {why}");
        let visual = self
            .conn
            .get_window_attributes(window)
            .map_err(|e| e.to_string())
            .and_then(|c| c.reply().map_err(|e| e.to_string()))
            .map_err(|e| format!("target_lost: 读窗口属性失败 {e}"))?
            .visual;
        let depth = self
            .conn
            .get_geometry(window)
            .map_err(|e| e.to_string())
            .and_then(|c| c.reply().map_err(|e| e.to_string()))
            .map_err(|e| format!("target_lost: 读窗口几何失败 {e}"))?
            .depth;
        let setup = self.conn.setup();
        let format = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == depth)
            .ok_or_else(|| unsupported(format!("没有深度 {depth} 的像素格式")))?;
        if format.bits_per_pixel != 32 {
            return Err(unsupported(format!(
                "深度 {depth} 每像素 {} 位，只支持 32 位",
                format.bits_per_pixel
            )));
        }
        let visual = setup
            .roots
            .iter()
            .flat_map(|s| s.allowed_depths.iter())
            .flat_map(|d| d.visuals.iter())
            .find(|v| v.visual_id == visual)
            .ok_or_else(|| unsupported(format!("找不到视觉 {visual}")))?;
        let shift = |mask: u32| -> Result<u32, String> {
            let at = mask.trailing_zeros();
            (mask >> at == 0xff && at <= 24)
                .then_some(at)
                .ok_or_else(|| unsupported(format!("颜色掩码 {mask:#x} 不是 8 位")))
        };
        Ok(Layout {
            pad: usize::from(format.scanline_pad),
            msb: setup.image_byte_order == ImageOrder::MSB_FIRST,
            shifts: [
                shift(visual.red_mask)?,
                shift(visual.green_mask)?,
                shift(visual.blue_mask)?,
            ],
        })
    }

    /// 逐个取事件交给 `seen`，它返回真即停。到期返回假。
    ///
    /// 本连接只订阅调用方此刻在等的那一类事件，其余事件交给 `seen` 之后丢弃。
    pub(super) fn wait_event(
        &self,
        deadline: Instant,
        mut seen: impl FnMut(&Event) -> bool,
    ) -> bool {
        loop {
            loop {
                match self.conn.poll_for_event() {
                    Ok(Some(event)) => {
                        if seen(&event) {
                            return true;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => return false,
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(EVENT_POLL);
        }
    }
}

/// 等事件时两次取事件之间隔多久。
const EVENT_POLL: Duration = Duration::from_millis(4);

/// ZPixmap 的像素排法，见 `Display::layout`。
struct Layout {
    /// 每行按多少位对齐。
    pad: usize,
    msb: bool,
    /// 红、绿、蓝在 32 位像素字里的位移。
    shifts: [u32; 3],
}

impl Layout {
    fn rgb(&self, data: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
        let pad = self.pad.max(8);
        let stride = (width * 32).div_ceil(pad) * pad / 8;
        if data.len() < stride * height {
            return Err(format!(
                "capture_failed: 像素数据 {} 字节，{width}×{height} 需要 {}",
                data.len(),
                stride * height
            ));
        }
        let mut out = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for px in data[y * stride..y * stride + width * 4].chunks_exact(4) {
                let bytes = [px[0], px[1], px[2], px[3]];
                let word = if self.msb {
                    u32::from_be_bytes(bytes)
                } else {
                    u32::from_le_bytes(bytes)
                };
                for shift in self.shifts {
                    out.push((word >> shift) as u8);
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 小端 BGRX：蓝在最低字节，读出来是 RGB 顺序。
    #[test]
    fn a_little_endian_word_splits_into_rgb() {
        let layout = Layout {
            pad: 32,
            msb: false,
            shifts: [16, 8, 0],
        };
        let data = [0x10, 0x20, 0x30, 0x00, 0xff, 0x00, 0x80, 0x00];
        assert_eq!(
            layout.rgb(&data, 2, 1).unwrap(),
            vec![0x30, 0x20, 0x10, 0x80, 0x00, 0xff]
        );
    }

    /// 大端 XRGB 与小端同一个像素值。
    #[test]
    fn a_big_endian_word_splits_into_the_same_rgb() {
        let layout = Layout {
            pad: 32,
            msb: true,
            shifts: [16, 8, 0],
        };
        assert_eq!(
            layout.rgb(&[0x00, 0x30, 0x20, 0x10], 1, 1).unwrap(),
            vec![0x30, 0x20, 0x10]
        );
    }

    #[test]
    fn short_pixel_data_is_refused() {
        let layout = Layout {
            pad: 32,
            msb: false,
            shifts: [16, 8, 0],
        };
        assert!(layout.rgb(&[0; 7], 2, 1).is_err());
    }
}
