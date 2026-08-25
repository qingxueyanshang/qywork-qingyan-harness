//! 工作区文件监听。
//!
//! 监听放在 Rust 侧的理由是性能：`notify` 在三个平台上分别走
//! ReadDirectoryChangesW / FSEvents / inotify，是内核原生通知；JS 侧的
//! chokidar 在大仓库上会退化成周期性 stat 轮询，把 CPU 烧满。
//!
//! **必须防抖**。一次 `npm install` 或一次构建会在几秒内产生上万个事件，
//! 逐条转发到前端会让 WebView 停止响应。这里用 debouncer 聚合成批。

use anyhow::Result;
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 防抖窗口。够长到能合并构建产生的事件风暴，又短到用户改一个文件后感觉是即时的。
const DEBOUNCE: Duration = Duration::from_millis(300);

/// 这些目录一律不监听：它们的写入量能达到源码的几百倍，且没人关心。
const IGNORED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    ".turbo",
    ".cache",
];

#[derive(Default)]
pub struct WatcherHandle(
    pub Arc<Mutex<Option<Debouncer<notify::RecommendedWatcher, RecommendedCache>>>>,
);

#[derive(serde::Serialize, Clone)]
struct FsBatch {
    paths: Vec<String>,
}

pub fn start(app: &AppHandle, root: &Path, handle: &WatcherHandle) -> Result<()> {
    let app_for_event = app.clone();
    let root_owned = root.to_path_buf();

    let mut debouncer =
        new_debouncer(
            DEBOUNCE,
            None,
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    let mut paths: Vec<String> = Vec::new();
                    for ev in events {
                        for p in &ev.paths {
                            if is_ignored(p) {
                                continue;
                            }
                            if let Some(rel) = relative(&root_owned, p) {
                                if !paths.contains(&rel) {
                                    paths.push(rel);
                                }
                            }
                        }
                    }
                    if !paths.is_empty() {
                        let _ = app_for_event.emit("fs:changed", FsBatch { paths });
                    }
                }
                Err(errors) => {
                    for e in errors {
                        eprintln!("[qywork] 文件监听错误：{e}");
                    }
                }
            },
        )?;

    debouncer.watch(root, RecursiveMode::Recursive)?;
    *handle.0.lock() = Some(debouncer);
    Ok(())
}

pub fn stop(handle: &WatcherHandle) {
    *handle.0.lock() = None;
}

fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| IGNORED.contains(&s))
            .unwrap_or(false)
    })
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .map(|s| s.replace('\\', "/"))
}
