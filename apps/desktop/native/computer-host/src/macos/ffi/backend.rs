//! `Backend` 在 macOS 上的实现：服务循环的每一次调用经这里接到 AX、CGWindowList、CGEvent 与
//! ScreenCaptureKit。边界见 `macos` 模块头。

use std::cell::RefCell;
use std::collections::HashSet;
use std::time::Duration;

use super::ax::{self, Element};
use super::capture;
use super::foreground::{self, Aim, Target};
use super::walk::{self, Located, Root};
use crate::backend::{
    dispatch_call, wait_loop, ActRequest, Attempt, Backend, CaptureRequest, Job, Outcome, Probe,
    WaitRequest, Watch,
};
use crate::geometry::ScreenPoint;
use crate::macos::pure::associate::CgWindow;
use crate::macos::pure::facts::{
    action, action_error, attr, error_name, no_screen_recording, not_trusted, Failure, Value,
};
use crate::macos::pure::node::{self, Fields};
use crate::macos::pure::plan::{self, Call, MAX_TOGGLE_STEPS};
use crate::protocol::{
    now_ms, Access, ActionEvidence, ActionSpec, BlockingWindow, Bounds, Dispatch, DragTarget,
    Grant, Image, Observation, Select, ToggleState, Tree, Wait, WaitUntil, WindowInfo,
    NOT_DISPATCHED, TARGET_BLOCKED,
};
use crate::tree::{matches_target, settle};

/// 第一次读一个窗口时两次读取之间隔多久。Chromium 系应用在第一次收到无障碍请求后才建树。
const FIRST_READ_INTERVAL: Duration = Duration::from_millis(350);
/// 第一次读一个窗口最多读多久。页面上有持续变化的元素时控件数一直在变，到点即交回最后一份。
const FIRST_READ_LIMIT: Duration = Duration::from_secs(2);
/// 调用没返回时随回执带回几个顶层窗口。
const MAX_BLOCKING_WINDOWS: usize = 16;

/// 没有唯一对应 CG 窗口的 AX 窗口被要求取图或前台动作时的拒绝原因。
const WINDOW_ONLY: &str =
    "window_unassociated: 这个窗口没有唯一对应的 CG 窗口，不能取图，也不能做前台动作";
/// 系统没有按窗口取图的接口。
const CAPTURE_UNAVAILABLE: &str =
    "capture_unavailable: 按窗口取图要 macOS 14 或更高版本（ScreenCaptureKit 的 SCScreenshotManager）";

/// 动作前重新定位与等待判定读的字段：值与状态都要，前台属性不要。
const ALL_FIELDS: Fields = Fields {
    value: true,
    state: true,
    foreground: false,
};

pub struct Ax {
    /// 这个实例读过控件表的窗口，按窗口编号与进程号记。
    read_before: RefCell<HashSet<(i64, i32)>>,
}

fn trusted() -> Result<(), String> {
    if ax::trusted() {
        Ok(())
    } else {
        Err(not_trusted())
    }
}

/// 窗口编号对应的 CGWindowID。负数是没有对应 CG 窗口的 AX 窗口。
fn cg_number(window: i64) -> Result<u32, String> {
    if window < 0 {
        return Err(WINDOW_ONLY.to_owned());
    }
    u32::try_from(window).map_err(|_| format!("bad_window: {window} 不是 CGWindowID"))
}

impl Backend for Ax {
    const NAME: &'static str = "macos-ax";

    fn new() -> Result<Self, String> {
        Ok(Self {
            read_before: RefCell::new(HashSet::new()),
        })
    }

    /// 辅助功能与屏幕录制两项分开报：前者管读取、动作与键鼠投递，后者只管取图。两项的读数与
    /// 调用被拒时判的是同一个（`ax::trusted`、`ax::screen_capture_allowed`）。
    fn access() -> Access {
        let mut missing = Vec::new();
        if !ax::trusted() {
            missing.push(Grant::Accessibility);
        }
        if !ax::screen_capture_allowed() {
            missing.push(Grant::ScreenRecording);
        }
        Access::of(missing, None)
    }

    /// AX 没有建连这一步，建连上界原样交回。调用上界设在系统范围元素上；AX 没有读回接口，
    /// 交回的是设置成功的那个值。
    fn set_timeouts(&self, connection_ms: u32, transaction_ms: u32) -> Result<(u32, u32), String> {
        // 对系统范围元素设 0 是恢复系统缺省值，那时调用上界不再由宿主决定。
        if transaction_ms == 0 {
            return Err("调用上界必须大于 0".to_owned());
        }
        let seconds = transaction_ms as f32 / 1000.0;
        Element::system_wide()
            .set_messaging_timeout(seconds)
            .map_err(|code| format!("设置 AX 消息上界失败：{}", error_name(code)))?;
        Ok((connection_ms, transaction_ms))
    }

    fn list_windows(&self) -> Result<Observation, String> {
        trusted()?;
        let windows = walk::discover()
            .into_iter()
            .filter(|w| !w.title.is_empty())
            .map(|w| WindowInfo {
                window: w.window,
                pid: u32::try_from(w.pid).unwrap_or(0),
                title: w.title,
                class_name: w.subrole,
            })
            .collect();
        Ok(Observation::Windows {
            captured_at: now_ms(),
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
        trusted()?;
        let root = walk::root(window).map_err(Failure::into_reason)?;
        let first = self.read_before.borrow_mut().insert((window, root.pid));
        let read = || read_tree_inner(&root, window, select, bounds, foreground);
        let tree = if first {
            walk::expose(root.pid);
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
        if let Err(reason) = trusted() {
            return refused(reason);
        }
        if req.action.foreground_only() {
            return match act_foreground(req, stop) {
                Attempt::Refused(reason) => refused(reason),
                // 调用还没返回：应用可能卡在这次调用里，重读会等满上界再超时。
                Attempt::Called(outcome) if !outcome.returned => {
                    (Attempt::Called(outcome), Err(TARGET_BLOCKED.to_owned()))
                }
                called => (called, self.reread(req)),
            };
        }
        let Some(reference) = req.reference else {
            return refused("missing_target: 这个动作只能按控件执行".to_owned());
        };
        let root = match walk::root(req.window) {
            Ok(r) => r,
            Err(f) => return refused(f.into_reason()),
        };
        let located = match walk::locate(&root, reference, true) {
            Ok(l) => l,
            Err(f) => return refused(f.into_reason()),
        };
        let watch = CallWatch::before(root.pid, root.cg);
        let attempt = match req.action {
            ActionSpec::SetToggle { state } => set_toggle(&watch, &located, root.pid, *state),
            spec => match plan::plan(&located.facts, located.context, spec)
                .and_then(|call| job(call, &located))
            {
                Ok(job) => dispatch_call(&watch, job),
                Err(reason) => Attempt::Refused(reason),
            },
        };
        match attempt {
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
        trusted()?;
        let root = walk::root(window).map_err(Failure::into_reason)?;
        walk::read_text(&root, window, reference, max_chars).map_err(Failure::into_reason)
    }

    /// 系统接口与屏幕录制授权先判，窗口最小化与几何再判，都满足才调 ScreenCaptureKit，
    /// 理由见 `capture` 第 1、2 条。
    fn capture_image(&self, req: &CaptureRequest<'_>) -> Result<Image, String> {
        let number = cg_number(req.window)?;
        if !capture::available() {
            return Err(CAPTURE_UNAVAILABLE.to_owned());
        }
        if !ax::screen_capture_allowed() {
            return Err(no_screen_recording());
        }
        trusted()?;
        let root = walk::root(req.window).map_err(Failure::into_reason)?;
        let facts = walk::window_facts(&root.element, root.pid).map_err(Failure::into_reason)?;
        if facts.minimized == Some(true) {
            return Err("window_minimized: 窗口已最小化，采不到内容".to_owned());
        }
        let placed = root
            .placed
            .ok_or_else(|| "target_lost: 读不出窗口几何".to_owned())?;
        capture::capture(number, &placed, req)
    }

    fn wait(&self, req: &WaitRequest<'_>, stop: &dyn Fn() -> bool) -> Result<Observation, String> {
        trusted()?;
        let (found, reason, probe) =
            wait_loop(req, stop, || probe(req)).map_err(Failure::into_reason)?;
        let tree = wait_state(req, probe).map_err(Failure::into_reason)?;
        Ok(Observation::Wait(Wait {
            found,
            reason,
            tree,
        }))
    }
}

impl Ax {
    /// 动作之后按调用方当前观察的范围整份重读。
    fn reread(&self, req: &ActRequest<'_>) -> Result<Observation, String> {
        let scope = Select {
            root: req.root.map(str::to_owned),
            ..Select::default()
        };
        self.read_tree(req.window, &scope, req.bounds, req.foreground)
    }
}

/// 前台动作：核对几何代际、重新定位控件、求落点，再交给 `foreground::perform`。
///
/// 按图像坐标的指针动作与不点名控件的键盘输入不读控件树：没有无障碍树的自绘窗口也做得了。
fn act_foreground(req: &ActRequest<'_>, stop: &dyn Fn() -> bool) -> Attempt {
    let number = match cg_number(req.window) {
        Ok(n) => n,
        Err(reason) => return Attempt::Refused(reason),
    };
    let root = match walk::root(req.window) {
        Ok(r) => r,
        Err(f) => return Attempt::Refused(f.into_reason()),
    };
    let Some(placed) = root.placed else {
        return Attempt::Refused("target_lost: 读不出窗口几何".to_owned());
    };
    // 按图定位的落点先核对窗口几何代际：窗口在采图与派发之间移动过的话，那个坐标指的
    // 已经不是同一块界面。
    if let Some(expected) = req.expect_generation {
        let actual = placed.frame.generation();
        if actual != expected {
            return Attempt::Refused(format!("geometry_changed: {expected} → {actual}"));
        }
    }
    let located = match req.reference.map(|r| walk::locate(&root, r, false)) {
        None => None,
        Some(Ok(l)) => Some(l),
        Some(Err(f)) => return Attempt::Refused(f.into_reason()),
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
    let target = Target {
        root: &root,
        number,
        placed,
    };
    let aim = match aim(&target, located.as_ref(), req) {
        Ok(aim) => aim,
        Err(reason) => return Attempt::Refused(reason),
    };
    let focused = |l: &Located| -> Result<bool, String> {
        l.element
            .raw(attr::FOCUSED)
            .map(|raw| raw.flag() == Some(true))
            .map_err(|code| Failure::from_ax("读焦点状态", code, ax::alive(root.pid)).into_reason())
    };
    let check = located
        .as_ref()
        .filter(|_| req.action.targets_window())
        .map(|l| move || focused(l));
    let focus: foreground::Focus<'_> = check
        .as_ref()
        .map(|c| c as &dyn Fn() -> Result<bool, String>);
    foreground::perform(&target, focus, req.action, aim, stop)
}

/// 指针动作的落点与拖拽终点，屏幕物理像素。非指针动作两项都缺席。
///
/// 落点两种来源：调用方给的屏幕坐标，或控件此刻矩形的中心。**矩形读的是这一次重新定位拿到的
/// 那一份**，不是观察时记下的。按控件定位时控件所在的顶层窗口取目标窗口本身：`ref` 从目标
/// 窗口元素出发。
fn aim(
    target: &Target<'_>,
    located: Option<&Located>,
    req: &ActRequest<'_>,
) -> Result<Aim, String> {
    if !req.action.takes_point() {
        return Ok(Aim::default());
    }
    let mapping = target.placed.mapping;
    let center = |l: &Located| {
        l.facts
            .frame
            .map(|f| mapping.rect(f).center())
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
                let other =
                    walk::locate(target.root, reference, false).map_err(Failure::into_reason)?;
                center(&other)?
            }
        }),
        _ => None,
    };
    Ok(Aim {
        anchor: Some(anchor),
        destination,
        host: req.point.is_none().then_some(req.window),
    })
}

fn read_tree_inner(
    root: &Root,
    window: i64,
    select: &Select,
    bounds: Bounds,
    foreground: bool,
) -> Result<Tree, Failure> {
    let fields = Fields {
        value: select.include_value,
        state: select.include_state,
        // 没有对应 CG 窗口的窗口给不出坐标，也做不了前台动作，前台动作不列。
        foreground: foreground && root.cg.is_some(),
    };
    let captured_at = now_ms();
    let start = match &select.root {
        None => walk::at_root(root)?,
        Some(reference) => walk::locate(root, reference, false)?,
    };
    let walked = walk::walk(&start, root, select, bounds, fields)?;
    // 窗口可用状态与遮挡只认窗口元素自己的那几格。
    let window_facts = if start.path.is_empty() {
        start.facts.clone()
    } else {
        walk::window_facts(&root.element, root.pid)?
    };
    let nodes = walked.nodes;
    Ok(Tree {
        window,
        captured_at,
        scope: (!start.path.is_empty())
            .then(|| nodes.first().map(|n| n.reference.clone()))
            .flatten(),
        window_enabled: window_facts.enabled.unwrap_or(true),
        window_covered: walk::covered(root, &window_facts),
        completeness: walked.completeness,
        node_count: u32::try_from(nodes.len()).unwrap_or(u32::MAX),
        nodes,
    })
}

/// 把一次调用包成交给调用线程的任务。任务里只有元素引用与值，不借用调用方的状态。
fn job(call: Call, target: &Located) -> Result<Job, String> {
    let element = target.element.clone();
    Ok(match call {
        Call::Perform(name) => Box::new(move || {
            element
                .perform(name)
                .map_err(|code| action_error(name, code))
        }),
        Call::Set(attribute, setting) => Box::new(move || {
            element
                .set(attribute, &setting)
                .map_err(|code| action_error(attribute, code))
        }),
        Call::SelectInParent(attribute) => {
            let parent = target.parent.clone().ok_or_else(|| {
                "missing_target: 窗口根没有父元素，不能经选中集合改选中".to_owned()
            })?;
            Box::new(move || {
                parent
                    .set_elements(attribute, &[element])
                    .map_err(|code| action_error(attribute, code))
            })
        }
    })
}

/// 把复选控件按到目标态。每按一下都重读一次状态，到了即停。
fn set_toggle(watch: &dyn Watch, target: &Located, pid: i32, want: ToggleState) -> Attempt {
    let current = match plan::toggle_precheck(&target.facts, want) {
        Ok(current) => current,
        Err(reason) => return Attempt::Refused(reason),
    };
    let read = || -> Result<Option<ToggleState>, String> {
        let raw = target
            .element
            .raw(attr::VALUE)
            .map_err(|code| Failure::from_ax("读复选状态", code, ax::alive(pid)).into_reason())?;
        let mut facts = target.facts.clone();
        facts.value = Value::of(&raw);
        Ok(node::toggle_state(&facts))
    };
    let mut last = Some(current);
    for _ in 0..MAX_TOGGLE_STEPS {
        let press = match job(Call::Perform(action::PRESS), target) {
            Ok(job) => job,
            Err(reason) => return Attempt::Refused(reason),
        };
        match dispatch_call(watch, press) {
            Attempt::Called(outcome)
                if outcome.dispatch == Dispatch::Submitted && outcome.returned => {}
            other => return other,
        }
        match read() {
            Ok(state) => {
                last = state;
                if state == Some(want) {
                    return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
                }
            }
            // 状态读不回来时不再按：按下去就不知道停在哪里了。
            Err(reason) => {
                return Attempt::Called(Outcome::returned(
                    Dispatch::Unknown,
                    Some(format!("按过之后读不回状态：{reason}")),
                ))
            }
        }
    }
    Attempt::Called(Outcome::returned(
        Dispatch::Unknown,
        Some(format!(
            "toggle_target_unreached: 按了 {MAX_TOGGLE_STEPS} 下之后是 {}，要的是 {}",
            last.map_or("未知", ToggleState::as_str),
            want.as_str()
        )),
    ))
}

/// 读一轮判定所需的事实。目标控件或它所在的窗口已经不在都算 `Missing`。
fn probe(req: &WaitRequest<'_>) -> Result<Probe, Failure> {
    match req.until {
        WaitUntil::Window => Ok(Probe::NewWindow(window_appeared(req))),
        WaitUntil::Appears => {
            let root = walk::root(req.window)?;
            let tree = read_tree_inner(
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
            let located = walk::root(req.window).and_then(|root| {
                walk::locate(&root, reference, false)
                    .map(|l| (l, root.frame, root.placed.map(|p| p.mapping)))
            });
            match located {
                Ok((l, frame, mapping)) => {
                    let node = node::node(
                        &l.facts,
                        l.context,
                        &l.path,
                        l.id,
                        frame,
                        mapping.as_ref(),
                        ALL_FIELDS,
                    );
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

/// 有没有出现标题包含给定文字的窗口，且不是目标窗口自己。标题取 AX：CG 的窗口名要屏幕录制授权。
fn window_appeared(req: &WaitRequest<'_>) -> bool {
    let Some(needle) = req.name.map(str::to_lowercase) else {
        return false;
    };
    walk::discover()
        .iter()
        .any(|w| w.window != req.window && w.title.to_lowercase().contains(&needle))
}

/// 等待返回时的那一份状态：调用方当前观察的范围，整份重读。`appears` 每轮读的就是整窗，
/// 范围也是整窗时直接复用最后一轮那一份。
fn wait_state(req: &WaitRequest<'_>, probe: Probe) -> Result<Tree, Failure> {
    if let (Probe::Matched { tree, .. }, None) = (probe, req.root) {
        return Ok(tree);
    }
    let scope = Select {
        root: req.root.map(str::to_owned),
        ..Select::default()
    };
    let root = walk::root(req.window)?;
    read_tree_inner(&root, req.window, &scope, req.bounds, req.foreground)
}

/// 调用前后都读得到的窗口事实，全部来自 CGWindowList：应用卡在一次 AX 调用里时窗口服务器
/// 照常应答。后台动作与关闭窗口共用。
pub(super) struct CallWatch {
    pid: i32,
    window: Option<u32>,
    before: Vec<u32>,
}

impl CallWatch {
    pub(super) fn before(pid: i32, window: Option<u32>) -> Self {
        Self {
            pid,
            window,
            before: own_windows(pid).map(|w| w.number).collect(),
        }
    }
}

fn own_windows(pid: i32) -> impl Iterator<Item = CgWindow> {
    ax::cg_windows()
        .into_iter()
        .filter(move |w| w.pid == pid && w.layer == 0)
}

impl Watch for CallWatch {
    /// 动作已经生效的证据：目标窗口已关闭，或同一进程多出一个此前没有的窗口。
    fn evidence(&self) -> Option<ActionEvidence> {
        let windows: Vec<u32> = own_windows(self.pid).map(|w| w.number).collect();
        if let Some(window) = self.window {
            if !windows.contains(&window) {
                return Some(ActionEvidence::WindowGone);
            }
        }
        windows
            .iter()
            .any(|w| !self.before.contains(w))
            .then_some(ActionEvidence::NewWindow)
    }

    /// 标题取 CG 的窗口名，没有屏幕录制授权时为空：应用卡在调用里时 AX 读不出标题。
    fn blocking(&self) -> Vec<BlockingWindow> {
        own_windows(self.pid)
            .take(MAX_BLOCKING_WINDOWS)
            .map(|w| BlockingWindow {
                appeared: !self.before.contains(&w.number),
                info: WindowInfo {
                    window: i64::from(w.number),
                    pid: u32::try_from(w.pid).unwrap_or(0),
                    title: w.name,
                    class_name: w.owner,
                },
            })
            .collect()
    }
}
