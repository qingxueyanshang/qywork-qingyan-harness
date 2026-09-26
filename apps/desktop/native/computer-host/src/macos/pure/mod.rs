//! 不调任何系统接口的换算与判定：AX 属性值与错误码（`facts`）、协议节点与可用动作（`node`）、
//! 动作的发法（`plan`）、身份表（`identity`）、AX 与 CG 窗口的对应与命中（`associate`）、
//! 点与像素的换算（`screen`）、输入事件的 CGEvent 形状（`events`）。
//!
//! 这里的每个模块在每个目标上都编译，单测在 Windows 与 Linux 上照跑；事实由 `ffi` 读好交进来。

pub mod associate;
pub mod events;
pub mod facts;
pub mod identity;
pub mod node;
pub mod plan;
pub mod screen;
