//! 调用系统接口的层，只在 macOS 上编译：AX、CF、CGWindowList 与显示器清单的轻量封装（`ax`），
//! 控件树的遍历、重新定位与窗口几何（`walk`），CGEvent 派发端（`sink`），ScreenCaptureKit 采图
//! （`capture`），前台动作（`foreground`），后端本身（`backend`），以及父进程退出监听（`parent`）。
//!
//! 判定一律位于 `pure` 中，此处只负责调用、类型换算以及把事实交给判定。

mod ax;
mod backend;
mod capture;
mod foreground;
mod parent;
mod sink;
mod walk;

pub use backend::Ax;
pub use parent::exit_with_parent;
