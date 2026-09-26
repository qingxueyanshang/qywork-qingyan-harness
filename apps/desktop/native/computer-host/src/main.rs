//! 结构化桌面控制 worker。服务循环（`serve`）与平台后端（`Backend` 的实现）分开：
//! 协议、服务循环、按下状态账、控件身份与 `ref` 编解码这些不调 OS 的部分在每个目标上
//! 都编译并跑单测；每个目标只编译一个平台后端，在这里按 `cfg` 选定。

mod backend;
mod geometry;
mod input;
#[cfg(target_os = "linux")]
mod linux;
// macOS 后端的纯换算在每个目标的单测里编译；调它们的 AX 层只在 macOS 上编译，
// 别的目标上没被单测用到的项因此报未使用。
#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macos;
mod protocol;
mod serve;
mod tree;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() {
    serve::run::<windows::Uia>()
}

#[cfg(target_os = "linux")]
fn main() {
    serve::run::<linux::Atspi>()
}

#[cfg(target_os = "macos")]
fn main() {
    serve::run::<macos::Ax>()
}
