//! 平台后端的契约：`Backend` trait、跨 trait 传递的请求与结果类型，以及每个后端都按
//! 同一规则执行的四项判定（动作调用的有界等待、窗口动作的结果核对、等待的轮询结束、指针落点归属）。
//!
//! 每个构建目标只编译一个后端，由 `main.rs` 按 `cfg` 选定，运行时不存在两个后端并存。
//! 本模块不调用任何 OS 接口。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use crate::geometry::{ScreenPoint, ScreenRect};
use crate::protocol::{
    attainable, classify_action, next_poll, satisfied, Access, ActionEvidence, ActionSpec,
    BlockingWindow, Bounds, Dispatch, Image, Observation, Seen, Select, Tree, WaitUntil,
};

/// 单个平台的桌面控制实现。服务循环只经由这些方法调用平台接口。
///
/// **按线程构造**：执行线程构造一个实例，等待线程为每条请求各构造一个。UIA 的 COM 单元属于线程，
/// 跨线程共用一个实例会使等待中的一次长调用阻塞执行线程上正在进行的调用。
pub trait Backend: Sized {
    /// 握手回执中 `backend` 字段的值。
    const NAME: &'static str;

    /// 在调用线程上创建本平台的客户端。
    ///
    /// 操作系统未满足前提（`access`）不视为构造失败：此时握手仍发布就绪，由 `access` 报告缺少哪些前提，
    /// 前提满足后无需更换 worker。
    fn new() -> Result<Self, String>;

    /// 操作系统当前满足哪些前提。每次调用时实时查询，不创建客户端：授权监视线程上没有后端实例。
    fn access() -> Access;

    /// 设定跨进程调用的上界，并读取实际生效值。
    ///
    /// 上界由宿主在握手时给定，后端不自带默认值：上界有两个来源时，无法确定哪一个生效。
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

    /// 执行一个动作，然后按调用方当前观察的范围完整重读。
    ///
    /// 纯准入拒绝无需重读；前台准备可能已还原窗口或改变焦点，其后的拒绝同样需要重读。
    /// 观察与所请求动作的派发事实相互独立。`stop` 供派发中途可中止的动作（拖拽）逐段查询。
    fn act(
        &self,
        req: &ActRequest<'_>,
        stop: &dyn Fn() -> bool,
    ) -> (Attempt, Result<Observation, String>);

    fn read_text(&self, window: i64, reference: &str, max_chars: u32)
        -> Result<Observation, String>;

    /// 采集一张目标窗口的图像。平台的采集前提在此处判定，不满足即返回拒绝原因，不采集任何像素。
    fn capture_image(&self, req: &CaptureRequest<'_>) -> Result<Image, String>;

    /// 等待后置条件成立。每轮查询一次 `stop`，为真时以 `cancelled` 结束。
    fn wait(&self, req: &WaitRequest<'_>, stop: &dyn Fn() -> bool) -> Result<Observation, String>;

    /// 回执发出后清理一次该窗口所属 provider 的连接。
    ///
    /// 只在动作调用未返回时调用（见 `Response::after_reply`）。没有此类连接状态的
    /// 平台保留默认的空实现。
    fn drain_provider(&self, _window: i64) {}
}

/// 一次动作请求的全部目标信息。
///
/// 合并为一个结构体而不是八个位置参数：两种目标指定方式、几何代际与前台开关需一起传递，
/// 位置参数顺序写错不会导致编译失败。
pub struct ActRequest<'a> {
    pub window: i64,
    /// 控件目标。与 `point` 互斥，准入判定已保证只提供其中一个。
    pub reference: Option<&'a str>,
    /// 动作之后重读的范围根。缺失表示整个窗口。
    pub root: Option<&'a str>,
    /// 屏幕物理像素落点。仅指针动作接受。
    pub point: Option<ScreenPoint>,
    /// 采集落点所在图像时的窗口几何代际。提供 `point` 时必须提供。
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
    /// `until=appears` 等待出现的控件角色。其余条件忽略该字段。
    pub role: Option<&'a str>,
    /// `until=appears` 等待出现的控件文字。其余条件忽略该字段。
    pub name_contains: Option<&'a str>,
    /// 等待结束时重读的范围根。缺失表示整个窗口。
    pub root: Option<&'a str>,
    /// `until=window` 等待的标题子串。
    pub name: Option<&'a str>,
    pub poll: Duration,
    pub deadline: Instant,
    pub bounds: Bounds,
    /// 用户是否启用了前台接管。等待自带的重读据此决定是否列出前台动作。
    pub foreground: bool,
}

/// 一次采集的全部输入。
pub struct CaptureRequest<'a> {
    pub window: i64,
    /// 要采集的屏幕物理像素矩形。缺失表示整个窗口。
    pub region: Option<ScreenRect>,
    /// 要求窗口几何代际仍为该值。
    pub expect_generation: Option<&'a str>,
    pub max_edge: u32,
    pub max_bytes: u32,
    pub budget: Duration,
}

/// 一次动作尝试的事实。`Refused` 表示请求的动作没有发出，`Called` 表示调用已经发出。
/// `Refused` 不保证前台准备没有改变窗口；是否重读由后端单独返回。
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
    /// 为假时目标应用的 UI 线程仍阻塞于本次调用，**对该窗口的任何控件树读取都会等待至
    /// 超时**，因此调用方不要在此类回执之后重读目标窗口。
    pub returned: bool,
    /// `returned` 为假时目标进程当前的顶层窗口。读取它不经过控件树接口。
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

/// 主路径等待动作调用返回的时长。
///
/// 正常的控件调用在该时长内即可返回。它不是调用的上界：打开模态对话框的调用要等到
/// 对话框关闭才返回。
const CALL_CONFIRM_MS: u64 = 400;
/// 调用未按时返回时，用于查找可核实的生效证据的时长。
///
/// 两段时长之和在宿主给定的调用上界（2000 ms）以内：超过该上界时调用自身即带错误返回，
/// 继续等待只会推迟同一结论。
const CALL_EVIDENCE_MS: u64 = 1_400;
/// 查找证据时两次查询的间隔。证据读取的是窗口系统的属性，每次耗时数微秒。
const EVIDENCE_POLL_MS: u64 = 40;
/// 尚未返回的动作调用线程上界。
///
/// 达到上界即拒绝新动作：这表示目标应用已有该数量的调用未返回，再发出一次只会多一条阻塞的
/// 线程。每条线程在调用返回时自行退出，调用上界为其设定了期限。
const MAX_PENDING_CALLS: u32 = 8;

static PENDING_CALLS: AtomicU32 = AtomicU32::new(0);

/// 交给调用线程执行的一次动作调用。平台要求的线程初始化由后端封装在任务中。
pub type Job = Box<dyn FnOnce() -> Result<(), String> + Send>;

/// 调用未返回时从何处查找动作已生效的证据。
///
/// **每种动作采用的证据不同**：后台控件调用采用「窗口被禁用 / 已关闭 / 同进程新增一个顶层
/// 窗口」，而激活会主动改变前台，此时新增顶层窗口无法证明本次激活产生了效果。
/// 因此窗口动作各自读取各自对应的属性。
pub trait Watch {
    fn evidence(&self) -> Option<ActionEvidence>;
    /// 调用未返回时交给调用方的顶层窗口清单。
    fn blocking(&self) -> Vec<BlockingWindow>;
}

/// 启动一条线程执行本次调用。达到线程上界时返回 `None`，调用未发出。
pub fn spawn_call(job: Job) -> Option<Receiver<Result<(), String>>> {
    PENDING_CALLS
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < MAX_PENDING_CALLS).then_some(n + 1)
        })
        .ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // 发送失败属于正常情况：主路径可能已放弃等待。
        let _ = tx.send(job());
        PENDING_CALLS.fetch_sub(1, Ordering::SeqCst);
    });
    Some(rx)
}

/// 发出一次可能不返回的调用，并在有限时间内确定执行事实。
///
/// 先等待一个短确认时段；未等到时改为检查 `watch` 指定的可核实事实。有证据即 `submitted`，
/// 没有证据且调用仍未返回时为 `unknown`。
pub fn dispatch_call(watch: &dyn Watch, job: Job) -> Attempt {
    let Some(rx) = spawn_call(job) else {
        return Attempt::Refused(format!("action_calls_exhausted: {MAX_PENDING_CALLS}"));
    };
    let first = match rx.recv_timeout(Duration::from_millis(CALL_CONFIRM_MS)) {
        Ok(result) => Some(result),
        Err(RecvTimeoutError::Timeout) => None,
        Err(RecvTimeoutError::Disconnected) => Some(Err("动作调用线程未返回结果".to_owned())),
    };
    if let Some(result) = first {
        let (dispatch, reason) =
            classify_action(Some(&result), None, true).expect("调用有返回值时必定能判定终态");
        return Attempt::Called(Outcome::returned(dispatch, reason));
    }
    let until = Instant::now() + Duration::from_millis(CALL_EVIDENCE_MS);
    loop {
        let returned = match rx.try_recv() {
            Ok(result) => Some(result),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Err("动作调用线程未返回结果".to_owned())),
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

/// 核对结果时两次查询的间隔。查询的是窗口系统的属性，每次耗时不足一毫秒。
const SETTLE_POLL_MS: u64 = 20;

/// 在期限内等待窗口系统的读数满足条件。
pub fn settled(limit: Duration, reached: impl Fn() -> bool) -> bool {
    let until = Instant::now() + limit;
    loop {
        if reached() {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(SETTLE_POLL_MS));
    }
}

/// 调用返回成功后再读取并核对一次目标值。
///
/// 调用返回成功只说明对端已受理，窗口状态在对端处理完成后才改变。读取不到目标值时
/// 记为 `unknown`：状态可能仍在变化，记为失败会使调用方重发一次。
pub fn confirm(attempt: Attempt, limit: Duration, reached: impl Fn() -> bool) -> Attempt {
    let Attempt::Called(outcome) = attempt else {
        return attempt;
    };
    if outcome.dispatch != Dispatch::Submitted || !outcome.returned {
        return Attempt::Called(outcome);
    }
    if settled(limit, reached) {
        return Attempt::Called(outcome);
    }
    Attempt::Called(Outcome::returned(
        Dispatch::Unknown,
        Some("调用成功，但窗口未变为请求的状态".to_owned()),
    ))
}

/// 一轮等待判定读取到的事实。`Matched` 同时携带本轮读取的树，返回时不再重读。
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

/// 轮询直到条件成立、不可能再成立（`target_gone`）、到期或被撤销。返回是否等到、未等到的
/// 原因，以及最后一轮读取的事实。
///
/// `probe` 读取一轮事实，失败即整次等待失败：provider 不应答时再轮询一轮只会再等待一次超时。
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

/// 落点所在的顶层窗口是否接受本次指针动作。
///
/// 是目标窗口本身即接受。否则只在按控件定位时接受：落点所在的顶层窗口就是目标控件所在的
/// 顶层窗口，且它属于目标窗口（目标窗口弹出的下拉框、菜单）。模态对话框或其他应用覆盖
/// 目标控件时，落点所在的顶层窗口不是控件所在的窗口，仍然拒绝；按图像坐标定位的动作
/// 没有控件，`control_root` 缺失，只接受目标窗口本身。
///
/// 不要改为只检查落点窗口是否属于目标窗口：目标窗口的模态对话框同样属于它，
/// 对话框覆盖控件时，点击落在对话框上。
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

    /// 目标窗口、其弹出的下拉框、其模态对话框、其他应用的窗口。
    const TARGET: i64 = 0x1000;
    const POPUP: i64 = 0x2000;
    const DIALOG: i64 = 0x3000;
    const OTHER: i64 = 0x4000;

    #[test]
    fn a_landing_on_the_target_window_itself_is_accepted() {
        assert!(lands_on_target(TARGET, TARGET, TARGET, Some(TARGET)));
        // 按图像坐标定位时没有控件，落点位于目标窗口本身时同样接受。
        assert!(lands_on_target(TARGET, TARGET, TARGET, None));
    }

    /// 原始失败形状：Edge 的自动填充下拉框是其拥有的另一个顶层窗口，点击其中的历史账号被判定为遮挡。
    #[test]
    fn a_landing_on_the_popup_the_target_control_lives_in_is_accepted() {
        assert!(lands_on_target(TARGET, POPUP, TARGET, Some(POPUP)));
    }

    #[test]
    fn another_application_covering_the_control_is_refused() {
        assert!(!lands_on_target(TARGET, OTHER, OTHER, Some(TARGET)));
        // 其他应用的窗口即使恰好是控件所在的窗口，也不属于目标窗口。
        assert!(!lands_on_target(TARGET, OTHER, OTHER, Some(OTHER)));
    }

    /// 模态对话框属于目标窗口，但控件位于目标窗口中：点击落在对话框上。
    #[test]
    fn a_modal_dialog_covering_the_control_is_refused() {
        assert!(!lands_on_target(TARGET, DIALOG, TARGET, Some(TARGET)));
    }

    /// 按图像坐标定位时没有可识别的控件，落在弹出窗口上一律拒绝。
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

    /// 等待值时目标控件已不存在：第一轮即以 `target_gone` 结束，不轮询至超时。
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

    /// 条件在第三轮成立即返回；到期之前持续轮询。
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

    /// 到期时如实上报 `timeout`，撤销时如实上报 `cancelled`，两者都携带最后一轮的事实。
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

    /// 调用线程有上界：达到上界后不再启动线程，该次动作因此未发出。
    ///
    /// 额度在线程退出时归还，因此上界不会因一段时间的调用积压而永久阻止动作。
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
            .expect("上界之内应能启动线程");
            held.push(rx);
        }
        assert!(
            spawn_call(Box::new(|| Ok(()))).is_none(),
            "达到上界后不应再启动线程"
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
