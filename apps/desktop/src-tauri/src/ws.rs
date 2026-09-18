//! 回环 WebSocket 客户端：握手、收发文本帧、应答控制帧。宿主连接共用这一份，
//! 不按平台分叉。
//!
//! 只覆盖宿主连接需要的形态——明文 `ws://127.0.0.1`、文本帧、客户端掩码。
//! 不实现扩展协商、permessage-deflate、分片发送。
//!
//! 读写用两个 `TcpStream` 句柄：读在专用线程上阻塞，写由请求线程加锁发出。
//! 关闭走 `shutdown`，读线程因此从阻塞里返回，不靠标志位轮询。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// 单帧上限。宿主连接上的帧是状态快照与动作回执，远小于这个数；
/// 超限即判协议错误并断开，不为一条畸形帧分配任意大的缓冲区。
const MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;

/// 发送端。掩码状态与写句柄同锁，保证一帧的头与体不会被另一帧插进来。
pub struct WsSender {
    inner: Mutex<(TcpStream, u64)>,
}

pub struct WsClient {
    reader: BufReader<TcpStream>,
    sender: Arc<WsSender>,
}

/// 掩码源。掩码防的是中间代理缓存，不承担机密性——那由宿主凭据负责。
fn next_mask(state: &mut u64) -> [u8; 4] {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    let v = state.to_le_bytes();
    [v[0], v[1], v[2], v[3]]
}

fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn io_err(msg: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg.into())
}

impl WsSender {
    pub fn send_text(&self, text: &str) -> std::io::Result<()> {
        self.send_frame(OP_TEXT, text.as_bytes())
    }

    fn send_frame(&self, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
        let mut guard = self.inner.lock().map_err(|_| io_err("写句柄被污染"))?;
        let (stream, mask_state) = &mut *guard;
        let mask = next_mask(mask_state);
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x80 | opcode);
        let len = payload.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        stream.write_all(&frame)?;
        stream.flush()
    }

    /// 断开底层连接。读线程随之从阻塞里返回。
    pub fn shutdown(&self) {
        if let Ok(guard) = self.inner.lock() {
            let _ = guard.0.shutdown(Shutdown::Both);
        }
    }
}

impl WsClient {
    /// 连回环端口并完成升级。`headers` 里放宿主凭据，不进 URL。
    pub fn connect(
        port: u16,
        path: &str,
        headers: &[(&str, String)],
        seed: u64,
    ) -> std::io::Result<Self> {
        let stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.set_nodelay(true)?;
        let write_half = stream.try_clone()?;

        let mut mask_state = seed | 1;
        let mut nonce = [0u8; 16];
        for slot in nonce.chunks_mut(4) {
            slot.copy_from_slice(&next_mask(&mut mask_state));
        }
        let key = base64(&nonce);

        let mut request = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        );
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        {
            let mut w = &stream;
            w.write_all(request.as_bytes())?;
            w.flush()?;
        }

        let mut reader = BufReader::new(stream);
        let mut status = String::new();
        reader.read_line(&mut status)?;
        if !status.contains(" 101") {
            return Err(io_err(format!("升级被拒：{}", status.trim_end())));
        }
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 {
                return Err(io_err("升级应答在头部结束前断开"));
            }
            if line.trim_end().is_empty() {
                break;
            }
        }

        Ok(Self {
            reader,
            sender: Arc::new(WsSender { inner: Mutex::new((write_half, mask_state)) }),
        })
    }

    pub fn sender(&self) -> Arc<WsSender> {
        Arc::clone(&self.sender)
    }

    /// 读一条文本消息。`Ok(None)` = 对端关闭。控制帧就地应答，不返回给调用方。
    pub fn read_text(&mut self) -> std::io::Result<Option<String>> {
        let mut buffer: Vec<u8> = Vec::new();
        let mut text_message = false;
        loop {
            let (fin, opcode, payload) = self.read_frame()?;
            match opcode {
                OP_CLOSE => {
                    let _ = self.sender.send_frame(OP_CLOSE, &[]);
                    return Ok(None);
                }
                OP_PING => {
                    self.sender.send_frame(OP_PONG, &payload)?;
                    continue;
                }
                OP_PONG => continue,
                OP_TEXT => {
                    buffer = payload;
                    text_message = true;
                }
                OP_BINARY => {
                    buffer = payload;
                    text_message = false;
                }
                OP_CONTINUATION => buffer.extend_from_slice(&payload),
                other => return Err(io_err(format!("未知帧类型 {other}"))),
            }
            if !fin {
                continue;
            }
            if !text_message {
                buffer.clear();
                continue;
            }
            return String::from_utf8(buffer)
                .map(Some)
                .map_err(|e| io_err(format!("文本帧不是 UTF-8：{e}")));
        }
    }

    fn read_frame(&mut self) -> std::io::Result<(bool, u8, Vec<u8>)> {
        let mut head = [0u8; 2];
        self.reader.read_exact(&mut head)?;
        let fin = head[0] & 0x80 != 0;
        let opcode = head[0] & 0x0F;
        let masked = head[1] & 0x80 != 0;
        let mut len = u64::from(head[1] & 0x7F);
        if len == 126 {
            let mut ext = [0u8; 2];
            self.reader.read_exact(&mut ext)?;
            len = u64::from(u16::from_be_bytes(ext));
        } else if len == 127 {
            let mut ext = [0u8; 8];
            self.reader.read_exact(&mut ext)?;
            len = u64::from_be_bytes(ext);
        }
        if len > MAX_FRAME_BYTES {
            return Err(io_err(format!("帧长度 {len} 超过上限")));
        }
        let mut mask = [0u8; 4];
        if masked {
            self.reader.read_exact(&mut mask)?;
        }
        let mut payload = vec![0u8; len as usize];
        self.reader.read_exact(&mut payload)?;
        if masked {
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[i % 4];
            }
        }
        Ok((fin, opcode, payload))
    }
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
