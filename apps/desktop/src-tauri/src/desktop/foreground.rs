//! 把本进程的前台权限转让给 worker。只有 Windows 编译本模块。
//!
//! Windows 的前台锁只允许前台进程转让前台权限，用户发送消息时前台进程通常是本进程。X11 没有
//! 按进程裁决前台的机制：worker 的激活请求携带来源标记，由窗口管理器按 EWMH 处理。
//!
//! 三条边界：
//!
//! 1. **本模块不是执行入口，也不做裁决。** 本模块只在系统层面允许 worker 调用
//!    `SetForegroundWindow`，激活哪个窗口、是否成功均由 worker 自行判定。
//! 2. **只对开启前台模式的请求调用。** `foreground` 由服务端配置决定，随每条
//!    请求下发，此处读取该字段，不另存副本。
//! 3. **每条请求调用一次。** 该授权由 worker 的下一次前台切换消费，也会随本进程失去
//!    前台而失效，在启动 worker 时调用一次无法保留到需要的时刻。

/// 允许 `pid` 指定的进程把窗口切换到前台。
///
/// 本进程当前不在前台时系统直接拒绝，返回 false：此时 worker 会自行附加到前台线程上再次请求。
pub fn grant(pid: u32) -> bool {
    use ::windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

    // SAFETY: 只传入一个进程号，没有输出参数。
    unsafe { AllowSetForegroundWindow(pid) }.is_ok()
}
