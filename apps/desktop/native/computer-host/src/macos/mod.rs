//! macOS 后端（`Ax`）的纯换算：属性值、角色与可用动作、动作发法、身份表与窗口对应。
//!
//! 这几个模块不调用 AX，在每个目标的单测里编译。

mod associate;
mod facts;
mod identity;
mod node;
mod plan;
