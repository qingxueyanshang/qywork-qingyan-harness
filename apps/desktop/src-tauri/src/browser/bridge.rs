//! 宿主连接：Rust 主动连回 sidecar 的宿主专用路径。
//!
//! 方向是 Rust → sidecar，发布版与开发版走同一条路径。反过来不行：开发版的
//! sidecar 不由 Rust 父进程启动，建立在父子 stdio 上的桥只在发布版成立。
//!
//! 连接在专用线程上跑，请求就地执行——`add_child` 要求不在主线程上调用，
//! 这个线程正好满足。

use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;

use super::frames::{reject_reason, RequestFrame, ResultFrame};
use super::{now_ms, BrowserHost};
use crate::ws::WsClient;

/// 与 `packages/core/src/protocol/native-browser.ts` 的常量逐字一致。
const PATH: &str = "/native/browser";
const KEY_HEADER: &str = "x-qywork-browser-key";

const RETRY_BASE_MS: u64 = 400;
const RETRY_MAX_MS: u64 = 15_000;

pub fn spawn(app: AppHandle, host: Arc<BrowserHost>, port: u16, key: String) {
    std::thread::spawn(move || {
        let mut delay = RETRY_BASE_MS;
        loop {
            if host.is_stopping() {
                return;
            }
            match run(&app, &host, port, &key) {
                Ok(()) => log::info!("浏览器宿主连接已关闭"),
                Err(e) => log::warn!("浏览器宿主连接中断：{e}"),
            }
            host.disconnected();
            if host.is_stopping() {
                return;
            }
            std::thread::sleep(Duration::from_millis(delay));
            delay = (delay * 2).min(RETRY_MAX_MS);
        }
    });
}

fn run(app: &AppHandle, host: &Arc<BrowserHost>, port: u16, key: &str) -> std::io::Result<()> {
    let seed = now_ms() ^ (u64::from(std::process::id()) << 32);
    let mut client =
        WsClient::connect(port, PATH, &[(KEY_HEADER, key.to_owned())], seed)?;
    let sender = client.sender();
    let ready = host.connected(Arc::clone(&sender));
    let text = serde_json::to_string(&ready)
        .map_err(|e| std::io::Error::other(format!("host.ready 序列化失败：{e}")))?;
    sender.send_text(&text)?;
    log::info!("浏览器宿主已连上 sidecar epoch={}", ready.connection_epoch);

    while let Some(raw) = client.read_text()? {
        let Some(reply) = handle(app, host, &raw) else { continue };
        let text = serde_json::to_string(&reply)
            .map_err(|e| std::io::Error::other(format!("browser.result 序列化失败：{e}")))?;
        sender.send_text(&text)?;
    }
    Ok(())
}

/// 处理一帧。认不出的帧不回复，也不猜测意图。
fn handle(app: &AppHandle, host: &Arc<BrowserHost>, raw: &str) -> Option<ResultFrame> {
    let frame: RequestFrame = match serde_json::from_str(raw) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("认不出的宿主帧：{e}");
            return None;
        }
    };
    let epoch = host.current_epoch();
    if let Some(reason) = reject_reason(epoch, &frame, now_ms()) {
        return Some(ResultFrame {
            kind: "browser.result",
            request_id: frame.request_id,
            connection_epoch: epoch,
            ok: false,
            data: None,
            error: Some(reason.to_owned()),
        });
    }
    let (ok, data, error) = match host.dispatch(app, &frame) {
        Ok(data) => (true, Some(data), None),
        Err(message) => (false, None, Some(message)),
    };
    Some(ResultFrame {
        kind: "browser.result",
        request_id: frame.request_id,
        connection_epoch: epoch,
        ok,
        data,
        error,
    })
}
