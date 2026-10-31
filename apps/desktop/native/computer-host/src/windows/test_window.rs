//! 测试用的真实窗口：在独立线程上创建并运行消息循环，位于所有显示器之外，显示时不激活，
//! 记录收到的鼠标左键消息。
//!
//! 窗口是不透明度为 255 的分层窗口：位于显示器之外的普通窗口没有经 DWM 绘制的内容，`PrintWindow`
//! 取回全黑；分层窗口经 `WM_PRINT` 按窗口类的背景画刷绘制，取回的颜色即创建时指定的颜色。
//! 窗口都带 `WS_EX_NOACTIVATE`：不出现在任务栏上，也不会成为前台窗口。

use std::ffi::c_void;
use std::sync::Mutex;

use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::Graphics::Gdi::CreateSolidBrush;
use ::windows::Win32::System::Threading::GetCurrentThreadId;
use ::windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    PostThreadMessageW, RegisterClassExW, SetLayeredWindowAttributes, SetWindowPos, ShowWindow,
    LWA_ALPHA, MSG, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT, WNDCLASSEXW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_POPUP,
};

use crate::geometry::ScreenRect;

/// 用到真实窗口的用例串行执行：弹出窗口的查找遍历整个 z 序，并行创建的窗口会互相计入。
pub static SERIAL: Mutex<()> = Mutex::new(());

/// 收到的鼠标左键消息：窗口句柄与消息号。
static CLICKS: Mutex<Vec<(isize, u32)>> = Mutex::new(Vec::new());

unsafe extern "system" fn record(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP {
        if let Ok(mut clicks) = CLICKS.lock() {
            clicks.push((hwnd.0 as isize, msg));
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// 取出并清空 `window` 收到的鼠标左键消息。
pub fn clicks_on(window: HWND) -> Vec<u32> {
    let mut clicks = CLICKS.lock().expect("记录锁");
    let mine = clicks
        .iter()
        .filter(|(hwnd, _)| *hwnd == window.0 as isize)
        .map(|(_, msg)| *msg)
        .collect();
    clicks.retain(|(hwnd, _)| *hwnd != window.0 as isize);
    mine
}

/// 窗口的形状。
#[derive(Clone, Copy)]
pub enum Kind {
    /// 工具弹出窗口：目标窗口，以及下拉框、菜单的形状。
    ///
    /// 不要把目标窗口改为非工具窗口：多个用例并行运行时，未被拥有的非工具窗口可能位于在它之后
    /// 创建的弹出窗口之上，弹出窗口的查找结果因此不稳定。
    Tool,
    /// 带标题栏与可调边框的窗口：另一个应用主窗口的形状。
    Main,
}

pub struct TestWindow {
    pub hwnd: HWND,
    thread: u32,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl TestWindow {
    /// 按屏幕矩形创建并显示。`color` 为 `0x00BBGGRR`；`owner` 是所有者窗口。
    pub fn open(kind: Kind, rect: ScreenRect, color: u32, owner: Option<HWND>) -> Self {
        let owner = owner.map(|h| h.0 as isize);
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let name: Vec<u16> = format!("qy-popup-test-{color:06x}")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let (style, extra): (WINDOW_STYLE, WINDOW_EX_STYLE) = match kind {
                Kind::Tool => (WS_POPUP, WS_EX_TOOLWINDOW),
                Kind::Main => (WS_OVERLAPPEDWINDOW, WINDOW_EX_STYLE(0)),
            };
            // SAFETY: 窗口类与窗口都只在本线程上创建和使用，退出消息循环后销毁；
            // 类名缓冲区在整个线程期间有效。
            unsafe {
                let class = PCWSTR(name.as_ptr());
                let wc = WNDCLASSEXW {
                    cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
                    lpfnWndProc: Some(record),
                    lpszClassName: class,
                    hbrBackground: CreateSolidBrush(COLORREF(color)),
                    ..WNDCLASSEXW::default()
                };
                // 同一进程中重复注册返回 0，窗口类已存在，不影响创建窗口。
                RegisterClassExW(&wc);
                let hwnd = CreateWindowExW(
                    extra | WS_EX_LAYERED | WS_EX_NOACTIVATE,
                    class,
                    PCWSTR::null(),
                    style,
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    owner.map(|h| HWND(h as *mut c_void)),
                    None,
                    None,
                    None,
                )
                .expect("创建测试窗口");
                SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA)
                    .expect("设置分层窗口的不透明度");
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                let _ = tx.send((hwnd.0 as isize, GetCurrentThreadId()));
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    DispatchMessageW(&msg);
                }
                let _ = DestroyWindow(hwnd);
            }
        });
        let (hwnd, thread) = rx.recv().expect("测试窗口线程启动");
        Self {
            hwnd: HWND(hwnd as *mut c_void),
            thread,
            handle: Some(handle),
        }
    }

    pub fn id(&self) -> i64 {
        self.hwnd.0 as i64
    }

    /// 移动到新的左上角，尺寸与 z 序不变。
    pub fn move_to(&self, x: i32, y: i32) {
        // SAFETY: 句柄由本对象持有；窗口线程运行消息循环，同步发送的定位消息能被处理。
        unsafe {
            SetWindowPos(
                self.hwnd,
                None,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        }
        .expect("移动测试窗口");
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        // SAFETY: 线程号来自窗口线程自身。
        let _ = unsafe { PostThreadMessageW(self.thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn rect(x: i32, y: i32, width: i32, height: i32) -> ScreenRect {
    ScreenRect {
        x,
        y,
        width,
        height,
    }
}
