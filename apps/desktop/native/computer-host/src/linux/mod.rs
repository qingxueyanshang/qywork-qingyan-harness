//! Linux 后端（`Atspi`）：AT-SPI 负责控件树、后台语义动作、读文本与有界等待，X11 负责窗口
//! 清单、层叠序、几何、取图、前台键鼠与窗口动作（`x11`、`foreground`）；Wayland 会话里原生
//! Wayland 窗口的取图与前台键鼠经 xdg-desktop-portal（`portal`）。
//!
//! 六条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。前台动作只在前台模式开着
//!    时列出与执行。
//! 2. 窗口清单以 X11 的 EWMH 清单为准，AT-SPI frame 按 `associate` 的规则对上 X 窗口；
//!    对不上的 frame 以负数编号单独列出。X11 会话里它们只给控件树与后台动作；Wayland 会话里
//!    它们（原生 Wayland 窗口，以及没对上的 XWayland 窗口）在用户经系统授权框共享之后另给
//!    取图与键鼠，见 `portal`。X11 一侧不可用（连不上 X 服务器，或根窗口上没有 EWMH 清单）时
//!    清单里只有这种 frame。
//! 3. 能力与坐标可信度按窗口定，不按平台定，规则见 `Reach`。
//! 4. `ref` 是不透明串：从窗口根 frame 出发的子节点下标路径、`@` 后的核对串（角色与稳定标识的
//!    指纹），`#` 后的身份段（总线唯一名 + 对象路径）。动作前按路径重新定位并核对两者，
//!    不允许拿旧编号操作换过位置、或对象路径已经给了别的控件的那个位置。
//! 5. 每次总线调用以宿主握手时给的上界为限，由 zbus 连接的 `method_timeout` 承担；
//!    本模块不另起线程等待读取。
//! 6. 每个后端实例自己连一条无障碍总线：等待线程各建一个实例，与执行线程互不排队，
//!    一次卡住的调用只占住它自己那条连接。连接在握手之后的第一次调用时建立，会话里找不到
//!    无障碍总线时下一次调用再找：总线装上或启动之后不必换 worker。

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
use walk::{Frame, Located};

/// 第一次读一个窗口时两次读取之间隔多久。Chromium 系应用在第一次收到无障碍请求后才建树。
const FIRST_READ_INTERVAL: Duration = Duration::from_millis(350);
/// 第一次读一个窗口最多读多久。页面上有持续变化的元素时控件数一直在变，到点即交回最后一份。
const FIRST_READ_LIMIT: Duration = Duration::from_secs(2);
/// 调用没返回时随回执带回几个顶层窗口。
const MAX_BLOCKING_WINDOWS: usize = 16;

/// 没有唯一对应 X 窗口的 frame 被要求取图或前台动作时的拒绝原因。后面接 X11 一侧的状况，
/// 见 `Atspi::frame_only`。
const FRAME_ONLY: &str =
    "window_unassociated: 这个 frame 没有唯一对应的 X11 窗口，不能取图，也不能做前台动作";
/// Wayland 会话里的 X 窗口被要求做指针动作时的拒绝原因，理由见 `Reach`。
const POINTER_UNVERIFIABLE: &str = "pointer_unverifiable: 这是 Wayland 会话里的 X11 窗口，\
     XTest 指针事件落到哪个窗口由合成器决定，X11 一侧核对不了；键盘输入与窗口动作不受这一条限制";
/// 原生 Wayland 窗口量流时等一帧的上限。动作请求没有自己的采集预算，取与取图相同的量级。
const MEASURE_BUDGET: Duration = Duration::from_secs(2);

/// 一个窗口此刻能给出什么。按窗口定，由窗口有没有对上 X 窗口、会话类型与 portal 共享决定。
///
/// - `rect`：AT-SPI 包围盒是 X 根窗口坐标，可以作为节点的 `rect` 发布、作为指针落点。对上
///   X 窗口的窗口是；没对上的只在 X11 会话里是。Wayland 会话里原生 Wayland 窗口报的是以
///   自己 surface 左上角为原点的坐标（含客户端画的阴影），弹出菜单也按这个原点报，与屏幕、
///   与图像几何都不是同一套坐标；经 portal 共享之后也不发布，按图定位用流自己的坐标。
/// - `keyboard`：键盘输入。对上 X 窗口即可：前置条件核对的是窗口管理器维护的活动窗口与
///   X 输入焦点，Wayland 会话里由合成器自己的 X 窗口管理器维护。原生 Wayland 窗口要经
///   portal 共享、且用户允许了键盘控制。
/// - `window`：窗口动作。只有对上 X 窗口的窗口有：Wayland 合成器不允许客户端摆放别的窗口。
/// - `pointer`：指针动作。对上 X 窗口且不在 Wayland 会话里；或原生 Wayland 窗口经 portal
///   共享、且用户允许了指针控制，那时只接受按图定位的落点。XWayland 投递 XTest 指针事件时
///   还要看合成器的指针此刻在不在它的某个 surface 上，X11 一侧读不到这一项，也看不见原生
///   Wayland 窗口，`lands_on_target` 的判据在这里不成立。不要按合成器名或环境放开它：
///   XWayland 是否把 XTest 事件转交合成器取决于合成器启动它的方式，X 协议里没有可核对的标志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Reach {
    rect: bool,
    keyboard: bool,
    window: bool,
    pointer: bool,
}

impl Reach {
    /// `associated`：窗口对上了 X 窗口。`x_server`：连得上 X 服务器。`shared`：没对上 X 窗口的
    /// frame 在 Wayland 会话里经 portal 共享的方式。
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

/// Wayland 会话：环境里有合成器的套接字名、登录会话类型是 `wayland`，或 X 服务器是 XWayland。
///
/// 三项都要看：`WAYLAND_DISPLAY` 可能被调用方的环境去掉，连上的仍是 XWayland；WSLg 不设
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
    /// X 服务器连接。连不上时是原因，窗口清单只有 AT-SPI frame。
    display: Result<x11::Display, String>,
    /// 见 `wayland_session`。构造时定一次。
    wayland: bool,
    /// 握手时宿主给的建连上界与调用上界。握手之前没有：那时准入判定不放行任何读取。
    bounds: Cell<Option<(Duration, Duration)>>,
    /// 按上界建的无障碍总线连接，与建连时读到的 `org.a11y.Status.IsEnabled`（只读不写，见
    /// `bus::locate`）。还没建或会话里找不到总线时为空。
    bus: RefCell<Option<(Connection, Result<bool, String>)>>,
    /// 这个实例读过控件表的窗口，按窗口编号与进程号记。
    read_before: RefCell<HashSet<(i64, u32)>>,
}

/// 读控件树用的根：窗口对应的 frame，所在应用的进程号，以及对应上的 X 窗口。
struct Root {
    obj: Obj,
    pid: u32,
    xid: Option<u32>,
}

impl Backend for Atspi {
    const NAME: &'static str = "linux-atspi";

    /// 构造不要求无障碍总线（见 `access`），X 服务器连不上也不算失败，见 `Atspi::display`。
    fn new() -> Result<Self, String> {
        let display = x11::Display::connect();
        let wayland = wayland_session(
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
            std::env::var_os("XDG_SESSION_TYPE").as_deref(),
            display.as_ref().is_ok_and(x11::Display::xwayland),
        );
        // 宿主把 worker 的 stderr 转进应用日志。每个进程只记一次：等待线程每条请求各建一个实例。
        // 总线地址与 IsEnabled 在第一次建连时记，见 `conn`。
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

    /// 会话总线上查得到无障碍总线的地址即授权。查不到时读取与动作一律不可用，原因原文随通报
    /// 写进 stderr。
    fn access() -> Access {
        match bus::locate() {
            Ok(_) => Access::of(Vec::new(), None),
            Err(detail) => Access::of(vec![Grant::AccessibilityBus], Some(detail)),
        }
    }

    /// 记下宿主给的上界，丢掉旧连接。之后的每条连接都按这两个值建：建连上界由 `bus::connect`
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

    /// 读一个窗口的控件表。这个实例第一次读一个窗口时读到控件数不再变化为止，
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

    /// 执行一个动作并按调用方当前观察的范围整份重读。没有派发就不重读。
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
            return refused("missing_target: 这个动作只能按控件执行".to_owned());
        };
        let conn = match self.conn() {
            Ok(c) => c,
            Err(reason) => return refused(reason),
        };
        let root = match self.root(&conn, req.window) {
            Ok(r) => r,
            Err(f) => return refused(f.into_reason()),
        };
        let located = match walk::locate(&conn, &root.obj, reference, ALL_FIELDS) {
            Ok(l) => l,
            Err(f) => return refused(f.into_reason()),
        };
        let watch = CallWatch::before(self.display.as_ref().ok(), root.xid, root.pid);
        match actions::perform(&conn, &watch, &located, located.parent.as_ref(), req.action) {
            Attempt::Refused(reason) => refused(reason),
            // 调用还没返回：应用可能卡在这次调用里，重读会等满上界再超时。
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
        let located =
            walk::locate(&conn, &root.obj, reference, fields).map_err(Failure::into_reason)?;
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

/// 动作前重新定位与等待判定读的字段：值与状态都要，前台属性不要。
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
    /// 这个实例的无障碍总线连接。第一次调用时按握手给的上界建立；总线那一端关掉之后重建；
    /// 建不成时以 `ACCESSIBILITY_BUS_UNAVAILABLE` 拒绝，下一次调用再找。
    ///
    /// 不要去掉 `is_closed` 的判定：总线守护进程退出后这条连接上的每次调用都失败，而原因
    /// 原文里没有原因码，服务循环也就不会现查授权事实。
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
        // 宿主把 worker 的 stderr 转进应用日志。每个进程只记一次：等待线程每条请求各建一个实例。
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

    /// X11 一侧的顶层窗口，从下到上。连不上 X 服务器或根窗口上没有 EWMH 清单时交回原因。
    fn x_clients(&self) -> Result<Vec<x11::Client>, String> {
        self.display()?.clients()
    }

    /// 读控件树的那个窗口此刻能给出什么。没对上 X 窗口的 frame 在 Wayland 会话里按 portal
    /// 的共享状态算，只读已有的状态，不触发授权框。
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

    /// X11 会话里对没有对应 X 窗口的 frame 取图或做前台动作时的拒绝原因，带上 X11 一侧此刻的
    /// 状况。Wayland 会话里这种 frame 走 `portal`，不到这里。
    fn frame_only(&self) -> String {
        let mut reason = FRAME_ONLY.to_owned();
        if let Err(x_side) = self.x_clients() {
            reason.push('；');
            reason.push_str(&x_side);
        }
        reason
    }

    /// 窗口清单：X11 一侧有标题的顶层窗口（从上到下），加上没对上任何 X 窗口、有标题的 frame。
    ///
    /// X11 一侧不可用时只有后者；原因在对这些窗口取图或做前台动作时随拒绝交回，见 `frame_only`。
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
    /// X 窗口先只问进程号一致的应用：对应规则在有进程号一致的候选时只留它们，结论与问遍
    /// 全部应用相同，而不用等每个应用应答。那些应用里一个同名同位置的 frame 都没有时
    /// （flatpak 的沙箱进程号）再问全部应用。
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
                })
                .ok_or_else(|| {
                    Failure::Refused(format!("{TARGET_LOST}: 编号 {window} 的 frame 已经不在"))
                });
        }
        let xid = u32::try_from(window)
            .map_err(|_| Failure::Refused(format!("bad_window: {window} 不是 X11 窗口号")))?;
        let clients = self.x_clients().map_err(Failure::Refused)?;
        let Some(at) = clients.iter().position(|c| c.window == xid) else {
            return Err(Failure::Refused(format!(
                "{TARGET_LOST}: 窗口 {window} 已经不在"
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
                Ok(Root {
                    obj: frame.obj,
                    pid: frame.pid,
                    xid: Some(xid),
                })
            }
            Err(Unmatched::None) => Err(Failure::Refused(format!(
                "window_unassociated: 这个窗口没有对应的无障碍 frame{}",
                self.enabled_hint()
            ))),
            Err(Unmatched::Ambiguous(n)) => Err(Failure::Refused(format!(
                "window_unassociated: 这个窗口的标题与位置对应 {n} 个无障碍 frame，判不出是哪一个；\
                 窗口清单另列了这些 frame，按它们的编号读控件树"
            ))),
        }
    }

    /// 按控件定位时控件所在的顶层窗口：控件画在目标窗口拥有的弹出窗口里时是那个弹出窗口
    /// （`Located::popup` 的内容整个装得下的最上面一个），否则是目标窗口。
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

    /// 前台动作：核对几何代际、重新定位控件、求落点，再交给 `foreground::perform`。
    ///
    /// 按图像坐标的指针动作与不点名控件的键盘输入不经 AT-SPI：没有无障碍树的自绘窗口也做得了。
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
        // 在向 X 服务器发任何请求之前拒：指针动作的第一步就是激活目标窗口。
        if req.action.takes_point() && !Reach::of(true, true, self.wayland, None).pointer {
            return Attempt::Refused(POINTER_UNVERIFIABLE.to_owned());
        }
        // 按图定位的落点先核对窗口几何代际：窗口在采图与派发之间移动过的话，那个坐标指的
        // 已经不是同一块界面。
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
                match walk::locate(conn, &root.obj, reference, ALL_FIELDS) {
                    Ok(l) => Some(l),
                    Err(f) => return Attempt::Refused(f.into_reason()),
                }
            }
            _ => None,
        };
        // 窗口动作作用于整个窗口，只接受窗口根节点，与它们只列在根节点上一致。
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
                .map_err(bus::dbus("读焦点状态"))
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

    /// 指针动作的落点、拖拽终点与控件所在的顶层窗口。非指针动作三项都缺席。
    ///
    /// 落点两种来源：调用方给的屏幕坐标，或控件此刻的包围盒中心。**包围盒读的是这一次重新
    /// 定位拿到的那一份**，不是观察时记下的。控件所在的顶层窗口见 `host`：不要取目标窗口本身，
    /// `ref` 从目标窗口的 frame 出发，而组合框下拉列表里的控件画在目标窗口拥有的弹出窗口里。
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
                .ok_or_else(|| "no_bounds: 这个控件没有可视位置".to_owned())
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
                    let target = walk::locate(conn, &root.obj, reference, ALL_FIELDS)
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

    /// 此刻全部没对上 X 窗口的 frame（Wayland 会话里即原生 Wayland 窗口），以及编号 `window`
    /// 的那一个在其中的下标。
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
            .ok_or_else(|| format!("{TARGET_LOST}: 编号 {window} 的 frame 已经不在"))?;
        Ok((frames, at))
    }

    /// 原生 Wayland 窗口的共享授权，没有时按 `portal::grant` 去量流、对应或问用户。交回授权与
    /// 窗口此刻的 AT-SPI 尺寸。
    fn shared(
        &self,
        frames: &[Frame],
        target: &Frame,
        budget: Duration,
    ) -> Result<(portal::Grant, (i32, i32)), String> {
        let size = target
            .rect
            .map(|r| (r.width, r.height))
            .ok_or("no_bounds: 读不出这个窗口的尺寸")?;
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

    /// 取一张原生 Wayland 窗口的图，经 portal 共享的流。
    fn capture_shared(&self, req: &CaptureRequest<'_>) -> Result<Image, String> {
        let conn = self.conn()?;
        let (frames, at) = self.native_frames(&conn, req.window)?;
        let target = &frames[at];
        let accessible: AccessibleProxyBlocking =
            target.obj.proxy(&conn).map_err(Failure::into_reason)?;
        let states = accessible
            .get_state()
            .map_err(bus::dbus("读 frame 状态"))
            .map_err(Failure::into_reason)?;
        if states.contains(State::Iconified) {
            return Err("window_minimized: 窗口已最小化，采不到内容".to_owned());
        }
        let (grant, size) = self.shared(&frames, target, req.budget)?;
        portal::capture(&grant, portal::generation(size, grant.coverage.node), req)
    }

    /// 原生 Wayland 窗口的前台输入，经 portal。窗口动作合成器不允许，按控件定位的指针动作
    /// 没有可用的坐标：这类请求在要共享授权之前就拒绝，见 `portal::screen`。
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
            Some(reference) => match walk::locate(&conn, &target.obj, reference, ALL_FIELDS) {
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
                .map_err(bus::dbus("读状态"))
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

    /// `IsEnabled` 为假时附在「没有对应 frame」后面的说明。
    ///
    /// 只说「可能」：Qt 在根窗口上有 `AT_SPI_BUS` 属性时不看 `IsEnabled` 照样连上总线，
    /// 而那一项由总线启动器写，有没有取决于启动先后。
    fn enabled_hint(&self) -> &'static str {
        match self.bus.borrow().as_ref().map(|(_, enabled)| enabled) {
            Some(Ok(false)) => {
                "；org.a11y.Status.IsEnabled 为假，Qt、Chromium 与 Electron 应用在这种会话里可能不交出控件树"
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
            // 按控件定位的指针动作要有屏幕坐标的包围盒；经 portal 共享的窗口只按图定位。
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
            Some(reference) => walk::locate(conn, &root.obj, reference, fields)?,
        };
        let walked = walk::walk(conn, &start, select, bounds, fields)?;
        // 窗口可用状态只认 frame 自己的那一格。
        let window_enabled = if start.path.is_empty() {
            node::enabled(start.facts.states)
        } else {
            let accessible: AccessibleProxyBlocking = root.obj.proxy(conn)?;
            node::enabled(accessible.get_state().map_err(bus::dbus("读 frame 状态"))?)
        };
        let window_covered = match root.xid {
            Some(xid) => self
                .display()
                .is_ok_and(|d| d.clients().is_ok_and(|stack| d.covered(xid, &stack))),
            // 没有对应 X 窗口时读不出几何，只认最小化。
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

    /// 读一轮判定所需的事实。目标控件或它所在的窗口已经不在都算 `Missing`。
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
                let located = self
                    .root(conn, req.window)
                    .and_then(|root| walk::locate(conn, &root.obj, reference, ALL_FIELDS));
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

    /// 有没有出现标题包含给定文字的顶层窗口，且不是目标窗口自己。
    ///
    /// X11 会话里只读 X11、不经应用：应用卡死时 X 服务器照常应答，而会话里的顶层窗口都在
    /// EWMH 清单里。Wayland 会话或 X11 一侧不可用时原生 Wayland 窗口只在 AT-SPI 里，
    /// 按窗口清单同一份判；不要在这里只读 X11，那样等不到任何原生 Wayland 窗口。
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

    /// 等待返回时的那一份状态：调用方当前观察的范围，整份重读。`appears` 每轮读的就是整窗，
    /// 范围也是整窗时直接复用最后一轮那一份。
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

/// 调用前后都读得到的窗口事实，全部来自 X11：应用卡在一次调用里时 X 服务器照常应答。
///
/// X11 一侧不可用时没有证据可读，调用没按时返回即记结果未知：原生 Wayland 窗口只能经应用
/// 自己的 AT-SPI 读到，而应用此刻卡在这次调用里。
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

/// X11 一侧此刻的顶层窗口。读不到时为空。
fn clients_of(display: Option<&x11::Display>) -> Vec<x11::Client> {
    display.and_then(|d| d.clients().ok()).unwrap_or_default()
}

impl Watch for CallWatch<'_> {
    /// 动作已经生效的证据：目标窗口已关闭，或同一进程多出一个此前没有的顶层窗口。
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

    /// X11 会话里对上 X 窗口的窗口什么都给；没对上的 frame 只给屏幕坐标的包围盒。
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

    /// Wayland 会话里原生 Wayland 窗口的包围盒以它自己的 surface 为原点，不能作为屏幕坐标
    /// 发布；XWayland 窗口的指针落点核对不了，只留键盘与窗口动作。
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

    /// 原始失败形状：原生 Wayland 窗口没有取图与键鼠。经 portal 共享之后给键盘与按图定位的
    /// 指针，按用户允许的设备分别给；包围盒与窗口动作仍不给。
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

    /// 连不上 X 服务器时没有屏幕坐标系，包围盒一律不发布。
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
        // WSLg 的形状：不设会话类型；worker 的环境里去掉了 WAYLAND_DISPLAY，连上的仍是 XWayland。
        assert!(wayland_session(None, None, true));
        assert!(!wayland_session(some(""), some("x11"), false));
        assert!(!wayland_session(None, None, false));
    }
}
