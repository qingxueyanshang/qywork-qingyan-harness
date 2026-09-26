//! AT-SPI 总线：地址查找、带调用上界的连接、对象代理与失败分类。
//!
//! 调用上界由 zbus 连接的 `method_timeout` 承担，对这条连接上的每一次方法调用都生效。
//! 这个值只能在建连时给定，所以握手重设上界时换一条新连接，不改旧连接。

use std::io::ErrorKind;
use std::time::Duration;

use atspi::proxy::bus::{BusProxyBlocking, StatusProxyBlocking};
use zbus::blocking::fdo::DBusProxy;
use zbus::blocking::proxy::ProxyImpl;
use zbus::blocking::Connection;
use zbus::names::BusName;
use zbus::proxy::CacheProperties;

use crate::protocol::REF_STALE;

/// 总线上的一个无障碍对象：所在应用的唯一名与对象路径。
///
/// 唯一名在总线存续期间不复用，应用重启后换一个，所以旧对象的 `Obj` 不会指到新进程上。
/// 以众所周知名交回的引用由 `resolve` 换成属主的唯一名，`bus` 里只有唯一名。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Obj {
    pub bus: String,
    pub path: String,
}

/// 应用交回的一格对象引用 `(so)`，按总线名的形式分。
#[derive(Debug, PartialEq, Eq)]
pub enum Reference {
    /// 空引用。应用对不存在的子节点交回它，不报错。
    Null,
    Unique(Obj),
    /// WebKitGTK 的界面进程以 WebProcess 的众所周知名（`<应用>.Sandboxed.WebProcess-<uuid>`）引用
    /// 网页的根，沙箱开关与否都是这个形式；WebProcess 自己交回的引用用它的唯一名。
    WellKnown {
        name: BusName<'static>,
        path: String,
    },
    /// 总线名既不是唯一名也不是众所周知名，原文是原因。
    Invalid(String),
}

impl Reference {
    /// 按 D-Bus 的总线名语法分类。空引用只看路径，与总线名无关。
    pub fn parse(name: &str, path: &str) -> Self {
        if path == Obj::NULL_PATH {
            return Self::Null;
        }
        match BusName::try_from(name.to_owned()) {
            Ok(BusName::Unique(unique)) => Self::Unique(Obj {
                bus: unique.to_string(),
                path: path.to_owned(),
            }),
            Ok(name) => Self::WellKnown {
                name,
                path: path.to_owned(),
            },
            Err(e) => Self::Invalid(format!("对象引用 ({name:?}, {path}) 的总线名不合法：{e}")),
        }
    }

    /// 换成对象，空引用交回 `None`。`owner` 查众所周知名此刻的属主，见 `owner`。
    ///
    /// 身份段取属主的唯一名，不要改成众所周知名：众所周知名可以在进程重启后由新进程重新持有，
    /// 旧 `ref` 会重新定位到新进程里同一路径的对象上；WebProcess 引用自己的对象时用唯一名，
    /// 同一个对象会有两个身份段，遍历的去重随之失效。
    ///
    /// 总线名不合法的一格按对象消失记：这一格没有可以寻址的对象。
    pub fn resolve(
        self,
        owner: impl FnOnce(BusName<'static>) -> Result<String, Failure>,
    ) -> Option<Result<Obj, Failure>> {
        match self {
            Self::Null => None,
            Self::Unique(obj) => Some(Ok(obj)),
            Self::WellKnown { name, path } => Some(owner(name).map(|bus| Obj { bus, path })),
            Self::Invalid(text) => Some(Err(Failure::Gone { app: false, text })),
        }
    }
}

/// 众所周知名此刻的属主（唯一名），由总线守护进程给出，不经应用。
pub fn owner(conn: &Connection, name: BusName<'static>) -> Result<String, Failure> {
    let daemon = DBusProxy::new(conn).map_err(dbus("建总线守护进程代理"))?;
    daemon
        .get_name_owner(name)
        .map(|unique| unique.to_string())
        .map_err(|e| Failure::from_zbus("查总线名的属主", &e.into()))
}

impl Obj {
    /// 这个对象在注册表里的空引用路径。应用对不存在的子节点交回它，不报错。
    const NULL_PATH: &'static str = "/org/a11y/atspi/null";

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

    /// 不该问总线守护进程的引用：唯一名与空引用。
    fn no_lookup(name: BusName<'static>) -> Result<String, Failure> {
        panic!("不该查 {name} 的属主")
    }

    /// 空引用只看路径：总线名为空、为唯一名都一样。
    #[test]
    fn a_null_reference_is_not_an_object() {
        assert!(Reference::parse("", Obj::NULL_PATH)
            .resolve(no_lookup)
            .is_none());
        assert!(Reference::parse(":1.2", Obj::NULL_PATH)
            .resolve(no_lookup)
            .is_none());
        let obj = Reference::parse(":1.2", "/org/a11y/atspi/accessible/7")
            .resolve(no_lookup)
            .expect("真实对象")
            .expect("唯一名直接可用");
        assert_eq!(obj.key(), ":1.2/org/a11y/atspi/accessible/7");
    }

    const WEB_PROCESS: &str = "org.webkit.app-2a42ef0a781e095cffb6c580eb308d5545f3c4e5da6e3d626c0899063a3fd236.Sandboxed.WebProcess-8105f09d-d955-4a1d-81d9-b0d18a512e8f";
    const WEB_ROOT: &str = "/org/a11y/webkit/accessible/eee2d7dc_8d6f_4ce7_9d21_4328496c21ed";

    /// 原始失败形状：WebKitGTK 界面进程交回的网页根引用，总线名是 WebProcess 的众所周知名。
    /// 它是一格合法引用；身份段取属主的唯一名，与 WebProcess 自己以唯一名交回的同一个对象相同。
    #[test]
    fn a_web_process_reference_resolves_to_its_owner() {
        let asked = std::cell::Cell::new(false);
        let obj = Reference::parse(WEB_PROCESS, WEB_ROOT)
            .resolve(|name| {
                asked.set(true);
                assert_eq!(name.as_str(), WEB_PROCESS);
                Ok(":1.2".to_owned())
            })
            .expect("真实对象")
            .expect("属主查得到");
        assert!(asked.get());
        let same = Reference::parse(":1.2", WEB_ROOT)
            .resolve(no_lookup)
            .expect("真实对象")
            .expect("唯一名直接可用");
        assert_eq!(obj, same);
        assert_eq!(obj.key(), format!(":1.2{WEB_ROOT}"));
    }

    /// WebProcess 换了一个之后众所周知名与属主都换了：旧身份段对不上新对象。
    #[test]
    fn a_restarted_web_process_gets_a_new_identity() {
        let before = Reference::parse(WEB_PROCESS, WEB_ROOT)
            .resolve(|_| Ok(":1.2".to_owned()))
            .and_then(Result::ok)
            .expect("旧对象");
        let after = Reference::parse(
            "org.webkit.app-2a42ef0a781e095cffb6c580eb308d5545f3c4e5da6e3d626c0899063a3fd236.Sandboxed.WebProcess-dba5a8e7-f257-4093-a8b1-6761f797eba8",
            WEB_ROOT,
        )
        .resolve(|_| Ok(":1.5".to_owned()))
        .and_then(Result::ok)
        .expect("新对象");
        assert_ne!(before.key(), after.key());
    }

    /// 众所周知名此刻没有属主：这一格按对象消失记，交给遍历记截断，不是整条回复失败。
    #[test]
    fn a_well_known_name_without_an_owner_is_a_vanished_child() {
        let no_owner = zbus::fdo::Error::NameHasNoOwner("x".to_owned());
        let gone = Reference::parse(WEB_PROCESS, WEB_ROOT)
            .resolve(|_| Err(Failure::from_zbus("查总线名的属主", &no_owner.into())))
            .expect("不是空引用")
            .expect_err("没有属主");
        assert!(gone.is_gone() && !gone.is_timeout());
    }

    /// 总线名为空或不合法的一格是读不出的引用，按对象消失记，只丢这一格。
    #[test]
    fn a_malformed_bus_name_is_an_unreadable_reference() {
        for name in ["", "not a name", "1.2"] {
            let failure = Reference::parse(name, "/org/a11y/atspi/accessible/5")
                .resolve(no_lookup)
                .expect("不是空引用")
                .expect_err("读不出");
            assert!(failure.is_gone() && !failure.is_timeout());
            let reason = failure.into_reason();
            assert!(reason.starts_with("ref_stale: "), "{reason}");
            assert!(reason.contains("/org/a11y/atspi/accessible/5"), "{reason}");
        }
    }
}
