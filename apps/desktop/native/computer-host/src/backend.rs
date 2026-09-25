//! 平台后端的契约：`Backend` trait、跨 trait 传递的请求与结果类型，以及每个后端都按
//! 同一规则做的三项判定（动作调用的有界等待、等待的轮询收尾、指针落点归属）。
//!
//! 每个构建目标只编译一个后端，由 `main.rs` 按 `cfg` 选定，运行时不存在两个后端并存。
//! 本模块不调用任何 OS 接口。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use crate::geometry::{ScreenPoint, ScreenRect};
use crate::protocol::{
    attainable, classify_action, next_poll, satisfied, ActionEvidence, ActionSpec,
    BlockingWindow, Bounds, Dispatch, Image, Observation, Seen, Select, Tree, WaitUntil,
};

/// 一个平台的桌面控制实现。服务循环只经这几个方法调用平台接口。
///
/// **按线程构造**：执行线程构造一个，等待线程每条请求各构造一个。UIA 的 COM 单元归线程，
/// 跨线程共用一个实例会让等待里的一次长调用挡住执行线程手上的那一次。
pub trait Backend: Sized {
    /// 握手回执里 `backend` 那一格的值。
    const NAME: &'static str;

    /// 在调用线程上建起这个平台的客户端。
    fn new() -> Result<Self, String>;

    /// 设定跨进程调用的上界，并把实际生效值读回来。
    ///
    /// 上界由宿主在握手时给定，后端不自带默认值：上界有两个出处时，没人说得清哪一个生效。
    fn set_timeouts(&self, connection_ms: u32, transaction_ms: u32)
        -> Result<(u32, u32), String>;

    fn list_windows(&self) -> Result<Observation, String>;

    fn read_tree(
        &self,
        window: i64,
        select: &Select,
        bounds: Bounds,
        foreground: bool,
    ) -> Result<Observation, String>;

    /// 执行一个动作，之后按调用方当前观察的范围整份重读。
    ///
    /// **没有派发就不重读**：那一份观察会被调用方读成动作已经发生。`stop` 供派发中途
    /// 可以中止的动作（拖拽）逐段查询。
    fn act(
        &self,
        req: &ActRequest<'_>,
        stop: &dyn Fn() -> bool,
    ) -> (Attempt, Result<Observation, String>);

    fn read_text(&self, window: i64, reference: &str, max_chars: u32)
        -> Result<Observation, String>;

    /// 采一张目标窗口的图。平台的采集前提在这里判，不满足即返回拒绝原因，一个像素都不采。
    fn capture_image(&self, req: &CaptureRequest<'_>) -> Result<Image, String>;

    /// 等一个后置条件成立。`stop` 每轮查一次，变真即以 `cancelled` 收尾。
    fn wait(&self, req: &WaitRequest<'_>, stop: &dyn Fn() -> bool) -> Result<Observation, String>;

    /// 回执发出之后清一次这个窗口所属 provider 的连接。
    ///
    /// 只在动作调用没有返回时被调用（见 `Response::after_reply`）。没有这种连接状态的
    /// 平台保留默认的空实现。
    fn drain_provider(&self, _window: i64) {}
}

/// 一次动作请求的全部目标信息。
///
/// 收成一个结构体而不是八个位置参数：目标两种给法、几何代际与前台开关都要一起传，
/// 位置参数写错顺序不会编译失败。
pub struct ActRequest<'a> {
    pub window: i64,
    /// 控件目标。与 `point` 互斥，准入判定已经保证只给了一个。
    pub reference: Option<&'a str>,
    /// 动作之后重读的范围根。缺席表示整窗。
    pub root: Option<&'a str>,
    /// 屏幕物理像素落点。只有指针动作接受。
    pub point: Option<ScreenPoint>,
    /// 采集落点那张图的窗口几何代际。给了 `point` 就必须给。
    pub expect_generation: Option<&'a str>,
    pub action: &'a ActionSpec,
    pub bounds: Bounds,
    pub foreground: bool,
}

/// 一次等待的全部输入。
pub struct WaitRequest<'a> {
    pub window: i64,
    pub until: WaitUntil,
    pub reference: Option<&'a str>,
    pub value: Option<&'a str>,
    /// `until=appears` 要出现的控件角色。其余条件不看它。
    pub role: Option<&'a str>,
    /// `until=appears` 要出现的控件文字。其余条件不看它。
    pub name_contains: Option<&'a str>,
    /// 等待结束时重读的范围根。缺席表示整窗。
    pub root: Option<&'a str>,
    /// `until=window` 要等的标题子串。
    pub name: Option<&'a str>,
    pub poll: Duration,
    pub deadline: Instant,
    pub bounds: Bounds,
    /// 用户启用了前台接管。等待自带的那份重读按它决定列不列前台动作。
    pub foreground: bool,
}

/// 一次采集的全部输入。
pub struct CaptureRequest<'a> {
    pub window: i64,
    /// 要采的屏幕物理像素矩形。缺席表示整窗。
    pub region: Option<ScreenRect>,
    /// 要求窗口几何代际仍是这一个。
    pub expect_generation: Option<&'a str>,
    pub max_edge: u32,
    pub max_bytes: u32,
    pub budget: Duration,
}

/// 一次动作尝试的事实。`Refused` 表示没有向 provider 发出调用，`Called` 表示调用已经发出。
///
/// 两者必须分开：`Called` 的动作可能已经生效，不能与「模式缺失」「只读」归为同一类。
pub enum Attempt {
    Refused(String),
    Called(Outcome),
}

/// 一次已经发出的动作调用的终态。
pub struct Outcome {
    pub dispatch: Dispatch,
    pub reason: Option<String>,
    /// 调用已经返回。
    ///
    /// 为假时目标应用的 UI 线程还卡在这次调用里，**对这个窗口的任何控件树读取都会等到
    /// 超时**，所以调用方不要在这种回执之后重读目标窗口。
    pub returned: bool,
    /// `returned` 为假时目标进程此刻的顶层窗口。读取它不经过控件树接口。
    pub windows: Vec<BlockingWindow>,
}

impl Outcome {
    pub fn returned(dispatch: Dispatch, reason: Option<String>) -> Self {
        Self {
            dispatch,
            reason,
            returned: true,
            windows: Vec::new(),
        }
    }
}

/// 主路径等一次动作调用返回多久。
///
/// 正常的控件调用在这段时间里早就回来了。它不是调用的上界：点开模态对话框的调用要等
/// 对话框关掉才返回。
const CALL_CONFIRM_MS: u64 = 400;
/// 调用没按时返回时，再花多久找可核实的生效证据。
///
/// 两段加起来留在宿主给的调用上界（2000 ms）以内：超过它调用自己就带错误返回，
/// 再等只是把同一个结论推迟。
const CALL_EVIDENCE_MS: u64 = 1_400;
/// 找证据时两次查询之间隔多久。证据读的是窗口系统的属性，一次几微秒。
const EVIDENCE_POLL_MS: u64 = 40;
/// 尚未返回的动作调用线程上界。
///
/// 到上界即拒绝新动作：那说明目标应用已经有这么多次调用没回来，再发一次只多一条挂着的
/// 线程。每条线程在调用返回时自行退出，调用上界给了它一个期限。
const MAX_PENDING_CALLS: u32 = 8;

static PENDING_CALLS: AtomicU32 = AtomicU32::new(0);

/// 交给调用线程执行的一次动作调用。平台要求的线程初始化由后端包在任务里。
pub type Job = Box<dyn FnOnce() -> Result<(), String> + Send>;

/// 调用没返回时去哪儿找「动作已经生效」的证据。
///
/// **每种动作认的证据不同**：后台控件调用认「窗口被禁用 / 已关闭 / 同进程多出一个顶层
/// 窗口」，而激活会主动改前台，那时「多出一个顶层窗口」证明不了这次激活做过什么。
/// 窗口动作因此各自读回自己那一项。
pub trait Watch {
    fn evidence(&self) -> Option<ActionEvidence>;
    /// 调用没返回时交给调用方的顶层窗口清单。
    fn blocking(&self) -> Vec<BlockingWindow>;
}

/// 起一条线程执行这次调用。到达线程上界时返回 `None`，调用没有发出。
pub fn spawn_call(job: Job) -> Option<Receiver<Result<(), String>>> {
    PENDING_CALLS
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < MAX_PENDING_CALLS).then_some(n + 1)
        })
        .ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // 送不出去是常态：主路径可能已经放弃等待了。
        let _ = tx.send(job());
        PENDING_CALLS.fetch_sub(1, Ordering::SeqCst);
    });
    Some(rx)
}

/// 发一次可能不返回的调用，并在有界时间里定下执行事实。
///
/// 先等一个短确认窗口；没等到就改看 `watch` 认的可核实事实。有证据即 `submitted`，
/// 没有证据而调用仍未返回才是 `unknown`。
pub fn dispatch_call(watch: &dyn Watch, job: Job) -> Attempt {
    let Some(rx) = spawn_call(job) else {
        return Attempt::Refused(format!("action_calls_exhausted: {MAX_PENDING_CALLS}"));
    };
    let first = match rx.recv_timeout(Duration::from_millis(CALL_CONFIRM_MS)) {
        Ok(result) => Some(result),
        Err(RecvTimeoutError::Timeout) => None,
        Err(RecvTimeoutError::Disconnected) => Some(Err("动作调用线程没有留下结果".to_owned())),
    };
    if let Some(result) = first {
        let (dispatch, reason) =
            classify_action(Some(&result), None, true).expect("调用有返回值时终态必定判得出");
        return Attempt::Called(Outcome::returned(dispatch, reason));
    }
    let until = Instant::now() + Duration::from_millis(CALL_EVIDENCE_MS);
    loop {
        let returned = match rx.try_recv() {
            Ok(result) => Some(result),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Err("动作调用线程没有留下结果".to_owned())),
        };
        let settled = classify_action(returned.as_ref(), watch.evidence(), Instant::now() >= until);
        if let Some((dispatch, reason)) = settled {
            if returned.is_some() {
                return Attempt::Called(Outcome::returned(dispatch, reason));
            }
            return Attempt::Called(Outcome {
                dispatch,
                reason,
                returned: false,
                windows: watch.blocking(),
            });
        }
        std::thread::sleep(Duration::from_millis(EVIDENCE_POLL_MS));
    }
}

/// 一轮等待判定读到的事实。`Matched` 一并带回这一轮读到的树，返回时不再重读一遍。
pub enum Probe {
    Element {
        enabled: bool,
        value: Option<String>,
    },
    Missing,
    Matched {
        count: u32,
        tree: Tree,
    },
    NewWindow(bool),
}

impl Probe {
    fn seen(&self) -> Seen<'_> {
        match self {
            Self::Element { enabled, value } => Seen::Element {
                enabled: *enabled,
                value: value.as_deref(),
            },
            Self::Missing => Seen::Missing,
            Self::Matched { count, .. } => Seen::Matches(*count),
            Self::NewWindow(found) => Seen::Window(*found),
        }
    }
}

/// 轮询到条件成立、不可能再成立（`target_gone`）、到期或被撤销。返回有没有等到、没等到的
/// 原因，以及最后一轮读到的事实。
///
/// `probe` 读一轮事实，失败即整次等待失败：provider 不应答时再轮询一轮只会再等一次超时。
pub fn wait_loop<E>(
    req: &WaitRequest<'_>,
    stop: &dyn Fn() -> bool,
    probe: impl Fn() -> Result<Probe, E>,
) -> Result<(bool, Option<String>, Probe), E> {
    loop {
        if stop() {
            return Ok((false, Some("cancelled".to_owned()), probe()?));
        }
        let started = Instant::now();
        let seen = probe()?;
        if satisfied(req.until, req.value, seen.seen()) {
            return Ok((true, None, seen));
        }
        if !attainable(req.until, seen.seen()) {
            return Ok((false, Some("target_gone".to_owned()), seen));
        }
        let now = Instant::now();
        if now >= req.deadline {
            return Ok((false, Some("timeout".to_owned()), seen));
        }
        std::thread::sleep(next_poll(
            req.poll,
            now.saturating_duration_since(started),
            req.deadline - now,
        ));
    }
}

/// 落点所在的顶层窗口收不收这次指针动作。
///
/// 是目标窗口本身即收。不是时只在按控件定位时收：落点所在的顶层窗口就是目标控件自己所在的
/// 顶层窗口，且它归目标窗口所有（目标窗口弹出的下拉框、菜单）。模态对话框或别的应用盖在
/// 目标控件上时，落点所在的顶层窗口不是控件所在的那一个，照旧拒绝；按图像坐标定位的动作
/// 没有控件，`control_root` 缺席，只认目标窗口本身。
///
/// 不要改成只看「落点窗口归目标窗口所有」：目标窗口自己的模态对话框同样归它所有，
/// 盖住控件时点下去的是对话框。
pub fn lands_on_target(
    window: i64,
    hit_root: i64,
    hit_owner: i64,
    control_root: Option<i64>,
) -> bool {
    hit_root == window || (control_root == Some(hit_root) && hit_owner == window)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    /// 目标窗口、它弹出的下拉框、它的模态对话框、别的应用的窗口。
    const TARGET: i64 = 0x1000;
    const POPUP: i64 = 0x2000;
    const DIALOG: i64 = 0x3000;
    const OTHER: i64 = 0x4000;

    #[test]
    fn a_landing_on_the_target_window_itself_is_accepted() {
        assert!(lands_on_target(TARGET, TARGET, TARGET, Some(TARGET)));
        // 按图像坐标定位没有控件，落在目标窗口本身照样收。
        assert!(lands_on_target(TARGET, TARGET, TARGET, None));
    }

    /// 原始失败形状：Edge 的自动填充下拉框是它拥有的另一个顶层窗口，点里面的历史账号被判遮挡。
    #[test]
    fn a_landing_on_the_popup_the_target_control_lives_in_is_accepted() {
        assert!(lands_on_target(TARGET, POPUP, TARGET, Some(POPUP)));
    }

    #[test]
    fn another_application_covering_the_control_is_refused() {
        assert!(!lands_on_target(TARGET, OTHER, OTHER, Some(TARGET)));
        // 别的应用的窗口哪怕恰好就是控件所在的那个，也不归目标窗口所有。
        assert!(!lands_on_target(TARGET, OTHER, OTHER, Some(OTHER)));
    }

    /// 模态对话框归目标窗口所有，但控件在目标窗口里：点下去的是对话框。
    #[test]
    fn a_modal_dialog_covering_the_control_is_refused() {
        assert!(!lands_on_target(TARGET, DIALOG, TARGET, Some(TARGET)));
    }

    /// 按图像坐标定位没有控件可认，落在弹出窗口上一律拒绝。
    #[test]
    fn an_image_point_on_an_owned_popup_is_refused() {
        assert!(!lands_on_target(TARGET, POPUP, TARGET, None));
    }

    fn wait_request(until: WaitUntil, timeout: Duration) -> WaitRequest<'static> {
        WaitRequest {
            window: 66,
            until,
            reference: Some("w.0#7"),
            value: Some("完成"),
            role: None,
            name_contains: None,
            root: None,
            name: None,
            poll: Duration::from_millis(1),
            deadline: Instant::now() + timeout,
            bounds: Bounds {
                max_nodes: 10,
                max_depth: 2,
                time_budget_ms: 100,
            },
            foreground: false,
        }
    }

    /// 等值时目标控件已经不在：第一轮就以 `target_gone` 结束，不轮询到超时。
    #[test]
    fn a_wait_whose_target_is_gone_ends_on_the_first_probe() {
        let rounds = Cell::new(0u32);
        let req = wait_request(WaitUntil::Value, Duration::from_secs(30));
        let outcome = wait_loop::<()>(&req, &|| false, || {
            rounds.set(rounds.get() + 1);
            Ok(Probe::Missing)
        });
        let (found, reason, _) = outcome.expect("判定不失败");
        assert!(!found);
        assert_eq!(reason.as_deref(), Some("target_gone"));
        assert_eq!(rounds.get(), 1);
    }

    /// 条件在第三轮成立即返回；到期之前一直轮询。
    #[test]
    fn a_wait_polls_until_the_condition_holds() {
        let rounds = Cell::new(0u32);
        let req = wait_request(WaitUntil::Enabled, Duration::from_secs(30));
        let outcome = wait_loop::<()>(&req, &|| false, || {
            rounds.set(rounds.get() + 1);
            Ok(Probe::Element {
                enabled: rounds.get() >= 3,
                value: None,
            })
        });
        assert!(outcome.expect("判定不失败").0);
        assert_eq!(rounds.get(), 3);
    }

    /// 到期如实报 `timeout`，撤销如实报 `cancelled`，两者都带最后一轮的事实。
    #[test]
    fn a_wait_ends_on_timeout_or_cancellation() {
        let req = wait_request(WaitUntil::Gone, Duration::ZERO);
        let enabled = || {
            Ok::<_, ()>(Probe::Element {
                enabled: true,
                value: None,
            })
        };
        let (found, reason, _) = wait_loop(&req, &|| false, enabled).expect("判定不失败");
        assert!(!found);
        assert_eq!(reason.as_deref(), Some("timeout"));
        let req = wait_request(WaitUntil::Gone, Duration::from_secs(30));
        let (found, reason, last) = wait_loop(&req, &|| true, enabled).expect("判定不失败");
        assert!(!found);
        assert_eq!(reason.as_deref(), Some("cancelled"));
        assert!(matches!(last, Probe::Element { enabled: true, .. }));
    }

    /// 调用线程有上界：到上界之后不再起线程，那一次动作因此没有发出。
    ///
    /// 额度在线程退出时归还，所以上界不会因为一段时间的拥挤就永久关闭动作。
    #[test]
    fn pending_action_calls_are_bounded_and_the_budget_comes_back() {
        static RELEASE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        RELEASE.store(false, Ordering::SeqCst);
        let mut held = Vec::new();
        for _ in 0..MAX_PENDING_CALLS {
            let rx = spawn_call(Box::new(|| {
                while !RELEASE.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Ok(())
            }))
            .expect("上界之内应当起得来线程");
            held.push(rx);
        }
        assert!(
            spawn_call(Box::new(|| Ok(()))).is_none(),
            "到上界之后不该再起线程"
        );
        RELEASE.store(true, Ordering::SeqCst);
        for rx in held {
            assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(Ok(())));
        }
        let until = Instant::now() + Duration::from_secs(5);
        let recovered = loop {
            if let Some(rx) = spawn_call(Box::new(|| Ok(()))) {
                break Some(rx);
            }
            if Instant::now() >= until {
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let rx = recovered.expect("线程退出之后额度应当归还");
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(Ok(())));
    }

    /// 一轮读取失败即整次等待失败，不再轮询下一轮。
    #[test]
    fn a_failed_probe_fails_the_wait() {
        let req = wait_request(WaitUntil::Enabled, Duration::from_secs(30));
        let outcome = wait_loop(&req, &|| false, || Err::<Probe, _>("provider_timeout"));
        assert!(matches!(outcome, Err("provider_timeout")));
    }
}
