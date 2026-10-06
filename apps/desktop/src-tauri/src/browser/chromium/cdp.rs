//! 外壳自身的 CDP 连接。只承担宿主职责：新建页面、注入标记、投影页签状态、裁决下载。
//!
//! 请求与响应按 `id` 配对，flatten 会话按 `sessionId` 区分，事件按到达顺序交给唯一的
//! 消费者。读取在专用线程上阻塞，调用方线程阻塞等待自身的响应：事件消费者自身也要发送
//! 命令，因此读线程不能兼任消费者，否则它等待的响应永远无人读取。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::ws::{WsClient, WsSender};

/// 单条命令等待响应的上限。宿主发出的命令都在毫秒级完成，达到该上限只可能是浏览器无响应。
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// 一条协议事件。`session` 为 `None` 是浏览器级事件。
pub struct Event {
    pub method: String,
    pub session: Option<String>,
    pub params: Value,
}

type Waiters = Mutex<Option<HashMap<u64, Sender<Result<Value, String>>>>>;

pub struct Cdp {
    sender: Arc<WsSender>,
    next_id: AtomicU64,
    /// 在途命令。连接断开后置为 `None`：此后的调用立即失败，不等待不会到达的响应。
    waiters: Waiters,
}

impl Cdp {
    /// 连接浏览器级调试端点。返回的接收端在连接断开时结束，事件消费者据此得知浏览器已退出。
    pub fn connect(port: u16, path: &str) -> std::io::Result<(Arc<Cdp>, Receiver<Event>)> {
        let seed = super::super::now_ms() ^ (u64::from(std::process::id()) << 32);
        let mut client = WsClient::connect(port, path, &[], seed)?;
        let cdp = Arc::new(Cdp {
            sender: client.sender(),
            next_id: AtomicU64::new(0),
            waiters: Mutex::new(Some(HashMap::new())),
        });
        let (events, received) = channel();
        let reader = Arc::clone(&cdp);
        std::thread::spawn(move || {
            while let Ok(Some(text)) = client.read_text() {
                route(&reader.waiters, &events, &text);
            }
            // 丢弃全部等待端：在途调用随之以「连接已断开」返回。
            reader.waiters.lock().expect("CDP 等待表锁被污染").take();
        });
        Ok((cdp, received))
    }

    /// 发送一条命令并等待其响应。`session` 为 `None` 时发给浏览器级会话。
    pub fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = channel();
        {
            let mut guard = self.waiters.lock().expect("CDP 等待表锁被污染");
            let Some(waiters) = guard.as_mut() else {
                return Err(format!("{method}：CDP 连接已断开"));
            };
            waiters.insert(id, tx);
        }
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        if let Err(e) = self.sender.send_text(&message.to_string()) {
            self.forget(id);
            return Err(format!("{method} 发送失败：{e}"));
        }
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(result) => result.map_err(|e| format!("{method}：{e}")),
            Err(RecvTimeoutError::Timeout) => {
                self.forget(id);
                Err(format!("{method} 超过 {} 秒未收到响应", CALL_TIMEOUT.as_secs()))
            }
            Err(RecvTimeoutError::Disconnected) => Err(format!("{method}：CDP 连接已断开")),
        }
    }

    /// 断开连接。读线程随之返回，事件接收端结束。
    pub fn close(&self) {
        self.sender.shutdown();
    }

    fn forget(&self, id: u64) {
        if let Some(waiters) = self.waiters.lock().expect("CDP 等待表锁被污染").as_mut() {
            waiters.remove(&id);
        }
    }
}

/// 分派一条入站消息：带 `id` 的是响应，交给等待它的调用；带 `method` 的是事件。
///
/// 无法识别的 `id` 直接丢弃：对应调用已超时返回，迟到的响应不得完成其他调用。
fn route(waiters: &Waiters, events: &Sender<Event>, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        log::warn!("无法识别的 CDP 消息");
        return;
    };
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let waiter = waiters
            .lock()
            .expect("CDP 等待表锁被污染")
            .as_mut()
            .and_then(|w| w.remove(&id));
        if let Some(waiter) = waiter {
            let result = match message.get("error") {
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("浏览器拒绝了该命令")
                    .to_owned()),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = waiter.send(result);
        }
        return;
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else { return };
    let _ = events.send(Event {
        method: method.to_owned(),
        session: message.get("sessionId").and_then(Value::as_str).map(str::to_owned),
        params: message.get("params").cloned().unwrap_or(Value::Null),
    });
}

#[cfg(test)]
mod tests {
    use super::{route, Waiters};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::mpsc::channel;
    use std::sync::Mutex;

    #[test]
    fn replies_go_to_their_caller_and_errors_keep_the_browser_message() {
        let (ok_tx, ok_rx) = channel();
        let (err_tx, err_rx) = channel();
        let waiters: Waiters = Mutex::new(Some(HashMap::from([(1, ok_tx), (2, err_tx)])));
        let (events, received) = channel();
        route(&waiters, &events, r#"{"id":2,"error":{"code":-32000,"message":"No target"}}"#);
        route(&waiters, &events, r#"{"id":1,"result":{"targetId":"T1"}}"#);
        assert_eq!(ok_rx.recv().unwrap(), Ok(json!({"targetId":"T1"})));
        assert_eq!(err_rx.recv().unwrap(), Err("No target".to_owned()));
        assert!(received.try_recv().is_err(), "响应不作为事件派发");
    }

    /// 超时后被移除的调用，其迟到的响应不得完成任何调用，也不作为事件处理。
    #[test]
    fn a_late_reply_for_a_forgotten_call_is_dropped() {
        let waiters: Waiters = Mutex::new(Some(HashMap::new()));
        let (events, received) = channel();
        route(&waiters, &events, r#"{"id":7,"result":{}}"#);
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn events_keep_their_session_and_arrival_order() {
        let waiters: Waiters = Mutex::new(Some(HashMap::new()));
        let (events, received) = channel();
        route(&waiters, &events, r#"{"method":"Target.targetCreated","params":{"a":1}}"#);
        route(&waiters, &events, r#"{"method":"Page.frameNavigated","sessionId":"S1","params":{}}"#);
        let first = received.recv().unwrap();
        assert_eq!((first.method.as_str(), first.session.as_deref()), ("Target.targetCreated", None));
        assert_eq!(first.params, json!({"a":1}));
        let second = received.recv().unwrap();
        assert_eq!(second.session.as_deref(), Some("S1"));
    }
}
