//! xdg-desktop-portal 的 RemoteDesktop 与 ScreenCast 接口，经会话总线的 zbus 阻塞连接调用。
//!
//! 三条边界：
//!
//! 1. **请求的回答是信号，不是方法返回值。** `CreateSession`、`SelectDevices`、`SelectSources`、
//!    `Start` 只交回一个请求对象，结果以它的 `Response` 信号送达。收信号的是本连接上唯一一条
//!    常驻线程（`pump`），它按对象路径把回答交给在等的那一方；登记在发请求之前做，
//!    否则回答可能先于登记到达。
//! 2. **会话结束也是信号。** `Session::Closed` 由同一条线程记下，调用方在下一次读状态时取走。
//! 3. **每次方法调用以握手给的调用上界为限**，由连接的 `method_timeout` 承担；等回答的上界由
//!    调用方给，用户在授权框里考虑的时间不算方法调用。

use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use zbus::blocking::{Connection, MessageIterator};
use zbus::message::Type;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::MatchRule;

use super::ledger::Bound;
use super::ledger::{Session, Stream, KEYBOARD, POINTER};

const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE_DESKTOP: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREEN_CAST: &str = "org.freedesktop.portal.ScreenCast";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SESSION: &str = "org.freedesktop.portal.Session";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

/// ScreenCast 的来源类型位：按窗口共享。
const SOURCE_WINDOW: u32 = 2;
/// ScreenCast 的光标模式位：图里不画光标。
const CURSOR_HIDDEN: u32 = 1;
/// RemoteDesktop 的持久化方式：直到用户撤销。
const PERSIST_UNTIL_REVOKED: u32 = 2;

/// 请求的回答码：0 同意，1 用户取消，2 其他。
pub const RESPONSE_SUCCESS: u32 = 0;
pub const RESPONSE_CANCELLED: u32 = 1;

pub type Reply = (u32, HashMap<String, OwnedValue>);

/// portal 此刻提供的能力。
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    remote_desktop_version: u32,
    devices: u32,
    cursors: u32,
}

/// 一次已经发出 `Start` 的请求。
pub struct Started {
    pub session: String,
    /// `Start` 那个请求对象，到点没回答时经它关掉授权框。
    pub request: String,
    pub reply: Receiver<Reply>,
}

pub struct Bus {
    conn: Connection,
    /// 本连接发出的请求对象的路径前缀：`/org/freedesktop/portal/desktop/request/<唯一名>`。
    requests: String,
    sessions: String,
    waiting: Mutex<HashMap<String, Sender<Reply>>>,
    closed: Mutex<Vec<String>>,
    tokens: AtomicU32,
}

fn fail(step: &str) -> impl Fn(zbus::Error) -> String + '_ {
    move |e| format!("portal_failed: {step}失败：{e}")
}

impl Bus {
    /// 连上会话总线并起收信号的线程。每次方法调用以 `call` 为上界。
    pub fn open(call: Duration) -> Result<Arc<Self>, String> {
        let conn = zbus::blocking::connection::Builder::session()
            .map(|b| b.method_timeout(call))
            .and_then(zbus::blocking::connection::Builder::build)
            .map_err(|e| format!("portal_unavailable: 连接会话总线失败：{e}"))?;
        let unique = conn
            .unique_name()
            .map(|n| n.as_str().trim_start_matches(':').replace('.', "_"))
            .ok_or("portal_unavailable: 会话总线没有给本连接唯一名")?;
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .path_namespace(PATH)
            .map_err(fail("建信号匹配规则"))?
            .build();
        let signals = MessageIterator::for_match_rule(rule, &conn, None)
            .map_err(|e| format!("portal_unavailable: 订阅 portal 信号失败：{e}"))?;
        let bus = Arc::new(Self {
            conn,
            requests: format!("{PATH}/request/{unique}"),
            sessions: format!("{PATH}/session/{unique}"),
            waiting: Mutex::new(HashMap::new()),
            closed: Mutex::new(Vec::new()),
            tokens: AtomicU32::new(0),
        });
        let pumped = Arc::downgrade(&bus);
        std::thread::spawn(move || pump(signals, &pumped));
        Ok(bus)
    }

    /// 读 portal 的能力。没有 RemoteDesktop，或 ScreenCast 不能按窗口共享时交回原因：
    /// wlroots 系与 Hyprland 的 portal 没有 RemoteDesktop。
    pub fn caps(&self) -> Result<Caps, String> {
        let get = |iface: &str, name: &str| -> Result<u32, String> {
            let reply = self
                .conn
                .call_method(Some(DESTINATION), PATH, Some(PROPERTIES), "Get", &(iface, name))
                .map_err(|e| {
                    format!(
                        "portal_unavailable: 这个会话的 xdg-desktop-portal 不提供 {iface}，原生 Wayland \
                         窗口的取图与键鼠不可用（读 {name} 失败：{e}）"
                    )
                })?;
            let value: OwnedValue = reply
                .body()
                .deserialize()
                .map_err(|e| format!("portal_unavailable: {iface}.{name} 读不出来：{e}"))?;
            u32::try_from(value)
                .map_err(|e| format!("portal_unavailable: {iface}.{name} 不是整数：{e}"))
        };
        let devices = get(REMOTE_DESKTOP, "AvailableDeviceTypes")?;
        let remote_desktop_version = get(REMOTE_DESKTOP, "version")?;
        let sources = get(SCREEN_CAST, "AvailableSourceTypes")?;
        if sources & SOURCE_WINDOW == 0 {
            return Err("portal_unavailable: 这个合成器的 ScreenCast 不能按窗口共享".to_owned());
        }
        if devices & (KEYBOARD | POINTER) == 0 {
            return Err(
                "portal_unavailable: 这个合成器的 RemoteDesktop 不提供键盘与指针".to_owned(),
            );
        }
        let cursors = get(SCREEN_CAST, "AvailableCursorModes").unwrap_or(0);
        Ok(Caps {
            remote_desktop_version,
            devices,
            cursors,
        })
    }

    fn token(&self) -> String {
        format!("qywork{}", self.tokens.fetch_add(1, Ordering::SeqCst))
    }

    /// 发一个请求，交回等它回答的接收端。登记在发出之前，见本模块第 1 条。
    fn request(
        &self,
        iface: &str,
        method: &str,
        send: impl FnOnce(&str) -> zbus::Result<zbus::message::Message>,
    ) -> Result<(String, Receiver<Reply>), String> {
        let token = self.token();
        let path = format!("{}/{token}", self.requests);
        let (tx, rx) = std::sync::mpsc::channel();
        self.lock_waiting().insert(path.clone(), tx);
        let sent = send(&token).and_then(|reply| {
            let body = reply.body();
            let handle: ObjectPath<'_> = body.deserialize()?;
            Ok(handle.to_string())
        });
        match sent {
            Ok(handle) if handle == path => Ok((path, rx)),
            Ok(handle) => {
                self.lock_waiting().remove(&path);
                Err(format!(
                    "portal_failed: {iface}.{method} 交回的请求对象是 {handle}，不是 {path}；这个 portal 太旧"
                ))
            }
            Err(e) => {
                self.lock_waiting().remove(&path);
                Err(format!("portal_failed: {iface}.{method} 失败：{e}"))
            }
        }
    }

    fn lock_waiting(&self) -> std::sync::MutexGuard<'_, HashMap<String, Sender<Reply>>> {
        self.waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 等一个不需要用户参与的请求回答。
    fn answered(
        rx: &Receiver<Reply>,
        step: &str,
        limit: Duration,
    ) -> Result<HashMap<String, OwnedValue>, String> {
        match rx.recv_timeout(limit) {
            Ok((RESPONSE_SUCCESS, results)) => Ok(results),
            Ok((code, _)) => Err(format!("portal_failed: {step}被拒绝（回答码 {code}）")),
            Err(_) => Err(format!(
                "portal_failed: {step}在 {} ms 内没有回答",
                limit.as_millis()
            )),
        }
    }

    /// 建会话、选设备与来源，再发 `Start`。前三步不经用户、按 `limit` 等回答；`Start` 的回答
    /// 由调用方等，那一步要用户在授权框里点。
    ///
    /// `restore` 是上一次同意时存下的 restore token。它只能用一次：portal 收到即作废，
    /// 同意之后在 `Start` 的回答里交回新的。
    pub fn negotiate(
        &self,
        caps: Caps,
        restore: Option<&str>,
        limit: Duration,
    ) -> Result<Started, String> {
        let (_, rx) = self.request(REMOTE_DESKTOP, "CreateSession", |token| {
            let session_token = format!("s{token}");
            let options: HashMap<&str, Value<'_>> = HashMap::from([
                ("handle_token", Value::from(token)),
                ("session_handle_token", Value::from(session_token.as_str())),
            ]);
            self.conn.call_method(
                Some(DESTINATION),
                PATH,
                Some(REMOTE_DESKTOP),
                "CreateSession",
                &(options,),
            )
        })?;
        let created = Self::answered(&rx, "建会话", limit)?;
        let session = created
            .get("session_handle")
            .and_then(|v| String::try_from(v.clone()).ok())
            .ok_or("portal_failed: 建会话的回答里没有 session_handle")?;
        let staged = self.select(caps, &session, restore, limit).and_then(|()| {
            let (request, reply) = self.request(REMOTE_DESKTOP, "Start", |token| {
                let options: HashMap<&str, Value<'_>> =
                    HashMap::from([("handle_token", Value::from(token))]);
                let path = ObjectPath::try_from(session.as_str())?;
                self.conn.call_method(
                    Some(DESTINATION),
                    PATH,
                    Some(REMOTE_DESKTOP),
                    "Start",
                    &(path, "", options),
                )
            })?;
            Ok(Started {
                session: session.clone(),
                request,
                reply,
            })
        });
        if staged.is_err() {
            self.close_session(&session);
        }
        staged
    }

    fn select(
        &self,
        caps: Caps,
        session: &str,
        restore: Option<&str>,
        limit: Duration,
    ) -> Result<(), String> {
        let path = ObjectPath::try_from(session)
            .map_err(|e| format!("portal_failed: 会话路径 {session} 不合法：{e}"))?;
        let (_, rx) = self.request(REMOTE_DESKTOP, "SelectDevices", |token| {
            let mut options: HashMap<&str, Value<'_>> = HashMap::from([
                ("handle_token", Value::from(token)),
                ("types", Value::from(caps.devices & (KEYBOARD | POINTER))),
            ]);
            // 持久化与 restore token 只能经 RemoteDesktop 给：远程桌面会话的 SelectSources
            // 带上它们会被拒绝。
            if caps.remote_desktop_version >= 2 {
                options.insert("persist_mode", Value::from(PERSIST_UNTIL_REVOKED));
                if let Some(token) = restore {
                    options.insert("restore_token", Value::from(token));
                }
            }
            self.conn.call_method(
                Some(DESTINATION),
                PATH,
                Some(REMOTE_DESKTOP),
                "SelectDevices",
                &(&path, options),
            )
        })?;
        Self::answered(&rx, "选输入设备", limit)?;
        let (_, rx) = self.request(SCREEN_CAST, "SelectSources", |token| {
            let mut options: HashMap<&str, Value<'_>> = HashMap::from([
                ("handle_token", Value::from(token)),
                ("types", Value::from(SOURCE_WINDOW)),
                ("multiple", Value::from(true)),
            ]);
            if caps.cursors & CURSOR_HIDDEN != 0 {
                options.insert("cursor_mode", Value::from(CURSOR_HIDDEN));
            }
            self.conn.call_method(
                Some(DESTINATION),
                PATH,
                Some(SCREEN_CAST),
                "SelectSources",
                &(&path, options),
            )
        })?;
        Self::answered(&rx, "选共享来源", limit).map(|_| ())
    }

    /// 关掉一个还没回答的请求：授权框随之关闭。
    pub fn close_request(&self, request: &str) {
        self.lock_waiting().remove(request);
        let _ = self
            .conn
            .call_method(Some(DESTINATION), request, Some(REQUEST), "Close", &());
    }

    /// 结束一个会话。会话已经不在时 portal 回错误，不理会。
    pub fn close_session(&self, session: &str) {
        let _ = self
            .conn
            .call_method(Some(DESTINATION), session, Some(SESSION), "Close", &());
    }

    /// 取走收到的「会话已结束」。
    pub fn take_closed(&self) -> Vec<String> {
        std::mem::take(
            &mut *self
                .closed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    /// 这个会话的 PipeWire 连接。每次调用给一个新的描述符。
    pub fn pipewire_remote(&self, session: &str) -> Result<OwnedFd, String> {
        let path = ObjectPath::try_from(session)
            .map_err(|e| format!("portal_failed: 会话路径不合法：{e}"))?;
        let options: HashMap<&str, Value<'_>> = HashMap::new();
        let reply = self
            .conn
            .call_method(
                Some(DESTINATION),
                PATH,
                Some(SCREEN_CAST),
                "OpenPipeWireRemote",
                &(path, options),
            )
            .map_err(fail("取 PipeWire 连接"))?;
        let fd: zbus::zvariant::OwnedFd = reply
            .body()
            .deserialize()
            .map_err(fail("读 PipeWire 连接"))?;
        Ok(fd.into())
    }

    fn notify<B>(&self, method: &str, body: &B) -> Result<(), String>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        self.conn
            .call_method(Some(DESTINATION), PATH, Some(REMOTE_DESKTOP), method, body)
            .map(|_| ())
            .map_err(|e| format!("portal_failed: {method} 失败：{e}"))
    }

    /// 指针移到流 `node` 的逻辑坐标 `(x, y)`。
    pub fn pointer_to(&self, session: &str, node: u32, x: f64, y: f64) -> Result<(), String> {
        let path = session_path(session)?;
        self.notify(
            "NotifyPointerMotionAbsolute",
            &(path, no_options(), node, x, y),
        )
    }

    /// `button` 是 Linux 输入事件码。
    pub fn pointer_button(&self, session: &str, button: i32, pressed: bool) -> Result<(), String> {
        let path = session_path(session)?;
        self.notify(
            "NotifyPointerButton",
            &(path, no_options(), button, u32::from(pressed)),
        )
    }

    /// `axis` 0 是纵轴、1 是横轴；`steps` 正值向下或向右。
    pub fn pointer_axis(&self, session: &str, axis: u32, steps: i32) -> Result<(), String> {
        let path = session_path(session)?;
        self.notify(
            "NotifyPointerAxisDiscrete",
            &(path, no_options(), axis, steps),
        )
    }

    pub fn keysym(&self, session: &str, keysym: u32, pressed: bool) -> Result<(), String> {
        let path = session_path(session)?;
        let keysym =
            i32::try_from(keysym).map_err(|_| format!("portal_failed: keysym {keysym:#x} 越界"))?;
        self.notify(
            "NotifyKeyboardKeysym",
            &(path, no_options(), keysym, u32::from(pressed)),
        )
    }

    /// 这个会话是不是本连接建的。别的连接的会话结束信号不算数。
    fn owns(&self, session: &str) -> bool {
        session.starts_with(&self.sessions)
    }
}

fn session_path(session: &str) -> Result<ObjectPath<'_>, String> {
    ObjectPath::try_from(session)
        .map_err(|e| format!("portal_failed: 会话路径 {session} 不合法：{e}"))
}

fn no_options() -> HashMap<&'static str, Value<'static>> {
    HashMap::new()
}

/// 收信号的线程：请求的回答交给在等的那一方，会话结束记进 `closed`。连接关闭即退出。
fn pump(signals: MessageIterator, bus: &std::sync::Weak<Bus>) {
    for message in signals {
        let Ok(message) = message else { continue };
        let Some(bus) = bus.upgrade() else { return };
        let header = message.header();
        let (Some(path), Some(iface), Some(member)) =
            (header.path(), header.interface(), header.member())
        else {
            continue;
        };
        match (iface.as_str(), member.as_str()) {
            (REQUEST, "Response") => {
                let Ok(reply) = message.body().deserialize::<Reply>() else {
                    continue;
                };
                if let Some(tx) = bus.lock_waiting().remove(path.as_str()) {
                    let _ = tx.send(reply);
                }
            }
            (SESSION, "Closed") if bus.owns(path.as_str()) => {
                bus.closed
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(path.to_string());
            }
            _ => {}
        }
    }
}

/// 从 `Start` 的回答里读出会话：用户允许的设备、共享的流，以及新的 restore token。
pub fn started(
    session: String,
    results: &HashMap<String, OwnedValue>,
) -> Result<(Session, Option<String>), String> {
    let devices = results
        .get("devices")
        .and_then(|v| u32::try_from(v.clone()).ok())
        .unwrap_or(0);
    let token = results
        .get("restore_token")
        .and_then(|v| String::try_from(v.clone()).ok());
    let streams = results
        .get("streams")
        .map(|v| streams(v))
        .unwrap_or_default();
    // 凭 restore token 恢复时，记住的窗口已经不在（应用重启后窗口标题或应用 id 变了），
    // GNOME 的 portal 照样回答同意，只是不带流。
    if streams.is_empty() {
        return Err(
            "consent_incomplete: portal 的回答里没有共享的窗口，记住的共享窗口可能已经不在"
                .to_owned(),
        );
    }
    Ok((
        Session {
            handle: session,
            devices,
            streams,
            pointer_used: false,
        },
        token,
    ))
}

/// `a(ua{sv})`：每条流的节点号与属性，属性里取 `size`。
fn streams(value: &Value<'_>) -> Vec<Stream> {
    let Value::Array(array) = value else {
        return Vec::new();
    };
    array
        .iter()
        .filter_map(|entry| {
            let Value::Structure(entry) = entry else {
                return None;
            };
            let [Value::U32(node), Value::Dict(props)] = entry.fields() else {
                return None;
            };
            let size = props
                .get::<&str, Value<'_>>(&"size")
                .ok()
                .flatten()
                .and_then(|size| match size {
                    Value::Structure(s) => match s.fields() {
                        [Value::I32(w), Value::I32(h)] => Some((*w, *h)),
                        _ => None,
                    },
                    _ => None,
                });
            Some(Stream {
                node: *node,
                size,
                bound: Bound::Unmeasured,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::{Array, Dict, Signature, StructureBuilder};

    fn stream_entry(node: u32, size: Option<(i32, i32)>) -> Value<'static> {
        let mut props = Dict::new(&Signature::Str, &Signature::Variant);
        if let Some((w, h)) = size {
            props
                .add(
                    "size",
                    Value::from(
                        StructureBuilder::new()
                            .add_field(w)
                            .add_field(h)
                            .build()
                            .unwrap(),
                    ),
                )
                .unwrap();
        }
        props.add("source_type", Value::from(2u32)).unwrap();
        Value::from(
            StructureBuilder::new()
                .add_field(node)
                .append_field(Value::Dict(props))
                .build()
                .unwrap(),
        )
    }

    /// `Start` 的回答：节点号与逻辑范围读出来，restore token 与设备位原样交回。
    #[test]
    fn a_start_reply_gives_streams_devices_and_the_new_token() {
        let signature = Signature::try_from("(ua{sv})").unwrap();
        let mut array = Array::new(&signature);
        array.append(stream_entry(44, Some((1280, 800)))).unwrap();
        array.append(stream_entry(45, None)).unwrap();
        let results: HashMap<String, OwnedValue> = HashMap::from([
            ("devices".to_owned(), OwnedValue::from(3u32)),
            (
                "restore_token".to_owned(),
                OwnedValue::try_from(Value::from("7c0f3b1e-0000-4000-8000-000000000001")).unwrap(),
            ),
            (
                "streams".to_owned(),
                OwnedValue::try_from(Value::Array(array)).unwrap(),
            ),
        ]);
        let (session, token) = started("/s/1".to_owned(), &results).expect("回答完整");
        assert_eq!(session.devices, 3);
        assert_eq!(
            token.as_deref(),
            Some("7c0f3b1e-0000-4000-8000-000000000001")
        );
        let nodes: Vec<(u32, Option<(i32, i32)>)> =
            session.streams.iter().map(|s| (s.node, s.size)).collect();
        assert_eq!(nodes, vec![(44, Some((1280, 800))), (45, None)]);
    }

    /// 没有流的「同意」不算会话。
    #[test]
    fn a_start_reply_without_streams_is_refused() {
        let results: HashMap<String, OwnedValue> =
            HashMap::from([("devices".to_owned(), OwnedValue::from(3u32))]);
        assert!(started("/s/1".to_owned(), &results).is_err());
    }
}
