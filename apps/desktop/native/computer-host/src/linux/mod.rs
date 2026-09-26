//! Linux 后端（`Atspi`）：AT-SPI 负责控件树、后台语义动作、读文本与有界等待，X11 负责窗口
//! 清单、层叠序与几何。
//!
//! 五条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。取图、前台键鼠与窗口动作
//!    这个后端还没有实现：一律以 `unsupported` 拒绝，可用动作表里也不列。
//! 2. 窗口清单以 X11 的 EWMH 清单为准，AT-SPI frame 按 `associate` 的规则对上 X 窗口；
//!    对不上的 frame 以负数编号单独列出，只给控件树。
//! 3. `ref` 是不透明串：从窗口根 frame 出发的子节点下标路径、`@` 后的核对串（角色与稳定标识的
//!    指纹），`#` 后的身份段（总线唯一名 + 对象路径）。动作前按路径重新定位并核对两者，
//!    不允许拿旧编号操作换过位置、或对象路径已经给了别的控件的那个位置。
//! 4. 每次总线调用以宿主握手时给的上界为限，由 zbus 连接的 `method_timeout` 承担；
//!    本模块不另起线程等待读取。
//! 5. 每个后端实例自己连一条无障碍总线：等待线程各建一个实例，与执行线程互不排队，
//!    一次卡住的调用只占住它自己那条连接。

mod actions;
mod associate;
mod bus;
mod node;
mod text;
mod walk;
mod x11;

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::Once;
use std::time::Duration;

use atspi::proxy::accessible::AccessibleProxyBlocking;
use atspi::{Interface, State};
use zbus::blocking::Connection;

use crate::backend::{
    wait_loop, ActRequest, Attempt, Backend, CaptureRequest, Probe, WaitRequest, Watch,
};
use crate::protocol::{
    ActionEvidence, BlockingWindow, Bounds, Image, Observation, Select, Tree, Wait, WaitUntil,
    WindowInfo, NOT_DISPATCHED, TARGET_BLOCKED,
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

/// 前台动作的拒绝原因。准入已经要求前台模式开着，走到这里说明模式开着而这个后端没有实现。
const FOREGROUND_UNSUPPORTED: &str =
    "unsupported: 前台动作（指针、键盘与窗口动作）在 Linux 后端尚未实现";

pub struct Atspi {
    display: x11::Display,
    address: String,
    /// `org.a11y.Status.IsEnabled`，构造时读一次。只读不写，见 `bus::locate`。
    enabled: Result<bool, String>,
    /// 握手时按宿主给的上界建的连接。握手之前没有：那时准入判定不放行任何读取。
    conn: RefCell<Option<Connection>>,
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

    fn new() -> Result<Self, String> {
        let display = x11::Display::connect()?;
        let located = bus::locate()?;
        // 宿主把 worker 的 stderr 转进应用日志。每个进程只记一次：等待线程每条请求各建一个实例。
        static REPORTED: Once = Once::new();
        REPORTED.call_once(|| {
            eprintln!(
                "a11y bus={} IsEnabled={:?}",
                located.address, located.enabled
            );
        });
        Ok(Self {
            display,
            address: located.address,
            enabled: located.enabled,
            conn: RefCell::new(None),
            read_before: RefCell::new(HashSet::new()),
        })
    }

    /// 按宿主给的上界建一条新连接并换上。调用上界读回自连接本身；建连上界由
    /// `bus::connect` 在等待建连时执行。
    fn set_timeouts(&self, connection_ms: u32, transaction_ms: u32) -> Result<(u32, u32), String> {
        let conn = bus::connect(
            &self.address,
            Duration::from_millis(u64::from(connection_ms)),
            Duration::from_millis(u64::from(transaction_ms)),
        )?;
        let applied = conn
            .method_timeout()
            .map_or(0, |d| u32::try_from(d.as_millis()).unwrap_or(u32::MAX));
        *self.conn.borrow_mut() = Some(conn);
        Ok((connection_ms, applied))
    }

    fn list_windows(&self) -> Result<Observation, String> {
        let conn = self.conn()?;
        let clients = self.display.clients()?;
        let apps = walk::apps(&conn).map_err(Failure::into_reason)?;
        let frames = walk::frames(&conn, &apps);
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
        Ok(Observation::Windows {
            captured_at: crate::protocol::now_ms(),
            windows,
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

    /// 执行一个后台动作并按调用方当前观察的范围整份重读。没有派发就不重读。
    fn act(
        &self,
        req: &ActRequest<'_>,
        _stop: &dyn Fn() -> bool,
    ) -> (Attempt, Result<Observation, String>) {
        let refused = |reason: String| (Attempt::Refused(reason), Err(NOT_DISPATCHED.to_owned()));
        if req.action.foreground_only() || req.point.is_some() {
            return refused(FOREGROUND_UNSUPPORTED.to_owned());
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
        let watch = CallWatch::before(&self.display, root.xid, root.pid);
        match actions::perform(&conn, &watch, &located, located.parent.as_ref(), req.action) {
            Attempt::Refused(reason) => refused(reason),
            // 调用还没返回：应用可能卡在这次调用里，重读会等满上界再超时。
            Attempt::Called(outcome) if !outcome.returned => {
                (Attempt::Called(outcome), Err(TARGET_BLOCKED.to_owned()))
            }
            called => {
                let scope = Select {
                    root: req.root.map(str::to_owned),
                    ..Select::default()
                };
                (
                    called,
                    self.read_tree(req.window, &scope, req.bounds, req.foreground),
                )
            }
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
        if req.window < 0 {
            return Err(
                "window_unassociated: 这个 frame 没有唯一对应的 X11 窗口，不能取图".to_owned(),
            );
        }
        Err("unsupported: 取图在 Linux 后端尚未实现".to_owned())
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
};

fn x_sides(clients: &[x11::Client]) -> Vec<XSide<'_>> {
    clients
        .iter()
        .map(|c| XSide {
            title: &c.title,
            pid: c.pid,
            client: c.client,
            outer: c.outer,
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
    fn conn(&self) -> Result<Connection, String> {
        self.conn
            .borrow()
            .clone()
            .ok_or_else(|| "no_handshake: 无障碍总线连接在握手时建立".to_owned())
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
        let clients = self.display.clients().map_err(Failure::Refused)?;
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

    /// `IsEnabled` 为假时附在「没有对应 frame」后面的说明。
    ///
    /// 只说「可能」：Qt 在根窗口上有 `AT_SPI_BUS` 属性时不看 `IsEnabled` 照样连上总线，
    /// 而那一项由总线启动器写，有没有取决于启动先后。
    fn enabled_hint(&self) -> &'static str {
        match self.enabled {
            Ok(false) => {
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
        let fields = Fields {
            value: select.include_value,
            state: select.include_state,
            foreground,
        };
        let captured_at = crate::protocol::now_ms();
        let start = match &select.root {
            None => Located {
                obj: root.obj.clone(),
                path: Vec::new(),
                facts: walk::facts(conn, &root.obj, fields)?,
                context: node::Context::default(),
                parent: None,
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
                .display
                .clients()
                .is_ok_and(|stack| self.display.covered(xid, &stack)),
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
            WaitUntil::Window => Ok(Probe::NewWindow(self.window_appeared(req))),
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

    /// 有没有出现标题包含给定文字的顶层窗口，且不是目标窗口自己。只读 X11，不经应用。
    fn window_appeared(&self, req: &WaitRequest<'_>) -> bool {
        let Some(needle) = req.name.map(str::to_lowercase) else {
            return false;
        };
        self.display.clients().is_ok_and(|clients| {
            clients.iter().any(|c| {
                i64::from(c.window) != req.window && c.title.to_lowercase().contains(&needle)
            })
        })
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
struct CallWatch<'a> {
    display: &'a x11::Display,
    window: Option<u32>,
    pid: u32,
    before: Vec<u32>,
}

impl<'a> CallWatch<'a> {
    fn before(display: &'a x11::Display, window: Option<u32>, pid: u32) -> Self {
        let before = display
            .clients()
            .map(|c| {
                c.into_iter()
                    .filter(|c| c.pid == pid)
                    .map(|c| c.window)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            display,
            window,
            pid,
            before,
        }
    }
}

impl Watch for CallWatch<'_> {
    /// 动作已经生效的证据：目标窗口已关闭，或同一进程多出一个此前没有的顶层窗口。
    fn evidence(&self) -> Option<ActionEvidence> {
        let clients = self.display.clients().ok()?;
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
        self.display
            .clients()
            .unwrap_or_default()
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
