//! 应用退出：主线程只登记退出请求、隐藏窗口，收尾在后台任务中进行，结束后再次请求退出。
//!
//! 收尾依次为：终端（`terminal::shutdown`，上限 2 秒）、桌面宿主（`desktop::shutdown`，上限 3 秒）、
//! sidecar（`sidecar::stop`，上限 5 秒）。顺序不能颠倒：桌面宿主结算进行中请求的回执须经由 sidecar 的
//! 宿主连接发出，sidecar 先退出时服务端只能等待超时，一次可证明未发出的动作会被记为可能已执行。
//! 前两项含阻塞等待，在阻塞线程池中执行；在主线程等待时外壳的全部命令与界面在此期间停止响应。

use std::sync::atomic::{AtomicU8, Ordering};

use tauri::{AppHandle, Manager};

use crate::{desktop, sidecar, terminal};

/// 一次退出请求的处理方式。
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// 首次请求：阻止本次退出并开始收尾。
    Begin,
    /// 收尾进行中再次请求：阻止本次退出，不重复收尾。
    Wait,
    /// 收尾已完成：放行。
    Proceed,
}

const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const DONE: u8 = 2;

/// 收尾的进度，只进不退。
pub struct Gate(AtomicU8);

impl Gate {
    pub const fn new() -> Self {
        Self(AtomicU8::new(IDLE))
    }

    pub fn request(&self) -> Step {
        match self
            .0
            .compare_exchange(IDLE, RUNNING, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => Step::Begin,
            Err(RUNNING) => Step::Wait,
            Err(_) => Step::Proceed,
        }
    }

    fn finish(&self) {
        self.0.store(DONE, Ordering::Release);
    }
}

pub static GATE: Gate = Gate::new();

/// 在后台任务中收尾，结束后以 `code` 再次请求退出。只在 `GATE.request()` 返回 `Begin` 时调用。
pub fn begin(app: AppHandle, code: i32) {
    tauri::async_runtime::spawn(async move {
        let blocking = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            terminal::shutdown(&blocking.state::<terminal::TerminalHandle>());
            desktop::shutdown();
        })
        .await;
        sidecar::stop(&app).await;
        GATE.finish();
        app.exit(code);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_request_begins_later_ones_wait_until_finished_then_proceed() {
        let gate = Gate::new();
        assert_eq!(gate.request(), Step::Begin);
        assert_eq!(gate.request(), Step::Wait);
        assert_eq!(gate.request(), Step::Wait);
        gate.finish();
        assert_eq!(gate.request(), Step::Proceed);
        assert_eq!(gate.request(), Step::Proceed);
    }
}
