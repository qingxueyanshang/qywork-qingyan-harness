//! 经 PipeWire 从一条 ScreenCast 流里取一帧。
//!
//! 四条边界：
//!
//! 1. **libpipewire-0.3 在运行时 dlopen。** 构建不要它的头文件与链接库，没装它的系统上 worker
//!    照常启动，只有这条取图路径报不可用。
//! 2. **每次取图单独建一次连接。** portal 交来的连接描述符、一条流、一个线程循环，取到一帧即全部
//!    拆掉。不要改成常驻的流：流被消费期间合成器按窗口的每次重绘出帧，没人取图时也一直在出。
//! 3. **等帧有上界。** 到点没有帧即失败，不交半张图；裁剪区、帧头标了损坏或数据为空的缓冲区
//!    不算一帧。
//! 4. **回调在线程循环的线程上执行，并持有循环锁。** 调用线程只在持锁期间读写 `Pull`，
//!    唯一放开锁的地方是 `pw_thread_loop_timed_wait_full`。

use std::ffi::{c_char, c_int, c_void, CStr};
use std::os::fd::{IntoRawFd, OwnedFd};
use std::ptr::{null, null_mut};
use std::sync::OnceLock;
use std::time::Duration;

use super::pod::{
    self, VideoFormat, META_HEADER, META_VIDEO_CROP, PARAM_FORMAT, VIDEO_ABGR, VIDEO_ARGB,
    VIDEO_BGRA, VIDEO_BGRX, VIDEO_RGBA, VIDEO_RGBX, VIDEO_XBGR, VIDEO_XRGB,
};

const LIBRARY: &CStr = c"libpipewire-0.3.so.0";
const STREAM_STATE_ERROR: c_int = -1;
const DIRECTION_INPUT: u32 = 0;
const FLAG_AUTOCONNECT: u32 = 1 << 0;
const FLAG_MAP_BUFFERS: u32 = 1 << 2;
const CHUNK_CORRUPTED: i32 = 1 << 0;
const HEADER_CORRUPTED: u32 = 1 << 1;
const STREAM_EVENTS_VERSION: u32 = 2;

#[repr(C)]
struct SpaBuffer {
    n_metas: u32,
    n_datas: u32,
    metas: *const SpaMeta,
    datas: *const SpaData,
}

#[repr(C)]
struct SpaMeta {
    kind: u32,
    size: u32,
    data: *const c_void,
}

#[repr(C)]
struct SpaData {
    kind: u32,
    flags: u32,
    fd: i64,
    mapoffset: u32,
    maxsize: u32,
    data: *const c_void,
    chunk: *const SpaChunk,
}

#[repr(C)]
struct SpaChunk {
    offset: u32,
    size: u32,
    stride: i32,
    flags: i32,
}

#[repr(C)]
struct PwBuffer {
    buffer: *const SpaBuffer,
}

/// `struct spa_hook`：链表两指针、回调两指针、`removed` 与 `priv`。由 PipeWire 填写，
/// 本模块只提供存放它的内存，必须在流销毁之后才释放。
#[repr(C)]
#[derive(Default)]
struct SpaHook {
    words: [usize; 6],
}

type Unused = Option<unsafe extern "C" fn()>;

/// `struct pw_stream_events`，版本 2。只接状态、参数与出帧三个回调。
#[repr(C)]
struct StreamEvents {
    version: u32,
    destroy: Unused,
    state_changed: Option<unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char)>,
    control_info: Unused,
    io_changed: Unused,
    param_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    add_buffer: Unused,
    remove_buffer: Unused,
    process: Option<unsafe extern "C" fn(*mut c_void)>,
    drained: Unused,
    command: Unused,
    trigger_done: Unused,
}

type Raw = *mut c_void;

/// 从 libpipewire 里取出的函数。
struct Api {
    thread_loop_new: unsafe extern "C" fn(*const c_char, *const c_void) -> Raw,
    thread_loop_get_loop: unsafe extern "C" fn(Raw) -> Raw,
    thread_loop_start: unsafe extern "C" fn(Raw) -> c_int,
    thread_loop_stop: unsafe extern "C" fn(Raw),
    thread_loop_lock: unsafe extern "C" fn(Raw),
    thread_loop_unlock: unsafe extern "C" fn(Raw),
    thread_loop_signal: unsafe extern "C" fn(Raw, bool),
    thread_loop_get_time: unsafe extern "C" fn(Raw, *mut libc::timespec, i64) -> c_int,
    thread_loop_timed_wait_full: unsafe extern "C" fn(Raw, *const libc::timespec) -> c_int,
    thread_loop_destroy: unsafe extern "C" fn(Raw),
    context_new: unsafe extern "C" fn(Raw, Raw, usize) -> Raw,
    context_connect_fd: unsafe extern "C" fn(Raw, c_int, Raw, usize) -> Raw,
    context_destroy: unsafe extern "C" fn(Raw),
    core_disconnect: unsafe extern "C" fn(Raw) -> c_int,
    properties_new_string: unsafe extern "C" fn(*const c_char) -> Raw,
    stream_new: unsafe extern "C" fn(Raw, *const c_char, Raw) -> Raw,
    stream_add_listener: unsafe extern "C" fn(Raw, *mut SpaHook, *const StreamEvents, Raw),
    stream_connect: unsafe extern "C" fn(Raw, u32, u32, u32, *const *const c_void, u32) -> c_int,
    stream_update_params: unsafe extern "C" fn(Raw, *const *const c_void, u32) -> c_int,
    stream_dequeue_buffer: unsafe extern "C" fn(Raw) -> *mut PwBuffer,
    stream_queue_buffer: unsafe extern "C" fn(Raw, *mut PwBuffer) -> c_int,
    stream_disconnect: unsafe extern "C" fn(Raw) -> c_int,
    stream_destroy: unsafe extern "C" fn(Raw),
}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn dl_error() -> String {
    // SAFETY: dlerror 交回的串归动态链接器所有，这里立即复制。
    let text = unsafe { libc::dlerror() };
    if text.is_null() {
        return String::new();
    }
    // SAFETY: 非空时是 NUL 结尾的 C 串。
    unsafe { CStr::from_ptr(text) }
        .to_string_lossy()
        .into_owned()
}

/// 进程内加载一次 libpipewire。失败的原因一并缓存：库在进程运行期间不会凭空出现。
fn api() -> Result<&'static Api, String> {
    API.get_or_init(load).as_ref().map_err(Clone::clone)
}

/// 这台机器上有没有可用的 libpipewire。
pub fn available() -> Result<(), String> {
    api().map(|_| ())
}

fn load() -> Result<Api, String> {
    // SAFETY: 以只读方式加载一个系统库；句柄不关闭，进程退出时由系统回收。
    let lib = unsafe { libc::dlopen(LIBRARY.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if lib.is_null() {
        return Err(format!(
            "capture_unavailable: 找不到 libpipewire-0.3.so.0，Wayland 下取图与认出共享的是哪个窗口都要经 PipeWire（{}）",
            dl_error()
        ));
    }
    macro_rules! sym {
        ($name:literal) => {{
            // SAFETY: 名字是 NUL 结尾的字面量。
            let found = unsafe { libc::dlsym(lib, concat!($name, "\0").as_ptr().cast()) };
            if found.is_null() {
                return Err(format!(
                    "capture_unavailable: libpipewire-0.3 里没有 {}（{}）",
                    $name,
                    dl_error()
                ));
            }
            // SAFETY: 符号的 C 签名与字段类型一致，取自 libpipewire-0.3 的公开头文件。
            unsafe { std::mem::transmute::<*mut c_void, _>(found) }
        }};
    }
    let init: unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char) = sym!("pw_init");
    let api = Api {
        thread_loop_new: sym!("pw_thread_loop_new"),
        thread_loop_get_loop: sym!("pw_thread_loop_get_loop"),
        thread_loop_start: sym!("pw_thread_loop_start"),
        thread_loop_stop: sym!("pw_thread_loop_stop"),
        thread_loop_lock: sym!("pw_thread_loop_lock"),
        thread_loop_unlock: sym!("pw_thread_loop_unlock"),
        thread_loop_signal: sym!("pw_thread_loop_signal"),
        thread_loop_get_time: sym!("pw_thread_loop_get_time"),
        thread_loop_timed_wait_full: sym!("pw_thread_loop_timed_wait_full"),
        thread_loop_destroy: sym!("pw_thread_loop_destroy"),
        context_new: sym!("pw_context_new"),
        context_connect_fd: sym!("pw_context_connect_fd"),
        context_destroy: sym!("pw_context_destroy"),
        core_disconnect: sym!("pw_core_disconnect"),
        properties_new_string: sym!("pw_properties_new_string"),
        stream_new: sym!("pw_stream_new"),
        stream_add_listener: sym!("pw_stream_add_listener"),
        stream_connect: sym!("pw_stream_connect"),
        stream_update_params: sym!("pw_stream_update_params"),
        stream_dequeue_buffer: sym!("pw_stream_dequeue_buffer"),
        stream_queue_buffer: sym!("pw_stream_queue_buffer"),
        stream_disconnect: sym!("pw_stream_disconnect"),
        stream_destroy: sym!("pw_stream_destroy"),
    };
    // SAFETY: 不传命令行参数；pw_init 可以重复调用。
    unsafe { init(null_mut(), null_mut()) };
    Ok(api)
}

/// 从流里取到的一帧，已换成 RGB。
pub struct Frame {
    /// 裁剪区的像素尺寸，即共享窗口在帧里占的那一块。
    pub crop: (u32, u32),
    /// 整帧的像素尺寸，协商好的视频尺寸。
    pub video: (u32, u32),
    pub rgb: Vec<u8>,
}

/// 回调与调用线程共用的状态，见本模块第 4 条。
struct Pull {
    api: &'static Api,
    thread_loop: Raw,
    stream: Raw,
    format: Option<VideoFormat>,
    frame: Option<Result<Frame, String>>,
    failed: Option<String>,
}

/// POD 按 8 字节对齐存放：PipeWire 按字读它。
fn aligned(bytes: &[u8]) -> Vec<u64> {
    bytes
        .chunks(8)
        .map(|c| {
            let mut word = [0u8; 8];
            word[..c.len()].copy_from_slice(c);
            u64::from_ne_bytes(word)
        })
        .collect()
}

unsafe extern "C" fn on_state(data: *mut c_void, _old: c_int, state: c_int, error: *const c_char) {
    // SAFETY: data 是 `pull` 里登记的 `Pull`，回调期间调用线程不持有它，见本模块第 4 条。
    let pull = unsafe { &mut *data.cast::<Pull>() };
    if state != STREAM_STATE_ERROR {
        return;
    }
    let detail = if error.is_null() {
        String::new()
    } else {
        // SAFETY: PipeWire 交来的错误串是 NUL 结尾的 C 串。
        unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned()
    };
    pull.failed = Some(format!("capture_failed: PipeWire 流出错：{detail}"));
    // SAFETY: 在循环线程上、持锁调用。
    unsafe { (pull.api.thread_loop_signal)(pull.thread_loop, false) };
}

unsafe extern "C" fn on_param(data: *mut c_void, id: u32, param: *const c_void) {
    // SAFETY: 同 `on_state`。
    let pull = unsafe { &mut *data.cast::<Pull>() };
    if id != PARAM_FORMAT || param.is_null() {
        return;
    }
    // SAFETY: param 指向一个完整的 POD，头 8 字节给出它的总长。
    let format = unsafe {
        let head = std::slice::from_raw_parts(param.cast::<u8>(), 8);
        pod::total_len(head)
            .map(|len| std::slice::from_raw_parts(param.cast::<u8>(), len))
            .and_then(pod::video_format)
    };
    pull.format = format;
    // 要求缓冲区带上裁剪区与帧头：没有裁剪区时整帧是显示器那么大，窗口只在左上角。
    let crop = aligned(&pod::meta(META_VIDEO_CROP));
    let header = aligned(&pod::meta(META_HEADER));
    let params = [
        crop.as_ptr().cast::<c_void>(),
        header.as_ptr().cast::<c_void>(),
    ];
    // SAFETY: 在循环线程上、持锁调用；PipeWire 复制参数，调用返回后即可释放。
    unsafe { (pull.api.stream_update_params)(pull.stream, params.as_ptr(), 2) };
}

unsafe extern "C" fn on_process(data: *mut c_void) {
    // SAFETY: 同 `on_state`。
    let pull = unsafe { &mut *data.cast::<Pull>() };
    let api = pull.api;
    // 只看最新的一块，更早的直接还回去。
    let mut newest: *mut PwBuffer = null_mut();
    loop {
        // SAFETY: 在循环线程上、持锁调用。
        let next = unsafe { (api.stream_dequeue_buffer)(pull.stream) };
        if next.is_null() {
            break;
        }
        if !newest.is_null() {
            // SAFETY: 同上；这块缓冲区刚从同一条流取出。
            unsafe { (api.stream_queue_buffer)(pull.stream, newest) };
        }
        newest = next;
    }
    if newest.is_null() {
        return;
    }
    if pull.frame.is_none() {
        // SAFETY: 缓冲区在还回去之前有效。
        if let Some(read) = unsafe { read_buffer(newest, pull.format) } {
            pull.frame = Some(read);
            // SAFETY: 在循环线程上、持锁调用。
            unsafe { (api.thread_loop_signal)(pull.thread_loop, false) };
        }
    }
    // SAFETY: 同上。
    unsafe { (api.stream_queue_buffer)(pull.stream, newest) };
}

/// 一块缓冲区里的一帧。不算一帧（空、损坏、格式还没协商好）时交回 `None`，继续等下一块。
///
/// # Safety
///
/// `buffer` 必须是刚从流里取出、还没还回去的缓冲区。
unsafe fn read_buffer(
    buffer: *const PwBuffer,
    format: Option<VideoFormat>,
) -> Option<Result<Frame, String>> {
    let format = format?;
    // SAFETY: 调用方保证缓冲区有效；各指针由 PipeWire 填写，空指针逐个判过再解引用。
    unsafe {
        let spa = (*buffer).buffer.as_ref()?;
        if spa.n_datas == 0 || spa.datas.is_null() {
            return None;
        }
        let metas: &[SpaMeta] = if spa.metas.is_null() {
            &[]
        } else {
            std::slice::from_raw_parts(spa.metas, spa.n_metas as usize)
        };
        let header = metas
            .iter()
            .find(|m| m.kind == META_HEADER && m.size >= 4 && !m.data.is_null());
        if header.is_some_and(|m| *m.data.cast::<u32>() & HEADER_CORRUPTED != 0) {
            return None;
        }
        let data = &*spa.datas;
        let chunk = data.chunk.as_ref()?;
        if chunk.size == 0 || chunk.flags & CHUNK_CORRUPTED != 0 {
            return None;
        }
        if data.data.is_null() {
            return Some(Err(
                "capture_failed: 缓冲区没有映射进内存（合成器给的是 DMA-BUF）".to_owned(),
            ));
        }
        let crop = metas
            .iter()
            .find(|m| m.kind == META_VIDEO_CROP && m.size >= 16 && !m.data.is_null())
            .map(|m| {
                let words = std::slice::from_raw_parts(m.data.cast::<i32>(), 4);
                (words[0], words[1], words[2], words[3])
            });
        let Some(order) = channels(format.format) else {
            return Some(Err(format!(
                "capture_failed: 协商出的像素格式 {} 不是 8 位四通道",
                format.format
            )));
        };
        let region = crop_region(crop, (format.width, format.height));
        let stride = usize::try_from(chunk.stride)
            .ok()
            .filter(|s| *s > 0)
            .unwrap_or(format.width as usize * 4);
        let maxsize = data.maxsize as usize;
        let offset = if maxsize > 0 {
            chunk.offset as usize % maxsize
        } else {
            chunk.offset as usize
        };
        let bytes = std::slice::from_raw_parts(
            data.data.cast::<u8>().add(offset),
            maxsize.saturating_sub(offset),
        );
        Some(to_rgb(bytes, stride, region, order).map(|rgb| Frame {
            crop: (region.2, region.3),
            video: (format.width, format.height),
            rgb,
        }))
    }
}

/// 红、绿、蓝三个通道在 4 字节像素里的下标，按内存里的字节顺序。
const fn channels(format: u32) -> Option<[usize; 3]> {
    match format {
        VIDEO_BGRX | VIDEO_BGRA => Some([2, 1, 0]),
        VIDEO_RGBX | VIDEO_RGBA => Some([0, 1, 2]),
        VIDEO_XRGB | VIDEO_ARGB => Some([1, 2, 3]),
        VIDEO_XBGR | VIDEO_ABGR => Some([3, 2, 1]),
        _ => None,
    }
}

/// 裁剪区夹到帧里。没有裁剪区或它为空时取整帧。交回（x, y, 宽, 高）。
fn crop_region(crop: Option<(i32, i32, i32, i32)>, video: (u32, u32)) -> (u32, u32, u32, u32) {
    let full = (0, 0, video.0, video.1);
    let Some((x, y, w, h)) = crop else {
        return full;
    };
    let (Ok(x), Ok(y), Ok(w), Ok(h)) = (
        u32::try_from(x),
        u32::try_from(y),
        u32::try_from(w),
        u32::try_from(h),
    ) else {
        return full;
    };
    if w == 0 || h == 0 || x >= video.0 || y >= video.1 {
        return full;
    }
    (x, y, w.min(video.0 - x), h.min(video.1 - y))
}

/// 从一帧的字节里取出裁剪区，换成 RGB。数据不够裁剪区用时失败，不交半张图。
fn to_rgb(
    bytes: &[u8],
    stride: usize,
    region: (u32, u32, u32, u32),
    order: [usize; 3],
) -> Result<Vec<u8>, String> {
    let (x, y, w, h) = (
        region.0 as usize,
        region.1 as usize,
        region.2 as usize,
        region.3 as usize,
    );
    let need = (y + h).saturating_sub(1) * stride + (x + w) * 4;
    if h == 0 || w == 0 || bytes.len() < need || stride < (x + w) * 4 {
        return Err(format!(
            "capture_failed: 帧数据 {} 字节，裁剪区 {w}×{h} 需要 {need}",
            bytes.len()
        ));
    }
    let mut out = Vec::with_capacity(w * h * 3);
    for row in y..y + h {
        let start = row * stride + x * 4;
        for px in bytes[start..start + w * 4].chunks_exact(4) {
            out.extend(order.map(|i| px[i]));
        }
    }
    Ok(out)
}

/// 连上 portal 交来的 PipeWire 连接，从节点 `node` 取一帧。`budget` 是等第一帧的上限。
pub fn pull(remote: OwnedFd, node: u32, budget: Duration) -> Result<Frame, String> {
    let api = api()?;
    // SAFETY: 以下是 libpipewire 公开接口的标准用法；每个对象在同一函数里按创建的逆序销毁，
    // 对流与连接的调用都在持有循环锁时进行。
    unsafe {
        let thread_loop = (api.thread_loop_new)(c"qywork-capture".as_ptr(), null());
        if thread_loop.is_null() {
            return Err("capture_failed: 建 PipeWire 线程循环失败".to_owned());
        }
        let context = (api.context_new)((api.thread_loop_get_loop)(thread_loop), null_mut(), 0);
        if context.is_null() {
            (api.thread_loop_destroy)(thread_loop);
            return Err("capture_failed: 建 PipeWire 上下文失败".to_owned());
        }
        if (api.thread_loop_start)(thread_loop) < 0 {
            (api.context_destroy)(context);
            (api.thread_loop_destroy)(thread_loop);
            return Err("capture_failed: 启动 PipeWire 线程循环失败".to_owned());
        }
        (api.thread_loop_lock)(thread_loop);
        let result = pull_locked(api, thread_loop, context, remote, node, budget);
        (api.thread_loop_unlock)(thread_loop);
        (api.thread_loop_stop)(thread_loop);
        (api.context_destroy)(context);
        (api.thread_loop_destroy)(thread_loop);
        result
    }
}

/// # Safety
///
/// 调用方持有 `thread_loop` 的锁，且线程循环已经启动。
unsafe fn pull_locked(
    api: &'static Api,
    thread_loop: Raw,
    context: Raw,
    remote: OwnedFd,
    node: u32,
    budget: Duration,
) -> Result<Frame, String> {
    // SAFETY: 见函数说明；描述符的所有权交给 PipeWire，出错与断开时由它关闭。
    unsafe {
        let core = (api.context_connect_fd)(context, remote.into_raw_fd(), null_mut(), 0);
        if core.is_null() {
            return Err("capture_failed: 连不上 portal 交来的 PipeWire 连接".to_owned());
        }
        let props = (api.properties_new_string)(
            c"media.type=Video media.category=Capture media.role=Screen".as_ptr(),
        );
        let stream = (api.stream_new)(core, c"qywork-capture".as_ptr(), props);
        if stream.is_null() {
            (api.core_disconnect)(core);
            return Err("capture_failed: 建 PipeWire 流失败".to_owned());
        }
        let mut pull = Box::new(Pull {
            api,
            thread_loop,
            stream,
            format: None,
            frame: None,
            failed: None,
        });
        let events = Box::new(StreamEvents {
            version: STREAM_EVENTS_VERSION,
            destroy: None,
            state_changed: Some(on_state),
            control_info: None,
            io_changed: None,
            param_changed: Some(on_param),
            add_buffer: None,
            remove_buffer: None,
            process: Some(on_process),
            drained: None,
            command: None,
            trigger_done: None,
        });
        let mut hook = Box::new(SpaHook::default());
        let data: *mut Pull = &mut *pull;
        (api.stream_add_listener)(stream, &mut *hook, &*events, data.cast());
        let format = aligned(&pod::enum_format());
        let params = [format.as_ptr().cast::<c_void>()];
        let connected = (api.stream_connect)(
            stream,
            DIRECTION_INPUT,
            node,
            FLAG_AUTOCONNECT | FLAG_MAP_BUFFERS,
            params.as_ptr(),
            1,
        );
        let outcome = if connected < 0 {
            Err(format!("capture_failed: 连不上流 {node}（{connected}）"))
        } else {
            let mut deadline = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            let nanos = i64::try_from(budget.as_nanos()).unwrap_or(i64::MAX);
            (api.thread_loop_get_time)(thread_loop, &mut deadline, nanos);
            loop {
                let pull = &mut *data;
                if let Some(frame) = pull.frame.take() {
                    break frame;
                }
                if let Some(failed) = pull.failed.take() {
                    break Err(failed);
                }
                if (api.thread_loop_timed_wait_full)(thread_loop, &deadline) != 0 {
                    let pull = &mut *data;
                    break pull.frame.take().unwrap_or_else(|| {
                        Err(format!(
                            "capture_failed: {} ms 内流 {node} 没有交出一帧",
                            budget.as_millis()
                        ))
                    });
                }
            }
        };
        (api.stream_disconnect)(stream);
        (api.stream_destroy)(stream);
        (api.core_disconnect)(core);
        drop(hook);
        drop(events);
        drop(pull);
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存里 B G R X 的顺序读出来是 R G B；另外三种排法同样落到 R G B。
    #[test]
    fn each_byte_order_reads_out_as_rgb() {
        let px = [0x10, 0x20, 0x30, 0x40];
        let rgb = |format| to_rgb(&px, 4, (0, 0, 1, 1), channels(format).expect("支持的格式"));
        assert_eq!(rgb(VIDEO_BGRX).unwrap(), vec![0x30, 0x20, 0x10]);
        assert_eq!(rgb(VIDEO_RGBA).unwrap(), vec![0x10, 0x20, 0x30]);
        assert_eq!(rgb(VIDEO_XRGB).unwrap(), vec![0x20, 0x30, 0x40]);
        assert_eq!(rgb(VIDEO_ABGR).unwrap(), vec![0x40, 0x30, 0x20]);
        assert!(channels(3).is_none());
    }

    /// 裁剪区从帧的左上角取窗口那一块，行宽按 stride 走。
    #[test]
    fn the_crop_region_is_cut_out_row_by_row() {
        // 3×2 的帧，stride 16（每行 4 个像素位），像素值就是它的序号。
        let mut bytes = vec![0u8; 32];
        for (i, px) in bytes.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(&[i as u8, 0, 0, 0]);
        }
        let rgb = to_rgb(&bytes, 16, (1, 0, 2, 2), [0, 1, 2]).expect("数据够用");
        assert_eq!(rgb, vec![1, 0, 0, 2, 0, 0, 5, 0, 0, 6, 0, 0]);
        // 裁剪区超出数据：失败，不交半张图。
        assert!(to_rgb(&bytes, 16, (0, 0, 4, 3), [0, 1, 2]).is_err());
    }

    /// 裁剪区夹到帧里；缺席、为空或在帧外时取整帧。
    #[test]
    fn the_crop_region_is_clamped_to_the_frame() {
        assert_eq!(
            crop_region(Some((0, 0, 412, 389)), (1280, 800)),
            (0, 0, 412, 389)
        );
        assert_eq!(
            crop_region(Some((1000, 700, 412, 389)), (1280, 800)),
            (1000, 700, 280, 100)
        );
        for crop in [
            None,
            Some((0, 0, 0, 0)),
            Some((2000, 0, 5, 5)),
            Some((-1, 0, 5, 5)),
        ] {
            assert_eq!(
                crop_region(crop, (1280, 800)),
                (0, 0, 1280, 800),
                "{crop:?}"
            );
        }
    }

    #[test]
    fn a_pod_is_stored_word_aligned_without_losing_bytes() {
        let words = aligned(&[1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].to_ne_bytes(), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(words[1].to_ne_bytes()[0], 9);
    }
}
