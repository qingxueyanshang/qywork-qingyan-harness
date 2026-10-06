//! 宿主连接：Rust 主动连接 sidecar 的宿主专用通道。
//!
//! 方向为 Rust → sidecar，发布版与开发版使用同一路径。不能反向：开发版的
//! sidecar 不由 Rust 父进程启动，基于父子进程 stdio 的桥接只在发布版中成立。
//!
//! 连接在专用线程上运行，请求就地执行：`add_child` 要求不在主线程上调用，
//! Chromium 引擎的调用需要阻塞等待 CDP 响应，该线程同时满足这两项。

use std::sync::Arc;

use tauri::AppHandle;

use super::frames::{reject_reason, RequestFrame, ResultFrame};
use super::{now_ms, BrowserHost};
use crate::hostkey::KEY_HEADER;
use crate::ws::{Reconnect, WsClient};

/// 与 `packages/core/src/protocol/native-browser.ts` 的常量逐字一致。
const PATH: &str = "/native/browser";

pub fn spawn(app: AppHandle, host: Arc<BrowserHost>, port: u16, key: String) {
    std::thread::spawn(move || {
        let mut backoff = Reconnect::new();
        loop {
            if host.is_stopping() {
                return;
            }
            match run(&app, &host, port, &key, &mut backoff) {
                Ok(()) => log::info!("浏览器宿主连接已关闭"),
                Err(e) => log::warn!("浏览器宿主连接中断：{e}"),
            }
            host.disconnected();
            if host.is_stopping() {
                return;
            }
            std::thread::sleep(backoff.next_delay());
        }
    });
}

fn run(
    app: &AppHandle,
    host: &Arc<BrowserHost>,
    port: u16,
    key: &str,
    backoff: &mut Reconnect,
) -> std::io::Result<()> {
    let seed = now_ms() ^ (u64::from(std::process::id()) << 32);
    let mut client =
        WsClient::connect(port, PATH, &[(KEY_HEADER, key.to_owned())], seed)?;
    let sender = client.sender();
    let (epoch, hello) = host.connected(Arc::clone(&sender));
    let text = serde_json::to_string(&hello)
        .map_err(|e| std::io::Error::other(format!("宿主首帧序列化失败：{e}")))?;
    sender.send_text(&text)?;
    backoff.connected();
    log::info!("浏览器宿主已连接 sidecar epoch={epoch}");

    while let Some(raw) = client.read_text()? {
        let Some(reply) = handle(app, host, &raw) else { continue };
        let text = serde_json::to_string(&reply)
            .map_err(|e| std::io::Error::other(format!("browser.result 序列化失败：{e}")))?;
        sender.send_text(&text)?;
    }
    Ok(())
}

/// 处理一帧。无法识别的帧不回复，也不推测意图。
fn handle(app: &AppHandle, host: &Arc<BrowserHost>, raw: &str) -> Option<ResultFrame> {
    let frame: RequestFrame = match serde_json::from_str(raw) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("无法识别的宿主帧：{e}");
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
