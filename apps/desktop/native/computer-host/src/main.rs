//! 结构化桌面控制 worker。服务循环（`serve`）与平台后端（`Backend` 的实现）分开：
//! 协议、服务循环、按下状态账、控件身份与 `ref` 编解码这些不调 OS 的部分在每个目标上
//! 都编译并跑单测；每个目标只编译一个平台后端，在这里按 `cfg` 选定。

// 非 Windows 目标还没有后端，中立模块此时只有单测在用。给这个目标接上后端时删掉这一行。
#![cfg_attr(not(windows), allow(dead_code))]

mod backend;
mod geometry;
mod input;
mod protocol;
mod serve;
mod tree;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() {
    serve::run::<windows::Uia>()
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("qy-computer-host 只实现了 Windows 后端，当前平台没有可用实现");
    std::process::ExitCode::FAILURE
}
