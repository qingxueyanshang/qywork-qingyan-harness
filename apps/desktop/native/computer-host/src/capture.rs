//! Windows 图像采集：Windows Graphics Capture 取帧、WIC 缩放与 PNG 编码。
//!
//! 五条边界：
//!
//! 1. **按窗口采，不采屏再裁。** 采屏再裁会把别的窗口的内容带进来，还要求目标窗口在
//!    前台；WGC 的窗口采集对被遮挡的窗口同样交回它自己的内容。
//! 2. **退路只有 `PrintWindow(PW_RENDERFULLCONTENT)`。** 它依赖目标应用响应 `WM_PRINT`，
//!    画不全的部分在图上是黑的，因此采集方式如实记进观察，调用方分得出两者。
//! 3. **不置前台、不设焦点、不动指针。** 采集全程只读窗口属性与合成器的帧。
//! 4. **WGC 帧的原点是 DWM 的可见边框，不是 `GetWindowRect`。** 后者含不可见的调整边框，
//!    拿它当原点会让图像坐标与屏幕坐标整体错开几个像素。
//! 5. **进程必须是 per-monitor v2 DPI 感知。** 不是的话窗口矩形被系统虚拟化过，图像几何
//!    与控件包围盒不在同一套坐标上，采集请求一律拒绝。

use std::ffi::c_void;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ::windows::core::Interface;
use ::windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use ::windows::Graphics::DirectX::DirectXPixelFormat;
use ::windows::Graphics::SizeInt32;
use ::windows::Win32::Foundation::{HGLOBAL, HWND, RECT};
use ::windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use ::windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_FLAG,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use ::windows::Win32::Graphics::Dxgi::IDXGIDevice;
use ::windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use ::windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, IWICBitmapFrameEncode, IWICBitmapSource, IWICImagingFactory,
    GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGR, WICBitmapEncoderNoCache,
    WICBitmapInterpolationModeFant,
};
use ::windows::Win32::System::Com::StructuredStorage::{
    CreateStreamOnHGlobal, IPropertyBag2,
};
use ::windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STATFLAG_NONAME, STATSTG};
use ::windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use ::windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use ::windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use ::windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use ::windows::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, GetDpiForWindow, GetThreadDpiAwarenessContext,
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, GetWindowRect, IsIconic, IsWindow, PW_RENDERFULLCONTENT, SM_CMONITORS,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::geometry::{crop_for, generation_matches, Geometry, ScreenRect, WindowFrame};
use crate::protocol::{now_ms, Image};

/// 采集方式。图像观察如实带上它。
pub const SOURCE_WGC: &str = "wgc";
pub const SOURCE_PRINT_WINDOW: &str = "print_window";

/// 取帧的轮询间隔。WGC 的帧由合成器推过来，第一帧通常在一两个合成周期内到。
const FRAME_POLL: Duration = Duration::from_millis(8);

/// 采集计数。只在 debug 构建里存在，与读树的跨进程调用计数同一套做法：
/// 取出即清零，因此一次结构化观察打出来的那一行恒为 0。
#[cfg(debug_assertions)]
static CAPTURES: AtomicU64 = AtomicU64::new(0);

/// 记一次真的取到了像素的采集。
#[inline(always)]
fn note_capture() {
    #[cfg(debug_assertions)]
    CAPTURES.fetch_add(1, Ordering::Relaxed);
}

/// 取出并清零采集计数。release 构建里恒为 0。
pub fn take_captures() -> u64 {
    #[cfg(debug_assertions)]
    {
        CAPTURES.swap(0, Ordering::Relaxed)
    }
    #[cfg(not(debug_assertions))]
    {
        0
    }
}

/// 把本进程设成 per-monitor v2 DPI 感知，并把实际生效的模式读回来。
///
/// **必须在任何窗口矩形或 DPI 查询之前调用一次。** 设晚了，系统已经按虚拟化的坐标
/// 回答过问题，而那些答案不会重来。返回值是读回来的实际模式，不是设置调用的成败。
pub fn set_per_monitor_v2() -> bool {
    // SAFETY: 两个调用都只改本进程本线程的 DPI 感知模式，不接受外部指针。
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
        .as_bool()
    }
}

/// 一次采集的全部输入。
pub struct CaptureRequest<'a> {
    pub window: i64,
    /// 要采的屏幕物理像素矩形。缺席表示整窗。
    pub region: Option<ScreenRect>,
    /// 要求窗口几何代际仍是这一个。
    pub expect_generation: Option<&'a str>,
    pub max_edge: u32,
    pub max_bytes: u32,
    pub budget: Duration,
}

/// 采集器。D3D 设备、WinRT 设备与 WIC 工厂各建一次，按 worker 进程存活。
///
/// 与 UIA 的 `Backend` 同理：COM 单元属于线程，必须在要用它的那条线程上构造。
pub struct Capturer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt_device: ::windows::Graphics::DirectX::Direct3D11::IDirect3DDevice,
    wic: IWICImagingFactory,
    /// 这台机器支不支持 WGC。不支持时整条路径直接走退路。
    wgc: bool,
}

impl Capturer {
    pub fn new() -> Result<Self, String> {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        // SAFETY: 三个出参都是本函数的局部变量，其余入参为空。
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                ::windows::Win32::Foundation::HMODULE::default(),
                // BGRA 支持是 WGC 帧格式的前提。
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(|e| format!("建 D3D11 设备失败：{e}"))?;
        let device = device.ok_or("D3D11 设备为空")?;
        let context = context.ok_or("D3D11 设备上下文为空")?;
        let dxgi: IDXGIDevice = device
            .cast()
            .map_err(|e| format!("取 DXGI 设备失败：{e}"))?;
        // SAFETY: dxgi 由本函数持有，出参是局部变量。
        let winrt_device = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .map_err(|e| format!("建 WinRT D3D 设备失败：{e}"))?
            .cast()
            .map_err(|e| format!("WinRT D3D 设备转换失败：{e}"))?;
        // SAFETY: CLSID 是常量，无外部指针。
        let wic: IWICImagingFactory =
            unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| format!("建 WIC 工厂失败：{e}"))?;
        let wgc = GraphicsCaptureSession::IsSupported().unwrap_or(false);
        Ok(Self {
            device,
            context,
            winrt_device,
            wic,
            wgc,
        })
    }

    /// 采一张图。返回 `Err(原因)` 时一个像素都没采。
    pub fn capture(&self, req: &CaptureRequest<'_>) -> Result<Image, String> {
        let hwnd = HWND(req.window as *mut c_void);
        // SAFETY: 只读窗口状态。
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err("target_lost: 窗口句柄已失效".to_owned());
        }
        // SAFETY: 同上。
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return Err("window_minimized: 窗口已最小化，采不到内容".to_owned());
        }
        let frame = window_frame(hwnd)?;
        let generation = frame.generation();
        if !generation_matches(req.expect_generation, &generation) {
            return Err(format!(
                "geometry_changed: 窗口几何已经变了（{} → {generation}），请重新采图",
                req.expect_generation.unwrap_or_default()
            ));
        }
        if frame.window.width <= 0 || frame.window.height <= 0 {
            return Err("window_zero_size: 窗口尺寸为零，采不到内容".to_owned());
        }

        let started = Instant::now();
        let (pixels, source) = match self.wgc.then(|| self.wgc_pixels(hwnd, &frame, req.budget)) {
            Some(Ok(pixels)) => (pixels, SOURCE_WGC),
            Some(Err(wgc_error)) => (
                self.print_window_pixels(hwnd, &frame)
                    .map_err(|e| format!("capture_failed: WGC {wgc_error}；退路 {e}"))?,
                SOURCE_PRINT_WINDOW,
            ),
            None => (
                self.print_window_pixels(hwnd, &frame)
                    .map_err(|e| format!("capture_failed: 本机不支持 WGC；退路 {e}"))?,
                SOURCE_PRINT_WINDOW,
            ),
        };
        note_capture();
        // 取到像素之后一律报一行成本：计数器在这里清零，漏报一次会让它累加到下一条
        // 请求的那一行上，而「结构化观察采集计数为零」正是按那一行判的。
        let built = self.finish(req, &frame, generation, source, &pixels);
        report_capture_cost(source, built.as_ref(), started);
        built
    }

    /// 裁剪、编码、核字节上限，成功即组装观察。
    fn finish(
        &self,
        req: &CaptureRequest<'_>,
        frame: &WindowFrame,
        generation: String,
        source: &'static str,
        pixels: &Pixels,
    ) -> Result<Image, String> {
        let crop = crop_for(
            (pixels.origin.0, pixels.origin.1),
            pixels.width,
            pixels.height,
            req.region,
            req.max_edge,
        )
        .ok_or_else(|| {
            format!(
                "region_outside_window: 要采的区域与窗口覆盖的 {},{} {}×{} 没有交集",
                pixels.origin.0, pixels.origin.1, pixels.width, pixels.height
            )
        })?;

        let bytes = self.encode_png(pixels, crop)?;
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
            source,
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

    /// 走 WGC 取一帧。
    ///
    /// 用自由线程的帧池并轮询：事件回调要一条带消息泵的线程，而 worker 的执行线程是
    /// MTA，回调进不来。
    fn wgc_pixels(&self, hwnd: HWND, frame: &WindowFrame, budget: Duration) -> Result<Pixels, String> {
        let interop: IGraphicsCaptureItemInterop =
            ::windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                .map_err(|e| format!("取采集接口失败：{e}"))?;
        // SAFETY: 句柄在上一层已经核过还在。
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd) }
            .map_err(|e| format!("窗口建采集项失败：{e}"))?;
        let size: SizeInt32 = item.Size().map_err(|e| format!("读采集项尺寸失败：{e}"))?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err("采集项尺寸为零".to_owned());
        }
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &self.winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )
        .map_err(|e| format!("建帧池失败：{e}"))?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|e| format!("建采集会话失败：{e}"))?;
        // 指针不进图：模型按控件包围盒与图像几何定位，多一个随时在动的光标只会让同一个
        // 界面采两次得到两张不同的图。
        let _ = session.SetIsCursorCaptureEnabled(false);
        // 关采集边框的开关在 `IGraphicsCaptureSession3` 上，只有 Windows 11 提供；
        // 更早的系统上这一句返回接口不存在。图上有没有那一圈边框只能靠人眼核，
        // debug 构建把接口的返回码打出来，人眼看图时对得上号。
        let border = session.SetIsBorderRequired(false);
        #[cfg(debug_assertions)]
        eprintln!(
            "capture border_api={}",
            border
                .as_ref()
                .map_or_else(|e| format!("{:#010x}", e.code().0), |()| "ok".to_owned())
        );
        let _ = &border;
        session
            .StartCapture()
            .map_err(|e| format!("启动采集失败：{e}"))?;

        let until = Instant::now() + budget;
        let outcome = loop {
            match pool.TryGetNextFrame() {
                Ok(captured) => break self.read_frame(&captured, frame),
                Err(e) => {
                    if Instant::now() >= until {
                        break Err(format!("等不到采集帧：{e}"));
                    }
                    std::thread::sleep(FRAME_POLL);
                }
            }
        };
        // 会话与帧池都要显式关：它们持着合成器那一侧的资源，等 Drop 会让同一个窗口的
        // 下一次采集撞上一个还没释放的会话。
        let _ = session.Close();
        let _ = pool.Close();
        outcome
    }

    /// 把一帧的像素读到内存。
    fn read_frame(
        &self,
        captured: &::windows::Graphics::Capture::Direct3D11CaptureFrame,
        frame: &WindowFrame,
    ) -> Result<Pixels, String> {
        let content = captured
            .ContentSize()
            .map_err(|e| format!("读帧内容尺寸失败：{e}"))?;
        let surface = captured.Surface().map_err(|e| format!("取帧表面失败：{e}"))?;
        let access: IDirect3DDxgiInterfaceAccess = surface
            .cast()
            .map_err(|e| format!("取帧表面的 DXGI 接口失败：{e}"))?;
        // SAFETY: access 由本函数持有，出参是局部变量。
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }
            .map_err(|e| format!("取帧纹理失败：{e}"))?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: desc 是本栈帧上的结构体。
        unsafe { texture.GetDesc(&mut desc) };
        // 帧池按采集项尺寸分配，内容尺寸可能小于纹理：多出来的那一圈是上一帧的残留。
        let width = desc.Width.min(content.Width.max(0) as u32);
        let height = desc.Height.min(content.Height.max(0) as u32);
        if width == 0 || height == 0 {
            return Err("帧内容尺寸为零".to_owned());
        }
        let bgra = self.download(&texture, &desc, width, height)?;
        Ok(Pixels {
            bgra,
            width,
            height,
            // WGC 帧的原点是 DWM 的可见边框，不是 GetWindowRect。
            origin: (frame.visible.x, frame.visible.y),
        })
    }

    /// 把 GPU 纹理复制到暂存纹理再映射到内存。GPU 纹理本身不能直接被 CPU 读。
    fn download(
        &self,
        texture: &ID3D11Texture2D,
        desc: &D3D11_TEXTURE2D_DESC,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            BindFlags: D3D11_BIND_FLAG(0).0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
            ..*desc
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        // SAFETY: 描述符是本栈帧上的结构体，出参是局部变量。
        unsafe { self.device.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }
            .map_err(|e| format!("建暂存纹理失败：{e}"))?;
        let staging = staging.ok_or("暂存纹理为空")?;
        // SAFETY: 两个纹理都由本函数持有。
        unsafe { self.context.CopyResource(&staging, texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: mapped 是本栈帧上的结构体；出口处一定 Unmap。
        unsafe { self.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
            .map_err(|e| format!("映射暂存纹理失败：{e}"))?;
        let row = width as usize * 4;
        let mut out = vec![0u8; row * height as usize];
        // SAFETY: 映射有效期内按 RowPitch 逐行复制，每行只读 row 个字节，不越出纹理宽度。
        unsafe {
            let src = mapped.pData.cast::<u8>();
            for y in 0..height as usize {
                std::ptr::copy_nonoverlapping(
                    src.add(y * mapped.RowPitch as usize),
                    out.as_mut_ptr().add(y * row),
                    row,
                );
            }
            self.context.Unmap(&staging, 0);
        }
        Ok(out)
    }

    /// 退路：让窗口把自己画进一张位图。
    ///
    /// 它不要求窗口在前台，但要目标应用响应 `WM_PRINT`；不响应的那些交回全黑或半张图，
    /// 因此采集方式要如实记进观察。
    fn print_window_pixels(&self, hwnd: HWND, frame: &WindowFrame) -> Result<Pixels, String> {
        let width = frame.window.width;
        let height = frame.window.height;
        // SAFETY: 以下 GDI 调用成对申请与释放，出口处逐个清理。
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("取屏幕 DC 失败".to_owned());
            }
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
            // PW_RENDERFULLCONTENT 要求连非客户区一起画。少了它，DirectComposition 窗口
            // （Chromium 一类）交回的是一张全黑的图。
            let printed = PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT));
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
                    biWidth: width,
                    // 负高度表示自上而下的行序。正数会让整张图上下翻转。
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let row = width as usize * 4;
            let mut out = vec![0u8; row * height as usize];
            let copied = GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                Some(out.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            );
            SelectObject(memory, previous);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            if !printed.as_bool() {
                return Err("PrintWindow 被目标窗口拒绝".to_owned());
            }
            if copied == 0 {
                return Err("GetDIBits 没有取到像素".to_owned());
            }
            Ok(Pixels {
                bgra: out,
                width: width as u32,
                height: height as u32,
                origin: (frame.window.x, frame.window.y),
            })
        }
    }

    /// 裁剪、缩放并编码成 PNG。缩放与编码都走 WIC，不引第三方图像库。
    fn encode_png(&self, pixels: &Pixels, crop: crate::geometry::Crop) -> Result<Vec<u8>, String> {
        let row = pixels.width as usize * 4;
        let mut cropped = Vec::with_capacity(crop.width as usize * 4 * crop.height as usize);
        for y in 0..crop.height as usize {
            let at = (crop.y as usize + y) * row + crop.x as usize * 4;
            cropped.extend_from_slice(&pixels.bgra[at..at + crop.width as usize * 4]);
        }
        // SAFETY: 以下 WIC 调用只接受本函数持有的对象与栈上缓冲区。
        unsafe {
            let bitmap = self
                .wic
                .CreateBitmapFromMemory(
                    crop.width,
                    crop.height,
                    &GUID_WICPixelFormat32bppBGR,
                    crop.width * 4,
                    &cropped,
                )
                .map_err(|e| format!("建 WIC 位图失败：{e}"))?;
            let source: IWICBitmapSource = if crop.image_width == crop.width
                && crop.image_height == crop.height
            {
                bitmap.cast().map_err(|e| format!("位图转换失败：{e}"))?
            } else {
                let scaler = self
                    .wic
                    .CreateBitmapScaler()
                    .map_err(|e| format!("建缩放器失败：{e}"))?;
                scaler
                    .Initialize(
                        &bitmap,
                        crop.image_width,
                        crop.image_height,
                        WICBitmapInterpolationModeFant,
                    )
                    .map_err(|e| format!("缩放失败：{e}"))?;
                scaler.cast().map_err(|e| format!("缩放器转换失败：{e}"))?
            };
            let stream = CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true)
                .map_err(|e| format!("建内存流失败：{e}"))?;
            let encoder = self
                .wic
                .CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())
                .map_err(|e| format!("建 PNG 编码器失败：{e}"))?;
            encoder
                .Initialize(&stream, WICBitmapEncoderNoCache)
                .map_err(|e| format!("初始化编码器失败：{e}"))?;
            let mut frame: Option<IWICBitmapFrameEncode> = None;
            let mut options: Option<IPropertyBag2> = None;
            encoder
                .CreateNewFrame(&mut frame, &mut options)
                .map_err(|e| format!("建编码帧失败：{e}"))?;
            let frame = frame.ok_or("编码帧为空")?;
            frame
                .Initialize(options.as_ref())
                .map_err(|e| format!("初始化编码帧失败：{e}"))?;
            frame
                .SetSize(crop.image_width, crop.image_height)
                .map_err(|e| format!("设编码尺寸失败：{e}"))?;
            let mut format = GUID_WICPixelFormat32bppBGR;
            frame
                .SetPixelFormat(&mut format)
                .map_err(|e| format!("设编码像素格式失败：{e}"))?;
            frame
                .WriteSource(&source, std::ptr::null())
                .map_err(|e| format!("写编码帧失败：{e}"))?;
            frame.Commit().map_err(|e| format!("提交编码帧失败：{e}"))?;
            encoder
                .Commit()
                .map_err(|e| format!("提交编码器失败：{e}"))?;

            let mut stat = STATSTG::default();
            stream
                .Stat(&mut stat, STATFLAG_NONAME)
                .map_err(|e| format!("读流长度失败：{e}"))?;
            let length = usize::try_from(stat.cbSize).map_err(|_| "流长度越界".to_owned())?;
            let handle = ::windows::Win32::System::Com::StructuredStorage::GetHGlobalFromStream(
                &stream,
            )
            .map_err(|e| format!("取流内存失败：{e}"))?;
            let base = GlobalLock(handle);
            if base.is_null() {
                return Err("锁定流内存失败".to_owned());
            }
            let mut out = vec![0u8; length];
            std::ptr::copy_nonoverlapping(base.cast::<u8>(), out.as_mut_ptr(), length);
            let _ = GlobalUnlock(handle);
            Ok(out)
        }
    }
}

/// 一帧的像素与它覆盖的屏幕原点。行序自上而下，每像素 4 字节 BGRA。
struct Pixels {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
    origin: (i32, i32),
}

/// 读窗口此刻的几何事实。
fn window_frame(hwnd: HWND) -> Result<WindowFrame, String> {
    let mut window = RECT::default();
    // SAFETY: 出参是本栈帧上的结构体。
    unsafe { GetWindowRect(hwnd, &mut window) }.map_err(|e| format!("读窗口矩形失败：{e}"))?;
    let mut visible = RECT::default();
    // DWM 的可见边框取不到时退回窗口矩形：两者只差不可见的调整边框，
    // 而 `PrintWindow` 退路本来就按窗口矩形取景。
    // SAFETY: 出参是本栈帧上的结构体，长度按类型给。
    let visible = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            std::ptr::addr_of_mut!(visible).cast(),
            u32::try_from(std::mem::size_of::<RECT>()).unwrap_or(16),
        )
    }
    .map_or(window, |()| visible);
    // SAFETY: 只读窗口所在显示器与它的 DPI。
    let (dpi, monitor) = unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        (GetDpiForWindow(hwnd), monitor.0 as i64)
    };
    Ok(WindowFrame {
        window: rect_of(window),
        visible: rect_of(visible),
        // DPI 读不出来时按 96 记：它只进几何供调用方读，不参与坐标换算。
        dpi: if dpi == 0 { 96 } else { dpi },
        monitor,
    })
}

fn rect_of(r: RECT) -> ScreenRect {
    ScreenRect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// 本机的显示器配置与虚拟桌面范围，进 worker 启动日志。只读，不改任何显示设置。
///
/// 它要在 `set_per_monitor_v2` 之后读：DPI 感知没设上时系统交回的是虚拟化过的尺寸。
pub fn monitor_report() -> String {
    // SAFETY: 五个指标都是无参只读查询。
    let virtual_screen = unsafe {
        format!(
            "virtual {},{} {}×{} monitors={}",
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
            GetSystemMetrics(SM_CMONITORS),
        )
    };
    let mut out: Vec<String> = vec![virtual_screen];
    // SAFETY: 回调只在本次调用期间运行，lparam 指向本栈帧上的 out。
    unsafe {
        let _ = ::windows::Win32::Graphics::Gdi::EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            ::windows::Win32::Foundation::LPARAM(std::ptr::addr_of_mut!(out) as isize),
        );
    }
    out.join(" | ")
}

unsafe extern "system" fn collect_monitor(
    monitor: ::windows::Win32::Graphics::Gdi::HMONITOR,
    _dc: ::windows::Win32::Graphics::Gdi::HDC,
    _clip: *mut RECT,
    lparam: ::windows::Win32::Foundation::LPARAM,
) -> ::windows::core::BOOL {
    let out = &mut *(lparam.0 as *mut Vec<String>);
    let mut info = MONITORINFO {
        cbSize: u32::try_from(std::mem::size_of::<MONITORINFO>()).unwrap_or(40),
        ..Default::default()
    };
    if GetMonitorInfoW(monitor, std::ptr::addr_of_mut!(info)).as_bool() {
        let r = info.rcMonitor;
        out.push(format!(
            "{},{} {}×{}{}",
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            if info.dwFlags & 1 == 1 { " primary" } else { "" }
        ));
    }
    ::windows::Win32::Foundation::TRUE
}

/// 把一次采集的方式、结果、字节数与耗时写到 stderr。只在 debug 构建里输出。
///
/// 成功与失败都要打：计数器在这里清零，失败时不打会让它累加到下一条请求那一行上。
fn report_capture_cost(source: &str, built: Result<&Image, &String>, started: Instant) {
    let captures = take_captures();
    #[cfg(debug_assertions)]
    {
        let outcome = match built {
            Ok(image) => {
                // base64 每 4 个字符携带 3 个字节，末尾的 `=` 各抵消一个。
                let padding = image.bytes.bytes().rev().take_while(|b| *b == b'=').count();
                format!(
                    "size={}x{} bytes={}",
                    image.geometry.image_width,
                    image.geometry.image_height,
                    image.bytes.len() / 4 * 3 - padding
                )
            }
            Err(reason) => format!("failed={reason}"),
        };
        eprintln!(
            "cost capture_image source={source} {outcome} captures={captures} elapsed_ms={:.3}",
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (source, built, captures, started);
    }
}

/// 标准 base64。图像字节要经行分隔 JSON 交给宿主，不能按原始字节走。
fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0x00, 0xff, 0x80]), "AP+A");
    }

    /// 最小化的窗口与失效句柄在采集之前就被挡下，一个像素都不采。
    #[test]
    fn an_invalid_handle_never_reaches_the_capture_path() {
        let capturer = match Capturer::new() {
            Ok(c) => c,
            // 没有图形会话或没有 D3D 设备的环境里这条用例不成立，跳过而不是假装通过。
            Err(_) => return,
        };
        let before = take_captures();
        let outcome = capturer.capture(&CaptureRequest {
            window: 1,
            region: None,
            expect_generation: None,
            max_edge: 1568,
            max_bytes: 4 << 20,
            budget: Duration::from_millis(200),
        });
        assert!(outcome.is_err());
        assert!(outcome.unwrap_err().starts_with("target_lost"));
        assert_eq!(take_captures(), 0, "被拒的请求不得记一次采集");
        let _ = before;
    }

    /// DPI 感知模式是从 OS 读回来的实际值。worker 在 `main` 最前面设过一次，
    /// 单测进程没设，因此这里只要求这个查询本身可用。
    #[test]
    fn the_dpi_awareness_query_reads_back_from_the_os() {
        let first = set_per_monitor_v2();
        assert_eq!(first, set_per_monitor_v2(), "同一进程里读回来的模式必须稳定");
    }
}
