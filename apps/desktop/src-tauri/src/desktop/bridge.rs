//! 桌面宿主连接：由 Rust 主动连接 sidecar 的 `/native/desktop`。
//!
//! 方向为 Rust → sidecar，发布版与开发版使用同一条路径。反方向不可行：开发版的 sidecar
//! 不由 Rust 父进程启动，基于父子进程 stdio 的桥接只在发布版中成立。
//!
//! 连接在专用线程上运行。读取到的请求当场转换并写入 worker 的 stdin 后即返回，不在该线程上
//! 等待 worker 的回执：等待会使一次耗时较长的 OS 调用阻塞整条连接，取消帧也无法送达。

use std::sync::Arc;

use super::DesktopHost;
use crate::hostkey::KEY_HEADER;
use crate::ws::{Reconnect, WsClient};

/// 与 `packages/core/src/protocol/native-desktop.ts` 的常量逐字一致。
const PATH: &str = "/native/desktop";

pub fn spawn(host: Arc<DesktopHost>, port: u16, key: String) {
    std::thread::spawn(move || {
        let mut backoff = Reconnect::new();
        loop {
            if host.is_stopping() {
                return;
            }
            match run(&host, port, &key, &mut backoff) {
                Ok(()) => log::info!("桌面宿主连接已关闭"),
                Err(e) => log::warn!("桌面宿主连接中断：{e}"),
            }
            host.disconnected();
            if host.is_stopping() {
                return;
            }
            std::thread::sleep(backoff.next_delay());
        }
    });
}

fn run(host: &Arc<DesktopHost>, port: u16, key: &str, backoff: &mut Reconnect) -> std::io::Result<()> {
    let seed = super::now_ms() as u64 ^ (u64::from(std::process::id()) << 32);
    let mut client = WsClient::connect(port, PATH, &[(KEY_HEADER, key.to_owned())], seed)?;
    let sender = client.sender();
    let ready = host.connected(Arc::clone(&sender));
    let epoch = ready.connection_epoch;
    // 先让 worker 切换到新代际，再发送注册帧：服务端收到注册帧后即按新代际发送请求，
    // 而仍使用旧代际的 worker 会以代际不符为由拒绝全部请求。
    host.rebind_worker();
    let text = serde_json::to_string(&ready)
        .map_err(|e| std::io::Error::other(format!("host.ready 序列化失败：{e}")))?;
    sender.send_text(&text)?;
    backoff.connected();
    log::info!("桌面宿主已连接 sidecar epoch={epoch}");

    while let Some(raw) = client.read_text()? {
        host.on_request(&raw);
    }
    Ok(())
}
