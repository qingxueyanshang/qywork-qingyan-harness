//! 桌面宿主连接：Rust 主动连回 sidecar 的 `/native/desktop`。
//!
//! 方向是 Rust → sidecar，发布版与开发版走同一条路径。反过来不行：开发版的 sidecar
//! 不由 Rust 父进程启动，建立在父子 stdio 上的桥只在发布版成立。
//!
//! 连接在专用线程上跑。读到的请求就地翻译并写进 worker 的 stdin 就返回，不在这条线程上
//! 等 worker 的回执——等它就会让一次长 OS 调用把整条连接堵住，取消帧也进不来。

use std::sync::Arc;
use std::time::Duration;

use super::DesktopHost;
use crate::hostkey::KEY_HEADER;
use crate::ws::WsClient;

/// 与 `packages/core/src/protocol/native-desktop.ts` 的常量逐字一致。
const PATH: &str = "/native/desktop";

const RETRY_BASE_MS: u64 = 400;
const RETRY_MAX_MS: u64 = 15_000;

pub fn spawn(host: Arc<DesktopHost>, port: u16, key: String) {
    std::thread::spawn(move || {
        let mut delay = RETRY_BASE_MS;
        loop {
            if host.is_stopping() {
                return;
            }
            match run(&host, port, &key) {
                Ok(()) => log::info!("桌面宿主连接已关闭"),
                Err(e) => log::warn!("桌面宿主连接中断：{e}"),
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

fn run(host: &Arc<DesktopHost>, port: u16, key: &str) -> std::io::Result<()> {
    let seed = super::now_ms() as u64 ^ (u64::from(std::process::id()) << 32);
    let mut client = WsClient::connect(port, PATH, &[(KEY_HEADER, key.to_owned())], seed)?;
    let sender = client.sender();
    let ready = host.connected(Arc::clone(&sender));
    let epoch = ready.connection_epoch;
    // 先让 worker 认下新代际，再发注册帧：服务端一收到注册帧就按新代际发请求，
    // 而认着旧代际的 worker 会把那些请求全部按代际不符拒掉。
    host.rebind_worker();
    let text = serde_json::to_string(&ready)
        .map_err(|e| std::io::Error::other(format!("host.ready 序列化失败：{e}")))?;
    sender.send_text(&text)?;
    log::info!("桌面宿主已连上 sidecar epoch={epoch}");

    while let Some(raw) = client.read_text()? {
        host.on_request(&raw);
    }
    Ok(())
}
