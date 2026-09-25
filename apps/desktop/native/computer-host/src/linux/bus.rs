//! AT-SPI 总线：地址查找、带调用上界的连接、对象代理与失败分类。
//!
//! 调用上界由 zbus 连接的 `method_timeout` 承担，对这条连接上的每一次方法调用都生效。
//! 这个值只能在建连时给定，所以握手重设上界时换一条新连接，不改旧连接。

use std::io::ErrorKind;
use std::time::Duration;

use atspi::proxy::bus::{BusProxyBlocking, StatusProxyBlocking};
use zbus::blocking::proxy::ProxyImpl;
use zbus::blocking::Connection;
use zbus::proxy::CacheProperties;

use crate::protocol::REF_STALE;

/// 总线上的一个无障碍对象：所在应用的唯一名与对象路径。
///
/// 唯一名在总线存续期间不复用，应用重启后换一个，所以旧对象的 `Obj` 不会指到新进程上。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Obj {
    pub bus: String,
    pub path: String,
}

impl Obj {
    /// 这个对象在注册表里的空引用路径。应用对不存在的子节点交回它，不报错。
    const NULL_PATH: &'static str = "/org/a11y/atspi/null";

    /// 从总线交回的对象引用构造。空引用交回 `None`。
    pub fn from_ref(object: &atspi::ObjectRefOwned) -> Option<Self> {
        let bus = object.name_as_str()?;
        let path = object.path_as_str();
        (path != Self::NULL_PATH && !bus.is_empty()).then(|| Self {
            bus: bus.to_owned(),
            path: path.to_owned(),
        })
    }

    /// 一个应用的根对象。
    pub fn root_of(bus: &str) -> Self {
        Self {
            bus: bus.to_owned(),
            path: "/org/a11y/atspi/accessible/root".to_owned(),
        }
    }

    /// 写进身份段与窗口编号的串：唯一名接对象路径。
    pub fn key(&self) -> String {
        format!("{}{}", self.bus, self.path)
    }

    /// 这个对象上某个接口的阻塞代理。不缓存属性：缓存会在建代理时多发一次 `GetAll`
    /// 并订阅属性变化信号，而每个代理只用一次。
    pub fn proxy<P>(&self, conn: &Connection) -> Result<P, Failure>
    where
        P: ProxyImpl<'static> + From<zbus::Proxy<'static>>,
    {
        P::builder(conn)
            .destination(self.bus.clone())
            .and_then(|b| b.path(self.path.clone()))
            .map(|b| b.cache_properties(CacheProperties::No))
            .and_then(zbus::blocking::proxy::Builder::build)
            .map_err(|e| Failure::from_zbus("建代理", &e))
    }
}

/// 一次总线调用失败的形状。
///
/// 超时与对象消失必须分开：应用不应答时对象还在，调用方该重试或放弃这一步；报成对象
/// 消失会让它转去重新发现目标。
#[derive(Debug)]
pub enum Failure {
    /// 调用在上界内没有应答。
    Timeout(String),
    /// 对象已经不在，或它所在的应用已经退出（`app` 为真）。
    Gone { app: bool, text: String },
    /// 其余总线错误，保留原文。
    Bus(String),
    /// worker 自己判定的拒绝，已带原因码。
    Refused(String),
}

impl Failure {
    /// 按 D-Bus 错误名分类。`step` 是出错的那一步，进回执原文。
    pub fn from_zbus(step: &str, error: &zbus::Error) -> Self {
        let text = format!("{step}失败：{error}");
        if let zbus::Error::InputOutput(io) = error {
            if io.kind() == ErrorKind::TimedOut {
                return Self::Timeout(text);
            }
        }
        match error_name(error).as_deref() {
            Some(
                "org.freedesktop.DBus.Error.NoReply"
                | "org.freedesktop.DBus.Error.Timeout"
                | "org.freedesktop.DBus.Error.TimedOut",
            ) => Self::Timeout(text),
            Some(
                "org.freedesktop.DBus.Error.ServiceUnknown"
                | "org.freedesktop.DBus.Error.NameHasNoOwner",
            ) => Self::Gone { app: true, text },
            Some("org.freedesktop.DBus.Error.UnknownObject") => Self::Gone { app: false, text },
            _ => Self::Bus(text),
        }
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Timeout(_))
    }

    /// 目标控件已经不在：对象消失、应用退出，或按 `ref` 定位时那个位置已经换了控件。
    pub fn is_gone(&self) -> bool {
        match self {
            Self::Gone { .. } => true,
            Self::Refused(text) => text.starts_with(REF_STALE) || text.starts_with(TARGET_LOST),
            Self::Timeout(_) | Self::Bus(_) => false,
        }
    }

    /// 转成回执原文。
    pub fn into_reason(self) -> String {
        match self {
            Self::Timeout(text) => format!("provider_timeout: {text}"),
            Self::Gone { app: true, text } => format!("{TARGET_LOST}: {text}"),
            Self::Gone { app: false, text } => format!("{REF_STALE}: {text}"),
            Self::Bus(text) | Self::Refused(text) => text,
        }
    }
}

/// 目标窗口或它所在的应用已经不在时的原因码。
pub const TARGET_LOST: &str = "target_lost";

fn error_name(error: &zbus::Error) -> Option<String> {
    match error {
        zbus::Error::MethodError(name, _, _) => Some(name.to_string()),
        zbus::Error::FDO(fdo) => Some(zbus::DBusError::name(fdo.as_ref()).to_string()),
        _ => None,
    }
}

/// 把总线调用的错误包成 `Failure`，`step` 是出错的那一步。
pub fn dbus(step: &'static str) -> impl Fn(zbus::Error) -> Failure {
    move |e| Failure::from_zbus(step, &e)
}

/// 会话总线上查到的无障碍总线，以及此刻的 `org.a11y.Status.IsEnabled`。
pub struct Located {
    pub address: String,
    pub enabled: Result<bool, String>,
}

/// 查无障碍总线的地址。`AT_SPI_BUS_ADDRESS` 给了就用它，否则问会话总线上的 `org.a11y.Bus`。
///
/// `IsEnabled` 只读不写：它是用户会话的设置，GTK 应用不看它，Qt 与 Chromium 系应用只在它为真
/// 时向总线交出控件树。
pub fn locate() -> Result<Located, String> {
    let session = Connection::session().map_err(|e| format!("连接会话总线失败：{e}"))?;
    let enabled = StatusProxyBlocking::new(&session)
        .and_then(|status| status.is_enabled())
        .map_err(|e| format!("读 org.a11y.Status.IsEnabled 失败：{e}"));
    if let Ok(address) = std::env::var("AT_SPI_BUS_ADDRESS") {
        if !address.is_empty() {
            return Ok(Located { address, enabled });
        }
    }
    let address = BusProxyBlocking::new(&session)
        .and_then(|bus| bus.get_address())
        .map_err(|e| format!("向 org.a11y.Bus 查无障碍总线地址失败：{e}"))?;
    Ok(Located { address, enabled })
}

/// 连上无障碍总线，每次方法调用以 `call` 为上界；建连本身以 `connect` 为上界。
///
/// 建连放到另一条线程上等：zbus 的建连没有期限参数，总线守护进程不应答时会一直等下去。
/// 到期未连上即失败，那条线程留给它自己结束。
pub fn connect(address: &str, connect: Duration, call: Duration) -> Result<Connection, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let address = address.to_owned();
    std::thread::spawn(move || {
        let built = zbus::blocking::connection::Builder::address(address.as_str())
            .map(|b| b.method_timeout(call))
            .and_then(zbus::blocking::connection::Builder::build);
        let _ = tx.send(built);
    });
    match rx.recv_timeout(connect) {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(e)) => Err(format!("连接无障碍总线失败：{e}")),
        Err(_) => Err(format!(
            "连接无障碍总线超时：{} ms 内没有完成",
            connect.as_millis()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn method_error(name: &str) -> zbus::Error {
        zbus::Error::FDO(Box::new(match name {
            "UnknownObject" => zbus::fdo::Error::UnknownObject("x".to_owned()),
            "ServiceUnknown" => zbus::fdo::Error::ServiceUnknown("x".to_owned()),
            "NoReply" => zbus::fdo::Error::NoReply("x".to_owned()),
            _ => zbus::fdo::Error::Failed("x".to_owned()),
        }))
    }

    /// 应用不应答与对象消失分开记：前者窗口还在，后者目标已经不在。
    #[test]
    fn a_silent_application_is_not_reported_as_a_vanished_object() {
        let timeout = Failure::from_zbus(
            "读名称",
            &zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::new(
                ErrorKind::TimedOut,
                "timed out",
            ))),
        );
        assert!(timeout.is_timeout() && !timeout.is_gone());
        assert!(timeout.into_reason().starts_with("provider_timeout: "));
        let no_reply = Failure::from_zbus("读名称", &method_error("NoReply"));
        assert!(no_reply.is_timeout());
    }

    /// 对象消失记 `ref_stale`，应用退出记 `target_lost`；两者都算目标已经不在。
    #[test]
    fn a_vanished_object_and_an_exited_application_are_both_gone() {
        let object = Failure::from_zbus("读名称", &method_error("UnknownObject"));
        assert!(object.is_gone());
        assert!(object.into_reason().starts_with("ref_stale: "));
        let app = Failure::from_zbus("读名称", &method_error("ServiceUnknown"));
        assert!(app.is_gone());
        assert!(app.into_reason().starts_with("target_lost: "));
    }

    /// 判不出归属的错误保留原文，不硬套一个原因码。
    #[test]
    fn an_unclassified_error_keeps_its_text() {
        let failed = Failure::from_zbus("读名称", &method_error("Failed"));
        assert!(!failed.is_gone() && !failed.is_timeout());
        assert!(failed.into_reason().starts_with("读名称失败："));
        let stale = Failure::Refused(format!("{REF_STALE}: 第 0 层没有下标 3 的子节点"));
        assert!(stale.is_gone());
    }

    #[test]
    fn a_null_reference_is_not_an_object() {
        let null = atspi::ObjectRef::new_owned(
            zbus::names::UniqueName::from_static_str_unchecked(":1.2"),
            zbus::zvariant::ObjectPath::from_static_str_unchecked(Obj::NULL_PATH),
        );
        assert_eq!(Obj::from_ref(&null), None);
        let real = atspi::ObjectRef::new_owned(
            zbus::names::UniqueName::from_static_str_unchecked(":1.2"),
            zbus::zvariant::ObjectPath::from_static_str_unchecked("/org/a11y/atspi/accessible/7"),
        );
        let obj = Obj::from_ref(&real).expect("真实对象");
        assert_eq!(obj.key(), ":1.2/org/a11y/atspi/accessible/7");
    }
}
