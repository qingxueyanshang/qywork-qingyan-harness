//! macOS 后端（`Ax`）：AX 负责窗口清单、控件树、后台语义动作、读文本与有界等待，
//! CGWindowList 负责层叠序与窗口编号。
//!
//! 纯换算（`facts`、`node`、`plan`、`identity`、`associate`）在每个目标的单测里编译，
//! 调 AX 的部分（`ax`、`walk` 与本文件的后端）只在 macOS 上编译。
//!
//! 五条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。取图、前台键鼠与窗口动作
//!    这个后端还没有实现：一律以 `unsupported` 拒绝，可用动作表里也不列。
//! 2. 本进程不是受信任的辅助功能客户端时，一切读取与动作都以 `accessibility_not_trusted`
//!    拒绝。每次现问：用户可以在 worker 运行期间开关授权。
//! 3. `ref` 是不透明串：从窗口元素出发的子节点下标路径、`@` 后的核对串（原始角色、子角色与
//!    稳定标识的指纹）、`#` 后的身份段（进程内身份表的编号）。动作前按路径重新定位并核对两者。
//! 4. 消息上界在握手时对系统范围元素设一次，对本进程的全部 AX 调用生效。不要改成对窗口或
//!    控件元素设：那只作用于那一个引用，逐层取出的子元素都是新引用。
//! 5. `AXUIElementPerformAction` 与写属性回 `kAXErrorCannotComplete` 记结果未知并照常重读，不重发：
//!    应用在动作回调里做模态处理时调用等不到回复，动作可能已经生效。

mod associate;
#[cfg(target_os = "macos")]
mod ax;
mod facts;
mod identity;
// 前台键盘派发还没有接上：这张表此刻只有外壳补发抬起与单测在用。
#[cfg_attr(target_os = "macos", allow(dead_code))]
mod keys;
mod node;
mod plan;
#[cfg(target_os = "macos")]
mod walk;

#[cfg(target_os = "macos")]
pub use backend::Ax;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::keys::keycode;
    use crate::protocol::{key_names, Modifier};

    /// 词表里的每个键名、每个修饰键都有自己的键码，F21–F24 除外（macOS 没有这四个键）。
    /// 两个名字共用一个键码时，补发抬起分不清抬的是哪一个。
    #[test]
    fn every_protocol_key_has_its_own_key_code() {
        let modifiers = [
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
            Modifier::Meta,
        ];
        let mut seen = HashMap::new();
        for name in key_names().chain(modifiers.map(|m| m.key_name().to_owned())) {
            let absent = ["f21", "f22", "f23", "f24"].contains(&name.as_str());
            match keycode(&name) {
                None => assert!(absent, "{name} 没有键码"),
                Some(code) => {
                    assert!(!absent, "{name} 在 macOS 上没有虚拟键码");
                    if let Some(other) = seen.insert(code, name.clone()) {
                        panic!("{name} 与 {other} 共用键码 {code:#04x}");
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod backend {
    use std::cell::RefCell;
    use std::collections::HashSet;
    use std::time::Duration;

    use super::ax::{self, Element};
    use super::facts::{action_error, attr, error_name, Failure, Value, NOT_TRUSTED};
    use super::node::{self, Fields};
    use super::plan::{self, Call, MAX_TOGGLE_STEPS};
    use super::walk::{self, Located, Root};
    use crate::backend::{
        dispatch_call, wait_loop, ActRequest, Attempt, Backend, CaptureRequest, Job, Outcome,
        Probe, WaitRequest, Watch,
    };
    use crate::protocol::{
        now_ms, ActionEvidence, ActionSpec, BlockingWindow, Bounds, Dispatch, Image, Observation,
        Select, ToggleState, Tree, Wait, WaitUntil, WindowInfo, NOT_DISPATCHED, TARGET_BLOCKED,
    };
    use crate::tree::{matches_target, settle};

    /// 第一次读一个窗口时两次读取之间隔多久。Chromium 系应用在第一次收到无障碍请求后才建树。
    const FIRST_READ_INTERVAL: Duration = Duration::from_millis(350);
    /// 第一次读一个窗口最多读多久。页面上有持续变化的元素时控件数一直在变，到点即交回最后一份。
    const FIRST_READ_LIMIT: Duration = Duration::from_secs(2);
    /// 调用没返回时随回执带回几个顶层窗口。
    const MAX_BLOCKING_WINDOWS: usize = 16;

    /// 前台动作的拒绝原因。准入已经要求前台模式开着，走到这里说明模式开着而这个后端没有实现。
    const FOREGROUND_UNSUPPORTED: &str =
        "unsupported: 前台动作（指针、键盘与窗口动作）在 macOS 后端尚未实现";

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
            Err(NOT_TRUSTED.to_owned())
        }
    }

    impl Backend for Ax {
        const NAME: &'static str = "macos-ax";

        fn new() -> Result<Self, String> {
            Ok(Self {
                read_before: RefCell::new(HashSet::new()),
            })
        }

        /// AX 没有建连这一步，建连上界原样交回。调用上界设在系统范围元素上；AX 没有读回接口，
        /// 交回的是设置成功的那个值。
        fn set_timeouts(
            &self,
            connection_ms: u32,
            transaction_ms: u32,
        ) -> Result<(u32, u32), String> {
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

        /// 执行一个后台动作并按调用方当前观察的范围整份重读。没有派发就不重读。
        fn act(
            &self,
            req: &ActRequest<'_>,
            _stop: &dyn Fn() -> bool,
        ) -> (Attempt, Result<Observation, String>) {
            let refused =
                |reason: String| (Attempt::Refused(reason), Err(NOT_DISPATCHED.to_owned()));
            if let Err(reason) = trusted() {
                return refused(reason);
            }
            if req.action.foreground_only() || req.point.is_some() {
                return refused(FOREGROUND_UNSUPPORTED.to_owned());
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
            trusted()?;
            let root = walk::root(window).map_err(Failure::into_reason)?;
            walk::read_text(&root, window, reference, max_chars).map_err(Failure::into_reason)
        }

        fn capture_image(&self, req: &CaptureRequest<'_>) -> Result<Image, String> {
            if req.window < 0 {
                return Err(
                    "window_unassociated: 这个窗口没有唯一对应的 CG 窗口，不能取图".to_owned(),
                );
            }
            Err("unsupported: 取图在 macOS 后端尚未实现".to_owned())
        }

        fn wait(
            &self,
            req: &WaitRequest<'_>,
            stop: &dyn Fn() -> bool,
        ) -> Result<Observation, String> {
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
            foreground,
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
            let raw = target.element.raw(attr::VALUE).map_err(|code| {
                Failure::from_ax("读复选状态", code, ax::alive(pid)).into_reason()
            })?;
            let mut facts = target.facts.clone();
            facts.value = Value::of(&raw);
            Ok(node::toggle_state(&facts))
        };
        let mut last = Some(current);
        for _ in 0..MAX_TOGGLE_STEPS {
            let press = match job(Call::Perform(super::facts::action::PRESS), target) {
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
                    walk::locate(&root, reference, false).map(|l| (l, root.frame))
                });
                match located {
                    Ok((l, frame)) => {
                        let node =
                            node::node(&l.facts, l.context, &l.path, l.id, frame, ALL_FIELDS);
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
    /// 照常应答。
    struct CallWatch {
        pid: i32,
        window: Option<u32>,
        before: Vec<u32>,
    }

    impl CallWatch {
        fn before(pid: i32, window: Option<u32>) -> Self {
            Self {
                pid,
                window,
                before: own_windows(pid).map(|w| w.number).collect(),
            }
        }
    }

    fn own_windows(pid: i32) -> impl Iterator<Item = super::associate::CgWindow> {
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
}
