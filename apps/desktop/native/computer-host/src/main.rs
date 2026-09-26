//! 结构化桌面控制 worker。服务循环（`serve`）与平台后端（`Backend` 的实现）分开：
//! 协议、服务循环、按下状态账、控件身份与 `ref` 编解码这些不调 OS 的部分在每个目标上
//! 都编译并跑单测；每个目标只编译一个平台后端，在这里按 `cfg` 选定。

// macOS 还没有后端，中立模块此时只有单测在用。给这个目标接上后端时删掉这一行。
#![cfg_attr(target_os = "macos", allow(dead_code))]

mod backend;
mod geometry;
mod input;
#[cfg(target_os = "linux")]
mod linux;
// macOS 后端的纯换算，此时只有单测在用。
#[cfg(test)]
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

#[cfg(not(any(windows, target_os = "linux")))]
fn main() -> std::process::ExitCode {
    eprintln!("qy-computer-host 在当前平台没有可用的后端");
    std::process::ExitCode::FAILURE
}
