//! Windows 后端（`Uia`）：UI Automation 负责窗口发现、控件树读取、后台语义动作与有界等待，
//! 前台输入由 `foreground` 负责，图像采集由 `capture` 负责。
//!
//! 五条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。
//! 2. 窗口发现经由 Win32 枚举而不是 UIA 根元素：`GetWindowTextW` 对无响应的跨进程窗口
//!    返回缓存标题而不阻塞，UIA 根元素的子节点枚举需要等待每个 provider 应答。
//! 3. `ref` 是不透明字符串，包含从窗口元素出发的子节点下标路径与 RuntimeId。动作前按路径重新
//!    定位并核对 RuntimeId，不允许用旧编号操作当前树中位置已变化的另一个节点。
//! 4. UIA 调用均为跨进程调用，上界只能由 IUIAutomation2 的连接超时与事务超时保证；本模块不另建
//!    线程等待，挂起的 provider 由这两项超时终止。
//! 5. 子节点枚举只有一处实现：带缓存请求的 `BuildUpdatedCache` + `GetCachedChildren`，筛选条件
//!    固定为 `ControlViewCondition`。读树与动作前的重定位共用该实现，下标才能一致；改用
//!    TreeWalker 会产生第二套顺序，同一个 `ref` 在两处指向不同节点。

mod capture;
mod foreground;
mod keys;
mod sink;

use std::cell::OnceCell;
use std::collections::HashSet;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ::windows::core::{Interface, BOOL, BSTR, PCWSTR};
use ::windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    SAFEARRAY,
};
use ::windows::Win32::System::Ole::{
    SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use ::windows::Win32::System::Variant::{
    VARIANT, VT_ARRAY, VT_BOOL, VT_BSTR, VT_I4, VT_R8, VT_UNKNOWN,
};
use ::windows::Win32::UI::Accessibility::{
    AutomationElementMode_Full, CUIAutomation8, ExpandCollapseState_Collapsed,
    ExpandCollapseState_Expanded, ExpandCollapseState_LeafNode,
    ExpandCollapseState_PartiallyExpanded, IUIAutomation, IUIAutomation2,
    IUIAutomationCacheRequest, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationElementArray,
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern, IUIAutomationItemContainerPattern,
    IUIAutomationRangeValuePattern, IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationSelectionPattern, IUIAutomationTextPattern,
    IUIAutomationTextRange, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    IUIAutomationVirtualizedItemPattern, ScrollAmount, SupportedTextSelection,
    SupportedTextSelection_Multiple, SupportedTextSelection_None, SupportedTextSelection_Single,
    TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character, TreeScope,
    TreeScope_Children, TreeScope_Element, UIA_AutomationIdPropertyId,
    UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId, UIA_E_ELEMENTNOTAVAILABLE,
    UIA_E_TIMEOUT, UIA_ExpandCollapseExpandCollapseStatePropertyId, UIA_ExpandCollapsePatternId,
    UIA_InvokePatternId, UIA_IsEnabledPropertyId,
    UIA_HasKeyboardFocusPropertyId, UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsItemContainerPatternAvailablePropertyId, UIA_IsOffscreenPropertyId,
    UIA_IsRangeValuePatternAvailablePropertyId, UIA_IsScrollItemPatternAvailablePropertyId,
    UIA_IsScrollPatternAvailablePropertyId, UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsSelectionPatternAvailablePropertyId, UIA_IsTextPatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId, UIA_IsTransformPatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId, UIA_IsWindowPatternAvailablePropertyId,
    UIA_ItemContainerPatternId, UIA_NamePropertyId, UIA_NativeWindowHandlePropertyId,
    UIA_RangeValueIsReadOnlyPropertyId,
    UIA_RangeValueLargeChangePropertyId, UIA_RangeValueMaximumPropertyId,
    UIA_RangeValueMinimumPropertyId, UIA_RangeValuePatternId, UIA_RangeValueSmallChangePropertyId,
    UIA_RangeValueValuePropertyId, UIA_RuntimeIdPropertyId,
    UIA_ScrollHorizontalScrollPercentPropertyId, UIA_ScrollHorizontallyScrollablePropertyId,
    UIA_ScrollItemPatternId, UIA_ScrollPatternId, UIA_ScrollPatternNoScroll,
    UIA_ScrollVerticalScrollPercentPropertyId, UIA_ScrollVerticallyScrollablePropertyId,
    UIA_SelectionCanSelectMultiplePropertyId, UIA_SelectionIsSelectionRequiredPropertyId,
    UIA_SelectionItemIsSelectedPropertyId, UIA_SelectionItemPatternId, UIA_SelectionPatternId,
    UIA_SelectionSelectionPropertyId,
    UIA_TextPatternId, UIA_TogglePatternId, UIA_ToggleToggleStatePropertyId,
    UIA_ValueIsReadOnlyPropertyId, UIA_ValuePatternId, UIA_ValueValuePropertyId,
    UIA_VirtualizedItemPatternId,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetClassNameW, GetWindow, GetWindowLongW, GetWindowTextW,
    GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_HWNDPREV, WS_EX_LAYERED, WS_EX_TRANSPARENT,
};

use crate::backend::{
    self, wait_loop, ActRequest, Attempt, Backend, CaptureRequest, Job, Outcome, Probe,
    WaitRequest, Watch,
};
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::protocol::{
    now_ms, toggle_steps, Access, ActionEvidence, ActionSpec, Bounds, range_state, BlockingWindow,
    Completeness, Dispatch, DragTarget, Image, Node, NodeAction, Observation, Role,
    ScrollDirection, ScrollState, ScrollStep, Select, SelectionState, Text, TextSelection,
    ToggleState, Tree, Wait, WaitUntil, WindowInfo, NOT_DISPATCHED, REF_STALE, TARGET_BLOCKED,
};
use crate::tree::{
    decode_ref, encode_ref, fingerprint, first_sighting, flatten, matches_target, settle,
    Collected, Identity,
};
use capture::Capturer;

/// 跨进程 UIA 调用计数。只在 debug 构建中存在，用于读树成本的对照测量。
#[cfg(debug_assertions)]
static UIA_CALLS: AtomicU64 = AtomicU64::new(0);

/// 记录一次跨进程 UIA 调用。release 构建中函数体为空，优化后不产生指令。
#[inline(always)]
fn count_call() {
    #[cfg(debug_assertions)]
    UIA_CALLS.fetch_add(1, Ordering::Relaxed);
}

/// 取出并清零调用计数。release 构建中恒为 0。
fn take_calls() -> u64 {
    #[cfg(debug_assertions)]
    {
        UIA_CALLS.swap(0, Ordering::Relaxed)
    }
    #[cfg(not(debug_assertions))]
    {
        0
    }
}

/// 将一次读取的节点数、跨进程调用数、采集次数与耗时写入 stderr。只在 debug 构建中输出。
///
/// 这是读树成本的唯一测量口径：计数器与该输出行必须同时增删，只改其中一处会使对照数据不一致。
/// `captures` 在结构化路径上恒为 0：读树、动作与等待都不会执行采集代码。
fn report_cost(op: &str, nodes: u32, started: Instant) {
    let calls = take_calls();
    let captures = capture::take_captures();
    #[cfg(debug_assertions)]
    eprintln!(
        "cost {op} nodes={nodes} uia_calls={calls} captures={captures} elapsed_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    #[cfg(not(debug_assertions))]
    {
        let _ = (op, nodes, calls, captures, started);
    }
}

const TIMEOUT_HRESULT: i32 = UIA_E_TIMEOUT as i32;
const ELEMENT_GONE_HRESULT: i32 = UIA_E_ELEMENTNOTAVAILABLE as i32;

/// 失败的两种类型：UIA 调用返回的错误，以及 worker 自身判定的拒绝。
///
/// UIA 错误保留 HRESULT，因为原因码按它分类；拒绝已携带自身的原因码。
enum Failure {
    Uia { code: i32, text: String },
    Refused(String),
}

/// 将一次 UIA 调用的错误包装为 `Failure`，`step` 是出错的步骤。
fn uia(step: &'static str) -> impl Fn(::windows::core::Error) -> Failure {
    move |e| Failure::Uia {
        code: e.code().0,
        text: format!("{step}失败：{e}"),
    }
}

/// 同 `uia`，用于步骤名需要按模式名拼接的位置。
fn uia_owned(step: String) -> impl FnOnce(::windows::core::Error) -> Failure {
    move |e| Failure::Uia {
        code: e.code().0,
        text: format!("{step}失败：{e}"),
    }
}

impl Failure {
    /// 转换为回执原文。原因码取决于窗口是否仍存在，因此只能在可取得窗口句柄的位置调用。
    fn into_reason(self, window: i64) -> String {
        match self {
            Self::Refused(text) => text,
            Self::Uia { code, text } => match failure_code(code, window_alive(window)) {
                Some(reason) => format!("{reason}: {text}"),
                None => text,
            },
        }
    }

    fn is_timeout(&self) -> bool {
        matches!(self, Self::Uia { code, .. } if *code == TIMEOUT_HRESULT)
    }

    fn is_element_gone(&self) -> bool {
        match self {
            Self::Uia { code, .. } => *code == ELEMENT_GONE_HRESULT,
            Self::Refused(text) => text.starts_with(REF_STALE),
        }
    }
}

/// UIA 失败的原因码。
///
/// 超时与目标失效必须区分：provider 挂起时窗口仍存在，调用方应重试或放弃该步骤；报告为
/// `target_lost` 会使调用方转而重新发现目标。窗口是否仍存在是 Win32 事实，由调用方查询后传入。
/// 无法判定时返回 `None`，回执保留 provider 原文。
fn failure_code(hresult: i32, window_alive: bool) -> Option<&'static str> {
    if hresult == TIMEOUT_HRESULT {
        return Some("provider_timeout");
    }
    if !window_alive {
        return Some("target_lost");
    }
    None
}

fn window_alive(window: i64) -> bool {
    unsafe { IsWindow(Some(HWND(window as *mut c_void))) }.as_bool()
}

/// 定位结果：目标元素本身、其从窗口元素出发的下标路径，以及其所在的 OS 窗口。
struct Located {
    element: IUIAutomationElement,
    path: Vec<usize>,
    /// 定位路径上最后一个带窗口句柄的节点（含目标自身）的句柄。
    ///
    /// 目标窗口弹出的下拉框、菜单是该窗口拥有的另一个顶层窗口，UIA 将其列在目标窗口的树中；
    /// 指针落点核对依据该字段识别落点位于控件自身所在的窗口上。
    host: i64,
}

/// 本进程的 DPI 感知模式是否为 per-monitor v2，取自 OS 返回的实际值。首次调用时设定。
///
/// **必须在任何窗口矩形或 DPI 查询之前设定**：设定过晚时，系统已按虚拟化坐标返回过查询结果，
/// 这些结果不会重新计算。执行线程最先构造后端，`Uia::new` 的第一步即调用本函数。
fn per_monitor_v2() -> bool {
    static SET: OnceLock<bool> = OnceLock::new();
    *SET.get_or_init(|| {
        let set = capture::set_per_monitor_v2();
        // 宿主将 worker 的 stderr 转入应用日志：图像几何不一致时，该行记录 DPI 感知档位、
        // 显示器数量与虚拟桌面的原点。
        eprintln!("dpi per_monitor_v2={set} displays {}", capture::monitor_report());
        set
    })
}

pub struct Uia {
    automation: IUIAutomation,
    options: IUIAutomation2,
    /// 子节点枚举的筛选条件。读树与重定位共用，下标因此一致。
    control_view: IUIAutomationCondition,
    /// 重定位用的缓存请求。
    ///
    /// **请求的属性与读树的缓存请求完全相同。** 定位路径上的节点会按完整节点读取（等待的判定
    /// 即以此方式读取目标控件），少缓存一项即会在读取时出现「所需属性不在 CacheRequest 中」。
    nav_cache: IUIAutomationCacheRequest,
    /// 本 worker 读取过控件表的窗口，按句柄与进程号记录，句柄被复用时不会误判。
    read_before: Mutex<HashSet<(i64, u32)>>,
    /// 图像采集器，首次采集时创建。
    ///
    /// 不要改为在 `new` 中创建：等待线程为每条请求各创建一个后端，这些后端不执行采集，
    /// 每次都创建 D3D 设备与 WIC 工厂只会增加开销。创建失败只影响采集请求，
    /// 结构化观察与动作不使用采集器。
    capturer: OnceCell<Result<Capturer, String>>,
}

impl Backend for Uia {
    const NAME: &'static str = "windows-uia";

    /// UIA 不需要用户授权。宿主未提权时无法操作提权窗口，这是 UIPI 的进程完整性规则，由动作回执中
    /// 的调用失败原文体现，不在此处声明。
    fn access() -> Access {
        Access::of(Vec::new(), None)
    }

    /// 在调用线程上初始化 COM 与 UIA。必须在执行线程上构造：COM 单元属于线程。
    fn new() -> Result<Self, String> {
        // 进程的 DPI 感知模式先于一切窗口查询设定，见 `per_monitor_v2`。
        per_monitor_v2();
        // UIA 客户端使用 MTA：STA 下客户端需要由自身的消息泵驱动跨进程回调，阻塞等待会死锁。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() {
            return Err(format!("CoInitializeEx 失败：{hr:?}"));
        }
        // 只有 CUIAutomation8 提供 IUIAutomation2 及以上接口；CUIAutomation 只提供 IUIAutomation。
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| format!("创建 UIAutomation 失败：{e}"))?;
        let options: IUIAutomation2 = automation
            .cast()
            .map_err(|e| format!("取 IUIAutomation2 失败：{e}"))?;
        // 关闭自动设置焦点：默认值 TRUE 会使部分模式调用把焦点移到目标控件上。
        unsafe { options.SetAutoSetFocus(false) }
            .map_err(|e| format!("关闭 AutoSetFocus 失败：{e}"))?;
        let control_view = unsafe { automation.ControlViewCondition() }
            .map_err(|e| format!("取 ControlViewCondition 失败：{e}"))?;
        // 重定位请求的属性与读树完全相同：定位路径上的节点会按完整节点读取
        // （等待的判定即以此方式读取目标控件），少一项即会在读取时出现「所需属性不在
        // CacheRequest 中」。
        let nav_cache = build_cache(
            &automation,
            &control_view,
            Fields {
                value: true,
                state: true,
                // 定位路径上不读取前台属性：焦点与窗口模式在派发时实时读取，
                // 读取的是动作发出前的实际值而不是定位时的快照。
                foreground: false,
            },
        )
        .map_err(|e| format!("创建重定位缓存请求失败：{e}"))?;
        // 重定位另外缓存窗口句柄：`locate` 沿路径取得目标所在的 OS 窗口，指针落点核对需要该句柄。
        // 读树不需要，不加入 `build_cache`。
        unsafe { nav_cache.AddProperty(UIA_NativeWindowHandlePropertyId) }
            .map_err(|e| format!("重定位缓存请求添加窗口句柄失败：{e}"))?;
        Ok(Self {
            automation,
            options,
            control_view,
            nav_cache,
            read_before: Mutex::new(HashSet::new()),
            capturer: OnceCell::new(),
        })
    }

    /// 设定 UIA 调用上界并读取实际生效值。
    ///
    /// 这两项是整个 IUIAutomation 实例的设置，无法按调用分别指定，因此由宿主在握手时给定：
    /// worker 不设默认值，避免上界有两个来源。
    fn set_timeouts(
        &self,
        connection_ms: u32,
        transaction_ms: u32,
    ) -> Result<(u32, u32), String> {
        unsafe {
            self.options
                .SetConnectionTimeout(connection_ms)
                .map_err(|e| format!("设置连接超时失败：{e}"))?;
            self.options
                .SetTransactionTimeout(transaction_ms)
                .map_err(|e| format!("设置事务超时失败：{e}"))?;
            let connection = self
                .options
                .ConnectionTimeout()
                .map_err(|e| format!("读取连接超时失败：{e}"))?;
            let transaction = self
                .options
                .TransactionTimeout()
                .map_err(|e| format!("读取事务超时失败：{e}"))?;
            Ok((connection, transaction))
        }
    }

    /// 读取窗口的控件表。给定 `select.root` 时从该子树开始读取。
    ///
    /// 本 worker 首次读取一个窗口时持续读取，直到控件数不再变化：Chromium 系应用在首次收到
    /// UIA 请求时才开启无障碍树，约 0.3 s 后构建完成，首次读取只得到浏览器外框、没有网页内容，
    /// 且不计为截断。之后读取同一个窗口只读取一次。
    fn read_tree(
        &self,
        window: i64,
        select: &Select,
        bounds: Bounds,
        foreground: bool,
    ) -> Result<Observation, String> {
        let first = self
            .read_before
            .lock()
            .map(|mut seen| seen.insert((window, window_pid(window))))
            .unwrap_or(false);
        let read = || self.read_tree_inner(window, select, bounds, foreground);
        let tree = if first {
            settle(read, |t| t.node_count, FIRST_READ_INTERVAL, FIRST_READ_LIMIT)
        } else {
            read()
        };
        tree.map(Observation::Tree).map_err(|f| f.into_reason(window))
    }

    /// 执行动作，并按调用方当前观察的范围完整重读。
    ///
    /// 十三种动作共用这一条路径：定位、准入判定、可放弃等待的调用与动作后重读各只有
    /// 一处实现。按动作拆分为多条路径会使这四个环节各有一份副本。
    ///
    /// **未派发时不重读**：重读结果会被调用方理解为动作已经发生。
    ///
    /// 不要改为只读取目标所在的子树：调用方取得的重读结果即为其当前观察，只读取一部分时，
    /// 范围外的控件或者缺失，或者由调用方拼回旧节点，而旧节点的状态与可用动作
    /// 仍是动作之前的值。
    fn act(
        &self,
        req: &ActRequest<'_>,
        stop: &dyn Fn() -> bool,
    ) -> (Attempt, Result<Observation, String>) {
        let ActRequest {
            window,
            reference,
            root,
            point,
            expect_generation,
            action,
            bounds,
            foreground: fg,
        } = *req;
        let scope = Select {
            root: root.map(str::to_owned),
            ..Select::default()
        };
        let reread = || self.read_tree(window, &scope, bounds, fg);
        // 前台准备可能已经还原窗口或改变焦点。请求的输入仍未派发，但观察必须重读。
        let refused = |reason| {
            let observed = if action.foreground_only() {
                reread()
            } else {
                Err(NOT_DISPATCHED.to_owned())
            };
            (Attempt::Refused(reason), observed)
        };
        // 已失效的截图不能触发窗口准备；几何已改变时也不能保留旧观察。
        if let Some(expected) = expect_generation {
            if let Err(reason) = foreground::check_generation(window, expected) {
                return refused(reason);
            }
        }
        if let Err(reason) = foreground::prepare(window, action) {
            return refused(reason);
        }
        // 不能把恢复窗口前的截图坐标用于恢复后的窗口。
        if let Some(expected) = expect_generation {
            if let Err(reason) = foreground::check_generation(window, expected) {
                return refused(reason);
            }
        }
        let located = match reference.map(|r| self.locate(window, r)) {
            None => None,
            Some(Ok(l)) => Some(l),
            Some(Err(f)) => {
                return refused(f.into_reason(window));
            }
        };
        let aim = match self.aim(window, located.as_ref(), point, action) {
            Ok(aim) => aim,
            Err(reason) => return refused(reason),
        };
        let element = located.as_ref().map(|l| &l.element);
        match perform(window, element, action, aim, stop) {
            Attempt::Refused(reason) => refused(reason),
            // 调用尚未返回：目标应用的 UI 线程阻塞于该调用，此时重读必然等满时间预算后超时。
            // 改为提供不经由 UIA 的事实，即目标进程当前的顶层窗口，调用方据此观察新出现的
            // 窗口。
            Attempt::Called(outcome) if !outcome.returned => {
                // 定位到的元素同样不能在本线程上丢弃：释放代理也需要等待目标进程应答，
                // 就地丢弃会等满 UIA 连接超时。
                if let Some(located) = located {
                    release_off_thread(located);
                }
                (
                    Attempt::Called(outcome),
                    Err(TARGET_BLOCKED.to_owned()),
                )
            }
            called => (called, reread()),
        }
    }

    /// 对目标 provider 的连接执行一次排空调用。
    ///
    /// 上一次动作调用仍未在目标应用中返回时，**该 provider 上的下一次 UIA 调用必定等到
    /// 连接超时才返回，再下一次才恢复正常**（实测 2010 ms 失败、随后成功）。本函数的调用即承担
    /// 这一代价，由 worker 在回执发出之后执行：留给调用方承担时，其下一次观察得到的
    /// 是一次本不应出现的超时失败。
    fn drain_provider(&self, window: i64) {
        let _ = self.window_element(window, &self.nav_cache);
    }

    /// 读取控件的文档文本与选区。只读，不改变状态，也不设置焦点。
    fn read_text(
        &self,
        window: i64,
        reference: &str,
        max_chars: u32,
    ) -> Result<Observation, String> {
        let located = self.locate(window, reference).map_err(|f| f.into_reason(window))?;
        let pattern: IUIAutomationTextPattern =
            current_pattern(window, &located.element, UIA_TextPatternId, "TextPattern")?;
        read_document(window, reference, &pattern, max_chars).map_err(|f| f.into_reason(window))
    }

    /// 等待后置条件成立。判定、轮询与到期都在此处处理，调用方只取得终态。
    ///
    /// `stop` 每轮查询一次：执行者撤销该请求时其值变为真，等待立即以 `cancelled` 结束。
    fn wait(&self, req: &WaitRequest<'_>, stop: &dyn Fn() -> bool) -> Result<Observation, String> {
        let (found, reason, probe) = match wait_loop(req, stop, || self.probe(req)) {
            Ok(v) => v,
            Err(f) => return Err(f.into_reason(req.window)),
        };
        // 只统计最后一次状态读取。轮询的每一轮已各自输出一行，把整段等待计入会重复统计。
        let started = Instant::now();
        let tree = self
            .wait_state(req, probe)
            .map_err(|f| f.into_reason(req.window))?;
        report_cost("wait_state", tree.completeness.visited, started);
        Ok(Observation::Wait(Wait { found, reason, tree }))
    }

    fn list_windows(&self) -> Result<Observation, String> {
        list_windows()
    }

    /// per-monitor v2 未设定成功时，窗口矩形经过系统虚拟化，采集的图像与控件包围盒不在同一坐标系中。
    /// 返回坐标不一致的图像比不返回更糟，因此此处直接拒绝。
    fn capture_image(&self, req: &CaptureRequest<'_>) -> Result<Image, String> {
        if !per_monitor_v2() {
            return Err(
                "dpi_awareness_unset: 进程不是 per-monitor v2 DPI 感知，图像几何不可信".to_owned(),
            );
        }
        let capturer = self.capturer.get_or_init(|| {
            let built = Capturer::new();
            if let Err(e) = &built {
                eprintln!("图像采集不可用：{e}");
            }
            built
        });
        match capturer {
            Ok(capturer) => capturer.capture(req),
            Err(e) => Err(format!("backend_unavailable: {e}")),
        }
    }
}

impl Uia {
    /// 读树使用的缓存请求。是否读取值、是否读取状态细节各自可选，可用动作始终可以判定。
    fn walk_cache(&self, fields: Fields) -> Result<IUIAutomationCacheRequest, Failure> {
        build_cache(&self.automation, &self.control_view, fields)
            .map_err(uia("创建读树缓存请求"))
    }

    /// 取得窗口元素，并将该元素及其子节点一次缓存。一次跨进程调用。
    fn window_element(
        &self,
        window: i64,
        cache: &IUIAutomationCacheRequest,
    ) -> Result<IUIAutomationElement, Failure> {
        let hwnd = HWND(window as *mut c_void);
        count_call();
        unsafe { self.automation.ElementFromHandleBuildCache(hwnd, cache) }
            .map_err(uia("按窗口句柄取 UIA 元素"))
    }

    /// 将元素及其子节点刷新为一份新缓存。一次跨进程调用。
    fn expand(
        &self,
        element: &IUIAutomationElement,
        cache: &IUIAutomationCacheRequest,
    ) -> Result<IUIAutomationElement, Failure> {
        count_call();
        unsafe { element.BuildUpdatedCache(cache) }.map_err(uia("刷新缓存"))
    }

    /// 按 `ref` 中的下标路径重新定位，并核对身份。
    ///
    /// 每层一次跨进程调用：取得该层的缓存子节点，按下标选取一个。子节点顺序与读树使用同一
    /// 筛选条件，下标因此指向同一个节点。
    ///
    /// 身份核对分两种，按 `ref` 中记录的种类判定：有 RuntimeId 的比较 RuntimeId，没有的比较
    /// 角色、名称与稳定标识的指纹。**两种不能互相替代**：原本没有 RuntimeId 的位置
    /// 当前有了 RuntimeId，说明该位置已经不是同一个控件。
    ///
    /// 本后端返回的 `ref` 不带核对串；带核对串的 `ref` 不是本后端返回的，拒绝而不是忽略该字段。
    fn locate(&self, window: i64, reference: &str) -> Result<Located, Failure> {
        let parts = decode_ref(reference).map_err(Failure::Refused)?;
        if parts.check.is_some() {
            return Err(Failure::Refused(format!("bad_ref: {reference}")));
        }
        let (path, expected) = (parts.path, parts.identity);
        let mut element = self.window_element(window, &self.nav_cache)?;
        let mut host = window;
        for (depth, index) in path.iter().enumerate() {
            let children = cached_children(&element)?;
            let Some(child) = children.get(*index).cloned() else {
                return Err(Failure::Refused(format!(
                    "{REF_STALE}: 第 {depth} 层没有下标 {index} 的子节点"
                )));
            };
            element = self.expand(&child, &self.nav_cache)?;
            host = cached_native_window(&element)?.unwrap_or(host);
        }
        let actual = cached_identity(&element)?;
        if actual != expected {
            return Err(Failure::Refused(format!(
                "{REF_STALE}: 该位置当前是 {}，ref 中记录的是 {}{}",
                describe(&actual),
                describe(&expected),
                if expected.is_weak() {
                    "；该控件没有 RuntimeId，身份只能按角色、名称与稳定标识核对，界面重排后旧引用不可靠，请重新观察"
                } else {
                    ""
                }
            )));
        }
        Ok(Located {
            element,
            path,
            host,
        })
    }

    fn read_tree_inner(
        &self,
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
        let cache = self.walk_cache(fields)?;
        match &select.root {
            None => {
                let root = self.window_element(window, &cache)?;
                self.walk_from(window, &root, &[], select, bounds, &cache, fields)
            }
            Some(reference) => {
                let located = self.locate(window, reference)?;
                let root = self.expand(&located.element, &cache)?;
                self.walk_from(window, &root, &located.path, select, bounds, &cache, fields)
            }
        }
    }

    /// 从已带缓存的元素开始遍历。
    ///
    /// **窗口可用状态只取窗口元素自身的字段。** Win32 的模态只禁用顶层窗口，子控件的
    /// HWND 仍处于启用状态，用子树根的状态替代会把「被模态窗口遮挡」误读为一切正常。
    fn walk_from(
        &self,
        window: i64,
        root: &IUIAutomationElement,
        root_path: &[usize],
        select: &Select,
        bounds: Bounds,
        cache: &IUIAutomationCacheRequest,
        fields: Fields,
    ) -> Result<Tree, Failure> {
        let captured_at = now_ms();
        let started = Instant::now();
        let mut walk = Walk {
            backend: self,
            cache,
            bounds,
            fields,
            until: started + Duration::from_millis(bounds.time_budget_ms),
            visited: 0,
            truncated_by: Vec::new(),
            collected: Vec::new(),
            seen: HashSet::new(),
        };
        let mut path = root_path.to_vec();
        // 根节点无法读取即整体失败：没有根节点，本次观察不成立。
        walk.node(root, &mut path, 0, None)?;
        let (nodes, visited, truncated_by) = walk.finish();
        // 根节点最先读取，表的第一项必定是根节点。
        let enabled = if root_path.is_empty() {
            nodes.first().map(|n| n.enabled)
        } else {
            Some(self.window_enabled(window)?)
        };
        report_cost("read_tree", visited, started);
        Ok(Tree {
            window,
            captured_at,
            scope: (!root_path.is_empty())
                .then(|| nodes.first().map(|n| n.reference.clone()))
                .flatten(),
            window_enabled: enabled.unwrap_or(false),
            window_covered: window_covered(window),
            completeness: Completeness {
                complete: truncated_by.is_empty(),
                truncated_by,
                filtered_by: select.describe(),
                visited,
            },
            node_count: u32::try_from(nodes.len()).unwrap_or(u32::MAX),
            nodes,
        })
    }

    /// 指针动作的落点与拖拽终点。非指针动作两项均缺失。
    ///
    /// 落点有两种来源：调用方给定的屏幕坐标，或控件当前的包围盒中心。**包围盒取自本次
    /// 重新定位的结果**，不是观察时记录的值：控件在观察与动作之间移动过时，
    /// 旧包围盒的中心已指向其他位置。
    fn aim(
        &self,
        window: i64,
        located: Option<&Located>,
        point: Option<ScreenPoint>,
        action: &ActionSpec,
    ) -> Result<foreground::Aim, String> {
        if !action.takes_point() {
            return Ok(foreground::Aim::default());
        }
        let anchor = match point {
            Some(point) => point,
            None => {
                let located = located.ok_or("missing_target: 指针动作没有落点")?;
                box_center(window, &located.element)?
            }
        };
        let destination = match action {
            ActionSpec::Drag { to } => Some(match to {
                DragTarget::Offset { dx, dy } => ScreenPoint {
                    x: anchor.x + dx,
                    y: anchor.y + dy,
                },
                DragTarget::Ref { reference } => {
                    let target = self
                        .locate(window, reference)
                        .map_err(|f| f.into_reason(window))?;
                    box_center(window, &target.element)?
                }
            }),
            _ => None,
        };
        Ok(foreground::Aim {
            anchor: Some(anchor),
            destination,
            // 按图像坐标定位时没有控件，落点只核对目标窗口本身。
            host: point.is_none().then(|| located.map(|l| l.host)).flatten(),
        })
    }

    /// 读取一轮判定所需的事实。
    fn probe(&self, req: &WaitRequest<'_>) -> Result<Probe, Failure> {
        match req.until {
            WaitUntil::Window => Ok(Probe::NewWindow(self.window_appeared(req))),
            WaitUntil::Appears => {
                let tree =
                    self.read_tree_inner(req.window, &Select::default(), req.bounds, req.foreground)?;
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
                match self.locate(req.window, reference) {
                    Ok(located) => {
                        let node = self.read_cached_node(
                            &located.element,
                            &located.path,
                            Fields {
                                value: true,
                                state: true,
                                foreground: false,
                            },
                        )?;
                        Ok(Probe::Element {
                            enabled: node.enabled,
                            value: node.value,
                        })
                    }
                    Err(f) if f.is_element_gone() => Ok(Probe::Missing),
                    Err(f) => Err(f),
                }
            }
        }
    }

    /// 判断是否出现标题包含给定文字的顶层窗口。窗口枚举是纯 Win32 调用，不经由 UIA。
    fn window_appeared(&self, req: &WaitRequest<'_>) -> bool {
        let Some(needle) = req.name.map(str::to_lowercase) else {
            return false;
        };
        top_level_windows().is_ok_and(|windows| {
            windows
                .iter()
                .any(|w| w.window != req.window && w.title.to_lowercase().contains(&needle))
        })
    }

    /// 等待返回时附带的状态：按调用方当前观察的范围完整重读。
    ///
    /// `appears` 的判定每轮读取的即是整个窗口，范围也是整个窗口时直接复用最后一轮的结果。
    fn wait_state(&self, req: &WaitRequest<'_>, probe: Probe) -> Result<Tree, Failure> {
        if let (Probe::Matched { tree, .. }, None) = (probe, req.root) {
            return Ok(tree);
        }
        let scope = Select {
            root: req.root.map(str::to_owned),
            ..Select::default()
        };
        self.read_tree_inner(req.window, &scope, req.bounds, req.foreground)
    }

    fn window_enabled(&self, window: i64) -> Result<bool, Failure> {
        let element = self.window_element(window, &self.nav_cache)?;
        cached_bool(&element, "读取窗口可用状态", |e| unsafe { e.CachedIsEnabled() })
    }

    /// 从缓存读取节点的属性。
    ///
    /// 只有选择容器的选中项实时读取，见 `selected_names`；其余全部来自缓存。
    fn read_cached_node(
        &self,
        element: &IUIAutomationElement,
        path: &[usize],
        fields: Fields,
    ) -> Result<Node, Failure> {
        let control_type = unsafe { element.CachedControlType() }.map_err(uia("读取控件类型"))?;
        let name = unsafe { element.CachedName() }.map_err(uia("读取名称"))?;
        let automation_id =
            unsafe { element.CachedAutomationId() }.map_err(uia("读取 AutomationId"))?;
        let enabled = cached_bool(element, "读取可用状态", |e| unsafe { e.CachedIsEnabled() })?;
        let offscreen = cached_bool(element, "读取可见状态", |e| unsafe { e.CachedIsOffscreen() })?;

        let mut actions = Vec::new();
        let mut value = None;
        let value_pattern = available(element, UIA_IsValuePatternAvailablePropertyId)?;
        if value_pattern {
            // 缓存请求未包含值时此处无法读取，这是字段选择的结果，不是失败。
            value = cached_string(element, UIA_ValueValuePropertyId)?;
            actions.push(
                if cached_flag(element, UIA_ValueIsReadOnlyPropertyId)?.unwrap_or(false) {
                    NodeAction::blocked("set_value", "read_only")
                } else {
                    NodeAction::ready("set_value")
                },
            );
        }
        if available(element, UIA_IsInvokePatternAvailablePropertyId)? {
            actions.push(NodeAction::ready("invoke"));
        }

        let mut range = None;
        if available(element, UIA_IsRangeValuePatternAvailablePropertyId)? {
            range = range_state(
                cached_number(element, UIA_RangeValueValuePropertyId)?.unwrap_or(f64::NAN),
                cached_number(element, UIA_RangeValueMinimumPropertyId)?.unwrap_or(f64::NAN),
                cached_number(element, UIA_RangeValueMaximumPropertyId)?.unwrap_or(f64::NAN),
                cached_number(element, UIA_RangeValueSmallChangePropertyId)?.unwrap_or(f64::NAN),
                cached_number(element, UIA_RangeValueLargeChangePropertyId)?.unwrap_or(f64::NAN),
            );
            actions.push(
                if cached_flag(element, UIA_RangeValueIsReadOnlyPropertyId)?.unwrap_or(false) {
                    NodeAction::blocked("set_range_value", "read_only")
                } else {
                    NodeAction::ready("set_range_value")
                },
            );
        }

        let mut toggle = None;
        if available(element, UIA_IsTogglePatternAvailablePropertyId)? {
            toggle = cached_int(element, UIA_ToggleToggleStatePropertyId)?
                .and_then(toggle_from_uia)
                .map(ToggleState::as_str);
            actions.push(NodeAction::ready("set_toggle"));
        }

        let mut expand = None;
        if available(element, UIA_IsExpandCollapsePatternAvailablePropertyId)? {
            let state = cached_int(element, UIA_ExpandCollapseExpandCollapseStatePropertyId)?;
            expand = state.map(expand_name);
            // 叶节点既无法展开也无法折叠：它没有可展开的内容，调用会失败。
            // 未读取状态时按非叶节点处理，由动作时的实时读数判定是否拒绝。
            let leaf = state == Some(ExpandCollapseState_LeafNode.0);
            actions.push(if leaf {
                NodeAction::blocked("expand", "leaf_node")
            } else {
                NodeAction::ready("expand")
            });
            actions.push(if leaf {
                NodeAction::blocked("collapse", "leaf_node")
            } else {
                NodeAction::ready("collapse")
            });
        }

        let mut selected = None;
        if available(element, UIA_IsSelectionItemPatternAvailablePropertyId)? {
            selected = cached_flag(element, UIA_SelectionItemIsSelectedPropertyId)?;
            actions.push(NodeAction::ready("select"));
            // 容器是否支持多选需要查询容器，这是一次跨进程调用；推迟到动作时查询，
            // 读树时不为每一项各查询一次。
            actions.push(NodeAction::ready("add_to_selection"));
            actions.push(NodeAction::ready("remove_from_selection"));
        }

        let mut selection = None;
        if available(element, UIA_IsSelectionPatternAvailablePropertyId)? {
            if let (Some(multiple), Some(required)) = (
                cached_flag(element, UIA_SelectionCanSelectMultiplePropertyId)?,
                cached_flag(element, UIA_SelectionIsSelectionRequiredPropertyId)?,
            ) {
                let (names, total) = selected_names(element)?;
                selection = Some(selection_state(multiple, required, names, total));
            }
        }

        let mut scroll = None;
        if available(element, UIA_IsScrollPatternAvailablePropertyId)? {
            let horizontal = cached_flag(element, UIA_ScrollHorizontallyScrollablePropertyId)?;
            let vertical = cached_flag(element, UIA_ScrollVerticallyScrollablePropertyId)?;
            if horizontal.is_some() || vertical.is_some() {
                scroll = Some(ScrollState {
                    horizontal: axis_percent(
                        element,
                        horizontal,
                        UIA_ScrollHorizontalScrollPercentPropertyId,
                    )?,
                    vertical: axis_percent(
                        element,
                        vertical,
                        UIA_ScrollVerticalScrollPercentPropertyId,
                    )?,
                });
            }
            // 未读取状态时按可滚动处理：能否滚动由动作时的实时读数判定。
            actions.push(
                if horizontal == Some(false) && vertical == Some(false) {
                    NodeAction::blocked("scroll", "not_scrollable")
                } else {
                    NodeAction::ready("scroll")
                },
            );
        }
        if available(element, UIA_IsScrollItemPatternAvailablePropertyId)? {
            actions.push(NodeAction::ready("scroll_into_view"));
        }
        if available(element, UIA_IsItemContainerPatternAvailablePropertyId)? {
            actions.push(NodeAction::ready("realize_item"));
        }
        let text = available(element, UIA_IsTextPatternAvailablePropertyId)?;
        if text {
            // 是否支持设置选区需要查询 `SupportedTextSelection`，该属性没有缓存版本；推迟到动作时查询。
            actions.push(NodeAction::ready("select_text"));
            // 终端与控制台的正文只能经由 TextPattern 读取：不读取时观察中只有控件名，无法得知窗口
            // 中正在运行的内容。
            if fields.value && !value_pattern {
                value = visible_text(element, &name.to_string())?;
            }
        }

        let bounds = unsafe { element.CachedBoundingRectangle() }.map_err(uia("读取包围盒"))?;
        let rect = bounding_box(bounds);

        let focused = cached_flag(element, UIA_HasKeyboardFocusPropertyId)?.unwrap_or(false);
        if fields.foreground {
            // 指针动作只列在有可视位置且当前位于可视区内的控件上：没有包围盒则无法确定
            // 落点，可视区外的控件在该坐标上是遮挡在其前方的另一个控件。
            if rect.is_some() && !offscreen {
                for action in ["click", "hover", "drag", "wheel"] {
                    actions.push(NodeAction::foreground(action));
                }
            }
            // 键盘动作列在两处：当前持有键盘焦点的控件（输入该控件），以及窗口根节点
            // （输入该窗口）。自绘界面无法提供持有焦点的控件，只列前者等于对这类界面关闭整条
            // 键盘路径。路径为空时才是窗口元素自身，子树读取的根节点带有其在整个窗口中的下标。
            //
            // 不要给窗口根添加「当前是系统前台窗口」的条件：定位前 `foreground::prepare` 先将
            // 目标窗口提升到前台再核对。添加该条件后，桌面这类没有 WindowPattern、无法先
            // activate 的窗口永远无法获得键盘动作，Win+I 这类系统快捷键只能借用户正在使用的
            // 窗口发出。
            if focused || path.is_empty() {
                actions.push(NodeAction::foreground("type_text"));
                actions.push(NodeAction::foreground("press_key"));
            }
            if available(element, UIA_IsWindowPatternAvailablePropertyId)? {
                for action in ["activate", "set_window_state", "close_window"] {
                    actions.push(NodeAction::foreground(action));
                }
            }
            if available(element, UIA_IsTransformPatternAvailablePropertyId)? {
                actions.push(NodeAction::foreground("move_window"));
                actions.push(NodeAction::foreground("resize_window"));
            }
        }

        let identity = cached_identity(element)?;
        Ok(Node {
            reference: encode_ref(path, None, &identity),
            parent_ref: None,
            depth: 0,
            role: role_name(control_type.0),
            name: name.to_string(),
            automation_id: automation_id.to_string(),
            value,
            enabled,
            offscreen,
            focused,
            rect,
            actions,
            range,
            toggle,
            expand,
            selected,
            selection,
            scroll,
            text,
            weak_identity: identity.is_weak(),
        })
    }
}

/// 将 ExpandCollapseState 常量转换为回执中的名称。
fn expand_name(state: i32) -> &'static str {
    if state == ExpandCollapseState_Collapsed.0 {
        "collapsed"
    } else if state == ExpandCollapseState_Expanded.0 {
        "expanded"
    } else if state == ExpandCollapseState_PartiallyExpanded.0 {
        "partial"
    } else if state == ExpandCollapseState_LeafNode.0 {
        "leaf"
    } else {
        "unknown"
    }
}

/// 元素自身的窗口句柄。只有对应一个 OS 窗口的元素具有该句柄，其余返回 `None`。只读取缓存。
fn cached_native_window(element: &IUIAutomationElement) -> Result<Option<i64>, Failure> {
    let handle = unsafe { element.CachedNativeWindowHandle() }.map_err(uia("读取窗口句柄"))?;
    Ok((!handle.0.is_null()).then_some(handle.0 as i64))
}

/// 控件当前的包围盒中心，单位为屏幕物理像素。
///
/// 没有包围盒的控件无法确定落点：provider 对没有可视位置的控件返回全零矩形，
/// 按该矩形计算出的中心是屏幕左上角。
pub fn box_center(window: i64, element: &IUIAutomationElement) -> Result<ScreenPoint, String> {
    let bounds = unsafe { element.CachedBoundingRectangle() }
        .map_err(uia("读取包围盒"))
        .map_err(|f| f.into_reason(window))?;
    bounding_box(bounds)
        .map(|rect| rect.center())
        .ok_or_else(|| "no_bounds: 该控件没有可视位置".to_owned())
}

/// 将 UIA 的包围盒转换为图像几何使用的矩形。
///
/// 零尺寸按缺失处理：provider 对没有可视位置的控件返回全零矩形，将其视为
/// 「位于屏幕左上角、宽高为零」会使调用方在该位置查找一个不存在的目标。
fn bounding_box(r: RECT) -> Option<ScreenRect> {
    let width = r.right - r.left;
    let height = r.bottom - r.top;
    (width > 0 && height > 0).then_some(ScreenRect {
        x: r.left,
        y: r.top,
        width,
        height,
    })
}

/// 读取节点所需的属性。
///
/// 只在此处列出一次：`read_cached_node` 逐项读取这些属性，缓存请求缺少一项即会在读取该项时失败，
/// 而失败位置与遗漏之处相距很远。
const NODE_PROPERTIES: &[::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    // 模式是否存在：经由 `Is*PatternAvailable` 布尔属性判定，不缓存模式对象本身。
    // **不要改为 `AddPattern`**：provider 需要为每个节点各创建一个模式对象，实测同一个
    // 155 节点窗口的读取从 197 ms 增至 518 ms，而此处只需判定模式是否存在。
    UIA_IsValuePatternAvailablePropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsRangeValuePatternAvailablePropertyId,
    UIA_IsSelectionPatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsScrollItemPatternAvailablePropertyId,
    UIA_IsTextPatternAvailablePropertyId,
    UIA_IsItemContainerPatternAvailablePropertyId,
];

/// 控件模式的状态属性。
///
/// 与 `NODE_PROPERTIES` 分开列出，因为 `includeState` 为假时不请求这些属性：动作可用性
/// 只取决于上方的布尔属性，与状态细节无关。
const STATE_PROPERTIES: &[::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_RangeValueMinimumPropertyId,
    UIA_RangeValueMaximumPropertyId,
    UIA_RangeValueSmallChangePropertyId,
    UIA_RangeValueLargeChangePropertyId,
    UIA_RangeValueIsReadOnlyPropertyId,
    UIA_SelectionCanSelectMultiplePropertyId,
    UIA_SelectionIsSelectionRequiredPropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_ScrollHorizontalScrollPercentPropertyId,
    UIA_ScrollVerticalScrollPercentPropertyId,
    UIA_ScrollHorizontallyScrollablePropertyId,
    UIA_ScrollVerticallyScrollablePropertyId,
];

/// 创建缓存请求：固定用控件视图筛选子节点，范围固定为「本节点 + 其子节点」。
///
/// 范围与筛选条件只在此处定义一次。只改其中一处会使读树与重定位的下标不一致，同一个 `ref`
/// 在两处指向不同节点。
fn build_cache(
    automation: &IUIAutomation,
    control_view: &IUIAutomationCondition,
    fields: Fields,
) -> ::windows::core::Result<IUIAutomationCacheRequest> {
    unsafe {
        let cache = automation.CreateCacheRequest()?;
        cache.SetTreeScope(TreeScope(TreeScope_Element.0 | TreeScope_Children.0))?;
        cache.SetTreeFilter(control_view)?;
        // 元素必须保留完整引用：动作需要在缓存返回的元素上调用模式，None 模式下无法调用。
        cache.SetAutomationElementMode(AutomationElementMode_Full)?;
        // RuntimeId 是 `ref` 的核对依据，每个节点都需要，不随字段选择变化。
        cache.AddProperty(UIA_RuntimeIdPropertyId)?;
        for property in NODE_PROPERTIES {
            cache.AddProperty(*property)?;
        }
        if fields.value {
            cache.AddProperty(UIA_ValueValuePropertyId)?;
        }
        if fields.state {
            for property in STATE_PROPERTIES {
                cache.AddProperty(*property)?;
            }
        }
        if fields.foreground {
            for property in FOREGROUND_PROPERTIES {
                cache.AddProperty(*property)?;
            }
        }
        Ok(cache)
    }
}

/// 仅在前台模式下读取的属性。
///
/// 前台模式关闭时不请求任何一项：这些属性只服务于前台动作表，而此时不列出任何前台动作。
const FOREGROUND_PROPERTIES: &[::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsWindowPatternAvailablePropertyId,
    UIA_IsTransformPatternAvailablePropertyId,
];

/// 本次读取包含的可选字段。
///
/// 前两项不影响可用动作表：动作按 `Is*PatternAvailable` 判定，这些属性始终读取。
/// `foreground` 影响可用动作表：它决定是否列出前台动作，以及是否额外请求三个属性。
#[derive(Debug, Clone, Copy)]
struct Fields {
    /// 读取控件当前值。
    value: bool,
    /// 读取控件模式的状态细节：数值区间、复选状态、展开状态、选中状态、容器约束、滚动位置。
    state: bool,
    /// 用户启用了前台接管。
    foreground: bool,
}

/// 深度优先遍历的状态。三个上限针对的是已遍历的节点数。
struct Walk<'a> {
    backend: &'a Uia,
    cache: &'a IUIAutomationCacheRequest,
    bounds: Bounds,
    fields: Fields,
    until: Instant,
    visited: u32,
    truncated_by: Vec<&'static str>,
    collected: Vec<Collected>,
    /// 本次遍历已输出的 RuntimeId。只在本次遍历内有效：RuntimeId 在不同时刻可能被复用。
    seen: HashSet<String>,
}

impl Walk<'_> {
    fn mark(&mut self, why: &'static str) {
        if !self.truncated_by.contains(&why) {
            self.truncated_by.push(why);
        }
    }

    /// 子节点级失败的处理。
    fn tolerate(&mut self, failure: Failure) -> Result<(), Failure> {
        // 先判定超时：超时说明 provider 已不再应答，继续遍历会使后续每个节点各等待一次超时。
        if failure.is_timeout() {
            return Err(failure);
        }
        // 节点在遍历过程中消失属于常见情况，记录一条截断原因后继续遍历。
        if failure.is_element_gone() {
            self.mark("node_unavailable");
            return Ok(());
        }
        Err(failure)
    }

    fn node(
        &mut self,
        element: &IUIAutomationElement,
        path: &mut Vec<usize>,
        depth: u32,
        parent: Option<usize>,
    ) -> Result<(), Failure> {
        // 已输出过的强身份不再输出、不再展开，也不计入 visited。UIA 返回的子节点列表可能
        // 包含祖先或已读取的节点（Edge 内容面板把父窗口的全部子节点追加在自身的子节点之后，
        // 其中包括它自身），照常展开会逐层复制同一棵子树，直到达到 max_depth / max_nodes。
        if !first_sighting(&mut self.seen, &runtime_id(element)?) {
            return Ok(());
        }
        let mut node = self.backend.read_cached_node(element, path, self.fields)?;
        node.depth = depth;
        self.visited += 1;
        let index = self.collected.len();
        self.collected.push(Collected { node, parent });
        if depth >= self.bounds.max_depth {
            self.mark("max_depth");
            return Ok(());
        }
        let expanded = match self.backend.expand(element, self.cache) {
            Ok(e) => e,
            Err(f) => {
                self.tolerate(f)?;
                return Ok(());
            }
        };
        let children = match cached_children(&expanded) {
            Ok(c) => c,
            Err(f) => {
                self.tolerate(f)?;
                return Ok(());
            }
        };
        // 下标照常递增：跳过一个子节点不得改变其后兄弟节点的 ref。
        for (offset, child) in children.iter().enumerate() {
            if self.visited >= self.bounds.max_nodes {
                self.mark("max_nodes");
                break;
            }
            if Instant::now() >= self.until {
                self.mark("time_budget");
                break;
            }
            path.push(offset);
            let built = self.node(child, path, depth + 1, Some(index));
            path.pop();
            if let Err(f) = built {
                self.tolerate(f)?;
            }
        }
        Ok(())
    }

    /// 输出前序表，并将父引用填写为父节点的 `ref`。
    fn finish(self) -> (Vec<Node>, u32, Vec<&'static str>) {
        (flatten(self.collected), self.visited, self.truncated_by)
    }
}

/// 顶层可见窗口清单。纯 Win32 调用，不经由 UIA，也不涉及图像。
///
/// 标题为空的可见窗口一律不列出：这类窗口是工具窗口与消息宿主窗口，不是可操作目标。代价是
/// 标题恰好为空的应用窗口在此处同样不可见，调用方无法取得其句柄。
///
/// 被 DWM 隐藏的窗口也不列出：其他虚拟桌面上的窗口、已关闭但进程仍在运行的应用窗口、浏览器
/// 标签页的代理窗口都不在屏幕上。
pub fn list_windows() -> Result<Observation, String> {
    Ok(Observation::Windows {
        captured_at: now_ms(),
        windows: top_level_windows()?,
    })
}

/// 列表在读取期间变化时完整重读的次数上限。
const SCAN_ATTEMPTS: usize = 3;

/// 屏幕上有标题的顶层窗口，按 z 序从上到下。
///
/// 不要改为 `EnumWindows`：它从 Windows 8 起只列出桌面程序的窗口，开始菜单、搜索面板这类
/// 系统界面（`Windows.UI.Core.CoreWindow`）不在其中，模型打开开始菜单后无法找到该窗口。
/// `FindWindowExW` 逐个读取的是实时列表：读取中途有窗口被销毁或调整 z 序时，本次结果不完整，
/// 需完整重读。
fn top_level_windows() -> Result<Vec<WindowInfo>, String> {
    (0..SCAN_ATTEMPTS)
        .find_map(|_| scan_top_level())
        .ok_or_else(|| format!("枚举窗口失败：读取期间窗口列表连续 {SCAN_ATTEMPTS} 次发生变化"))
}

/// 读取一次顶层窗口。列表在读取期间变化时返回 `None`。
fn scan_top_level() -> Option<Vec<WindowInfo>> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut after: Option<HWND> = None;
    loop {
        // SAFETY: 只读查询；类名与标题都不限定。
        let Ok(next) = (unsafe { FindWindowExW(None, after, PCWSTR::null(), PCWSTR::null()) }) else {
            // 无法读取下一个窗口有两种成因：已读取完毕，或上一个窗口刚被销毁；后者表示本次结果不完整。
            // SAFETY: 只读查询。
            let complete = after.is_none_or(|w| unsafe { IsWindow(Some(w)) }.as_bool());
            return complete.then_some(found);
        };
        // 再次读取到同一个窗口说明 z 序在读取期间发生了变化。
        if !seen.insert(next.0 as isize) {
            return None;
        }
        after = Some(next);
        found.extend(shown_window(next));
    }
}

/// 可见、未被 DWM 隐藏且有标题的窗口。
fn shown_window(hwnd: HWND) -> Option<WindowInfo> {
    // SAFETY: 均为只读查询，出参是本栈帧上的缓冲区与整数。
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || cloaked(hwnd) {
            return None;
        }
        let mut title = [0u16; 512];
        let written = GetWindowTextW(hwnd, &mut title);
        if written <= 0 {
            return None;
        }
        let mut class_name = [0u16; 256];
        let class_written = GetClassNameW(hwnd, &mut class_name);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        Some(WindowInfo {
            window: hwnd.0 as i64,
            pid,
            title: String::from_utf16_lossy(&title[..written as usize]),
            class_name: String::from_utf16_lossy(&class_name[..class_written.max(0) as usize]),
        })
    }
}

/// 判断 DWM 是否隐藏了该窗口。无法读取时按未隐藏处理。
fn cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: 只读查询，出参是本栈帧上的整数。
    let read = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            std::ptr::addr_of_mut!(cloaked).cast(),
            u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4),
        )
    };
    read.is_ok() && cloaked != 0
}

/// 首次读取一个窗口时两次读取之间的间隔。Edge 的无障碍树在首次请求后约 0.3 s 构建完成。
const FIRST_READ_INTERVAL: Duration = Duration::from_millis(350);
/// 首次读取一个窗口的最长时长。页面上有持续变化的元素时控件数不断变化，到时即返回最后一次的结果。
const FIRST_READ_LIMIT: Duration = Duration::from_secs(2);

/// 窗口所属进程号。无法读取时为 0。
fn window_pid(window: i64) -> u32 {
    let mut pid = 0u32;
    // SAFETY: 只读查询，出参是本栈帧上的整数。
    unsafe { GetWindowThreadProcessId(HWND(window as *mut c_void), Some(&mut pid)) };
    pid
}

/// 窗口当前在屏幕上是否完全不可见：已最小化，或可见部分被 z 序在其上方的窗口完全遮挡。
///
/// 遮挡方只计入可见、未最小化、未被 DWM 隐藏（其他虚拟桌面、挂起的应用）且不是
/// 分层或鼠标穿透的窗口：分层窗口通常是阴影、悬浮歌词这类透明层，计入后会把可见的窗口
/// 报告为被遮挡。矩形取 DWM 的可见边框，不含不可见的调整边框。无法读取几何时按未遮挡报告。
fn window_covered(window: i64) -> bool {
    let hwnd = HWND(window as *mut c_void);
    // SAFETY: 只读查询。
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return true;
    }
    let Ok(frame) = capture::window_frame(hwnd) else {
        return false;
    };
    let Some(target) = frame.visible.intersect(&foreground::virtual_desktop()) else {
        return true;
    };
    let mut covers = Vec::new();
    // SAFETY: 只读查询；沿 z 序向上逐个取得句柄，到达顶端返回错误时停止。
    let mut above = unsafe { GetWindow(hwnd, GW_HWNDPREV) };
    while let Ok(next) = above {
        if next.is_invalid() {
            break;
        }
        if covers_others(next) {
            if let Ok(f) = capture::window_frame(next) {
                covers.push(f.visible);
            }
        }
        // SAFETY: 同上。
        above = unsafe { GetWindow(next, GW_HWNDPREV) };
    }
    crate::geometry::fully_covered(target, &covers)
}

/// 判断该窗口能否遮挡其下方的窗口。
fn covers_others(hwnd: HWND) -> bool {
    // SAFETY: 三项都是只读查询。
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if style & (WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) != 0 {
            return false;
        }
    }
    !cloaked(hwnd)
}

/// UIA 用空指针表示「没有该子节点」「不支持该模式」。
///
/// 判据只能是 `code().is_ok()`：windows crate 对空出参返回的是 HRESULT 为 S_OK 的
/// `Err`，不是某个失败码，按具体错误码比对会把「不存在」误判为调用失败。
fn optional<T>(result: ::windows::core::Result<T>) -> ::windows::core::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.code().is_ok() => Ok(None),
        Err(e) => Err(e),
    }
}

/// 读取缓存的布尔属性。
fn cached_bool<T>(
    source: &T,
    step: &'static str,
    read: impl Fn(&T) -> ::windows::core::Result<::windows::core::BOOL>,
) -> Result<bool, Failure> {
    read(source).map(|v| v.as_bool()).map_err(uia(step))
}

/// 本次缓存请求未包含该属性。
///
/// UIA 对不在 CacheRequest 中的属性返回 `E_INVALIDARG`；本模块的属性 id 均为常量，
/// 该错误码在此处只有这一种成因。
const NOT_REQUESTED: i32 = -2_147_024_809; // E_INVALIDARG (0x80070057)

/// 读取缓存属性。本次未请求该属性时返回 `None`，不是失败。
fn cached_value(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<Option<VARIANT>, Failure> {
    match unsafe { element.GetCachedPropertyValue(id) } {
        Ok(variant) => Ok(Some(variant)),
        Err(e) if e.code().0 == NOT_REQUESTED => Ok(None),
        Err(e) => Err(uia("读取缓存属性")(e)),
    }
}

/// 缓存属性中的布尔值。缺失或类型不符时为 `None`。
///
/// **缺失与假含义不同**：未读取该项时按假处理，会把「未知」记为「不可用」。
fn cached_flag(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<Option<bool>, Failure> {
    let Some(variant) = cached_value(element, id)? else {
        return Ok(None);
    };
    if variant.vt() != VT_BOOL {
        return Ok(None);
    }
    // SAFETY: vt 为 VT_BOOL 时联合体中有效的成员是 boolVal。
    Ok(Some(unsafe { variant.Anonymous.Anonymous.Anonymous.boolVal }.as_bool()))
}

/// 缓存属性中的浮点数。
fn cached_number(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<Option<f64>, Failure> {
    let Some(variant) = cached_value(element, id)? else {
        return Ok(None);
    };
    if variant.vt() != VT_R8 {
        return Ok(None);
    }
    // SAFETY: vt 为 VT_R8 时联合体中有效的成员是 dblVal。
    Ok(Some(unsafe { variant.Anonymous.Anonymous.Anonymous.dblVal }))
}

/// 缓存属性中的整数。控件模式的状态枚举按整数读取。
fn cached_int(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<Option<i32>, Failure> {
    let Some(variant) = cached_value(element, id)? else {
        return Ok(None);
    };
    if variant.vt() != VT_I4 {
        return Ok(None);
    }
    // SAFETY: vt 为 VT_I4 时联合体中有效的成员是 lVal。
    Ok(Some(unsafe { variant.Anonymous.Anonymous.Anonymous.lVal }))
}

/// 缓存属性中的字符串。
fn cached_string(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<Option<String>, Failure> {
    let Some(variant) = cached_value(element, id)? else {
        return Ok(None);
    };
    if variant.vt() != VT_BSTR {
        return Ok(None);
    }
    // SAFETY: vt 为 VT_BSTR 时联合体中有效的成员是 bstrVal；字符串归 VARIANT 所有，
    // 此处只借用读取，再复制一份返回。
    let text = unsafe { &*variant.Anonymous.Anonymous.Anonymous.bstrVal };
    Ok(Some(String::from_utf16_lossy(text)))
}

/// 判断控件是否具有某个控件模式。按 `Is*PatternAvailable` 布尔属性判定，不创建模式对象。
fn available(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<bool, Failure> {
    Ok(cached_flag(element, id)?.unwrap_or(false))
}

/// 选择容器当前选中项的名称，以及容器报告的选中项总数。
///
/// **不要把 `UIA_SelectionSelectionPropertyId` 加入缓存请求。** 整棵树共用一份缓存请求，
/// 同一个容器在一次遍历中会被缓存多次，provider 每次都要另行创建完整的选中项数组：
/// 一个选中 800 项的虚拟化列表，加入缓存请求后单轮读树从 170 ms 增至 645 ms，改为在此处
/// 对每个容器实时读取一次则为 310 ms。数组的开销与选中项数成正比，实时读取保证每个容器只承担一次。
///
/// 名称再按每项一次跨进程调用读取：数组中的元素**自身不带缓存**，读取其缓存名称会返回
/// `E_INVALIDARG`。名称的调用数按 `selected_name_budget` 截断。
///
/// 读取某一项的名称时该项已消失，则跳过该项，总数按原值返回：两者不等即名单不完整。
/// 其余失败一律向上返回：provider 不应答时后续每一项都会各等待一次超时。
///
/// `includeState` 为假时调用方不会执行到此处：此时容器约束的两个属性不在缓存请求中，
/// 整个 `selection` 不成立。
fn selected_names(element: &IUIAutomationElement) -> Result<(Vec<String>, usize), Failure> {
    count_call();
    let variant = unsafe { element.GetCurrentPropertyValue(UIA_SelectionSelectionPropertyId) }
        .map_err(uia("读取选中项"))?;
    if variant.vt() != VT_UNKNOWN {
        return Ok((Vec::new(), 0));
    }
    // SAFETY: vt 为 VT_UNKNOWN 时联合体中有效的成员是 punkVal；接口指针归 VARIANT 所有，
    // 此处只借用该指针取得元素。
    let Some(unknown) = (unsafe { &*variant.Anonymous.Anonymous.Anonymous.punkVal }).as_ref() else {
        return Ok((Vec::new(), 0));
    };
    let array = unknown
        .cast::<IUIAutomationElementArray>()
        .map_err(uia("取选中项"))?;
    let length = unsafe { array.Length() }.map_err(uia("读取选中项数"))?;
    let total = usize::try_from(length).unwrap_or(0);
    let mut names = Vec::new();
    for index in 0..selected_name_budget(total) {
        let item = unsafe { array.GetElement(index as i32) }.map_err(uia("取选中项"))?;
        count_call();
        match unsafe { item.CurrentName() } {
            Ok(name) => names.push(name.to_string()),
            Err(e) => {
                let failure = uia("读取选中项名称")(e);
                if !failure.is_element_gone() {
                    return Err(failure);
                }
            }
        }
    }
    Ok((names, total))
}

/// 文本控件当前可见范围内的文字，规则见 `visible_lines`。
///
/// 不要改为读取 `DocumentRange`：终端的文档范围从缓冲区开头计算，读取到的是最早的输出，
/// 不是屏幕上正在显示的内容。
fn visible_text(element: &IUIAutomationElement, name: &str) -> Result<Option<String>, Failure> {
    count_call();
    let Some(found) =
        optional(unsafe { element.GetCurrentPattern(UIA_TextPatternId) }).map_err(uia("取 TextPattern"))?
    else {
        return Ok(None);
    };
    let pattern = found
        .cast::<IUIAutomationTextPattern>()
        .map_err(uia("TextPattern 转换"))?;
    count_call();
    let ranges = unsafe { pattern.GetVisibleRanges() }.map_err(uia("取可见范围"))?;
    let length = unsafe { ranges.Length() }.map_err(uia("读取可见范围段数"))?;
    let mut segments = Vec::new();
    for index in 0..length {
        let range = unsafe { ranges.GetElement(index) }.map_err(uia("取可见范围"))?;
        count_call();
        segments.push(unsafe { range.GetText(-1) }.map_err(uia("读取可见文本"))?.to_string());
    }
    Ok(visible_lines(&segments, name))
}

/// 可见范围的各段以换行拼接，去除行尾空格与首尾空行。为空或与控件名称相同时为 `None`。
///
/// 按段换行是因为 conhost 每行一段且段内不带换行；Windows Terminal 只返回一段，各行按窗口宽度
/// 补齐空格，不去除行尾空格时一屏内容含上万个空格。
fn visible_lines(segments: &[String], name: &str) -> Option<String> {
    let joined = segments.join("\n");
    let lines: Vec<&str> = joined.lines().map(str::trim_end).collect();
    let first = lines.iter().position(|line| !line.is_empty())?;
    let last = lines.iter().rposition(|line| !line.is_empty())?;
    let text = lines[first..=last].join("\n");
    (text != name.trim()).then_some(text)
}

/// 滚动轴的位置百分比。该轴不可滚动或未读取状态时缺失。
///
/// **缺失不等于 0**：0 表示位于顶端。
fn axis_percent(
    element: &IUIAutomationElement,
    scrollable: Option<bool>,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<Option<f64>, Failure> {
    if scrollable != Some(true) {
        return Ok(None);
    }
    Ok(cached_number(element, id)?.filter(|p| *p != UIA_ScrollPatternNoScroll))
}

/// 取得控件当前的模式。定位之后需要调用模式方法时使用，读取的是实时状态而不是缓存。
///
/// 模式缺失返回 `pattern_missing`，与调用失败区分：前者可证明未发出动作调用。
pub fn current_pattern<T: Interface>(
    window: i64,
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PATTERN_ID,
    name: &'static str,
) -> Result<T, String> {
    count_call();
    let found = optional(unsafe { element.GetCurrentPattern(id) })
        .map_err(uia_owned(format!("取 {name}")))
        .map_err(|f| f.into_reason(window))?;
    let Some(pattern) = found else {
        return Err(format!("pattern_missing: {name}"));
    };
    pattern
        .cast::<T>()
        .map_err(uia_owned(format!("{name} 转换")))
        .map_err(|f| f.into_reason(window))
}

/// 取得缓存中的子节点。缓存请求的范围包含子节点，因此不发出跨进程调用。
///
/// 没有子节点时 UIA 返回空指针与 S_OK，经 `optional` 判定为不存在，不是调用失败。
fn cached_children(element: &IUIAutomationElement) -> Result<Vec<IUIAutomationElement>, Failure> {
    let Some(array) =
        optional(unsafe { element.GetCachedChildren() }).map_err(uia("取缓存子节点"))?
    else {
        return Ok(Vec::new());
    };
    let length = unsafe { array.Length() }.map_err(uia("读取子节点数"))?;
    let mut out = Vec::with_capacity(length.max(0) as usize);
    for index in 0..length {
        out.push(unsafe { array.GetElement(index) }.map_err(uia("取子节点"))?);
    }
    Ok(out)
}

/// 身份在回执中的表述。指纹是不透明字符串，表述中写明其计算依据。
fn describe(identity: &Identity) -> String {
    match identity {
        Identity::Stable(id) => format!("RuntimeId {id}"),
        Identity::Attributes(print) => format!("属性指纹 {print}"),
    }
}

/// 从缓存读取元素的身份。不发出跨进程调用。
fn cached_identity(element: &IUIAutomationElement) -> Result<Identity, Failure> {
    let runtime = runtime_id(element)?;
    if !runtime.is_empty() {
        return Ok(Identity::Stable(runtime));
    }
    let control_type = unsafe { element.CachedControlType() }.map_err(uia("读取控件类型"))?;
    let name = unsafe { element.CachedName() }.map_err(uia("读取名称"))?;
    let automation_id =
        unsafe { element.CachedAutomationId() }.map_err(uia("读取 AutomationId"))?;
    Ok(Identity::Attributes(fingerprint(
        &role_name(control_type.0),
        &name.to_string(),
        &automation_id.to_string(),
    )))
}

/// 取得节点的 RuntimeId，没有身份的节点返回空字符串。
///
/// 只读取缓存：`GetRuntimeId()` 是跨进程调用，按节点各调用一次会抵消批量读取属性的收益。
/// 部分节点在两处都无法提供身份（实测同一批节点在缓存中是空 VARIANT，实时读取也是空数组），
/// 此时 `ref` 中的身份段为空，动作前的核对退化为只比较下标路径。

fn runtime_id(element: &IUIAutomationElement) -> Result<String, Failure> {
    let variant: VARIANT = unsafe { element.GetCachedPropertyValue(UIA_RuntimeIdPropertyId) }
        .map_err(uia("读取 RuntimeId"))?;
    if variant.vt().0 & VT_ARRAY.0 == 0 {
        return Ok(String::new());
    }
    // SAFETY: vt 带 VT_ARRAY 时联合体中有效的成员是 parray；数组归 VARIANT 所有，
    // 其 Drop 会调用 VariantClear，此处只借用读取，不能自行销毁。
    let array = unsafe { variant.Anonymous.Anonymous.Anonymous.parray };
    Ok(unsafe { read_i32_array(array) }?.join("."))
}

unsafe fn read_i32_array(array: *const SAFEARRAY) -> Result<Vec<String>, Failure> {
    let lower = SafeArrayGetLBound(array, 1).map_err(uia("读取 RuntimeId 下界"))?;
    let upper = SafeArrayGetUBound(array, 1).map_err(uia("读取 RuntimeId 上界"))?;
    let mut parts = Vec::new();
    for index in lower..=upper {
        let mut part = 0i32;
        SafeArrayGetElement(array, &index, std::ptr::addr_of_mut!(part).cast())
            .map_err(uia("读取 RuntimeId 元素"))?;
        parts.push(part.to_string());
    }
    Ok(parts)
}

// ── 动作：可放弃等待的调用路径 ──

/// 一次 `set_toggle` 最多切换的次数。三态循环最长三步，未达到目标状态即如实返回未知。
const MAX_TOGGLE_STEPS: u32 = 3;
/// 调用未返回时随回执返回的顶层窗口数上限。
///
/// 该字段用于向调用方指示下一步观察的窗口，不是窗口清单的第二个入口。
const MAX_BLOCKING_WINDOWS: usize = 16;

/// 一次待发出的模式调用，连同其捕获的 UIA 接口。
///
/// **两端都在进程的 MTA 中**：`Uia::new` 与每条调用线程都执行
/// `CoInitializeEx(COINIT_MULTITHREADED)`，同一个接口指针因此可以直接跨线程调用，
/// 不需要封送。不要把 UIA 客户端改为 STA，否则该封装不再成立。
pub struct Deferred(Box<dyn FnOnce() -> Result<(), String>>);

// SAFETY: 接口对象归进程 MTA 所有，调用线程加入同一个 MTA 之后可以直接调用。
unsafe impl Send for Deferred {}

impl Deferred {
    /// 发出本次调用。
    ///
    /// **必须经由本方法调用**：在闭包中直接解构字段时，2021 版的按字段捕获会使线程
    /// 捕获内部的 `Box`，`Send` 将不再由本类型声明。
    fn run(self) -> Result<(), String> {
        (self.0)()
    }

    /// 转换为在调用线程上执行的任务：先加入进程的 MTA，接口对象属于该 MTA，不加入则无法调用。
    fn into_job(self) -> Job {
        Box::new(move || {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let result = self.run();
            if hr.is_ok() {
                unsafe { CoUninitialize() };
            }
            result
        })
    }
}

/// 将一次 UIA 模式调用包装为可交给其他线程执行的形式。
pub fn defer(call: impl FnOnce() -> ::windows::core::Result<()> + 'static) -> Deferred {
    Deferred(Box::new(move || call().map_err(|e| e.to_string())))
}

/// 在调用线程上发出一次 UIA 模式调用，并在有界时间内确定执行事实，见 `backend::dispatch_call`。
pub fn dispatch_call(watch: &dyn Watch, deferred: Deferred) -> Attempt {
    count_call();
    backend::dispatch_call(watch, deferred.into_job())
}

/// 调用前后都可读取的窗口事实。后台模式调用的证据全部由它提供。
///
/// 三项均为 Win32 调用：目标进程的 UI 线程正在运行模态对话框的嵌套消息循环时，
/// 这些调用照常应答，而任何 UIA 调用都会排在那次未返回的调用之后。
pub struct CallWatch {
    window: i64,
    pid: u32,
    was_enabled: bool,
    before: Vec<i64>,
}

impl CallWatch {
    pub fn before(window: i64) -> Self {
        let hwnd = HWND(window as *mut c_void);
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        Self {
            window,
            pid,
            was_enabled: unsafe { IsWindowEnabled(hwnd) }.as_bool(),
            before: process_windows(pid).into_iter().map(|w| w.window).collect(),
        }
    }

}

impl Watch for CallWatch {
    /// 调用未返回时交给调用方的事实：目标进程当前的顶层窗口，并标出调用之前不存在的窗口。
    ///
    /// 只携带前 `MAX_BLOCKING_WINDOWS` 个：该字段用于向调用方指示下一步观察的窗口，
    /// 不是窗口清单的第二个入口。
    fn blocking(&self) -> Vec<BlockingWindow> {
        process_windows(self.pid)
            .into_iter()
            .take(MAX_BLOCKING_WINDOWS)
            .map(|info| BlockingWindow {
                appeared: !self.before.contains(&info.window),
                info,
            })
            .collect()
    }

    /// 动作已生效的证据。没有证据时为 `None`。
    ///
    /// 「窗口被禁用」只在调用之前窗口处于启用状态时才有效：原本就禁用的窗口无法说明
    /// 本次调用产生了什么效果。
    fn evidence(&self) -> Option<ActionEvidence> {
        let hwnd = HWND(self.window as *mut c_void);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Some(ActionEvidence::WindowGone);
        }
        if self.was_enabled && !unsafe { IsWindowEnabled(hwnd) }.as_bool() {
            return Some(ActionEvidence::WindowDisabled);
        }
        if self.pid != 0
            && process_windows(self.pid)
                .iter()
                .any(|w| !self.before.contains(&w.window))
        {
            return Some(ActionEvidence::NewWindow);
        }
        None
    }
}

/// 按读取值判定生效的观察者。窗口动作使用它：激活、显示状态与窗口矩形各自读取对应的值。
///
/// 顶层窗口清单仍由内层的 `CallWatch` 提供：关闭窗口引出未保存提示时，调用方需要的
/// 是该提示框的 id。
pub struct StateWatch {
    base: CallWatch,
    kind: ActionEvidence,
    reached: Box<dyn Fn() -> bool>,
}

impl StateWatch {
    pub fn new(window: i64, kind: ActionEvidence, reached: Box<dyn Fn() -> bool>) -> Self {
        Self {
            base: CallWatch::before(window),
            kind,
            reached,
        }
    }
}

impl Watch for StateWatch {
    fn evidence(&self) -> Option<ActionEvidence> {
        (self.reached)().then_some(self.kind)
    }

    fn blocking(&self) -> Vec<BlockingWindow> {
        self.base.blocking()
    }
}

/// 进程当前的可见顶层窗口。标题为空的窗口也列出：模态对话框未必有标题。
///
/// 纯 Win32 枚举：`GetWindowTextW` 对无响应的跨进程窗口返回缓存标题而不阻塞，因此本
/// 函数在目标 UI 线程无响应时仍然按时返回。
fn process_windows(pid: u32) -> Vec<WindowInfo> {
    struct Sink {
        pid: u32,
        found: Vec<WindowInfo>,
    }
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let sink = &mut *(lparam.0 as *mut Sink);
        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != sink.pid {
            return TRUE;
        }
        let mut title = [0u16; 512];
        let written = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        let mut class_name = [0u16; 256];
        let class_written = GetClassNameW(hwnd, &mut class_name).max(0) as usize;
        sink.found.push(WindowInfo {
            window: hwnd.0 as i64,
            pid,
            title: String::from_utf16_lossy(&title[..written]),
            class_name: String::from_utf16_lossy(&class_name[..class_written]),
        });
        TRUE
    }
    if pid == 0 {
        return Vec::new();
    }
    let mut sink = Sink {
        pid,
        found: Vec::new(),
    };
    // SAFETY: 回调只在本次调用期间运行，lparam 指向本栈帧上的 sink。
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(std::ptr::addr_of_mut!(sink) as isize)) };
    sink.found
}

/// 将 UIA 接口交给另一条线程丢弃。
///
/// **目标应用的 UI 线程阻塞于一次未返回的调用时，释放其代理需要等待该线程应答**：在执行线程上
/// 丢弃会等满 UIA 连接超时，实测一个元素约两秒。本函数与动作调用共用同一份线程额度；
/// 额度用尽时该封装就地丢弃，回退为等待目标进程应答。
fn release_off_thread<T: 'static>(value: T) {
    let _ = backend::spawn_call(
        Deferred(Box::new(move || {
            drop(value);
            Ok(())
        }))
        .into_job(),
    );
}

/// 按动作取得模式、判定前置条件，然后发出调用。
///
/// 前置条件在此处判定而不是在调用之后：只读、越界、模式缺失都可证明未发出调用，
/// 归为 `not_dispatched`。
fn perform(
    window: i64,
    element: Option<&IUIAutomationElement>,
    action: &ActionSpec,
    aim: foreground::Aim,
    stop: &dyn Fn() -> bool,
) -> Attempt {
    if action.foreground_only() {
        return foreground::perform(window, element, action, aim, stop);
    }
    // 后台动作一律按控件执行，屏幕落点对后台动作没有意义；准入判定已拒绝这种组合。
    let Some(element) = element else {
        return Attempt::Refused("missing_target: 该动作只能按控件执行".to_owned());
    };
    if let ActionSpec::SetToggle { state } = action {
        return set_toggle(window, element, *state);
    }
    match plan(window, element, action) {
        Ok(deferred) => dispatch_call(&CallWatch::before(window), deferred),
        Err(reason) => Attempt::Refused(reason),
    }
}

/// 一次动作的准入判定与调用构造。`Err` 一律表示可证明未发出调用。
fn plan(
    window: i64,
    element: &IUIAutomationElement,
    action: &ActionSpec,
) -> Result<Deferred, String> {
    match action {
        ActionSpec::Invoke => {
            let pattern: IUIAutomationInvokePattern =
                current_pattern(window, element, UIA_InvokePatternId, "InvokePattern")?;
            Ok(defer(move || unsafe { pattern.Invoke() }))
        }
        ActionSpec::SetValue { value } => {
            let pattern: IUIAutomationValuePattern =
                current_pattern(window, element, UIA_ValuePatternId, "ValuePattern")?;
            count_call();
            if unsafe { pattern.CurrentIsReadOnly() }
                .map_err(uia("读取只读标志"))
                .map_err(|f| f.into_reason(window))?
                .as_bool()
            {
                return Err("read_only".to_owned());
            }
            let text = BSTR::from(value.as_str());
            Ok(defer(move || unsafe { pattern.SetValue(&text) }))
        }
        ActionSpec::SetRangeValue { value } => {
            let pattern: IUIAutomationRangeValuePattern =
                current_pattern(window, element, UIA_RangeValuePatternId, "RangeValuePattern")?;
            let read = |step: &'static str,
                        f: &dyn Fn() -> ::windows::core::Result<f64>|
             -> Result<f64, String> {
                count_call();
                f().map_err(uia(step)).map_err(|e| e.into_reason(window))
            };
            count_call();
            if unsafe { pattern.CurrentIsReadOnly() }
                .map_err(uia("读取数值只读标志"))
                .map_err(|f| f.into_reason(window))?
                .as_bool()
            {
                return Err("read_only".to_owned());
            }
            let min = read("读取数值下界", &|| unsafe { pattern.CurrentMinimum() })?;
            let max = read("读取数值上界", &|| unsafe { pattern.CurrentMaximum() })?;
            // 越界时不截断到边界：截断后的值看似合法，但不是调用方请求的值。
            // provider 无法提供有限边界时此处无法判定，由 provider 自身拒绝。
            if min.is_finite() && max.is_finite() && (*value < min || *value > max) {
                return Err(format!("out_of_range: {value}，允许范围为 {min} 到 {max}"));
            }
            let target = *value;
            Ok(defer(move || unsafe { pattern.SetValue(target) }))
        }
        ActionSpec::Select => {
            let pattern: IUIAutomationSelectionItemPattern = current_pattern(
                window,
                element,
                UIA_SelectionItemPatternId,
                "SelectionItemPattern",
            )?;
            Ok(defer(move || unsafe { pattern.Select() }))
        }
        ActionSpec::AddToSelection | ActionSpec::RemoveFromSelection => {
            let pattern: IUIAutomationSelectionItemPattern = current_pattern(
                window,
                element,
                UIA_SelectionItemPatternId,
                "SelectionItemPattern",
            )?;
            // 单选容器上无法增选或取消选中：调用会失败，而失败记为 unknown，
            // 调用方无法区分「容器本身不支持」与「选择可能已改变」。
            if !multi_select(window, &pattern)? {
                return Err("single_selection_only: 该容器一次只能选择一项 · 改用 select".to_owned());
            }
            let add = matches!(action, ActionSpec::AddToSelection);
            Ok(defer(move || unsafe {
                if add {
                    pattern.AddToSelection()
                } else {
                    pattern.RemoveFromSelection()
                }
            }))
        }
        ActionSpec::Expand | ActionSpec::Collapse => {
            let pattern: IUIAutomationExpandCollapsePattern = current_pattern(
                window,
                element,
                UIA_ExpandCollapsePatternId,
                "ExpandCollapsePattern",
            )?;
            count_call();
            let state = unsafe { pattern.CurrentExpandCollapseState() }
                .map_err(uia("读取展开状态"))
                .map_err(|f| f.into_reason(window))?;
            if state.0 == ExpandCollapseState_LeafNode.0 {
                return Err("leaf_node: 没有可展开的内容".to_owned());
            }
            let expand = matches!(action, ActionSpec::Expand);
            let already = if expand {
                state.0 == ExpandCollapseState_Expanded.0
            } else {
                state.0 == ExpandCollapseState_Collapsed.0
            };
            if already {
                return Err(format!(
                    "already_in_state: {}",
                    expand_name(state.0)
                ));
            }
            Ok(defer(move || unsafe {
                if expand {
                    pattern.Expand()
                } else {
                    pattern.Collapse()
                }
            }))
        }
        ActionSpec::Scroll { direction, step } => {
            let pattern: IUIAutomationScrollPattern =
                current_pattern(window, element, UIA_ScrollPatternId, "ScrollPattern")?;
            count_call();
            let axis = if matches!(
                direction,
                crate::protocol::ScrollDirection::Up | crate::protocol::ScrollDirection::Down
            ) {
                unsafe { pattern.CurrentVerticallyScrollable() }
            } else {
                unsafe { pattern.CurrentHorizontallyScrollable() }
            };
            if !axis
                .map_err(uia("读取可滚动标志"))
                .map_err(|f| f.into_reason(window))?
                .as_bool()
            {
                return Err("not_scrollable: 该方向无法滚动".to_owned());
            }
            let (horizontal, vertical) = scroll_amounts(*direction, *step);
            Ok(defer(move || unsafe {
                pattern.Scroll(ScrollAmount(horizontal), ScrollAmount(vertical))
            }))
        }
        ActionSpec::ScrollIntoView => {
            let pattern: IUIAutomationScrollItemPattern =
                current_pattern(window, element, UIA_ScrollItemPatternId, "ScrollItemPattern")?;
            Ok(defer(move || unsafe { pattern.ScrollIntoView() }))
        }
        ActionSpec::RealizeItem { name } => {
            let container: IUIAutomationItemContainerPattern = current_pattern(
                window,
                element,
                UIA_ItemContainerPatternId,
                "ItemContainerPattern",
            )?;
            count_call();
            let needle = VARIANT::from(name.as_str());
            let found = optional(unsafe {
                container.FindItemByProperty(None, UIA_NamePropertyId, &needle)
            })
            .map_err(uia("在容器中查找项"))
            .map_err(|f| f.into_reason(window))?;
            let Some(item) = found else {
                return Err(format!("item_not_found: {name}"));
            };
            let virtualized: IUIAutomationVirtualizedItemPattern =
                current_pattern(window, &item, UIA_VirtualizedItemPatternId, "VirtualizedItemPattern")?;
            Ok(defer(move || unsafe { virtualized.Realize() }))
        }
        ActionSpec::SelectText { start, length } => {
            let pattern: IUIAutomationTextPattern =
                current_pattern(window, element, UIA_TextPatternId, "TextPattern")?;
            count_call();
            let support = unsafe { pattern.SupportedTextSelection() }
                .map_err(uia("读取选区支持"))
                .map_err(|f| f.into_reason(window))?;
            if support.0 == SupportedTextSelection_None.0 {
                return Err("selection_unsupported: 该控件不支持选区".to_owned());
            }
            let range = sub_range(window, &pattern, *start, *length)?;
            Ok(defer(move || unsafe { range.Select() }))
        }
        // 以下各项由 `perform` 单独分派。逐条列出而不使用 `_` 通配：
        // 新增后台动作而遗漏接入时，必须在此处编译失败，而不是变为一条拒绝。
        ActionSpec::SetToggle { .. } => Err("not_planned: set_toggle 使用独立的执行路径".to_owned()),
        ActionSpec::Click { .. }
        | ActionSpec::Hover
        | ActionSpec::Drag { .. }
        | ActionSpec::Wheel { .. }
        | ActionSpec::TypeText { .. }
        | ActionSpec::PressKey { .. }
        | ActionSpec::Activate
        | ActionSpec::SetWindowState { .. }
        | ActionSpec::MoveWindow { .. }
        | ActionSpec::ResizeWindow { .. }
        | ActionSpec::CloseWindow => {
            Err("not_planned: 前台动作不经由后台动作路径".to_owned())
        }
    }
}

/// 判断该项所在的选择容器是否支持多选。一次跨进程调用，只在增选或取消选中时查询。
fn multi_select(
    window: i64,
    item: &IUIAutomationSelectionItemPattern,
) -> Result<bool, String> {
    count_call();
    let container = unsafe { item.CurrentSelectionContainer() }
        .map_err(uia("取选择容器"))
        .map_err(|f| f.into_reason(window))?;
    let pattern: IUIAutomationSelectionPattern =
        current_pattern(window, &container, UIA_SelectionPatternId, "SelectionPattern")?;
    count_call();
    Ok(unsafe { pattern.CurrentCanSelectMultiple() }
        .map_err(uia("读取多选约束"))
        .map_err(|f| f.into_reason(window))?
        .as_bool())
}

/// 把复选控件切换到目标状态。
///
/// TogglePattern 只有 `Toggle()`，每次调用沿控件自身的状态循环切换一步；到达目标状态只能按当前状态
/// 计算切换次数。循环长度按「两端之间是否有中间态」推断，**每切换一次都重读一次状态**：推断错误时
/// 由重读结果判定，不会停在其他状态上仍报告成功。
fn set_toggle(window: i64, element: &IUIAutomationElement, target: ToggleState) -> Attempt {
    let pattern: IUIAutomationTogglePattern =
        match current_pattern(window, element, UIA_TogglePatternId, "TogglePattern") {
            Ok(p) => p,
            Err(reason) => return Attempt::Refused(reason),
        };
    let watch = CallWatch::before(window);
    let attempt = toggle_to(window, &watch, &pattern, target);
    // 某一次调用未返回时，该模式对象同样不能在本线程丢弃，理由同 `act` 中的定位结果。
    if matches!(&attempt, Attempt::Called(outcome) if !outcome.returned) {
        release_off_thread(pattern);
    }
    attempt
}

/// 向目标状态逐次切换，每次切换之后重读状态。`pattern` 的释放由调用方负责。
fn toggle_to(
    window: i64,
    watch: &dyn Watch,
    pattern: &IUIAutomationTogglePattern,
    target: ToggleState,
) -> Attempt {
    let read = || -> Result<ToggleState, String> {
        count_call();
        let raw = unsafe { pattern.CurrentToggleState() }
            .map_err(uia("读取复选状态"))
            .map_err(|f| f.into_reason(window))?;
        toggle_from_uia(raw.0).ok_or_else(|| format!("unknown_toggle_state: {}", raw.0))
    };
    let current = match read() {
        Ok(s) => s,
        Err(reason) => return Attempt::Refused(reason),
    };
    if current == target {
        return Attempt::Refused(format!(
            "already_in_state: 该控件已处于 {}",
            target.as_str()
        ));
    }
    let tri_state = current == ToggleState::Indeterminate || target == ToggleState::Indeterminate;
    let Some(planned) = toggle_steps(current, target, tri_state) else {
        return Attempt::Refused(format!(
            "toggle_state_unsupported: 无法切换到 {}",
            target.as_str()
        ));
    };
    let mut last = current;
    for _ in 0..planned.min(MAX_TOGGLE_STEPS) {
        let toggle = pattern.clone();
        match dispatch_call(watch, defer(move || unsafe { toggle.Toggle() })) {
            Attempt::Called(outcome) if outcome.dispatch == Dispatch::Submitted && outcome.returned => {}
            other => return other,
        }
        match read() {
            Ok(state) => {
                last = state;
                if state == target {
                    return Attempt::Called(Outcome::returned(Dispatch::Submitted, None));
                }
            }
            // 无法读取状态时不再切换：继续切换将无法确定最终状态。
            Err(reason) => {
                return Attempt::Called(Outcome::returned(
                    Dispatch::Unknown,
                    Some(format!("按下后无法读取状态：{reason}")),
                ))
            }
        }
    }
    Attempt::Called(Outcome::returned(
        Dispatch::Unknown,
        Some(format!(
            "toggle_target_unreached: 切换 {planned} 次后为 {}，目标为 {}",
            last.as_str(),
            target.as_str()
        )),
    ))
}

// ── 文本 ──

/// 一次选区起点查询最多读取的码元数。起点超过该值时按该值记录。
const MAX_OFFSET_PROBE: i32 = 100_000;

/// 读取文档文本与全部选区。
fn read_document(
    window: i64,
    reference: &str,
    pattern: &IUIAutomationTextPattern,
    max_chars: u32,
) -> Result<Observation, Failure> {
    count_call();
    let document = unsafe { pattern.DocumentRange() }.map_err(uia("取文档范围"))?;
    count_call();
    // 多请求一个码元：返回的文本长于上限即说明后面还有内容。
    let raw = unsafe { document.GetText(i32::try_from(max_chars).unwrap_or(i32::MAX).saturating_add(1)) }
        .map_err(uia("读取文档文本"))?;
    let (text, truncated) = clip_utf16(&raw, max_chars);
    count_call();
    let support = unsafe { pattern.SupportedTextSelection() }.map_err(uia("读取选区支持"))?;
    let mut selection = Vec::new();
    if support.0 != SupportedTextSelection_None.0 {
        count_call();
        if let Some(ranges) =
            optional(unsafe { pattern.GetSelection() }).map_err(uia("读取选区"))?
        {
            let length = unsafe { ranges.Length() }.map_err(uia("读取选区条数"))?;
            for index in 0..length {
                let range = unsafe { ranges.GetElement(index) }.map_err(uia("取选区"))?;
                selection.push(selected_range(&document, &range, max_chars)?);
            }
        }
    }
    Ok(Observation::Text(Text {
        window,
        captured_at: now_ms(),
        scope: reference.to_owned(),
        text,
        truncated,
        selection_support: selection_support_name(support),
        selection,
    }))
}

/// 一段选区的起点与文本。起点按 UTF-16 码元计。
fn selected_range(
    document: &IUIAutomationTextRange,
    range: &IUIAutomationTextRange,
    max_chars: u32,
) -> Result<TextSelection, Failure> {
    count_call();
    let prefix = unsafe { document.Clone() }.map_err(uia("复制文档范围"))?;
    unsafe { prefix.MoveEndpointByRange(TextPatternRangeEndpoint_End, range, TextPatternRangeEndpoint_Start) }
        .map_err(uia("对齐选区起点"))?;
    count_call();
    let head = unsafe { prefix.GetText(MAX_OFFSET_PROBE) }.map_err(uia("读取选区之前的文本"))?;
    count_call();
    let body = unsafe { range.GetText(i32::try_from(max_chars).unwrap_or(i32::MAX).saturating_add(1)) }
        .map_err(uia("读取选区文本"))?;
    let (text, truncated) = clip_utf16(&body, max_chars);
    Ok(TextSelection {
        start: u32::try_from(head.len()).unwrap_or(u32::MAX),
        text,
        truncated,
    })
}

/// 文档中从 `start` 开始、长度为 `length` 个码元的范围。
fn sub_range(
    window: i64,
    pattern: &IUIAutomationTextPattern,
    start: u32,
    length: u32,
) -> Result<IUIAutomationTextRange, String> {
    let step = |value: u32| i32::try_from(value).unwrap_or(i32::MAX);
    let wrap = |f: Failure| f.into_reason(window);
    count_call();
    let range = unsafe { pattern.DocumentRange() }
        .map_err(uia("取文档范围"))
        .map_err(wrap)?;
    count_call();
    unsafe {
        range.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, step(start))
    }
    .map_err(uia("移动选区起点"))
    .map_err(wrap)?;
    // 先将终点收拢到起点，再向后移动：不收拢时终点仍位于文档末尾，得到的是从起点到文档末尾的全部内容。
    unsafe {
        range.MoveEndpointByRange(
            TextPatternRangeEndpoint_End,
            &range,
            TextPatternRangeEndpoint_Start,
        )
    }
    .map_err(uia("收拢选区终点"))
    .map_err(wrap)?;
    unsafe {
        range.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, step(length))
    }
    .map_err(uia("移动选区终点"))
    .map_err(wrap)?;
    Ok(range)
}

/// 按 UTF-16 码元截断。截断点落在代理对中间时，该字符替换为替换字符。
fn clip_utf16(raw: &BSTR, max_chars: u32) -> (String, bool) {
    let wide: &[u16] = raw;
    let limit = max_chars as usize;
    if wide.len() <= limit {
        return (String::from_utf16_lossy(wide), false);
    }
    (String::from_utf16_lossy(&wide[..limit]), true)
}

fn selection_support_name(support: SupportedTextSelection) -> &'static str {
    if support.0 == SupportedTextSelection_Single.0 {
        "single"
    } else if support.0 == SupportedTextSelection_Multiple.0 {
        "multiple"
    } else {
        "none"
    }
}

/// UIA 控件类型 → 协议角色。UIA 的控件类型常量从 50000 起连续编号，按偏移量取值。
const CONTROL_TYPE_ROLES: [Role; 41] = [
    Role::Button,
    Role::Calendar,
    Role::CheckBox,
    Role::ComboBox,
    Role::Edit,
    Role::Hyperlink,
    Role::Image,
    Role::ListItem,
    Role::List,
    Role::Menu,
    Role::MenuBar,
    Role::MenuItem,
    Role::ProgressBar,
    Role::RadioButton,
    Role::ScrollBar,
    Role::Slider,
    Role::Spinner,
    Role::StatusBar,
    Role::Tab,
    Role::TabItem,
    Role::Text,
    Role::ToolBar,
    Role::ToolTip,
    Role::Tree,
    Role::TreeItem,
    Role::Custom,
    Role::Group,
    Role::Thumb,
    Role::DataGrid,
    Role::DataItem,
    Role::Document,
    Role::SplitButton,
    Role::Window,
    Role::Pane,
    Role::Header,
    Role::HeaderItem,
    Role::Table,
    Role::TitleBar,
    Role::Separator,
    Role::SemanticZoom,
    Role::AppBar,
];

/// 将控件类型换算为协议角色名。词表中没有对应角色的类型返回 `control_<ControlType>`，
/// 不推测相近的角色。
fn role_name(control_type: i32) -> String {
    usize::try_from(control_type - 50_000)
        .ok()
        .and_then(|offset| CONTROL_TYPE_ROLES.get(offset))
        .map_or_else(
            || format!("control_{control_type}"),
            |role| role.as_str().to_owned(),
        )
}

/// UIA 的 ToggleState 常量顺序：0 = Off，1 = On，2 = Indeterminate。
fn toggle_from_uia(raw: i32) -> Option<ToggleState> {
    match raw {
        0 => Some(ToggleState::Off),
        1 => Some(ToggleState::On),
        2 => Some(ToggleState::Indeterminate),
        _ => None,
    }
}

/// UIA `ScrollAmount` 常量。
///
/// 顺序是 LargeDecrement(0) / SmallDecrement(1) / NoAmount(2) / LargeIncrement(3) /
/// SmallIncrement(4)。**不要按枚举名的字母序重排**，调用按该数值传递。
const SCROLL_NO_AMOUNT: i32 = 2;

/// 将方向与步长转换为 `Scroll(horizontal, vertical)` 的两个实参。
///
/// 不滚动的轴必须是 `NoAmount`：传入其他值会使本次滚动同时移动两个轴。
fn scroll_amounts(direction: ScrollDirection, step: ScrollStep) -> (i32, i32) {
    let amount = match (direction, step) {
        (ScrollDirection::Up | ScrollDirection::Left, ScrollStep::Page) => 0,
        (ScrollDirection::Up | ScrollDirection::Left, ScrollStep::Line) => 1,
        (ScrollDirection::Down | ScrollDirection::Right, ScrollStep::Page) => 3,
        (ScrollDirection::Down | ScrollDirection::Right, ScrollStep::Line) => 4,
    };
    if matches!(direction, ScrollDirection::Up | ScrollDirection::Down) {
        (SCROLL_NO_AMOUNT, amount)
    } else {
        (amount, SCROLL_NO_AMOUNT)
    }
}

/// 最多列出的选中项名称数。
///
/// 名称逐项经跨进程调用读取，上限用于限制该开销；选中项更多时应读取列表本身，而不是一份长名单。
const MAX_SELECTED_NAMES: usize = 16;

/// 本次读取的选中项名称数。
fn selected_name_budget(total: usize) -> usize {
    total.min(MAX_SELECTED_NAMES)
}

/// `total` 是容器报告的选中项数，`names` 只包含已读取到名称的项。
///
/// 两者不等即名单不完整：达到 `MAX_SELECTED_NAMES`，或某一项在读取名称之前消失。
/// 两种情形记入同一字段，调用方只需要知道名单不完整。
fn selection_state(multiple: bool, required: bool, names: Vec<String>, total: usize) -> SelectionState {
    SelectionState {
        multiple,
        required,
        truncated: names.len() < total,
        selected: names,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_state_maps_to_the_uia_constants() {
        assert_eq!(toggle_from_uia(0), Some(ToggleState::Off));
        assert_eq!(toggle_from_uia(1), Some(ToggleState::On));
        assert_eq!(toggle_from_uia(2), Some(ToggleState::Indeterminate));
        assert_eq!(toggle_from_uia(3), None);
        assert_eq!(ToggleState::Indeterminate.as_str(), "indeterminate");
    }

    /// 不滚动的轴必须是 NoAmount：传入其他值会使一次滚动同时移动两个轴。
    #[test]
    fn scroll_amounts_move_one_axis_at_a_time() {
        use ScrollDirection::{Down, Left, Right, Up};
        use ScrollStep::{Line, Page};
        assert_eq!(scroll_amounts(Down, Line), (SCROLL_NO_AMOUNT, 4));
        assert_eq!(scroll_amounts(Down, Page), (SCROLL_NO_AMOUNT, 3));
        assert_eq!(scroll_amounts(Up, Line), (SCROLL_NO_AMOUNT, 1));
        assert_eq!(scroll_amounts(Up, Page), (SCROLL_NO_AMOUNT, 0));
        assert_eq!(scroll_amounts(Right, Line), (4, SCROLL_NO_AMOUNT));
        assert_eq!(scroll_amounts(Left, Page), (0, SCROLL_NO_AMOUNT));
    }

    /// 读取名称时某一项已消失：该项没有名称，名单因此不完整。
    #[test]
    fn a_selected_item_that_vanished_leaves_the_list_incomplete() {
        let state = selection_state(true, false, vec!["甲".to_owned()], 2);
        assert!(state.truncated);
        assert_eq!(state.selected, vec!["甲".to_owned()]);
    }

    /// 选中项多于上限时只读取前若干项，并标记名单不完整。
    #[test]
    fn a_long_selection_is_cut_at_the_cap_and_says_so() {
        let total = MAX_SELECTED_NAMES + 7;
        assert_eq!(selected_name_budget(total), MAX_SELECTED_NAMES);
        assert_eq!(selected_name_budget(3), 3);
        let names: Vec<String> = (0..selected_name_budget(total))
            .map(|i| format!("行-{i}"))
            .collect();
        let state = selection_state(true, false, names, total);
        assert_eq!(state.selected.len(), MAX_SELECTED_NAMES);
        assert!(state.truncated);
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["truncated"], true);
    }


    /// Windows Terminal 的格式：只有一段，各行按窗口宽度补齐空格，末尾有多个空行。
    #[test]
    fn visible_text_trims_padding_and_blank_edges() {
        let screen = "\r\n⏺ Bash(bun run task.ts)      \r\n  ⎿  Running…    \r\n\r\n>        \r\n        \r\n     ";
        assert_eq!(
            visible_lines(&[screen.to_owned()], "Windows PowerShell").as_deref(),
            Some("⏺ Bash(bun run task.ts)\n  ⎿  Running…\n\n>")
        );
    }

    /// conhost 的格式：每行一段，段内不带换行。拼接时不加换行会把两行合并为一行。
    #[test]
    fn visible_text_puts_each_range_on_its_own_line() {
        let rows = ["probe-line-1   ", "probe-line-2", "PS C:\\> "].map(str::to_owned);
        assert_eq!(
            visible_lines(&rows, "Text Area").as_deref(),
            Some("probe-line-1\nprobe-line-2\nPS C:\\>")
        );
    }

    /// 名称即正文的文字控件（网页文字、标签页标题）不重复返回正文，空白屏幕也不返回。
    #[test]
    fn visible_text_is_absent_when_it_repeats_the_name_or_is_blank() {
        assert_eq!(visible_lines(&["上下文膨胀与平衡".to_owned()], "上下文膨胀与平衡"), None);
        assert_eq!(visible_lines(&["   \r\n  ".to_owned()], "Windows PowerShell"), None);
        assert_eq!(visible_lines(&[], "Windows PowerShell"), None);
    }

    #[test]
    fn a_hung_provider_is_not_reported_as_a_lost_target() {
        // 窗口仍存在而 provider 不应答：调用方应重试或放弃该步骤，不应转而重新发现目标。
        assert_eq!(
            failure_code(TIMEOUT_HRESULT, true),
            Some("provider_timeout")
        );
        // 窗口句柄已失效时超时码仍然优先：本次失败的成因是未等到应答。
        assert_eq!(
            failure_code(TIMEOUT_HRESULT, false),
            Some("provider_timeout")
        );
        assert_eq!(
            failure_code(ELEMENT_GONE_HRESULT, false),
            Some("target_lost")
        );
        // 窗口仍存在而错误码无法判定归属：保留 provider 原文，不强行指定原因码。
        assert_eq!(failure_code(ELEMENT_GONE_HRESULT, true), None);
        assert_eq!(failure_code(0, true), None);
    }

    #[test]
    fn failure_classification_drives_the_walk_decisions() {
        let timeout = Failure::Uia {
            code: TIMEOUT_HRESULT,
            text: "读取名称失败".to_owned(),
        };
        assert!(timeout.is_timeout() && !timeout.is_element_gone());
        let gone = Failure::Uia {
            code: ELEMENT_GONE_HRESULT,
            text: "读取名称失败".to_owned(),
        };
        assert!(gone.is_element_gone() && !gone.is_timeout());
        let refused = Failure::Refused("bad_ref: w".to_owned());
        assert!(!refused.is_timeout() && !refused.is_element_gone());
    }

    /// 路径不匹配即目标已不在该位置：等待的「控件消失」条件据此判定。
    #[test]
    fn a_stale_ref_counts_as_a_missing_element() {
        let stale = Failure::Refused(format!("{REF_STALE}: 第 0 层没有下标 3 的子节点"));
        assert!(stale.is_element_gone());
    }

    /// 回执必须写明核对的身份种类，弱身份还须说明其不可靠的原因。
    #[test]
    fn the_refusal_names_the_kind_of_identity_it_compared() {
        assert_eq!(
            describe(&Identity::Stable("42.7".to_owned())),
            "RuntimeId 42.7"
        );
        assert_eq!(
            describe(&Identity::Attributes("abc".to_owned())),
            "属性指纹 abc"
        );
    }

    #[test]
    fn role_name_maps_known_ids_and_keeps_unknown_ones_visible() {
        assert_eq!(role_name(50_000), "button");
        assert_eq!(role_name(50_004), "edit");
        assert_eq!(role_name(50_040), "app_bar");
        assert_eq!(role_name(50_041), "control_50041");
        assert_eq!(role_name(0), "control_0");
    }

    #[test]
    fn expand_state_names_cover_the_four_uia_constants() {
        assert_eq!(expand_name(ExpandCollapseState_Collapsed.0), "collapsed");
        assert_eq!(expand_name(ExpandCollapseState_Expanded.0), "expanded");
        assert_eq!(
            expand_name(ExpandCollapseState_PartiallyExpanded.0),
            "partial"
        );
        assert_eq!(expand_name(ExpandCollapseState_LeafNode.0), "leaf");
        assert_eq!(expand_name(9), "unknown");
    }

    #[test]
    fn selection_support_names_follow_the_uia_constants() {
        assert_eq!(selection_support_name(SupportedTextSelection_None), "none");
        assert_eq!(
            selection_support_name(SupportedTextSelection_Single),
            "single"
        );
        assert_eq!(
            selection_support_name(SupportedTextSelection_Multiple),
            "multiple"
        );
    }

    /// 截断按 UTF-16 码元计算：每个汉字占一个码元，emoji 占一个代理对。
    #[test]
    fn text_is_clipped_by_utf16_units_and_marked() {
        let text = BSTR::from("中文内容");
        assert_eq!(clip_utf16(&text, 10), ("中文内容".to_owned(), false));
        assert_eq!(clip_utf16(&text, 4), ("中文内容".to_owned(), false));
        assert_eq!(clip_utf16(&text, 2), ("中文".to_owned(), true));
        assert_eq!(clip_utf16(&BSTR::new(), 4), (String::new(), false));
        // 截断点落在代理对中间时，该字符替换为替换字符，仍标记为截断。
        let pair = BSTR::from("a🙂b");
        assert_eq!(clip_utf16(&pair, 2), ("a\u{fffd}".to_owned(), true));
    }
}
