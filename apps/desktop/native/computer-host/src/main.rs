//! 结构化桌面控制 worker。服务循环（`serve`）与平台后端（`Backend` 的实现）相互分离：
//! 协议、服务循环、按下状态账、控件身份与 `ref` 编解码等不调用 OS 的部分在每个目标上
//! 都编译并运行单测；每个目标只编译一个平台后端，在此处按 `cfg` 选定。

mod backend;
mod geometry;
mod input;
#[cfg(target_os = "linux")]
mod linux;
// macOS 后端的纯换算在每个目标的单测中编译；调用它们的 AX 层只在 macOS 上编译，
// 其他目标上未被单测使用的项因此报告未使用。
#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macos;
// Linux 与 macOS 自行缩放与编码采集帧；Windows 使用 WIC，不编译本模块。
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod png;
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
    macos::exit_with_parent();
    serve::run::<macos::Ax>()
}
