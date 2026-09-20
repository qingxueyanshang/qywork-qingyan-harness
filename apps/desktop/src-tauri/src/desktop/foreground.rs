//! 把本进程的前台权让给 worker。
//!
//! 三条边界：
//!
//! 1. **它不是执行入口，也不裁决。** 这一层只在系统层面允许 worker 调用
//!    `SetForegroundWindow`，激活哪个窗口、成没成功全由 worker 自己判。
//! 2. **只在前台模式开着的请求上调。** 前台模式由用户显式打开，`foreground` 随每条
//!    请求下来，这里读它，不另存一份。
//! 3. **逐条请求调一次。** 这份授权由 worker 的下一次前台切换消费掉，也会随本进程失去
//!    前台而失效，起 worker 时调一次留不到用得上的时候。

/// 允许 `pid` 那个进程把窗口切到前台。
///
/// 本进程此刻不在前台时系统直接拒绝，返回假：那时 worker 自己会挂到前台线程上再要一次。
#[cfg(windows)]
pub fn grant(pid: u32) -> bool {
    use ::windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

    // SAFETY: 只传一个进程号，没有出参。
    unsafe { AllowSetForegroundWindow(pid) }.is_ok()
}

/// 非 Windows 平台没有前台锁这条机制。
#[cfg(not(windows))]
pub fn grant(_pid: u32) -> bool {
    false
}
