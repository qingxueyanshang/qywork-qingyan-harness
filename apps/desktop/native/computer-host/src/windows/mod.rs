//! Windows 后端（`Uia`）：UI Automation 负责窗口发现、控件树读取、后台语义动作与有界等待，
//! 前台输入在 `foreground`，图像采集在 `capture`。
//!
//! 五条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。
//! 2. 窗口发现走 Win32 枚举而不是 UIA 根元素：`GetWindowTextW` 对无响应的跨进程窗口
//!    返回缓存标题而不阻塞，UIA 根元素的子节点枚举要等每个 provider 应答。
//! 3. `ref` 是不透明串，含从窗口元素出发的子节点下标路径与 RuntimeId。动作前按路径重新
//!    定位并核对 RuntimeId，不允许拿旧编号操作当前树里换过位置的另一个节点。
//! 4. UIA 全是跨进程调用，上界只能靠 IUIAutomation2 的连接与事务超时；本模块不另起线程
//!    等待，挂起的 provider 由这两个设置收尾。
//! 5. 子节点枚举只有一处：带缓存请求的 `BuildUpdatedCache` + `GetCachedChildren`，筛选条件
//!    固定用 `ControlViewCondition`。读树与动作前重定位共用它，下标才对得上；换成
//!    TreeWalker 会多出第二套顺序，同一个 `ref` 在两处指不同节点。

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

use ::windows::core::{Interface, BOOL, BSTR};
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
    EnumWindows, GetClassNameW, GetWindow, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_HWNDPREV, WS_EX_LAYERED, WS_EX_TRANSPARENT,
};

use crate::backend::{
    self, wait_loop, ActRequest, Attempt, Backend, CaptureRequest, Job, Outcome, Probe,
    WaitRequest, Watch,
};
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::protocol::{
    now_ms, scroll_amounts, selected_name_budget, toggle_steps, ActionEvidence, ActionSpec,
    Bounds, range_state, BlockingWindow, Completeness, Dispatch, DragTarget, Image, Node,
    NodeAction, Observation, Role, ScrollState, Select, SelectionState, Text, TextSelection,
    ToggleState, Tree, Wait, WaitUntil, WindowInfo, NOT_DISPATCHED, REF_STALE, TARGET_BLOCKED,
};
use crate::tree::{
    decode_ref, encode_ref, fingerprint, first_sighting, flatten, matches_target, settle,
    Collected, Identity,
};
use capture::Capturer;

/// 跨进程 UIA 调用计数。只在 debug 构建里存在，用于读树成本的对照测量。
#[cfg(debug_assertions)]
static UIA_CALLS: AtomicU64 = AtomicU64::new(0);

/// 记一次跨进程 UIA 调用。release 构建里函数体为空，优化后不产生指令。
#[inline(always)]
fn count_call() {
    #[cfg(debug_assertions)]
    UIA_CALLS.fetch_add(1, Ordering::Relaxed);
}

/// 取出并清零调用计数。release 构建里恒为 0。
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

/// 把一次读取的节点数、跨进程调用数、采集次数与耗时写到 stderr。只在 debug 构建里输出。
///
/// 这是读树成本的唯一测量口径：计数器与这一行一起加减，改其中一处会让对照数据对不上。
/// `captures` 在结构化路径上恒为 0——读树、动作与等待都走不到采集代码。
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

/// 失败的两种形状：UIA 调用返回的错误，以及 worker 自己判定的拒绝。
///
/// UIA 那一支保留 HRESULT，因为原因码要按它分类；拒绝那一支已经带着自己的原因码。
enum Failure {
    Uia { code: i32, text: String },
    Refused(String),
}

/// 把一次 UIA 调用的错误包成 `Failure`，`step` 是出错的那一步。
fn uia(step: &'static str) -> impl Fn(::windows::core::Error) -> Failure {
    move |e| Failure::Uia {
        code: e.code().0,
        text: format!("{step}失败：{e}"),
    }
}

/// 同 `uia`，用在步骤名要按模式名拼出来的地方。
fn uia_owned(step: String) -> impl FnOnce(::windows::core::Error) -> Failure {
    move |e| Failure::Uia {
        code: e.code().0,
        text: format!("{step}失败：{e}"),
    }
}

impl Failure {
    /// 转成回执原文。原因码要看窗口是否还在，所以只能在拿得到窗口句柄的地方调用。
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
/// 超时与目标失效必须分开：provider 挂起时窗口还在，调用方该重试或放弃这一步；报成
/// `target_lost` 会让它转去重新发现目标。窗口是否还在是 Win32 事实，由调用方查好传进来。
/// 判不出的返回 `None`，回执保留 provider 原文。
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

/// 定位结果：目标元素本身、它从窗口元素出发的下标路径，以及它所在的那个 OS 窗口。
struct Located {
    element: IUIAutomationElement,
    path: Vec<usize>,
    /// 定位路径上最后一个带窗口句柄的节点（含目标自己）的句柄。
    ///
    /// 目标窗口弹出的下拉框、菜单是它所拥有的另一个顶层窗口，UIA 把它排在目标窗口的树里；
    /// 指针落点核对靠这一格认出落点打在控件自己所在的那个窗口上。
    host: i64,
}

/// 本进程的 DPI 感知模式是不是 per-monitor v2，从 OS 读回来的实际值。第一次调用时设定。
///
/// **必须在任何窗口矩形或 DPI 查询之前设**：设晚了，系统已经按虚拟化的坐标回答过问题，
/// 而那些答案不会重来。执行线程最先构造后端，`Uia::new` 第一步就调它。
fn per_monitor_v2() -> bool {
    static SET: OnceLock<bool> = OnceLock::new();
    *SET.get_or_init(|| {
        let set = capture::set_per_monitor_v2();
        // 宿主把 worker 的 stderr 转进应用日志：图像几何对不上时，这一行说得出是哪一档
        // DPI 感知、有几台显示器、虚拟桌面的原点在哪。
        eprintln!("dpi per_monitor_v2={set} displays {}", capture::monitor_report());
        set
    })
}

pub struct Uia {
    automation: IUIAutomation,
    options: IUIAutomation2,
    /// 子节点枚举的筛选条件。读树与重定位共用，下标因此对得上。
    control_view: IUIAutomationCondition,
    /// 重定位用的缓存请求。
    ///
    /// **与读树那一份要的属性完全相同。** 定位沿途的节点会被当成完整节点读（等待的判定
    /// 就这么读目标控件），少缓存一项就会在那里撞上「所需属性不在 CacheRequest 中」。
    nav_cache: IUIAutomationCacheRequest,
    /// 这个 worker 读过控件表的窗口，按句柄与进程号记，句柄被复用时不会认错。
    read_before: Mutex<HashSet<(i64, u32)>>,
    /// 图像采集器，第一次采集时才建。
    ///
    /// 不要改成在 `new` 里建：等待线程每条请求各建一个后端，它们用不到采集，
    /// 每次都建一份 D3D 设备与 WIC 工厂只增加开销。建不起来只影响采集请求，
    /// 结构化观察与动作不碰它。
    capturer: OnceCell<Result<Capturer, String>>,
}

impl Backend for Uia {
    const NAME: &'static str = "windows-uia";

    /// 在调用线程上初始化 COM 与 UIA。必须在执行线程上构造：COM 单元属于线程。
    fn new() -> Result<Self, String> {
        // 进程的 DPI 感知模式先于一切窗口查询设定，见 `per_monitor_v2`。
        per_monitor_v2();
        // UIA 客户端用 MTA：STA 下客户端要靠自己的消息泵驱动跨进程回调，阻塞等待会死锁。
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() {
            return Err(format!("CoInitializeEx 失败：{hr:?}"));
        }
        // CUIAutomation8 才提供 IUIAutomation2 及以上；CUIAutomation 只到 IUIAutomation。
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| format!("创建 UIAutomation 失败：{e}"))?;
        let options: IUIAutomation2 = automation
            .cast()
            .map_err(|e| format!("取 IUIAutomation2 失败：{e}"))?;
        // 关掉自动设焦点：默认值 TRUE 会让部分模式调用把焦点移到目标控件上。
        unsafe { options.SetAutoSetFocus(false) }
            .map_err(|e| format!("关闭 AutoSetFocus 失败：{e}"))?;
        let control_view = unsafe { automation.ControlViewCondition() }
            .map_err(|e| format!("取 ControlViewCondition 失败：{e}"))?;
        // 重定位要的属性与读树那一份完全相同：定位沿途的节点会被当成完整节点读
        // （等待的判定就这么读目标控件），少一项就会在那里撞上「所需属性不在
        // CacheRequest 中」。
        let nav_cache = build_cache(
            &automation,
            &control_view,
            Fields {
                value: true,
                state: true,
                // 定位路径上不取前台属性：焦点与窗口模式在派发那一刻实时读，
                // 读的是动作发出前的真值而不是定位时的快照。
                foreground: false,
            },
        )
        .map_err(|e| format!("建重定位缓存请求失败：{e}"))?;
        // 重定位另记窗口句柄：`locate` 沿路径取目标所在的 OS 窗口，指针落点核对要用它。
        // 读树不需要，不加进 `build_cache`。
        unsafe { nav_cache.AddProperty(UIA_NativeWindowHandlePropertyId) }
            .map_err(|e| format!("重定位缓存请求加窗口句柄失败：{e}"))?;
        Ok(Self {
            automation,
            options,
            control_view,
            nav_cache,
            read_before: Mutex::new(HashSet::new()),
            capturer: OnceCell::new(),
        })
    }

    /// 设定 UIA 调用上界并把实际生效值读回来。
    ///
    /// 这两项是整个 IUIAutomation 实例的设置，无法逐调用指定，因此由宿主在握手时给定：
    /// worker 不自带默认值，避免上界有两个出处。
    fn set_timeouts(
        &self,
        connection_ms: u32,
        transaction_ms: u32,
    ) -> Result<(u32, u32), String> {
        unsafe {
            self.options
                .SetConnectionTimeout(connection_ms)
                .map_err(|e| format!("设连接超时失败：{e}"))?;
            self.options
                .SetTransactionTimeout(transaction_ms)
                .map_err(|e| format!("设事务超时失败：{e}"))?;
            let connection = self
                .options
                .ConnectionTimeout()
                .map_err(|e| format!("读连接超时失败：{e}"))?;
            let transaction = self
                .options
                .TransactionTimeout()
                .map_err(|e| format!("读事务超时失败：{e}"))?;
            Ok((connection, transaction))
        }
    }

    /// 读一个窗口的控件表。`select.root` 给了就从那棵子树读起。
    ///
    /// 这个 worker 第一次读一个窗口时读到控件数不再变化为止：Chromium 系应用在第一次收到
    /// UIA 请求时才开启无障碍树，约 0.3 s 后建好，第一次读到的只有浏览器外框、没有网页内容，
    /// 且不算截断。之后再读同一个窗口只读一次。
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

    /// 执行一个动作并按调用方当前观察的范围整份重读。
    ///
    /// 十三种动作共用这一条路径：定位、准入判定、可放弃等待的调用与动作后重读各只有
    /// 一处实现。按动作分成多条路径会让这四件事各有一份拷贝。
    ///
    /// **没有派发就不重读**：那一份观察会被调用方读成动作已经发生。
    ///
    /// 不要改回只读目标所在的子树：调用方拿到的重读就是它的当前观察，只读一段的话，
    /// 范围外的控件要么缺席，要么由调用方把旧节点拼回来，而旧节点的状态与可用动作
    /// 停在动作之前。
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
        // 按图定位的落点先核对窗口几何代际：窗口在采图与派发之间移动过的话，
        // 那个坐标指的已经不是同一块界面。
        if let Some(expected) = expect_generation {
            if let Err(reason) = foreground::check_generation(window, expected) {
                return (Attempt::Refused(reason), Err(NOT_DISPATCHED.to_owned()));
            }
        }
        let located = match reference.map(|r| self.locate(window, r)) {
            None => None,
            Some(Ok(l)) => Some(l),
            Some(Err(f)) => {
                return (
                    Attempt::Refused(f.into_reason(window)),
                    Err(NOT_DISPATCHED.to_owned()),
                )
            }
        };
        let aim = match self.aim(window, located.as_ref(), point, action) {
            Ok(aim) => aim,
            Err(reason) => return (Attempt::Refused(reason), Err(NOT_DISPATCHED.to_owned())),
        };
        let element = located.as_ref().map(|l| &l.element);
        match perform(window, element, action, aim, stop) {
            Attempt::Refused(reason) => (Attempt::Refused(reason), Err(NOT_DISPATCHED.to_owned())),
            // 调用还没返回：目标应用的 UI 线程卡在里面，这一次重读必然等满时间预算再超时。
            // 换成一份不进 UIA 的事实——目标进程此刻的顶层窗口，调用方据此观察新出现的
            // 那一个。
            Attempt::Called(outcome) if !outcome.returned => {
                // 定位到的元素同样不能在这条线程上丢弃：释放代理也要等目标进程应答，
                // 就地丢会等满 UIA 连接超时。
                if let Some(located) = located {
                    release_off_thread(located);
                }
                (
                    Attempt::Called(outcome),
                    Err(TARGET_BLOCKED.to_owned()),
                )
            }
            called => {
                let scope = Select {
                    root: root.map(str::to_owned),
                    ..Select::default()
                };
                (called, self.read_tree(window, &scope, bounds, fg))
            }
        }
    }

    /// 清一次到目标 provider 的连接。
    ///
    /// 上一次动作调用还挂在目标应用里时，**这个 provider 上的下一次 UIA 调用必定等到
    /// 连接超时才回，再下一次才正常**（实测 2010 ms 失败、随后成功）。这一次调用就是
    /// 那个代价，由 worker 在回执发出之后自己付：留给调用方付的话，它下一次观察拿到的
    /// 是一次不该有的超时失败。
    fn drain_provider(&self, window: i64) {
        let _ = self.window_element(window, &self.nav_cache);
    }

    /// 读一个控件的文档文本与选区。只读，不改变状态，也不设焦点。
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

    /// 等一个后置条件成立。判定、轮询与到期都在这里，调用方只拿终态。
    ///
    /// `stop` 每轮问一次：执行者撤销这条请求时它变真，等待立即以 `cancelled` 收尾。
    fn wait(&self, req: &WaitRequest<'_>, stop: &dyn Fn() -> bool) -> Result<Observation, String> {
        let (found, reason, probe) = match wait_loop(req, stop, || self.probe(req)) {
            Ok(v) => v,
            Err(f) => return Err(f.into_reason(req.window)),
        };
        // 只计最后这一次状态读取。轮询各轮自己已经各打过一行，把整段等待算进来会重复计。
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

    /// per-monitor v2 没设上时窗口矩形被系统虚拟化过，采到的图与控件包围盒不在同一套坐标上。
    /// 交一张对不上号的图比不交更糟，所以这里直接拒。
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
    /// 读树用的缓存请求。取不取值与取不取状态细节各自可选，可用动作一直判得出来。
    fn walk_cache(&self, fields: Fields) -> Result<IUIAutomationCacheRequest, Failure> {
        build_cache(&self.automation, &self.control_view, fields)
            .map_err(uia("建读树缓存请求"))
    }

    /// 取窗口元素并把它与它的子节点一次缓存回来。一次跨进程调用。
    fn window_element(
        &self,
        window: i64,
        cache: &IUIAutomationCacheRequest,
    ) -> Result<IUIAutomationElement, Failure> {
        let hwnd = HWND(window as *mut c_void);
        count_call();
        unsafe { self.automation.ElementFromHandleBuildCache(hwnd, cache) }
            .map_err(uia("窗口取 UIA 元素"))
    }

    /// 把一个元素与它的子节点刷成一份新缓存。一次跨进程调用。
    fn expand(
        &self,
        element: &IUIAutomationElement,
        cache: &IUIAutomationCacheRequest,
    ) -> Result<IUIAutomationElement, Failure> {
        count_call();
        unsafe { element.BuildUpdatedCache(cache) }.map_err(uia("刷新缓存"))
    }

    /// 按 `ref` 里的下标路径重新定位，并核对身份。
    ///
    /// 每层一次跨进程调用：取这一层的缓存子节点，按下标挑一个。子节点顺序与读树同一份
    /// 条件，下标因此指同一个节点。
    ///
    /// 身份核对分两种，按 `ref` 里记的那一种判：有 RuntimeId 的比 RuntimeId，没有的比
    /// 角色、名称与稳定标识的指纹。**两种不能互相顶替**——一个原本没有 RuntimeId 的位置
    /// 现在有了，说明那里已经不是同一个控件。
    ///
    /// 这个后端交出的 `ref` 不带核对串；带了的不是它交出的，拒绝而不是忽略那一格。
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
                "{REF_STALE}: 该位置现在是 {}，ref 里记的是 {}{}",
                describe(&actual),
                describe(&expected),
                if expected.is_weak() {
                    "；这个控件没有 RuntimeId，身份只能按角色、名称与稳定标识核对，界面重排后旧引用不可靠，请重新观察"
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

    /// 从一个已经带缓存的元素开始遍历。
    ///
    /// **窗口可用状态只认窗口元素自己的那一格。** Win32 的模态只禁用顶层窗口，子控件的
    /// HWND 仍然是启用的，拿子树根的状态顶替会把「模态窗口挡着」读成一切正常。
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
        // 根节点读不到就整体失败：没有根就没有这次观察，不存在可以跳过它继续的走法。
        walk.node(root, &mut path, 0, None)?;
        let (nodes, visited, truncated_by) = walk.finish();
        // 根节点是第一个被读的，表的第一项一定是它。
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

    /// 指针动作的落点与拖拽终点。非指针动作两项都缺席。
    ///
    /// 落点两种来源：调用方给的屏幕坐标，或控件此刻的包围盒中心。**包围盒读的是这一次
    /// 重新定位拿到的那一份**，不是观察时记下的——控件在观察与动作之间移动过时，
    /// 旧包围盒的中心已经指向别处。
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
            // 按图像坐标定位时没有控件，落点只认目标窗口本身。
            host: point.is_none().then(|| located.map(|l| l.host)).flatten(),
        })
    }

    /// 读一轮判定所需的事实。
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

    /// 有没有出现标题包含给定文字的顶层窗口。窗口枚举是纯 Win32 调用，不进 UIA。
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

    /// 等待返回时的那一份状态：调用方当前观察的范围，整份重读。
    ///
    /// `appears` 的判定每轮读的就是整窗，范围也是整窗时直接复用最后一轮那一份。
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
        cached_bool(&element, "读窗口可用状态", |e| unsafe { e.CachedIsEnabled() })
    }

    /// 从缓存读一个节点的属性。
    ///
    /// 只有选择容器的选中项是实时读的，见 `selected_names`；其余全部来自缓存。
    fn read_cached_node(
        &self,
        element: &IUIAutomationElement,
        path: &[usize],
        fields: Fields,
    ) -> Result<Node, Failure> {
        let control_type = unsafe { element.CachedControlType() }.map_err(uia("读控件类型"))?;
        let name = unsafe { element.CachedName() }.map_err(uia("读名称"))?;
        let automation_id =
            unsafe { element.CachedAutomationId() }.map_err(uia("读 AutomationId"))?;
        let enabled = cached_bool(element, "读可用状态", |e| unsafe { e.CachedIsEnabled() })?;
        let offscreen = cached_bool(element, "读可见状态", |e| unsafe { e.CachedIsOffscreen() })?;

        let mut actions = Vec::new();
        let mut value = None;
        let value_pattern = available(element, UIA_IsValuePatternAvailablePropertyId)?;
        if value_pattern {
            // 缓存请求没要值时这里读不到，属于字段选择的结果，不是失败。
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
                .and_then(ToggleState::from_uia)
                .map(ToggleState::as_str);
            actions.push(NodeAction::ready("set_toggle"));
        }

        let mut expand = None;
        if available(element, UIA_IsExpandCollapsePatternAvailablePropertyId)? {
            let state = cached_int(element, UIA_ExpandCollapseExpandCollapseStatePropertyId)?;
            expand = state.map(expand_name);
            // 叶节点两个方向都到不了：它没有可展开的内容，调用会失败。
            // 状态没取时按不是叶节点算，由动作那一刻的实时读数拒。
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
            // 容器支不支持多选要问容器，那是一次跨进程调用；放到动作那一刻问，
            // 读树时不为每一项各问一次。
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
                selection = Some(SelectionState::new(multiple, required, names, total));
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
            // 状态没取时按可滚动算：那一刻能不能滚由动作的实时读数判。
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
            // 支不支持设选区要问 `SupportedTextSelection`，它没有缓存版本；动作那一刻再问。
            actions.push(NodeAction::ready("select_text"));
            // 终端与控制台的正文只有 TextPattern：不取的话观察里只剩控件名，看不出窗口
            // 里正在运行什么。
            if fields.value && !value_pattern {
                value = visible_text(element, &name.to_string())?;
            }
        }

        let bounds = unsafe { element.CachedBoundingRectangle() }.map_err(uia("读包围盒"))?;
        let rect = bounding_box(bounds);

        let focused = cached_flag(element, UIA_HasKeyboardFocusPropertyId)?.unwrap_or(false);
        if fields.foreground {
            // 指针动作只列在有可视位置、且此刻在可视区里的控件上：没有包围盒就指不出
            // 落点，在可视区外的控件那个坐标上是挡在它前面的另一个控件。
            if rect.is_some() && !offscreen {
                for action in ["click", "hover", "drag", "wheel"] {
                    actions.push(NodeAction::foreground(action));
                }
            }
            // 键盘动作列在两处：此刻持有键盘焦点的控件（输入进这个控件），以及窗口根节点
            // （输入进这个窗口）。自绘界面给不出持有焦点的控件，只列前者等于对它关掉整条
            // 键盘路径。路径为空才是窗口元素自己，子树读的根带着它在整窗里的下标。
            //
            // 不要给窗口根加「此刻是系统前台窗口」的条件：派发时 `foreground::perform` 先把
            // 目标窗口提到前台再核对。加了这个条件，桌面这类没有 WindowPattern、无法先
            // activate 的窗口永远拿不到键盘动作，Win+I 这类系统快捷键只能借用户正在用的
            // 窗口按出去。
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

/// ExpandCollapseState 常量转成回执里的名字。
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

/// 一个控件此刻的包围盒中心，屏幕物理像素。
///
/// 没有包围盒的控件指不出落点：provider 对没有可视位置的控件交回全零矩形，
/// 按它算出来的中心是屏幕左上角。
/// 这个元素自己的窗口句柄。只有对应一个 OS 窗口的元素有，其余交回 `None`。只读缓存。
fn cached_native_window(element: &IUIAutomationElement) -> Result<Option<i64>, Failure> {
    let handle = unsafe { element.CachedNativeWindowHandle() }.map_err(uia("读窗口句柄"))?;
    Ok((!handle.0.is_null()).then_some(handle.0 as i64))
}

pub fn box_center(window: i64, element: &IUIAutomationElement) -> Result<ScreenPoint, String> {
    let bounds = unsafe { element.CachedBoundingRectangle() }
        .map_err(uia("读包围盒"))
        .map_err(|f| f.into_reason(window))?;
    bounding_box(bounds)
        .map(|rect| rect.center())
        .ok_or_else(|| "no_bounds: 这个控件没有可视位置".to_owned())
}

/// UIA 的包围盒转成图像几何那一套的矩形。
///
/// 零尺寸按缺席算：provider 对没有可视位置的控件交回的就是一个全零矩形，把它当成
/// 「位于屏幕左上角、宽高为零」会让调用方在那里找一个不存在的目标。
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

/// 读一个节点要用到的属性。
///
/// 只在这里列一次：`read_cached_node` 逐项读它们，缓存请求少一项就会在读到那一项时失败，
/// 而失败点离缺的那一项很远。
const NODE_PROPERTIES: &[::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    // 模式有没有：走 `Is*PatternAvailable` 布尔属性，不缓存模式对象本身。
    // **不要改回 `AddPattern`**：provider 要为每个节点各造一份模式对象，实测同一个
    // 155 节点窗口从 197 ms 涨到 518 ms，而这里只要判「有没有」。
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
/// 与 `NODE_PROPERTIES` 分开一份，是因为 `includeState` 为假时不请求它们：动作可用性
/// 只看上面那些布尔属性，状态细节是另一件事。
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

/// 建一个缓存请求：固定用控件视图筛子节点，范围固定为「本节点 + 它的子节点」。
///
/// 范围与筛选条件只在这里写一次。改其中一处会让读树与重定位的下标错开，同一个 `ref`
/// 在两处指不同节点。
fn build_cache(
    automation: &IUIAutomation,
    control_view: &IUIAutomationCondition,
    fields: Fields,
) -> ::windows::core::Result<IUIAutomationCacheRequest> {
    unsafe {
        let cache = automation.CreateCacheRequest()?;
        cache.SetTreeScope(TreeScope(TreeScope_Element.0 | TreeScope_Children.0))?;
        cache.SetTreeFilter(control_view)?;
        // 元素要留完整引用：动作要在缓存回来的这个元素上调模式，None 模式下它调不动。
        cache.SetAutomationElementMode(AutomationElementMode_Full)?;
        // RuntimeId 是 `ref` 的核对依据，每个节点都要，不随字段选择变。
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

/// 前台模式下才取的属性。
///
/// 前台模式关着时一条都不请求：它们只服务于前台动作表，而那时前台动作一条都不列。
const FOREGROUND_PROPERTIES: &[::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID] = &[
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsWindowPatternAvailablePropertyId,
    UIA_IsTransformPatternAvailablePropertyId,
];

/// 这一次读取要取哪些可选字段。
///
/// 前两项不影响可用动作表：动作按 `Is*PatternAvailable` 判，那几个属性一直取。
/// `foreground` 影响：它决定前台动作列不列，以及要不要多请求三个属性。
#[derive(Debug, Clone, Copy)]
struct Fields {
    /// 取控件当前值。
    value: bool,
    /// 取控件模式的状态细节：数值区间、复选现态、展开现态、选中状态、容器约束、滚动位置。
    state: bool,
    /// 用户启用了前台接管。
    foreground: bool,
}

/// 深度优先遍历的状态。三个上限限的是遍历过的节点数。
struct Walk<'a> {
    backend: &'a Uia,
    cache: &'a IUIAutomationCacheRequest,
    bounds: Bounds,
    fields: Fields,
    until: Instant,
    visited: u32,
    truncated_by: Vec<&'static str>,
    collected: Vec<Collected>,
    /// 本次遍历已输出的 RuntimeId。只在这一次遍历内有效：RuntimeId 跨时刻可复用。
    seen: HashSet<String>,
}

impl Walk<'_> {
    fn mark(&mut self, why: &'static str) {
        if !self.truncated_by.contains(&why) {
            self.truncated_by.push(why);
        }
    }

    /// 子节点级失败的处置。
    fn tolerate(&mut self, failure: Failure) -> Result<(), Failure> {
        // 超时先判：它说明 provider 已经不应答，继续遍历会让后面每个节点各等一次超时。
        if failure.is_timeout() {
            return Err(failure);
        }
        // 节点在遍历途中消失是常态，记一条截断原因后接着走。
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
        // 含祖先或已读过的节点（Edge 内容面板把父窗口的全部子节点接在自己的子节点之后，
        // 其中包括它自己），照常展开会逐层复制同一棵子树，直到撞上 max_depth / max_nodes。
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
        // 下标照常递增：跳过一个子节点不能让它后面的兄弟换 ref。
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

    /// 输出前序表，并把父引用填成父节点的 `ref`。
    fn finish(self) -> (Vec<Node>, u32, Vec<&'static str>) {
        (flatten(self.collected), self.visited, self.truncated_by)
    }
}

/// 顶层可见窗口清单。纯 Win32 调用，不进 UIA，也不涉及图像。
///
/// 标题为空的可见窗口一律不收：那一类是工具窗口与消息宿主窗口，不是可操作目标。代价是
/// 标题恰好为空的应用窗口在这里也看不见，调用方拿不到它的句柄。
pub fn list_windows() -> Result<Observation, String> {
    Ok(Observation::Windows {
        captured_at: now_ms(),
        windows: top_level_windows()?,
    })
}

fn top_level_windows() -> Result<Vec<WindowInfo>, String> {
    let mut found: Vec<WindowInfo> = Vec::new();
    // SAFETY: 回调只在本次调用期间运行，lparam 指向本栈帧上的 found。
    unsafe {
        EnumWindows(
            Some(collect),
            LPARAM(std::ptr::addr_of_mut!(found) as isize),
        )
    }
    .map_err(|e| format!("枚举窗口失败：{e}"))?;
    Ok(found)
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let found = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    let mut title = [0u16; 512];
    let written = GetWindowTextW(hwnd, &mut title);
    if written <= 0 {
        return TRUE;
    }
    let mut class_name = [0u16; 256];
    let class_written = GetClassNameW(hwnd, &mut class_name);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    found.push(WindowInfo {
        window: hwnd.0 as i64,
        pid,
        title: String::from_utf16_lossy(&title[..written as usize]),
        class_name: String::from_utf16_lossy(&class_name[..class_written.max(0) as usize]),
    });
    TRUE
}

/// 第一次读一个窗口时两次读取之间隔多久。Edge 的无障碍树在第一次请求后约 0.3 s 建好。
const FIRST_READ_INTERVAL: Duration = Duration::from_millis(350);
/// 第一次读一个窗口最多读多久。页面上有持续变化的元素时控件数一直在变，到点即交回最后一份。
const FIRST_READ_LIMIT: Duration = Duration::from_secs(2);

/// 窗口所属进程号。读不到时为 0。
fn window_pid(window: i64) -> u32 {
    let mut pid = 0u32;
    // SAFETY: 只读查询，出参是本栈帧上的整数。
    unsafe { GetWindowThreadProcessId(HWND(window as *mut c_void), Some(&mut pid)) };
    pid
}

/// 窗口此刻在屏幕上是否一点都看不见：最小化，或可见部分被 z 序在它上面的窗口完全盖住。
///
/// 盖在上面的窗口只算可见、未最小化、未被 DWM 隐藏（其他虚拟桌面、挂起的应用）、且不是
/// 分层或鼠标穿透的窗口：分层窗口通常是阴影、悬浮歌词这类透明层，算进来会把看得见的窗口
/// 报成被盖住。矩形取 DWM 的可见边框，不含不可见的调整边框。读不出几何时按没盖住报。
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
    // SAFETY: 只读查询；句柄沿 z 序向上逐个取，取到顶返回错误即停。
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

/// 这个窗口能不能挡住它下面的窗口。
fn covers_others(hwnd: HWND) -> bool {
    // SAFETY: 四项都是只读查询，出参是本栈帧上的整数。
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if style & (WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) != 0 {
            return false;
        }
        let mut cloaked = 0u32;
        let read = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            std::ptr::addr_of_mut!(cloaked).cast(),
            u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4),
        );
        read.is_err() || cloaked == 0
    }
}

/// UIA 用空指针表示「没有这个子节点」「不支持这个模式」。
///
/// 判据只能是 `code().is_ok()`：windows crate 对空出参返回的是一个 HRESULT 为 S_OK 的
/// `Err`，不是某个失败码，按具体错误码比对会把「没有」误判成调用失败。
fn optional<T>(result: ::windows::core::Result<T>) -> ::windows::core::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.code().is_ok() => Ok(None),
        Err(e) => Err(e),
    }
}

/// 读一个缓存布尔属性。
fn cached_bool<T>(
    source: &T,
    step: &'static str,
    read: impl Fn(&T) -> ::windows::core::Result<::windows::core::BOOL>,
) -> Result<bool, Failure> {
    read(source).map(|v| v.as_bool()).map_err(uia(step))
}

/// 这一次缓存请求没要这个属性。
///
/// UIA 对不在 CacheRequest 里的属性回 `E_INVALIDARG`；本模块的属性 id 全是常量，
/// 这个码在这里只有这一个成因。
const NOT_REQUESTED: i32 = -2_147_024_809; // E_INVALIDARG (0x80070057)

/// 读一个缓存属性。这一次没要这一项时返回 `None`，不是失败。
fn cached_value(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<Option<VARIANT>, Failure> {
    match unsafe { element.GetCachedPropertyValue(id) } {
        Ok(variant) => Ok(Some(variant)),
        Err(e) if e.code().0 == NOT_REQUESTED => Ok(None),
        Err(e) => Err(uia("读缓存属性")(e)),
    }
}

/// 缓存属性里的布尔值。缺席或类型不符时 `None`。
///
/// **缺席与假是两件事**：没取这一项时按假读，会把「不知道」写成「不可以」。
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
    // SAFETY: vt 是 VT_BOOL 时联合体里有效的就是 boolVal。
    Ok(Some(unsafe { variant.Anonymous.Anonymous.Anonymous.boolVal }.as_bool()))
}

/// 缓存属性里的浮点数。
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
    // SAFETY: vt 是 VT_R8 时联合体里有效的就是 dblVal。
    Ok(Some(unsafe { variant.Anonymous.Anonymous.Anonymous.dblVal }))
}

/// 缓存属性里的整数。控件模式的状态枚举按它读。
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
    // SAFETY: vt 是 VT_I4 时联合体里有效的就是 lVal。
    Ok(Some(unsafe { variant.Anonymous.Anonymous.Anonymous.lVal }))
}

/// 缓存属性里的字符串。
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
    // SAFETY: vt 是 VT_BSTR 时联合体里有效的就是 bstrVal；字符串归 VARIANT 所有，
    // 这里只借读再复制一份出去。
    let text = unsafe { &*variant.Anonymous.Anonymous.Anonymous.bstrVal };
    Ok(Some(String::from_utf16_lossy(text)))
}

/// 这个控件有没有某个控件模式。按 `Is*PatternAvailable` 布尔属性判，不造模式对象。
fn available(
    element: &IUIAutomationElement,
    id: ::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Result<bool, Failure> {
    Ok(cached_flag(element, id)?.unwrap_or(false))
}

/// 选择容器此刻选中的那几项的名称，以及容器报的选中项总数。
///
/// **不要把 `UIA_SelectionSelectionPropertyId` 放进缓存请求。** 缓存请求整棵树共用一份，
/// 同一个容器在一次遍历里被缓存不止一次，provider 每次都要另造一条完整的选中项数组：
/// 一个选中 800 项的虚拟化列表，放进缓存请求让单轮读树从 170 ms 涨到 645 ms，改成在这里
/// 每个容器实时读一次是 310 ms。数组的代价与选中项数成正比，实时读只保证每个容器付一次。
///
/// 名称再按每项一次跨进程调用读：数组里的元素**自己不带缓存**，读它们的缓存名称回
/// `E_INVALIDARG`。名称的调用数按 `selected_name_budget` 截。
///
/// 读某一项名称时它已经消失，就跳过这一项，总数照原样交出去——两者不等即名单不全。
/// 其余失败一律交出去：provider 不应答时后面每一项都会各等一次超时。
///
/// `includeState` 为假时调用方走不到这里：那时容器约束的两个属性不在缓存请求里，
/// 整份 `selection` 就不成立。
fn selected_names(element: &IUIAutomationElement) -> Result<(Vec<String>, usize), Failure> {
    count_call();
    let variant = unsafe { element.GetCurrentPropertyValue(UIA_SelectionSelectionPropertyId) }
        .map_err(uia("读选中项"))?;
    if variant.vt() != VT_UNKNOWN {
        return Ok((Vec::new(), 0));
    }
    // SAFETY: vt 是 VT_UNKNOWN 时联合体里有效的就是 punkVal；接口指针归 VARIANT 所有，
    // 这里只借它取元素。
    let Some(unknown) = (unsafe { &*variant.Anonymous.Anonymous.Anonymous.punkVal }).as_ref() else {
        return Ok((Vec::new(), 0));
    };
    let array = unknown
        .cast::<IUIAutomationElementArray>()
        .map_err(uia("取选中项"))?;
    let length = unsafe { array.Length() }.map_err(uia("读选中项数"))?;
    let total = usize::try_from(length).unwrap_or(0);
    let mut names = Vec::new();
    for index in 0..selected_name_budget(total) {
        let item = unsafe { array.GetElement(index as i32) }.map_err(uia("取选中项"))?;
        count_call();
        match unsafe { item.CurrentName() } {
            Ok(name) => names.push(name.to_string()),
            Err(e) => {
                let failure = uia("读选中项名称")(e);
                if !failure.is_element_gone() {
                    return Err(failure);
                }
            }
        }
    }
    Ok((names, total))
}

/// 文本控件此刻可见范围里的文字，规则见 `visible_lines`。
///
/// 不要改读 `DocumentRange`：终端的文档范围从缓冲区开头算，读到的是最早的输出，
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
    let length = unsafe { ranges.Length() }.map_err(uia("读可见范围段数"))?;
    let mut segments = Vec::new();
    for index in 0..length {
        let range = unsafe { ranges.GetElement(index) }.map_err(uia("取可见范围"))?;
        count_call();
        segments.push(unsafe { range.GetText(-1) }.map_err(uia("读可见文本"))?.to_string());
    }
    Ok(visible_lines(&segments, name))
}

/// 可见范围各段按段换行拼接，去掉行尾空格与首尾空行。为空或与控件名称相同时为 `None`。
///
/// 按段换行是因为 conhost 每行一段且段内不带换行；Windows Terminal 只给一段，行按窗宽
/// 补空格，不去行尾空格一屏有上万个空格。
fn visible_lines(segments: &[String], name: &str) -> Option<String> {
    let joined = segments.join("\n");
    let lines: Vec<&str> = joined.lines().map(str::trim_end).collect();
    let first = lines.iter().position(|line| !line.is_empty())?;
    let last = lines.iter().rposition(|line| !line.is_empty())?;
    let text = lines[first..=last].join("\n");
    (text != name.trim()).then_some(text)
}

/// 一个滚动轴的位置百分比。这个轴滚不动、或状态没取时缺席。
///
/// **缺席不等于 0**：0 是「在顶端」。
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

/// 取一个控件此刻的模式。定位之后要调模式方法时用它，读的是实时状态不是缓存。
///
/// 模式缺失返回 `pattern_missing`，与调用失败分开：前者可证明没有发出动作调用。
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

/// 取缓存里的子节点。缓存请求的范围含子节点，因此不发跨进程调用。
///
/// 没有子节点时 UIA 交回的是空指针加 S_OK，按 `optional` 判成「没有」，不是调用失败。
fn cached_children(element: &IUIAutomationElement) -> Result<Vec<IUIAutomationElement>, Failure> {
    let Some(array) =
        optional(unsafe { element.GetCachedChildren() }).map_err(uia("取缓存子节点"))?
    else {
        return Ok(Vec::new());
    };
    let length = unsafe { array.Length() }.map_err(uia("读子节点数"))?;
    let mut out = Vec::with_capacity(length.max(0) as usize);
    for index in 0..length {
        out.push(unsafe { array.GetElement(index) }.map_err(uia("取子节点"))?);
    }
    Ok(out)
}

/// 回执里怎么称呼一个身份。指纹是不透明串，说清它是按什么算的。
fn describe(identity: &Identity) -> String {
    match identity {
        Identity::Stable(id) => format!("RuntimeId {id}"),
        Identity::Attributes(print) => format!("属性指纹 {print}"),
    }
}

/// 从缓存读一个元素的身份。不发跨进程调用。
fn cached_identity(element: &IUIAutomationElement) -> Result<Identity, Failure> {
    let runtime = runtime_id(element)?;
    if !runtime.is_empty() {
        return Ok(Identity::Stable(runtime));
    }
    let control_type = unsafe { element.CachedControlType() }.map_err(uia("读控件类型"))?;
    let name = unsafe { element.CachedName() }.map_err(uia("读名称"))?;
    let automation_id =
        unsafe { element.CachedAutomationId() }.map_err(uia("读 AutomationId"))?;
    Ok(Identity::Attributes(fingerprint(
        &role_name(control_type.0),
        &name.to_string(),
        &automation_id.to_string(),
    )))
}

/// 取一个节点的 RuntimeId，没有身份的节点交回空串。
///
/// 只读缓存：`GetRuntimeId()` 是跨进程调用，按节点各发一次就把批量取属性的收益抵消掉。
/// 部分节点两处都给不出身份（实测同一批节点在缓存里是空 VARIANT，现读也是空数组），
/// 这时 `ref` 里的身份段为空，动作前的核对退化成只比下标路径。

fn runtime_id(element: &IUIAutomationElement) -> Result<String, Failure> {
    let variant: VARIANT = unsafe { element.GetCachedPropertyValue(UIA_RuntimeIdPropertyId) }
        .map_err(uia("读 RuntimeId"))?;
    if variant.vt().0 & VT_ARRAY.0 == 0 {
        return Ok(String::new());
    }
    // SAFETY: vt 带 VT_ARRAY 时联合体里有效的是 parray；数组归 VARIANT 所有，
    // 它的 Drop 会 VariantClear，这里只借读，不能自己销毁。
    let array = unsafe { variant.Anonymous.Anonymous.Anonymous.parray };
    Ok(unsafe { read_i32_array(array) }?.join("."))
}

unsafe fn read_i32_array(array: *const SAFEARRAY) -> Result<Vec<String>, Failure> {
    let lower = SafeArrayGetLBound(array, 1).map_err(uia("读 RuntimeId 下界"))?;
    let upper = SafeArrayGetUBound(array, 1).map_err(uia("读 RuntimeId 上界"))?;
    let mut parts = Vec::new();
    for index in lower..=upper {
        let mut part = 0i32;
        SafeArrayGetElement(array, &index, std::ptr::addr_of_mut!(part).cast())
            .map_err(uia("读 RuntimeId 元素"))?;
        parts.push(part.to_string());
    }
    Ok(parts)
}

// ── 动作：可放弃等待的调用路径 ──

/// 一次 `set_toggle` 最多按几下。三态环最长三格，按不到目标态即如实回未知。
const MAX_TOGGLE_STEPS: u32 = 3;
/// 调用没返回时随回执带回几个顶层窗口。
///
/// 这一格是给调用方指下一步观察哪个窗口用的，不是窗口清单的第二个入口。
const MAX_BLOCKING_WINDOWS: usize = 16;

/// 一次待发的模式调用，连同它捕获的 UIA 接口。
///
/// **两端都在进程的 MTA 里**：`Uia::new` 与每条调用线程都做
/// `CoInitializeEx(COINIT_MULTITHREADED)`，同一个接口指针因此可以直接跨线程调用，
/// 不需要封送。不要把 UIA 客户端改成 STA，那时这个封装不再成立。
pub struct Deferred(Box<dyn FnOnce() -> Result<(), String>>);

// SAFETY: 接口对象归进程 MTA 所有，调用线程加入同一个 MTA 之后可以直接调它。
unsafe impl Send for Deferred {}

impl Deferred {
    /// 发出这次调用。
    ///
    /// **必须经这个方法用它**：闭包里直接解构字段的话，2021 版的按字段捕获会让线程
    /// 捕到里面那个 `Box`，`Send` 就不再由本类型声明。
    fn run(self) -> Result<(), String> {
        (self.0)()
    }

    /// 换成调用线程上执行的任务：先加入进程的 MTA，接口对象属于它，不加入就调不动。
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

/// 把一次 UIA 模式调用包成可以交给别的线程的形状。
pub fn defer(call: impl FnOnce() -> ::windows::core::Result<()> + 'static) -> Deferred {
    Deferred(Box::new(move || call().map_err(|e| e.to_string())))
}

/// 在调用线程上发一次 UIA 模式调用，并在有界时间里定下执行事实，见 `backend::dispatch_call`。
pub fn dispatch_call(watch: &dyn Watch, deferred: Deferred) -> Attempt {
    count_call();
    backend::dispatch_call(watch, deferred.into_job())
}

/// 调用前后都读得到的窗口事实。后台模式调用的证据全部由它给出。
///
/// 三项都是 Win32 调用：目标进程的 UI 线程正在跑模态对话框的嵌套消息循环时，
/// 这些调用照常应答，而任何 UIA 调用都会排在那次没返回的调用后面。
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
    /// 调用没返回时交给调用方的那份事实：目标进程此刻的顶层窗口，调用之前不存在的标出来。
    ///
    /// 只带前 `MAX_BLOCKING_WINDOWS` 个：这一格是给调用方指下一步观察哪个窗口用的，
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

    /// 动作已经生效的证据。没有即 `None`。
    ///
    /// 「窗口被禁用」只在调用之前它是启用的时候才算数：一个本来就禁用的窗口说明不了
    /// 这次调用做过什么。
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

/// 按一个读回值判生效的观察者。窗口动作用它：激活、显示状态与窗口矩形各读各的。
///
/// 顶层窗口清单仍由内层的 `CallWatch` 给：关闭窗口引出未保存提示时，调用方要的
/// 是那个提示框的 id。
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

/// 一个进程此刻的可见顶层窗口。标题为空的也收：模态对话框未必有标题。
///
/// 纯 Win32 枚举：`GetWindowTextW` 对无响应的跨进程窗口交回缓存标题而不阻塞，因此这个
/// 函数在目标 UI 线程卡死时仍然按时返回。
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

/// 把一个 UIA 接口交给另一条线程去丢弃。
///
/// **目标应用的 UI 线程卡在一次没返回的调用里时，释放它的代理要等它应答**：在执行线程上
/// 丢弃会等满 UIA 连接超时，实测一个元素约两秒。占用与动作调用同一份线程额度；
/// 额度满时这个封装就地被丢弃，退回等目标进程应答。
fn release_off_thread<T: 'static>(value: T) {
    let _ = backend::spawn_call(
        Deferred(Box::new(move || {
            drop(value);
            Ok(())
        }))
        .into_job(),
    );
}

/// 按动作取模式、判前置条件，然后发调用。
///
/// 前置条件判在这里而不是调用之后：只读、越界、模式缺失都是可证明的「没有发出调用」，
/// 归 `not_dispatched`。
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
    // 后台动作一律按控件执行，屏幕落点对它们没有意义；准入判定已经拦下这种组合。
    let Some(element) = element else {
        return Attempt::Refused("missing_target: 这个动作只能按控件执行".to_owned());
    };
    if let ActionSpec::SetToggle { state } = action {
        return set_toggle(window, element, *state);
    }
    match plan(window, element, action) {
        Ok(deferred) => dispatch_call(&CallWatch::before(window), deferred),
        Err(reason) => Attempt::Refused(reason),
    }
}

/// 一次动作的准入判定与调用构造。`Err` 一律是「可证明没有发出调用」。
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
                .map_err(uia("读只读标志"))
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
                .map_err(uia("读数值只读标志"))
                .map_err(|f| f.into_reason(window))?
                .as_bool()
            {
                return Err("read_only".to_owned());
            }
            let min = read("读数值下界", &|| unsafe { pattern.CurrentMinimum() })?;
            let max = read("读数值上界", &|| unsafe { pattern.CurrentMaximum() })?;
            // 越界不夹到边上：夹出来的值看着合法，而它不是调用方要的那一个。
            // provider 给不出有限边界时这一关判不了，交给它自己拒。
            if min.is_finite() && max.is_finite() && (*value < min || *value > max) {
                return Err(format!("out_of_range: {value}，允许 {min} 到 {max}"));
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
            // 单选容器上增选与取消都做不到：调用会失败，而失败按 unknown 记，
            // 调用方分不出「容器本来就不支持」与「可能已经改了选择」。
            if !multi_select(window, &pattern)? {
                return Err("single_selection_only: 这个容器一次只能选一项 · 改用 select".to_owned());
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
                .map_err(uia("读展开状态"))
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
                .map_err(uia("读可滚动标志"))
                .map_err(|f| f.into_reason(window))?
                .as_bool()
            {
                return Err("not_scrollable: 这个方向滚不动".to_owned());
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
            .map_err(uia("在容器里找项"))
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
                .map_err(uia("读选区支持"))
                .map_err(|f| f.into_reason(window))?;
            if support.0 == SupportedTextSelection_None.0 {
                return Err("selection_unsupported: 这个控件不支持选区".to_owned());
            }
            let range = sub_range(window, &pattern, *start, *length)?;
            Ok(defer(move || unsafe { range.Select() }))
        }
        // 上面一条条列完，剩下的是在 `perform` 里单独分流的那些。逐条列而不是写一个
        // `_`：新增一个后台动作忘了接进来时要在这里编译失败，不是变成一句拒绝。
        ActionSpec::SetToggle { .. } => Err("not_planned: set_toggle 走它自己的路径".to_owned()),
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
            Err("not_planned: 前台动作走前台输入路径".to_owned())
        }
    }
}

/// 这一项所在的选择容器支不支持多选。一次跨进程调用，只在增选/取消选中时才问。
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
        .map_err(uia("读多选约束"))
        .map_err(|f| f.into_reason(window))?
        .as_bool())
}

/// 把复选控件按到目标态。
///
/// TogglePattern 只有 `Toggle()`，它沿控件自己的状态环转一格；到达一个目标态只能按现态
/// 算要转几格。环长按「两端有没有中间态」推断，**每按一下都重读一次状态**——推断错了
/// 由这一步兜住，不会停在别的状态上还报成功。
fn set_toggle(window: i64, element: &IUIAutomationElement, target: ToggleState) -> Attempt {
    let pattern: IUIAutomationTogglePattern =
        match current_pattern(window, element, UIA_TogglePatternId, "TogglePattern") {
            Ok(p) => p,
            Err(reason) => return Attempt::Refused(reason),
        };
    let watch = CallWatch::before(window);
    let attempt = toggle_to(window, &watch, &pattern, target);
    // 某一下没返回时这个模式对象也丢不动，理由同 `act` 里的定位结果。
    if matches!(&attempt, Attempt::Called(outcome) if !outcome.returned) {
        release_off_thread(pattern);
    }
    attempt
}

/// 按目标态逐下按，每下之后重读状态。`pattern` 的收场归调用方。
fn toggle_to(
    window: i64,
    watch: &dyn Watch,
    pattern: &IUIAutomationTogglePattern,
    target: ToggleState,
) -> Attempt {
    let read = || -> Result<ToggleState, String> {
        count_call();
        let raw = unsafe { pattern.CurrentToggleState() }
            .map_err(uia("读复选状态"))
            .map_err(|f| f.into_reason(window))?;
        ToggleState::from_uia(raw.0).ok_or_else(|| format!("unknown_toggle_state: {}", raw.0))
    };
    let current = match read() {
        Ok(s) => s,
        Err(reason) => return Attempt::Refused(reason),
    };
    if current == target {
        return Attempt::Refused(format!(
            "already_in_state: 这个控件已经是 {}",
            target.as_str()
        ));
    }
    let tri_state = current == ToggleState::Indeterminate || target == ToggleState::Indeterminate;
    let Some(planned) = toggle_steps(current, target, tri_state) else {
        return Attempt::Refused(format!(
            "toggle_state_unsupported: 到不了 {}",
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
            "toggle_target_unreached: 按了 {planned} 下之后是 {}，要的是 {}",
            last.as_str(),
            target.as_str()
        )),
    ))
}

// ── 文本 ──

/// 一次选区起点查询最多读多少码元。起点超过它时按它记，回执里说明。
const MAX_OFFSET_PROBE: i32 = 100_000;

/// 读文档文本与全部选区。
fn read_document(
    window: i64,
    reference: &str,
    pattern: &IUIAutomationTextPattern,
    max_chars: u32,
) -> Result<Observation, Failure> {
    count_call();
    let document = unsafe { pattern.DocumentRange() }.map_err(uia("取文档范围"))?;
    count_call();
    // 多要一个码元：要回来的比上限长就说明后面还有内容。
    let raw = unsafe { document.GetText(i32::try_from(max_chars).unwrap_or(i32::MAX).saturating_add(1)) }
        .map_err(uia("读文档文本"))?;
    let (text, truncated) = clip_utf16(&raw, max_chars);
    count_call();
    let support = unsafe { pattern.SupportedTextSelection() }.map_err(uia("读选区支持"))?;
    let mut selection = Vec::new();
    if support.0 != SupportedTextSelection_None.0 {
        count_call();
        if let Some(ranges) =
            optional(unsafe { pattern.GetSelection() }).map_err(uia("读选区"))?
        {
            let length = unsafe { ranges.Length() }.map_err(uia("读选区条数"))?;
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
    let head = unsafe { prefix.GetText(MAX_OFFSET_PROBE) }.map_err(uia("读选区之前的文本"))?;
    count_call();
    let body = unsafe { range.GetText(i32::try_from(max_chars).unwrap_or(i32::MAX).saturating_add(1)) }
        .map_err(uia("读选区文本"))?;
    let (text, truncated) = clip_utf16(&body, max_chars);
    Ok(TextSelection {
        start: u32::try_from(head.len()).unwrap_or(u32::MAX),
        text,
        truncated,
    })
}

/// 文档里从 `start` 起 `length` 个码元的那一段。
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
    // 先把终点收到起点上，再往后推：不收的话终点还停在文档末尾，推出来的是整段尾巴。
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

/// 按 UTF-16 码元截断。截断点落在代理对中间时那一个字符换成替换字符。
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

/// UIA 控件类型 → 协议角色。UIA 的控件类型常量从 50000 起连续编号，按偏移取。
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

/// 控件类型换算成协议角色名。词表里没有对应的类型交回 `control_<ControlType>`，
/// 不猜一个相近的角色。
fn role_name(control_type: i32) -> String {
    usize::try_from(control_type - 50_000)
        .ok()
        .and_then(|offset| CONTROL_TYPE_ROLES.get(offset))
        .map_or_else(
            || format!("control_{control_type}"),
            |role| role.as_str().to_owned(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows Terminal 形状：一段，行按窗宽补空格，末尾一片空行。
    #[test]
    fn visible_text_trims_padding_and_blank_edges() {
        let screen = "\r\n⏺ Bash(bun run task.ts)      \r\n  ⎿  Running…    \r\n\r\n>        \r\n        \r\n     ";
        assert_eq!(
            visible_lines(&[screen.to_owned()], "Windows PowerShell").as_deref(),
            Some("⏺ Bash(bun run task.ts)\n  ⎿  Running…\n\n>")
        );
    }

    /// conhost 形状：每行一段，段内不带换行。拼成一段会把两行粘成一行。
    #[test]
    fn visible_text_puts_each_range_on_its_own_line() {
        let rows = ["probe-line-1   ", "probe-line-2", "PS C:\\> "].map(str::to_owned);
        assert_eq!(
            visible_lines(&rows, "Text Area").as_deref(),
            Some("probe-line-1\nprobe-line-2\nPS C:\\>")
        );
    }

    /// 名称就是正文的文字控件（网页文字、标签页标题）不重复给一遍，空屏也不给。
    #[test]
    fn visible_text_is_absent_when_it_repeats_the_name_or_is_blank() {
        assert_eq!(visible_lines(&["上下文膨胀与平衡".to_owned()], "上下文膨胀与平衡"), None);
        assert_eq!(visible_lines(&["   \r\n  ".to_owned()], "Windows PowerShell"), None);
        assert_eq!(visible_lines(&[], "Windows PowerShell"), None);
    }

    #[test]
    fn a_hung_provider_is_not_reported_as_a_lost_target() {
        // 窗口还在，provider 不应答：调用方该重试或放弃这一步，不该转去重新发现目标。
        assert_eq!(
            failure_code(TIMEOUT_HRESULT, true),
            Some("provider_timeout")
        );
        // 窗口句柄已失效时超时码仍然优先：这一次失败的成因是没等到应答。
        assert_eq!(
            failure_code(TIMEOUT_HRESULT, false),
            Some("provider_timeout")
        );
        assert_eq!(
            failure_code(ELEMENT_GONE_HRESULT, false),
            Some("target_lost")
        );
        // 窗口还在而错误码判不出归属：保留 provider 原文，不硬套一个原因码。
        assert_eq!(failure_code(ELEMENT_GONE_HRESULT, true), None);
        assert_eq!(failure_code(0, true), None);
    }

    #[test]
    fn failure_classification_drives_the_walk_decisions() {
        let timeout = Failure::Uia {
            code: TIMEOUT_HRESULT,
            text: "读名称失败".to_owned(),
        };
        assert!(timeout.is_timeout() && !timeout.is_element_gone());
        let gone = Failure::Uia {
            code: ELEMENT_GONE_HRESULT,
            text: "读名称失败".to_owned(),
        };
        assert!(gone.is_element_gone() && !gone.is_timeout());
        let refused = Failure::Refused("bad_ref: w".to_owned());
        assert!(!refused.is_timeout() && !refused.is_element_gone());
    }

    /// 路径对不上就是目标已经不在那个位置：等待的「控件消失」条件按它判。
    #[test]
    fn a_stale_ref_counts_as_a_missing_element() {
        let stale = Failure::Refused(format!("{REF_STALE}: 第 0 层没有下标 3 的子节点"));
        assert!(stale.is_element_gone());
    }

    /// 回执要说清核对的是哪一种身份，弱身份还要说清它为什么不可靠。
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

    /// 截断按 UTF-16 码元算：中文一个字一个码元，emoji 是一对代理。
    #[test]
    fn text_is_clipped_by_utf16_units_and_marked() {
        let text = BSTR::from("中文内容");
        assert_eq!(clip_utf16(&text, 10), ("中文内容".to_owned(), false));
        assert_eq!(clip_utf16(&text, 4), ("中文内容".to_owned(), false));
        assert_eq!(clip_utf16(&text, 2), ("中文".to_owned(), true));
        assert_eq!(clip_utf16(&BSTR::new(), 4), (String::new(), false));
        // 截断点落在代理对中间时那一个字符换成替换字符，仍然标记为截断。
        let pair = BSTR::from("a🙂b");
        assert_eq!(clip_utf16(&pair, 2), ("a\u{fffd}".to_owned(), true));
    }
}
