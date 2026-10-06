//! Linux 后端（`Atspi`）：AT-SPI 负责控件树、后台语义动作、文本读取与有界等待，X11 负责窗口
//! 清单、层叠序、几何、采图、前台键盘与指针输入及窗口动作（`x11`、`foreground`）；Wayland
//! 会话中原生 Wayland 窗口的采图与前台输入经由 xdg-desktop-portal（`portal`）。
//!
//! 六条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。前台动作只在前台模式开启
//!    时列出与执行。
//! 2. 窗口清单以 X11 的 EWMH 清单为准，AT-SPI frame 按 `associate` 的规则对应 X 窗口；
//!    无法对应的 frame 以负数编号单独列出。X11 会话中这些 frame 只提供控件树与后台动作；
//!    Wayland 会话中这些 frame（原生 Wayland 窗口，以及未能对应的 XWayland 窗口）在用户经系统
//!    授权框共享之后另外提供采图与键盘、指针输入，见 `portal`。X11 一侧不可用（无法连接
//!    X 服务器，或根窗口上没有 EWMH 清单）时，清单中只有这类 frame。
//! 3. 能力与坐标可信度按窗口确定，不按平台确定，规则见 `Reach`。
//! 4. `ref` 是不透明字符串：从窗口根 frame 出发的子节点下标路径、`@` 后的核对串（角色与稳定标识的
//!    指纹），`#` 后的身份段（总线唯一名 + 对象路径）。动作前按路径重新定位并核对两者，
//!    不允许用旧编号操作位置已变化、或对象路径已分配给其他控件的位置。
//! 5. 每次总线调用以宿主握手时提供的上界为限，由 zbus 连接的 `method_timeout` 执行；
//!    本模块不另建线程等待读取。
//! 6. 每个后端实例各自建立一条无障碍总线连接：每个等待线程各建一个实例，与执行线程互不排队，
//!    一次阻塞的调用只占用所在的连接。连接在握手之后的第一次调用时建立，会话中未找到
//!    无障碍总线时由下一次调用重新查找：总线安装或启动之后无需更换 worker。

mod actions;
mod associate;
mod bus;
mod foreground;
mod node;
mod portal;
mod text;
mod walk;
mod x11;

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::sync::Once;
use std::time::Duration;

use atspi::proxy::accessible::AccessibleProxyBlocking;
use atspi::{Interface, State};
use zbus::blocking::Connection;

use crate::backend::{
    wait_loop, ActRequest, Attempt, Backend, CaptureRequest, Probe, WaitRequest, Watch,
};
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::protocol::{
    Access, ActionEvidence, ActionSpec, BlockingWindow, Bounds, DragTarget, Grant, Image,
    Observation, Select, Tree, Wait, WaitUntil, WindowInfo, ACCESSIBILITY_BUS_UNAVAILABLE,
    NOT_DISPATCHED, TARGET_BLOCKED,
};
use crate::tree::{matches_target, settle};
use associate::{frame_window, FrameSide, Unmatched, XSide};
use bus::{Failure, Obj, TARGET_LOST};
use node::Fields;
use walk::{Frame, Located, Popup};

/// 首次读取一个窗口时两次读取之间的间隔。Chromium 系应用在首次收到无障碍请求后才构建控件树。
const FIRST_READ_INTERVAL: Duration = Duration::from_millis(350);
/// 首次读取一个窗口的时长上限。页面上有持续变化的元素时控件数持续变化，到达上限即返回最后一次读取的结果。
const FIRST_READ_LIMIT: Duration = Duration::from_secs(2);
/// 调用未返回时随回执返回的顶层窗口数上限。
const MAX_BLOCKING_WINDOWS: usize = 16;

/// 对没有唯一对应 X 窗口的 frame 请求采图或前台动作时的拒绝原因。其后附加 X11 一侧的状况，
/// 见 `Atspi::frame_only`。
const FRAME_ONLY: &str =
    "window_unassociated: 该 frame 没有唯一对应的 X11 窗口，无法采图，也无法执行前台动作";
/// 对 Wayland 会话中的 X 窗口请求指针动作时的拒绝原因，理由见 `Reach`。
const POINTER_UNVERIFIABLE: &str = "pointer_unverifiable: 该窗口是 Wayland 会话中的 X11 窗口，\
     XTest 指针事件发往哪个窗口由合成器决定，X11 一侧无法核对；键盘输入与窗口动作不受此限制";
/// 测量原生 Wayland 窗口的流尺寸时等待一帧的上限。动作请求没有自身的采集预算，取与采图相同的量级。
const MEASURE_BUDGET: Duration = Duration::from_secs(2);

/// 一个窗口当前可提供的能力。按窗口确定，由窗口是否对应 X 窗口、会话类型与 portal 共享状态决定。
///
/// - `rect`：AT-SPI 包围盒是 X 根窗口坐标，可以作为节点的 `rect` 发布、作为指针落点。对应
///   X 窗口的窗口满足此条件；未对应的窗口只在 X11 会话中满足。Wayland 会话中原生 Wayland 窗口
///   报告的是以自身 surface 左上角为原点的坐标（含客户端绘制的阴影），弹出菜单也按该原点报告，
///   与屏幕坐标、图像几何均不是同一套坐标；经 portal 共享之后同样不发布，按图定位使用流自身的坐标。
/// - `keyboard`：键盘输入。对应 X 窗口即可：前置条件核对的是窗口管理器维护的活动窗口与
///   X 输入焦点，Wayland 会话中由合成器自身的 X 窗口管理器维护。原生 Wayland 窗口需要经
///   portal 共享，且用户允许键盘控制。
/// - `window`：窗口动作。只有对应 X 窗口的窗口具备：Wayland 合成器不允许客户端摆放其他窗口。
/// - `pointer`：指针动作。对应 X 窗口且不在 Wayland 会话中；或原生 Wayland 窗口经 portal
///   共享且用户允许指针控制，此时只接受按图定位的落点。XWayland 投递 XTest 指针事件的结果
///   还取决于合成器的指针当前是否位于其某个 surface 上，X11 一侧无法读取这一项，也无法看到原生
///   Wayland 窗口，`lands_on_target` 的判据在此不成立。不要按合成器名或环境放开此项：
///   XWayland 是否把 XTest 事件转交合成器取决于合成器启动它的方式，X 协议中没有可核对的标志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Reach {
    rect: bool,
    keyboard: bool,
    window: bool,
    pointer: bool,
}

impl Reach {
    /// `associated`：窗口已对应 X 窗口。`x_server`：可以连接 X 服务器。`shared`：未对应 X 窗口的
    /// frame 在 Wayland 会话中经 portal 共享的方式。
    fn of(
        associated: bool,
        x_server: bool,
        wayland: bool,
        shared: Option<&portal::Coverage>,
    ) -> Self {
        Self {
            rect: associated || (x_server && !wayland),
            keyboard: associated || shared.is_some_and(|c| c.keyboard),
            window: associated,
            pointer: (associated && !wayland) || shared.is_some_and(|c| c.pointer),
        }
    }
}

/// Wayland 会话：环境中有合成器的套接字名、登录会话类型是 `wayland`，或 X 服务器是 XWayland。
///
/// 三项都要检查：`WAYLAND_DISPLAY` 可能被调用方从环境中移除，而连接的仍是 XWayland；WSLg 不设置
/// `XDG_SESSION_TYPE`。
fn wayland_session(
    wayland_display: Option<&OsStr>,
    session_type: Option<&OsStr>,
    xwayland: bool,
) -> bool {
    wayland_display.is_some_and(|d| !d.is_empty())
        || session_type.is_some_and(|t| t == "wayland")
        || xwayland
}

pub struct Atspi {
    /// X 服务器连接。无法连接时为原因，窗口清单只有 AT-SPI frame。
    display: Result<x11::Display, String>,
    /// 见 `wayland_session`。构造时确定一次。
    wayland: bool,
    /// 握手时宿主提供的建连上界与调用上界。握手之前为空：此时准入判定不放行任何读取。
    bounds: Cell<Option<(Duration, Duration)>>,
    /// 按上界建立的无障碍总线连接，以及建连时读取的 `org.a11y.Status.IsEnabled`（只读不写，见
    /// `bus::locate`）。尚未建立或会话中未找到总线时为空。
    bus: RefCell<Option<(Connection, Result<bool, String>)>>,
    /// 本实例读取过控件表的窗口，按窗口编号与进程号记录。
    read_before: RefCell<HashSet<(i64, u32)>>,
}

/// 读取控件树使用的根：窗口对应的 frame、所在应用的进程号、对应的 X 窗口，以及接在 frame 子节点
/// 之后的、该窗口拥有的弹出窗口（见 `Atspi::popups`）。
struct Root {
    obj: Obj,
    pid: u32,
    xid: Option<u32>,
    popups: Vec<Popup>,
}

impl Backend for Atspi {
    const NAME: &'static str = "linux-atspi";

    /// 构造不要求无障碍总线（见 `access`），无法连接 X 服务器也不视为失败，见 `Atspi::display`。
    fn new() -> Result<Self, String> {
        let display = x11::Display::connect();
        let wayland = wayland_session(
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
            std::env::var_os("XDG_SESSION_TYPE").as_deref(),
            display.as_ref().is_ok_and(x11::Display::xwayland),
        );
        // 宿主将 worker 的 stderr 转入应用日志。每个进程只记录一次：等待线程为每条请求各建一个实例。
        // 总线地址与 IsEnabled 在第一次建连时记录，见 `conn`。
        static REPORTED: Once = Once::new();
        REPORTED.call_once(|| {
            eprintln!(
                "x11={} wayland={wayland}",
                display
                    .as_ref()
                    .map_or_else(Clone::clone, |_| "ok".to_owned()),
            );
        });
        Ok(Self {
            display,
            wayland,
            bounds: Cell::new(None),
            bus: RefCell::new(None),
            read_before: RefCell::new(HashSet::new()),
        })
    }

    /// 能在会话总线上查到无障碍总线的地址即视为已授权。查不到时读取与动作一律不可用，原因原文随通报
    /// 写入 stderr。
    fn access() -> Access {
        match bus::locate() {
            Ok(_) => Access::of(Vec::new(), None),
            Err(detail) => Access::of(vec![Grant::AccessibilityBus], Some(detail)),
        }
    }

    /// 记录宿主提供的上界，丢弃旧连接。之后的每条连接都按这两个值建立：建连上界由 `bus::connect`
    /// 在等待建连时执行，调用上界是连接的 `method_timeout`。
    fn set_timeouts(&self, connection_ms: u32, transaction_ms: u32) -> Result<(u32, u32), String> {
        self.bounds.set(Some((
            Duration::from_millis(u64::from(connection_ms)),
            Duration::from_millis(u64::from(transaction_ms)),
        )));
        *self.bus.borrow_mut() = None;
        Ok((connection_ms, transaction_ms))
    }

    fn list_windows(&self) -> Result<Observation, String> {
        let conn = self.conn()?;
        Ok(Observation::Windows {
            captured_at: crate::protocol::now_ms(),
            windows: self.windows(&conn)?,
        })
    }

    /// 读取一个窗口的控件表。本实例首次读取一个窗口时持续读取，直到控件数不再变化，
    /// 理由见 `FIRST_READ_INTERVAL`。
    fn read_tree(
        &self,
        window: i64,
        select: &Select,
        bounds: Bounds,
        foreground: bool,
    ) -> Result<Observation, String> {
        let conn = self.conn()?;
        let root = self.root(&conn, window).map_err(Failure::into_reason)?;
        let first = self.read_before.borrow_mut().insert((window, root.pid));
        let read = || self.read_tree_inner(&conn, &root, window, select, bounds, foreground);
        let tree = if first {
            settle(
                read,
                |t| t.node_count,
                FIRST_READ_INTERVAL,
                FIRST_READ_LIMIT,
            )
        } else {
            read()
        };
        tree.map(Observation::Tree).map_err(Failure::into_reason)
    }

    /// 执行动作，并按调用方当前观察的范围完整重读。未派发时不重读。
    fn act(
        &self,
        req: &ActRequest<'_>,
        stop: &dyn Fn() -> bool,
    ) -> (Attempt, Result<Observation, String>) {
        let refused = |reason: String| (Attempt::Refused(reason), Err(NOT_DISPATCHED.to_owned()));
        if req.action.foreground_only() {
            return match self.act_foreground(req, stop) {
                Attempt::Refused(reason) => refused(reason),
                called => (called, self.reread(req)),
            };
        }
        let Some(reference) = req.reference else {
            return refused("missing_target: 该动作只能按控件执行".to_owned());
        };
        let conn = match self.conn() {
            Ok(c) => c,
            Err(reason) => return refused(reason),
        };
        let root = match self.root(&conn, req.window) {
            Ok(r) => r,
            Err(f) => return refused(f.into_reason()),
        };
        let located = match walk::locate(&conn, &root.obj, &root.popups, reference, ALL_FIELDS) {
            Ok(l) => l,
            Err(f) => return refused(f.into_reason()),
        };
        let watch = CallWatch::before(self.display.as_ref().ok(), root.xid, root.pid);
        match actions::perform(&conn, &watch, &located, located.parent.as_ref(), req.action) {
            Attempt::Refused(reason) => refused(reason),
            // 调用尚未返回：应用可能阻塞于本次调用，重读会一直等待到上界后超时。
            Attempt::Called(outcome) if !outcome.returned => {
                (Attempt::Called(outcome), Err(TARGET_BLOCKED.to_owned()))
            }
            called => (called, self.reread(req)),
        }
    }

    fn read_text(
        &self,
        window: i64,
        reference: &str,
        max_chars: u32,
    ) -> Result<Observation, String> {
        let conn = self.conn()?;
        let root = self.root(&conn, window).map_err(Failure::into_reason)?;
        let fields = Fields {
            value: false,
            state: false,
            foreground: false,
            pointer: false,
            window: false,
            rect: false,
        };
        let located = walk::locate(&conn, &root.obj, &root.popups, reference, fields)
            .map_err(Failure::into_reason)?;
        if !located.facts.interfaces.contains(Interface::Text) {
            return Err("pattern_missing: Text".to_owned());
        }
        text::read(
            &conn,
            window,
            reference,
            &located.obj,
            node::text_selectable(&located.facts),
            max_chars,
        )
        .map_err(Failure::into_reason)
    }

    fn capture_image(&self, req: &CaptureRequest<'_>) -> Result<Image, String> {
        if req.window < 0 && self.wayland {
            return self.capture_shared(req);
        }
        let window = self.xid(req.window)?;
        self.display()?.capture(window, req)
    }

    fn wait(&self, req: &WaitRequest<'_>, stop: &dyn Fn() -> bool) -> Result<Observation, String> {
        let conn = self.conn()?;
        let (found, reason, probe) =
            wait_loop(req, stop, || self.probe(&conn, req)).map_err(Failure::into_reason)?;
        let tree = self
            .wait_state(&conn, req, probe)
            .map_err(Failure::into_reason)?;
        Ok(Observation::Wait(Wait {
            found,
            reason,
            tree,
        }))
    }
}

/// 动作前重新定位与等待判定读取的字段：读取值与状态，不读取前台属性。
const ALL_FIELDS: Fields = Fields {
    value: true,
    state: true,
    foreground: false,
    pointer: false,
    window: false,
    rect: false,
};

fn x_sides(clients: &[x11::Client]) -> Vec<XSide<'_>> {
    clients
        .iter()
        .map(|c| XSide {
            title: &c.title,
            pid: c.pid,
            client: c.client,
            outer: c.outer(),
        })
        .collect()
}

fn frame_sides(frames: &[Frame]) -> Vec<FrameSide<'_>> {
    frames
        .iter()
        .map(|f| FrameSide {
            title: &f.title,
            pid: f.pid,
            rect: f.rect,
        })
        .collect()
}

impl Atspi {
    /// 本实例的无障碍总线连接。第一次调用时按握手提供的上界建立；总线一端关闭之后重建；
    /// 无法建立时以 `ACCESSIBILITY_BUS_UNAVAILABLE` 拒绝，由下一次调用重新查找。
    ///
    /// 不要删除 `is_closed` 的判定：总线守护进程退出后该连接上的每次调用都失败，而原因
    /// 原文中没有原因码，服务循环因此不会重新查询授权事实。
    fn conn(&self) -> Result<Connection, String> {
        if let Some((conn, _)) = self.bus.borrow().as_ref() {
            if !conn.is_closed() {
                return Ok(conn.clone());
            }
        }
        *self.bus.borrow_mut() = None;
        let (connect, call) = self
            .bounds
            .get()
            .ok_or_else(|| "no_handshake: 无障碍总线连接在握手之后建立".to_owned())?;
        let unavailable = |e: String| format!("{ACCESSIBILITY_BUS_UNAVAILABLE}: {e}");
        let located = bus::locate().map_err(unavailable)?;
        let conn = bus::connect(&located.address, connect, call).map_err(unavailable)?;
        // 宿主将 worker 的 stderr 转入应用日志。每个进程只记录一次：等待线程为每条请求各建一个实例。
        static REPORTED: Once = Once::new();
        REPORTED.call_once(|| {
            eprintln!(
                "a11y bus={} IsEnabled={:?}",
                located.address, located.enabled
            );
        });
        *self.bus.borrow_mut() = Some((conn.clone(), located.enabled));
        Ok(conn)
    }

    fn display(&self) -> Result<&x11::Display, String> {
        self.display
            .as_ref()
            .map_err(|e| format!("x11_unavailable: {e}"))
    }

    /// X11 一侧的顶层窗口，从下到上。无法连接 X 服务器或根窗口上没有 EWMH 清单时返回原因。
    fn x_clients(&self) -> Result<Vec<x11::Client>, String> {
        self.display()?.clients()
    }

    /// 读取控件树的窗口当前可提供的能力。未对应 X 窗口的 frame 在 Wayland 会话中按 portal
    /// 的共享状态计算，只读取已有的状态，不触发授权框。
    fn reach(&self, root: &Root) -> Reach {
        let shared = (root.xid.is_none() && self.wayland)
            .then(|| portal::covers(&root.obj.key()))
            .flatten();
        Reach::of(
            root.xid.is_some(),
            self.display.is_ok(),
            self.wayland,
            shared.as_ref(),
        )
    }

    /// 窗口编号对应的 X 窗口号。负数是没有对应 X 窗口的 frame。
    fn xid(&self, window: i64) -> Result<u32, String> {
        if window < 0 {
            return Err(self.frame_only());
        }
        u32::try_from(window).map_err(|_| format!("bad_window: {window} 不是 X11 窗口号"))
    }

    /// X11 会话中对没有对应 X 窗口的 frame 采图或执行前台动作时的拒绝原因，附带 X11 一侧当前的
    /// 状况。Wayland 会话中这类 frame 经由 `portal`，不会执行到此处。
    fn frame_only(&self) -> String {
        let mut reason = FRAME_ONLY.to_owned();
        if let Err(x_side) = self.x_clients() {
            reason.push('；');
            reason.push_str(&x_side);
        }
        reason
    }

    /// 窗口清单：X11 一侧有标题的顶层窗口（从上到下），以及未对应任何 X 窗口、有标题的 frame。
    ///
    /// X11 一侧不可用时只有后者；原因在对这些窗口采图或执行前台动作时随拒绝返回，见 `frame_only`。
    fn windows(&self, conn: &Connection) -> Result<Vec<WindowInfo>, String> {
        let clients = self.x_clients().unwrap_or_default();
        let apps = walk::apps(conn).map_err(Failure::into_reason)?;
        let frames = walk::frames(conn, &apps);
        let sides = x_sides(&clients);
        let unclaimed = associate::unclaimed(&sides, &frame_sides(&frames));
        let mut windows: Vec<WindowInfo> = clients
            .iter()
            .rev()
            .filter(|c| !c.title.is_empty())
            .map(|c| WindowInfo {
                window: i64::from(c.window),
                pid: c.pid,
                title: c.title.clone(),
                class_name: c.class_name.clone(),
            })
            .collect();
        windows.extend(
            unclaimed
                .into_iter()
                .map(|i| &frames[i])
                .filter(|f| !f.title.is_empty())
                .map(|f| WindowInfo {
                    window: frame_window(&f.obj.key()),
                    pid: f.pid,
                    title: f.title.clone(),
                    class_name: String::new(),
                }),
        );
        Ok(windows)
    }

    /// 窗口编号对应的 frame。
    ///
    /// X 窗口先只查询进程号一致的应用：存在进程号一致的候选时，对应规则只保留这些候选，结论与
    /// 查询全部应用相同，而无需等待每个应用应答。这些应用中没有任何同名同位置的 frame 时
    /// （flatpak 的沙箱进程号）再查询全部应用。
    fn root(&self, conn: &Connection, window: i64) -> Result<Root, Failure> {
        let apps = walk::apps(conn)?;
        if window < 0 {
            return walk::frames(conn, &apps)
                .into_iter()
                .find(|f| frame_window(&f.obj.key()) == window)
                .map(|f| Root {
                    obj: f.obj,
                    pid: f.pid,
                    xid: None,
                    popups: Vec::new(),
                })
                .ok_or_else(|| {
                    Failure::Refused(format!("{TARGET_LOST}: 编号 {window} 的 frame 已不存在"))
                });
        }
        let xid = u32::try_from(window)
            .map_err(|_| Failure::Refused(format!("bad_window: {window} 不是 X11 窗口号")))?;
        let clients = self.x_clients().map_err(Failure::Refused)?;
        let Some(at) = clients.iter().position(|c| c.window == xid) else {
            return Err(Failure::Refused(format!(
                "{TARGET_LOST}: 窗口 {window} 已不存在"
            )));
        };
        let sides = x_sides(&clients);
        let pid = clients[at].pid;
        let mut frames = if pid == 0 {
            Vec::new()
        } else {
            walk::frames(conn, apps.iter().filter(|a| a.pid == pid))
        };
        let mut found = associate::resolve(at, &sides, &frame_sides(&frames));
        if matches!(found, Err(Unmatched::None)) {
            frames = walk::frames(conn, &apps);
            found = associate::resolve(at, &sides, &frame_sides(&frames));
        }
        match found {
            Ok(i) => {
                let frame = frames.swap_remove(i);
                let popups = self.popups(conn, xid, frame.pid, &frames)?;
                Ok(Root {
                    obj: frame.obj,
                    pid: frame.pid,
                    xid: Some(xid),
                    popups,
                })
            }
            Err(Unmatched::None) => Err(Failure::Refused(format!(
                "window_unassociated: 该窗口没有对应的无障碍 frame{}",
                self.enabled_hint()
            ))),
            Err(Unmatched::Ambiguous(n)) => Err(Failure::Refused(format!(
                "window_unassociated: 该窗口的标题与位置对应 {n} 个无障碍 frame，无法判定是哪一个；\
                 窗口清单另外列出了这些 frame，请按它们的编号读取控件树"
            ))),
        }
    }

    /// X 窗口 `xid` 拥有的弹出窗口中，内容位于应用顶层对象下的那些：顶层对象与 frame 属于同一进程、
    /// 屏幕矩形等于一个属于 `xid` 的 override-redirect 窗口，且是其子节点的父对象。`tops` 是
    /// 同一次查询得到的其余顶层对象。
    ///
    /// 右键菜单不在 frame 的子树中，GTK 将其列为应用的另一个顶层对象；将它接在 frame 之后，观察
    /// 目标窗口时即可看到它，并可按 `ref` 操作它。GTK 同样将组合框下拉菜单所在的弹出窗口列为
    /// 顶层，而该菜单把组合框报告为父对象，已位于组合框之下，由 `owns_children` 排除。
    ///
    /// 边界：Qt 的弹出菜单与 GTK 附着在普通按钮上的菜单不是应用的子节点，此处无法找到它们。
    fn popups(
        &self,
        conn: &Connection,
        xid: u32,
        pid: u32,
        tops: &[Frame],
    ) -> Result<Vec<Popup>, Failure> {
        let Ok(display) = self.display() else {
            return Ok(Vec::new());
        };
        let windows = display.popups(xid);
        let mut out = Vec::new();
        for top in tops.iter().filter(|t| t.pid == pid) {
            let Some(rect) = top.rect.filter(|r| windows.iter().any(|(_, w)| w == r)) else {
                continue;
            };
            if walk::owns_children(conn, &top.obj)? {
                out.push(Popup {
                    obj: top.obj.clone(),
                    rect,
                });
            }
        }
        Ok(out)
    }

    /// 按控件定位时控件所在的顶层窗口：控件绘制在目标窗口拥有的弹出窗口中时为该弹出窗口
    /// （能完整容纳 `Located::popup` 内容的最上层弹出窗口），否则为目标窗口。
    fn host(&self, window: u32, popup: Option<ScreenRect>) -> i64 {
        let held = popup.and_then(|content| {
            let display = self.display().ok()?;
            x11::holding(&display.popups(window), content)
        });
        i64::from(held.unwrap_or(window))
    }

    /// 动作之后按调用方当前观察的范围整份重读。
    fn reread(&self, req: &ActRequest<'_>) -> Result<Observation, String> {
        let scope = Select {
            root: req.root.map(str::to_owned),
            ..Select::default()
        };
        self.read_tree(req.window, &scope, req.bounds, req.foreground)
    }

    /// 前台动作：核对几何代际、重新定位控件、计算落点，再交给 `foreground::perform`。
    ///
    /// 按图像坐标的指针动作与未指定控件的键盘输入不经由 AT-SPI：没有无障碍树的自绘窗口同样可以执行。
    fn act_foreground(&self, req: &ActRequest<'_>, stop: &dyn Fn() -> bool) -> Attempt {
        if req.window < 0 && self.wayland {
            return self.act_shared(req, stop);
        }
        let window = match self.xid(req.window) {
            Ok(w) => w,
            Err(reason) => return Attempt::Refused(reason),
        };
        let display = match self.display() {
            Ok(d) => d,
            Err(reason) => return Attempt::Refused(reason),
        };
        // 在向 X 服务器发送任何请求之前拒绝：指针动作的第一步是激活目标窗口。
        if req.action.takes_point() && !Reach::of(true, true, self.wayland, None).pointer {
            return Attempt::Refused(POINTER_UNVERIFIABLE.to_owned());
        }
        // 按图定位的落点先核对窗口几何代际：窗口若在采图与派发之间移动过，该坐标指向的
        // 已不是同一块界面。
        if let Some(expected) = req.expect_generation {
            if let Err(reason) = foreground::check_generation(display, window, expected) {
                return Attempt::Refused(reason);
            }
        }
        let needs_tree = req.reference.is_some()
            || matches!(
                req.action,
                ActionSpec::Drag {
                    to: DragTarget::Ref { .. }
                }
            );
        let tree = if needs_tree {
            match self.conn().and_then(|conn| {
                self.root(&conn, req.window)
                    .map(|root| (conn, root))
                    .map_err(Failure::into_reason)
            }) {
                Ok(tree) => Some(tree),
                Err(reason) => return Attempt::Refused(reason),
            }
        } else {
            None
        };
        let located = match (&tree, req.reference) {
            (Some((conn, root)), Some(reference)) => {
                match walk::locate(conn, &root.obj, &root.popups, reference, ALL_FIELDS) {
                    Ok(l) => Some(l),
                    Err(f) => return Attempt::Refused(f.into_reason()),
                }
            }
            _ => None,
        };
        // 窗口动作作用于整个窗口，只接受窗口根节点，与这些动作只列在根节点上一致。
        let whole_window = matches!(
            req.action,
            ActionSpec::SetWindowState { .. }
                | ActionSpec::MoveWindow { .. }
                | ActionSpec::ResizeWindow { .. }
                | ActionSpec::CloseWindow
        );
        if whole_window && located.as_ref().is_some_and(|l| !l.path.is_empty()) {
            return Attempt::Refused("pattern_missing: 窗口动作只能对窗口根节点执行".to_owned());
        }
        let aim = match self.aim(window, tree.as_ref(), located.as_ref(), req) {
            Ok(aim) => aim,
            Err(reason) => return Attempt::Refused(reason),
        };
        let focused = |obj: &bus::Obj, conn: &Connection| -> Result<bool, String> {
            let accessible: AccessibleProxyBlocking =
                obj.proxy(conn).map_err(Failure::into_reason)?;
            let states = accessible
                .get_state()
                .map_err(bus::dbus("读取焦点状态"))
                .map_err(Failure::into_reason)?;
            Ok(states.contains(State::Focused))
        };
        let check = match (&tree, &located) {
            (Some((conn, _)), Some(l)) if req.action.targets_window() => {
                Some(move || focused(&l.obj, conn))
            }
            _ => None,
        };
        let focus: foreground::Focus<'_> = check
            .as_ref()
            .map(|c| c as &dyn Fn() -> Result<bool, String>);
        foreground::perform(display, window, focus, req.action, aim, stop)
    }

    /// 指针动作的落点、拖拽终点与控件所在的顶层窗口。非指针动作三项均缺失。
    ///
    /// 落点有两种来源：调用方提供的屏幕坐标，或控件当前的包围盒中心。**包围盒取自本次重新
    /// 定位的结果**，不是观察时记录的值。控件所在的顶层窗口见 `host`：不要取目标窗口本身，
    /// `ref` 从目标窗口的 frame 出发，而下拉列表与右键菜单中的控件绘制在目标窗口拥有的弹出窗口中。
    fn aim(
        &self,
        window: u32,
        tree: Option<&(Connection, Root)>,
        located: Option<&Located>,
        req: &ActRequest<'_>,
    ) -> Result<foreground::Aim, String> {
        if !req.action.takes_point() {
            return Ok(foreground::Aim::default());
        }
        let center = |l: &Located| {
            l.facts
                .extents
                .map(|r| r.center())
                .ok_or_else(|| "no_bounds: 该控件没有可视位置".to_owned())
        };
        let anchor = match req.point {
            Some(point) => point,
            None => center(located.ok_or("missing_target: 指针动作没有落点")?)?,
        };
        let destination = match req.action {
            ActionSpec::Drag { to } => Some(match to {
                DragTarget::Offset { dx, dy } => ScreenPoint {
                    x: anchor.x + dx,
                    y: anchor.y + dy,
                },
                DragTarget::Ref { reference } => {
                    let (conn, root) = tree.ok_or("missing_target: 拖拽终点没有控件树")?;
                    let target = walk::locate(conn, &root.obj, &root.popups, reference, ALL_FIELDS)
                        .map_err(Failure::into_reason)?;
                    center(&target)?
                }
            }),
            _ => None,
        };
        Ok(foreground::Aim {
            anchor: Some(anchor),
            destination,
            host: req
                .point
                .is_none()
                .then(|| self.host(window, located.and_then(|l| l.popup))),
        })
    }

    /// 当前全部未对应 X 窗口的 frame（Wayland 会话中即原生 Wayland 窗口），以及编号为 `window`
    /// 的 frame 在其中的下标。
    fn native_frames(&self, conn: &Connection, window: i64) -> Result<(Vec<Frame>, usize), String> {
        let clients = self.x_clients().unwrap_or_default();
        let apps = walk::apps(conn).map_err(Failure::into_reason)?;
        let frames = walk::frames(conn, &apps);
        let unclaimed = associate::unclaimed(&x_sides(&clients), &frame_sides(&frames));
        let frames: Vec<Frame> = frames
            .into_iter()
            .enumerate()
            .filter(|(i, _)| unclaimed.contains(i))
            .map(|(_, f)| f)
            .collect();
        let at = frames
            .iter()
            .position(|f| frame_window(&f.obj.key()) == window)
            .ok_or_else(|| format!("{TARGET_LOST}: 编号 {window} 的 frame 已不存在"))?;
        Ok((frames, at))
    }

    /// 原生 Wayland 窗口的共享授权，没有授权时按 `portal::grant` 测量流尺寸、对应窗口或询问用户。
    /// 返回授权与窗口当前的 AT-SPI 尺寸。
    fn shared(
        &self,
        frames: &[Frame],
        target: &Frame,
        budget: Duration,
    ) -> Result<(portal::Grant, (i32, i32)), String> {
        let size = target
            .rect
            .map(|r| (r.width, r.height))
            .ok_or("no_bounds: 无法读取该窗口的尺寸")?;
        let sizes: Vec<(String, (i32, i32))> = frames
            .iter()
            .filter_map(|f| f.rect.map(|r| (f.obj.key(), (r.width, r.height))))
            .collect();
        let (_, call) = self
            .bounds
            .get()
            .ok_or("no_handshake: portal 连接在握手之后建立")?;
        let key = target.obj.key();
        let want = portal::Want {
            key: &key,
            title: &target.title,
            size,
            frames: &sizes,
        };
        portal::grant(&want, call, budget).map(|grant| (grant, size))
    }

    /// 采集一张原生 Wayland 窗口的图像，经由 portal 共享的流。
    fn capture_shared(&self, req: &CaptureRequest<'_>) -> Result<Image, String> {
        let conn = self.conn()?;
        let (frames, at) = self.native_frames(&conn, req.window)?;
        let target = &frames[at];
        let accessible: AccessibleProxyBlocking =
            target.obj.proxy(&conn).map_err(Failure::into_reason)?;
        let states = accessible
            .get_state()
            .map_err(bus::dbus("读取 frame 状态"))
            .map_err(Failure::into_reason)?;
        if states.contains(State::Iconified) {
            return Err("window_minimized: 窗口已最小化，无法采集内容".to_owned());
        }
        let (grant, size) = self.shared(&frames, target, req.budget)?;
        portal::capture(&grant, portal::generation(size, grant.coverage.node), req)
    }

    /// 原生 Wayland 窗口的前台输入，经由 portal。合成器不允许窗口动作，按控件定位的指针动作
    /// 没有可用的坐标：这类请求在申请共享授权之前即被拒绝，见 `portal::screen`。
    fn act_shared(&self, req: &ActRequest<'_>, stop: &dyn Fn() -> bool) -> Attempt {
        if let Err(reason) = portal::screen(req.action, req.point) {
            return Attempt::Refused(reason);
        }
        let conn = match self.conn() {
            Ok(c) => c,
            Err(reason) => return Attempt::Refused(reason),
        };
        let (frames, at) = match self.native_frames(&conn, req.window) {
            Ok(found) => found,
            Err(reason) => return Attempt::Refused(reason),
        };
        let target = &frames[at];
        let (grant, size) = match self.shared(&frames, target, MEASURE_BUDGET) {
            Ok(shared) => shared,
            Err(reason) => return Attempt::Refused(reason),
        };
        if let Some(expected) = req.expect_generation {
            let actual = portal::generation(size, grant.coverage.node);
            if actual != expected {
                return Attempt::Refused(format!("geometry_changed: {expected} → {actual}"));
            }
        }
        let located = match req.reference.filter(|_| req.action.targets_window()) {
            Some(reference) => match walk::locate(&conn, &target.obj, &[], reference, ALL_FIELDS) {
                Ok(l) => Some(l),
                Err(f) => return Attempt::Refused(f.into_reason()),
            },
            None => None,
        };
        let state_of = |obj: &bus::Obj, state: State| -> Result<bool, String> {
            let accessible: AccessibleProxyBlocking =
                obj.proxy(&conn).map_err(Failure::into_reason)?;
            let states = accessible
                .get_state()
                .map_err(bus::dbus("读取状态"))
                .map_err(Failure::into_reason)?;
            Ok(states.contains(state))
        };
        let active = || state_of(&target.obj, State::Active);
        let focused = located
            .as_ref()
            .map(|l| move || state_of(&l.obj, State::Focused));
        let focus = focused
            .as_ref()
            .map(|f| f as &dyn Fn() -> Result<bool, String>);
        portal::perform(
            &portal::Target {
                grant: &grant,
                size,
                active: &active,
                focus,
            },
            req.action,
            req.point,
            stop,
        )
    }

    /// `IsEnabled` 为假时附加在「没有对应 frame」之后的说明。
    ///
    /// 只写「可能」：根窗口上有 `AT_SPI_BUS` 属性时，Qt 不检查 `IsEnabled` 也会连接总线，
    /// 而该属性由总线启动器写入，是否存在取决于启动顺序。
    fn enabled_hint(&self) -> &'static str {
        match self.bus.borrow().as_ref().map(|(_, enabled)| enabled) {
            Some(Ok(false)) => {
                "；org.a11y.Status.IsEnabled 为假，Qt、Chromium 与 Electron 应用在此类会话中可能不提供控件树"
            }
            _ => "",
        }
    }

    fn read_tree_inner(
        &self,
        conn: &Connection,
        root: &Root,
        window: i64,
        select: &Select,
        bounds: Bounds,
        foreground: bool,
    ) -> Result<Tree, Failure> {
        let reach = self.reach(root);
        let fields = Fields {
            value: select.include_value,
            state: select.include_state,
            foreground: foreground && reach.keyboard,
            // 按控件定位的指针动作需要屏幕坐标的包围盒；经 portal 共享的窗口只按图定位。
            pointer: foreground && reach.pointer && reach.rect,
            window: foreground && reach.window,
            rect: reach.rect,
        };
        let captured_at = crate::protocol::now_ms();
        let start = match &select.root {
            None => Located {
                obj: root.obj.clone(),
                path: Vec::new(),
                facts: walk::facts(conn, &root.obj, fields)?,
                context: node::Context::default(),
                parent: None,
                popup: None,
            },
            Some(reference) => walk::locate(conn, &root.obj, &root.popups, reference, fields)?,
        };
        let walked = walk::walk(conn, &start, &root.popups, select, bounds, fields)?;
        // 窗口可用状态只取 frame 自身的状态。
        let window_enabled = if start.path.is_empty() {
            node::enabled(start.facts.states)
        } else {
            let accessible: AccessibleProxyBlocking = root.obj.proxy(conn)?;
            node::enabled(accessible.get_state().map_err(bus::dbus("读取 frame 状态"))?)
        };
        let window_covered = match root.xid {
            Some(xid) => self
                .display()
                .is_ok_and(|d| d.clients().is_ok_and(|stack| d.covered(xid, &stack))),
            // 没有对应 X 窗口时无法读取几何，只判定最小化。
            None => start.path.is_empty() && start.facts.states.contains(State::Iconified),
        };
        let nodes = walked.nodes;
        Ok(Tree {
            window,
            captured_at,
            scope: (!start.path.is_empty())
                .then(|| nodes.first().map(|n| n.reference.clone()))
                .flatten(),
            window_enabled,
            window_covered,
            completeness: walked.completeness,
            node_count: u32::try_from(nodes.len()).unwrap_or(u32::MAX),
            nodes,
        })
    }

    /// 读取一轮判定所需的事实。目标控件或其所在的窗口已不存在时均记为 `Missing`。
    fn probe(&self, conn: &Connection, req: &WaitRequest<'_>) -> Result<Probe, Failure> {
        match req.until {
            WaitUntil::Window => Ok(Probe::NewWindow(self.window_appeared(conn, req))),
            WaitUntil::Appears => {
                let root = self.root(conn, req.window)?;
                let tree = self.read_tree_inner(
                    conn,
                    &root,
                    req.window,
                    &Select::default(),
                    req.bounds,
                    req.foreground,
                )?;
                let count = tree
                    .nodes
                    .iter()
                    .filter(|n| matches_target(req.role, req.name_contains, n))
                    .count();
                Ok(Probe::Matched {
                    count: u32::try_from(count).unwrap_or(u32::MAX),
                    tree,
                })
            }
            WaitUntil::Enabled | WaitUntil::Value | WaitUntil::Gone => {
                let reference = req
                    .reference
                    .ok_or_else(|| Failure::Refused("missing_ref".to_owned()))?;
                let located = self.root(conn, req.window).and_then(|root| {
                    walk::locate(conn, &root.obj, &root.popups, reference, ALL_FIELDS)
                });
                match located {
                    Ok(l) => {
                        let node =
                            node::node(&l.facts, l.context, &l.path, &l.obj.key(), ALL_FIELDS);
                        Ok(Probe::Element {
                            enabled: node.enabled,
                            value: node.value,
                        })
                    }
                    Err(f) if f.is_gone() => Ok(Probe::Missing),
                    Err(f) => Err(f),
                }
            }
        }
    }

    /// 是否出现了标题包含给定文字、且不是目标窗口本身的顶层窗口。
    ///
    /// X11 会话中只读取 X11、不经由应用：应用无响应时 X 服务器照常应答，而会话中的顶层窗口都在
    /// EWMH 清单中。Wayland 会话或 X11 一侧不可用时，原生 Wayland 窗口只存在于 AT-SPI 中，
    /// 按与窗口清单相同的来源判定；不要在此处只读取 X11，否则无法等到任何原生 Wayland 窗口。
    fn window_appeared(&self, conn: &Connection, req: &WaitRequest<'_>) -> bool {
        let Some(needle) = req.name.map(str::to_lowercase) else {
            return false;
        };
        let hit = |window: i64, title: &str| {
            window != req.window && title.to_lowercase().contains(&needle)
        };
        if !self.wayland {
            if let Ok(clients) = self.x_clients() {
                return clients.iter().any(|c| hit(i64::from(c.window), &c.title));
            }
        }
        self.windows(conn)
            .is_ok_and(|windows| windows.iter().any(|w| hit(w.window, &w.title)))
    }

    /// 等待返回时附带的状态：按调用方当前观察的范围整份重读。`appears` 每轮读取的是整个窗口，
    /// 范围同为整个窗口时直接复用最后一轮的结果。
    fn wait_state(
        &self,
        conn: &Connection,
        req: &WaitRequest<'_>,
        probe: Probe,
    ) -> Result<Tree, Failure> {
        if let (Probe::Matched { tree, .. }, None) = (probe, req.root) {
            return Ok(tree);
        }
        let scope = Select {
            root: req.root.map(str::to_owned),
            ..Select::default()
        };
        let root = self.root(conn, req.window)?;
        self.read_tree_inner(conn, &root, req.window, &scope, req.bounds, req.foreground)
    }
}

/// 调用前后都可读取的窗口事实，全部来自 X11：应用阻塞于一次调用时 X 服务器照常应答。
///
/// X11 一侧不可用时没有可读取的证据，调用未按时返回即记为结果未知：原生 Wayland 窗口只能经由
/// 应用自身的 AT-SPI 读取，而应用此时阻塞于本次调用。
struct CallWatch<'a> {
    display: Option<&'a x11::Display>,
    window: Option<u32>,
    pid: u32,
    before: Vec<u32>,
}

impl<'a> CallWatch<'a> {
    fn before(display: Option<&'a x11::Display>, window: Option<u32>, pid: u32) -> Self {
        let before = clients_of(display)
            .into_iter()
            .filter(|c| c.pid == pid)
            .map(|c| c.window)
            .collect();
        Self {
            display,
            window,
            pid,
            before,
        }
    }
}

/// X11 一侧当前的顶层窗口。无法读取时为空。
fn clients_of(display: Option<&x11::Display>) -> Vec<x11::Client> {
    display.and_then(|d| d.clients().ok()).unwrap_or_default()
}

impl Watch for CallWatch<'_> {
    /// 动作已生效的证据：目标窗口已关闭，或同一进程新增一个此前不存在的顶层窗口。
    fn evidence(&self) -> Option<ActionEvidence> {
        let clients = self.display?.clients().ok()?;
        if let Some(window) = self.window {
            if !clients.iter().any(|c| c.window == window) {
                return Some(ActionEvidence::WindowGone);
            }
        }
        (self.pid != 0
            && clients
                .iter()
                .any(|c| c.pid == self.pid && !self.before.contains(&c.window)))
        .then_some(ActionEvidence::NewWindow)
    }

    fn blocking(&self) -> Vec<BlockingWindow> {
        clients_of(self.display)
            .into_iter()
            .filter(|c| self.pid != 0 && c.pid == self.pid)
            .take(MAX_BLOCKING_WINDOWS)
            .map(|c| BlockingWindow {
                appeared: !self.before.contains(&c.window),
                info: WindowInfo {
                    window: i64::from(c.window),
                    pid: c.pid,
                    title: c.title,
                    class_name: c.class_name,
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Reach = Reach {
        rect: false,
        keyboard: false,
        window: false,
        pointer: false,
    };

    fn coverage(keyboard: bool, pointer: bool) -> portal::Coverage {
        portal::Coverage {
            session: "/s/1".to_owned(),
            node: 44,
            size: Some((1280, 800)),
            keyboard,
            pointer,
        }
    }

    /// X11 会话中对应 X 窗口的窗口具备全部能力；未对应的 frame 只提供屏幕坐标的包围盒。
    #[test]
    fn an_x11_session_gives_associated_windows_everything() {
        let all = Reach {
            rect: true,
            keyboard: true,
            window: true,
            pointer: true,
        };
        assert_eq!(Reach::of(true, true, false, None), all);
        assert_eq!(
            Reach::of(false, true, false, None),
            Reach { rect: true, ..NONE }
        );
    }

    /// Wayland 会话中原生 Wayland 窗口的包围盒以其自身 surface 为原点，不能作为屏幕坐标
    /// 发布；XWayland 窗口的指针落点无法核对，只保留键盘与窗口动作。
    #[test]
    fn a_wayland_session_withholds_native_rects_and_xwayland_pointers() {
        assert_eq!(Reach::of(false, true, true, None), NONE);
        assert_eq!(
            Reach::of(true, true, true, None),
            Reach {
                rect: true,
                keyboard: true,
                window: true,
                pointer: false,
            }
        );
    }

    /// 原始失败形状：原生 Wayland 窗口没有采图与键盘、指针输入。经 portal 共享之后提供键盘与
    /// 按图定位的指针，按用户允许的设备分别提供；包围盒与窗口动作仍不提供。
    #[test]
    fn a_shared_wayland_window_gains_input_but_no_rect_or_window_actions() {
        assert_eq!(
            Reach::of(false, false, true, Some(&coverage(true, true))),
            Reach {
                keyboard: true,
                pointer: true,
                ..NONE
            }
        );
        assert_eq!(
            Reach::of(false, true, true, Some(&coverage(false, true))),
            Reach {
                pointer: true,
                ..NONE
            }
        );
        assert_eq!(
            Reach::of(false, false, true, Some(&coverage(false, false))),
            NONE
        );
    }

    /// 无法连接 X 服务器时没有屏幕坐标系，包围盒一律不发布。
    #[test]
    fn without_an_x_server_no_rect_is_published() {
        assert!(!Reach::of(false, false, false, None).rect);
        assert!(!Reach::of(false, false, true, None).rect);
    }

    #[test]
    fn a_wayland_session_is_recognised_by_any_of_three_facts() {
        let some = |s: &'static str| Some(OsStr::new(s));
        assert!(wayland_session(some("wayland-0"), None, false));
        assert!(wayland_session(None, some("wayland"), false));
        // WSLg 的情形：不设置会话类型；worker 的环境中已移除 WAYLAND_DISPLAY，连接的仍是 XWayland。
        assert!(wayland_session(None, None, true));
        assert!(!wayland_session(some(""), some("x11"), false));
        assert!(!wayland_session(None, None, false));
    }
}
