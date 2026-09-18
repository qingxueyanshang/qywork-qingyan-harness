//! Windows UI Automation 后端：窗口发现、控件树读取、ValuePattern 设值、InvokePattern 调用、
//! 有界等待。
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

use std::ffi::c_void;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ::windows::core::{Interface, BOOL, BSTR};
use ::windows::Win32::Foundation::{HWND, LPARAM, TRUE};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, SAFEARRAY,
};
use ::windows::Win32::System::Ole::{
    SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use ::windows::Win32::System::Variant::{VARIANT, VT_ARRAY};
use ::windows::Win32::UI::Accessibility::{
    AutomationElementMode_Full, CUIAutomation8, IUIAutomation, IUIAutomation2,
    IUIAutomationCacheRequest, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationInvokePattern, IUIAutomationValuePattern, TreeScope, TreeScope_Children,
    TreeScope_Element, UIA_AutomationIdPropertyId, UIA_ControlTypePropertyId,
    UIA_E_ELEMENTNOTAVAILABLE, UIA_E_TIMEOUT, UIA_InvokePatternId, UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId, UIA_NamePropertyId, UIA_RuntimeIdPropertyId, UIA_ValuePatternId,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
};

use crate::protocol::{
    next_poll, now_ms, satisfied, Bounds, Completeness, Node, Observation, Seen, Select, Tree, Wait,
    WaitUntil, WindowInfo,
};

pub const BACKEND: &str = "windows-uia";

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

/// 把一次读取的节点数、跨进程调用数与耗时写到 stderr。只在 debug 构建里输出。
///
/// 这是读树成本的唯一测量口径：计数器与这一行一起加减，改其中一处会让对照数据对不上。
fn report_cost(op: &str, nodes: u32, started: Instant) {
    let calls = take_calls();
    #[cfg(debug_assertions)]
    eprintln!(
        "cost {op} nodes={nodes} uia_calls={calls} elapsed_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    #[cfg(not(debug_assertions))]
    {
        let _ = (op, nodes, calls, started);
    }
}

/// 一次动作尝试的事实。`Refused` 表示没有向 provider 发出调用，`Called` 表示调用已经发出。
///
/// 两者必须分开：`Called(Err)` 的动作可能已经生效，不能与「模式缺失」「只读」归为同一类。
pub enum Attempt {
    Refused(String),
    Called(Result<(), String>),
}

const TIMEOUT_HRESULT: i32 = UIA_E_TIMEOUT as i32;
const ELEMENT_GONE_HRESULT: i32 = UIA_E_ELEMENTNOTAVAILABLE as i32;

/// 目标已经不在树上时的拒绝原因前缀。等待的「控件消失」条件按它判定。
const REF_STALE: &str = "ref_stale";

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

/// 定位结果：目标元素本身与它的父节点。
///
/// 父节点单独交出来是动作后重读要用的：重读的是目标所在的子树，不是整窗。
struct Located {
    element: IUIAutomationElement,
    path: Vec<usize>,
    /// 父元素。目标就是窗口元素本身时缺席。
    parent: Option<IUIAutomationElement>,
}

/// 一次等待的全部输入。
pub struct WaitRequest<'a> {
    pub window: i64,
    pub until: WaitUntil,
    pub reference: Option<&'a str>,
    pub value: Option<&'a str>,
    /// `until=appears` 的筛选条件。其余条件不看它。
    pub select: &'a Select,
    /// `until=window` 要等的标题子串。
    pub name: Option<&'a str>,
    pub poll: Duration,
    pub deadline: Instant,
    pub bounds: Bounds,
}

/// 一轮判定读到的事实。`Matched` 一并带回这一轮读到的树，返回时不再重读一遍。
enum Probe {
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

pub struct Backend {
    automation: IUIAutomation,
    options: IUIAutomation2,
    /// 子节点枚举的筛选条件。读树与重定位共用，下标因此对得上。
    control_view: IUIAutomationCondition,
    /// 重定位用的缓存请求。
    ///
    /// **与读树那一份要的属性完全相同。** 定位沿途的节点会被当成完整节点读（等待的判定
    /// 就这么读目标控件），少缓存一项就会在那里撞上「所需属性不在 CacheRequest 中」。
    nav_cache: IUIAutomationCacheRequest,
}

impl Backend {
    /// 在调用线程上初始化 COM 与 UIA。必须在执行线程上构造：COM 单元属于线程。
    pub fn new() -> Result<Self, String> {
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
        let nav_cache = build_cache(&automation, &control_view, NODE_PROPERTIES, true)
            .map_err(|e| format!("建重定位缓存请求失败：{e}"))?;
        Ok(Self {
            automation,
            options,
            control_view,
            nav_cache,
        })
    }

    /// 设定 UIA 调用上界并把实际生效值读回来。
    ///
    /// 这两项是整个 IUIAutomation 实例的设置，无法逐调用指定，因此由宿主在握手时给定：
    /// worker 不自带默认值，避免上界有两个出处。
    pub fn set_timeouts(
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

    /// 读树用的缓存请求。`include_value` 为假时不取控件值，可用动作仍照常判定。
    fn walk_cache(&self, include_value: bool) -> Result<IUIAutomationCacheRequest, Failure> {
        build_cache(
            &self.automation,
            &self.control_view,
            NODE_PROPERTIES,
            include_value,
        )
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
    fn locate(&self, window: i64, reference: &str) -> Result<Located, Failure> {
        let (path, expected) = decode_ref(reference).map_err(Failure::Refused)?;
        let mut element = self.window_element(window, &self.nav_cache)?;
        let mut parent: Option<IUIAutomationElement> = None;
        for (depth, index) in path.iter().enumerate() {
            let children = cached_children(&element)?;
            let Some(child) = children.get(*index).cloned() else {
                return Err(Failure::Refused(format!(
                    "{REF_STALE}: 第 {depth} 层没有下标 {index} 的子节点"
                )));
            };
            parent = Some(element);
            element = self.expand(&child, &self.nav_cache)?;
        }
        let actual = cached_identity(&element)?;
        if actual != expected {
            return Err(Failure::Refused(format!(
                "{REF_STALE}: 该位置现在是 {}，ref 里记的是 {}{}",
                actual.describe(),
                expected.describe(),
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
            parent,
        })
    }

    /// 读一个窗口的控件表。`select.root` 给了就从那棵子树读起。
    pub fn read_tree(
        &self,
        window: i64,
        select: &Select,
        bounds: Bounds,
    ) -> Result<Observation, String> {
        self.read_tree_inner(window, select, bounds)
            .map(Observation::Tree)
            .map_err(|f| f.into_reason(window))
    }

    fn read_tree_inner(
        &self,
        window: i64,
        select: &Select,
        bounds: Bounds,
    ) -> Result<Tree, Failure> {
        let cache = self.walk_cache(select.include_value)?;
        match &select.root {
            None => {
                let root = self.window_element(window, &cache)?;
                self.walk_from(window, &root, &[], select, bounds, &cache)
            }
            Some(reference) => {
                let located = self.locate(window, reference)?;
                let root = self.expand(&located.element, &cache)?;
                self.walk_from(window, &root, &located.path, select, bounds, &cache)
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
    ) -> Result<Tree, Failure> {
        let captured_at = now_ms();
        let started = Instant::now();
        let mut walk = Walk {
            backend: self,
            cache,
            select,
            bounds,
            until: started + Duration::from_millis(bounds.time_budget_ms),
            visited: 0,
            truncated_by: Vec::new(),
            collected: Vec::new(),
        };
        let mut path = root_path.to_vec();
        // 根节点读不到就整体失败：没有根就没有这次观察，不存在可以跳过它继续的走法。
        walk.node(root, &mut path, 0, None)?;
        let (nodes, visited, truncated_by) = walk.finish();
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

    /// 动作之后重读目标所在的子树。读不到子树时如实回错，执行事实不变。
    fn reread_around(
        &self,
        window: i64,
        located: &Located,
        bounds: Bounds,
    ) -> Result<Observation, String> {
        let select = Select::default();
        let read = || -> Result<Tree, Failure> {
            let cache = self.walk_cache(true)?;
            match &located.parent {
                Some(parent) => {
                    let root = self.expand(parent, &cache)?;
                    let path = &located.path[..located.path.len() - 1];
                    self.walk_from(window, &root, path, &select, bounds, &cache)
                }
                // 目标就是窗口元素：这时「所在子树」只能是整窗。
                None => {
                    let root = self.window_element(window, &cache)?;
                    self.walk_from(window, &root, &[], &select, bounds, &cache)
                }
            }
        };
        read().map(Observation::Tree).map_err(|f| f.into_reason(window))
    }

    fn write_value(&self, window: i64, element: &IUIAutomationElement, value: &str) -> Attempt {
        count_call();
        let pattern = match optional(unsafe { element.GetCurrentPattern(UIA_ValuePatternId) })
            .map_err(uia("取 ValuePattern"))
        {
            Ok(Some(p)) => p,
            Ok(None) => return Attempt::Refused("pattern_missing: value".to_owned()),
            Err(f) => return Attempt::Refused(f.into_reason(window)),
        };
        let value_pattern: IUIAutomationValuePattern =
            match pattern.cast().map_err(uia("ValuePattern 转换")) {
                Ok(p) => p,
                Err(f) => return Attempt::Refused(f.into_reason(window)),
            };
        count_call();
        match unsafe { value_pattern.CurrentIsReadOnly() }.map_err(uia("读只读标志")) {
            Ok(read_only) if read_only.as_bool() => {
                return Attempt::Refused("read_only".to_owned())
            }
            Ok(_) => {}
            Err(f) => return Attempt::Refused(f.into_reason(window)),
        }
        count_call();
        Attempt::Called(
            unsafe { value_pattern.SetValue(&BSTR::from(value)) }.map_err(|e| e.to_string()),
        )
    }

    fn call_default(&self, window: i64, element: &IUIAutomationElement) -> Attempt {
        count_call();
        let pattern = match optional(unsafe { element.GetCurrentPattern(UIA_InvokePatternId) })
            .map_err(uia("取 InvokePattern"))
        {
            Ok(Some(p)) => p,
            Ok(None) => return Attempt::Refused("pattern_missing: invoke".to_owned()),
            Err(f) => return Attempt::Refused(f.into_reason(window)),
        };
        let invoke_pattern: IUIAutomationInvokePattern =
            match pattern.cast().map_err(uia("InvokePattern 转换")) {
                Ok(p) => p,
                Err(f) => return Attempt::Refused(f.into_reason(window)),
            };
        count_call();
        Attempt::Called(unsafe { invoke_pattern.Invoke() }.map_err(|e| e.to_string()))
    }

    /// 执行一个动作并重读目标所在的子树。
    ///
    /// `value` 给了是写值，缺席是调用默认动作。两者的定位、准入与重读完全一样，合成
    /// 一条路径：分开写会让「动作前重定位」这件事有两个出处。
    ///
    /// **没有派发就不重读**：那一份观察会被调用方读成动作已经发生。
    pub fn act(
        &self,
        window: i64,
        reference: &str,
        value: Option<&str>,
        bounds: Bounds,
    ) -> (Attempt, Result<Observation, String>) {
        let located = match self.locate(window, reference) {
            Ok(l) => l,
            Err(f) => {
                let reason = f.into_reason(window);
                return (
                    Attempt::Refused(reason.clone()),
                    Err("动作没有派发，没有重读".to_owned()),
                );
            }
        };
        let attempt = match value {
            Some(v) => self.write_value(window, &located.element, v),
            None => self.call_default(window, &located.element),
        };
        match attempt {
            Attempt::Refused(reason) => (
                Attempt::Refused(reason),
                Err("动作没有派发，没有重读".to_owned()),
            ),
            called => (called, self.reread_around(window, &located, bounds)),
        }
    }

    /// 等一个后置条件成立。判定、轮询与到期都在这里，调用方只拿终态。
    ///
    /// `stop` 每轮问一次：执行者撤销这条请求时它变真，等待立即以 `cancelled` 收尾。
    pub fn wait(&self, req: &WaitRequest<'_>, stop: &dyn Fn() -> bool) -> Result<Observation, String> {
        let (found, reason, probe) = match self.wait_loop(req, stop) {
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

    /// 轮询到条件成立、到期或被撤销。返回最后一轮读到的事实。
    fn wait_loop(
        &self,
        req: &WaitRequest<'_>,
        stop: &dyn Fn() -> bool,
    ) -> Result<(bool, Option<String>, Probe), Failure> {
        loop {
            if stop() {
                return Ok((false, Some("cancelled".to_owned()), self.probe(req)?));
            }
            let started = Instant::now();
            let probe = self.probe(req)?;
            if satisfied(req.until, req.value, probe.seen()) {
                return Ok((true, None, probe));
            }
            let now = Instant::now();
            if now >= req.deadline {
                return Ok((false, Some("timeout".to_owned()), probe));
            }
            std::thread::sleep(next_poll(
                req.poll,
                now.saturating_duration_since(started),
                req.deadline - now,
            ));
        }
    }

    /// 读一轮判定所需的事实。
    fn probe(&self, req: &WaitRequest<'_>) -> Result<Probe, Failure> {
        match req.until {
            WaitUntil::Window => Ok(Probe::NewWindow(self.window_appeared(req))),
            WaitUntil::Appears => {
                let tree = self.read_tree_inner(req.window, &Select::default(), req.bounds)?;
                let count = tree
                    .nodes
                    .iter()
                    .filter(|n| matches_select(req.select, n))
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
                        let node = self.read_cached_node(&located.element, &located.path)?;
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

    /// 等待返回时的那一份状态。
    ///
    /// 判定读到的树能复用就复用；`gone` 命中时目标已经不在，交回一份空表并把范围指成
    /// 那个 `ref`——调用方据此只作废这一段引用。
    fn wait_state(&self, req: &WaitRequest<'_>, probe: Probe) -> Result<Tree, Failure> {
        if let Probe::Matched { tree, .. } = probe {
            return Ok(tree);
        }
        let missing = matches!(probe, Probe::Missing);
        match req.reference {
            Some(reference) if !missing => {
                let select = Select {
                    root: Some(reference.to_owned()),
                    ..Select::default()
                };
                self.read_tree_inner(req.window, &select, req.bounds)
            }
            Some(reference) => Ok(Tree {
                window: req.window,
                captured_at: now_ms(),
                scope: Some(reference.to_owned()),
                window_enabled: self.window_enabled(req.window)?,
                completeness: Completeness {
                    complete: true,
                    truncated_by: Vec::new(),
                    filtered_by: Vec::new(),
                    visited: 0,
                },
                node_count: 0,
                nodes: Vec::new(),
            }),
            None => self.read_tree_inner(req.window, &Select::default(), req.bounds),
        }
    }

    fn window_enabled(&self, window: i64) -> Result<bool, Failure> {
        let element = self.window_element(window, &self.nav_cache)?;
        cached_bool(&element, "读窗口可用状态", |e| unsafe { e.CachedIsEnabled() })
    }

    /// 从缓存读一个节点的属性。不发跨进程调用。
    fn read_cached_node(
        &self,
        element: &IUIAutomationElement,
        path: &[usize],
    ) -> Result<Node, Failure> {
        let control_type = unsafe { element.CachedControlType() }.map_err(uia("读控件类型"))?;
        let name = unsafe { element.CachedName() }.map_err(uia("读名称"))?;
        let automation_id =
            unsafe { element.CachedAutomationId() }.map_err(uia("读 AutomationId"))?;
        let enabled = cached_bool(element, "读可用状态", |e| unsafe { e.CachedIsEnabled() })?;
        let offscreen = cached_bool(element, "读可见状态", |e| unsafe { e.CachedIsOffscreen() })?;

        let mut actions = Vec::new();
        let mut value = None;
        if let Some(pattern) =
            optional(unsafe { element.GetCachedPattern(UIA_ValuePatternId) }).map_err(uia("取 ValuePattern"))?
        {
            let value_pattern: IUIAutomationValuePattern =
                pattern.cast().map_err(uia("ValuePattern 转换"))?;
            // 缓存请求没要值时这里读不到，属于字段选择的结果，不是失败。
            if let Ok(text) = unsafe { value_pattern.CachedValue() } {
                value = Some(text.to_string());
            }
            if !cached_bool(&value_pattern, "读只读标志", |p| unsafe {
                p.CachedIsReadOnly()
            })? {
                actions.push("set_value");
            }
        }
        if optional(unsafe { element.GetCachedPattern(UIA_InvokePatternId) })
            .map_err(uia("取 InvokePattern"))?
            .is_some()
        {
            actions.push("invoke");
        }

        let identity = cached_identity(element)?;
        Ok(Node {
            reference: encode_ref(path, &identity),
            parent_ref: None,
            depth: 0,
            role: role_name(control_type.0),
            name: name.to_string(),
            automation_id: automation_id.to_string(),
            value,
            enabled,
            offscreen,
            actions,
            weak_identity: identity.is_weak(),
        })
    }
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
];

/// 建一个缓存请求：固定用控件视图筛子节点，范围固定为「本节点 + 它的子节点」。
///
/// 范围与筛选条件只在这里写一次。改其中一处会让读树与重定位的下标错开，同一个 `ref`
/// 在两处指不同节点。
fn build_cache(
    automation: &IUIAutomation,
    control_view: &IUIAutomationCondition,
    properties: &[::windows::Win32::UI::Accessibility::UIA_PROPERTY_ID],
    include_value: bool,
) -> ::windows::core::Result<IUIAutomationCacheRequest> {
    unsafe {
        let cache = automation.CreateCacheRequest()?;
        cache.SetTreeScope(TreeScope(TreeScope_Element.0 | TreeScope_Children.0))?;
        cache.SetTreeFilter(control_view)?;
        // 元素要留完整引用：动作要在缓存回来的这个元素上调模式，None 模式下它调不动。
        cache.SetAutomationElementMode(AutomationElementMode_Full)?;
        // RuntimeId 是 `ref` 的核对依据，每个节点都要，不随字段选择变。
        cache.AddProperty(UIA_RuntimeIdPropertyId)?;
        for property in properties {
            cache.AddProperty(*property)?;
        }
        // ValuePattern 一直缓存：可用动作要按它的只读标志判，与取不取值是两件事。
        cache.AddPattern(UIA_ValuePatternId)?;
        cache.AddPattern(UIA_InvokePatternId)?;
        if include_value {
            cache.AddProperty(::windows::Win32::UI::Accessibility::UIA_ValueValuePropertyId)?;
        }
        cache.AddProperty(::windows::Win32::UI::Accessibility::UIA_ValueIsReadOnlyPropertyId)?;
        Ok(cache)
    }
}

/// 一个节点连同它在前序表里的父节点下标。筛选时按 `keep` 决定留不留。
struct Collected {
    node: Node,
    parent: Option<usize>,
    keep: bool,
}

/// 深度优先遍历的状态。
///
/// 三个上限限的是**遍历过的节点数**，不是返回的条数：筛选发生在遍历之后，被筛掉的节点
/// 一样付出了读取成本。两者在 `completeness` 里分两格记。
struct Walk<'a> {
    backend: &'a Backend,
    cache: &'a IUIAutomationCacheRequest,
    select: &'a Select,
    bounds: Bounds,
    until: Instant,
    visited: u32,
    truncated_by: Vec<&'static str>,
    collected: Vec<Collected>,
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

    /// 命中的节点连同它的祖先一起留下。
    ///
    /// 祖先不留的话，展平表上的 `parent_ref` 会指向一个不在表里的节点，候选的祖先路径
    /// 就拼不出来。
    fn keep_up(&mut self, mut at: usize) {
        loop {
            let entry = &mut self.collected[at];
            if entry.keep {
                return;
            }
            entry.keep = true;
            match entry.parent {
                Some(parent) => at = parent,
                None => return,
            }
        }
    }

    fn node(
        &mut self,
        element: &IUIAutomationElement,
        path: &mut Vec<usize>,
        depth: u32,
        parent: Option<usize>,
    ) -> Result<(), Failure> {
        let mut node = self.backend.read_cached_node(element, path)?;
        node.depth = depth;
        self.visited += 1;
        let matched = matches_select(self.select, &node);
        let index = self.collected.len();
        self.collected.push(Collected {
            node,
            parent,
            keep: false,
        });
        if matched {
            self.keep_up(index);
        }
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

    /// 输出前序表：只留 `keep` 的节点，并把父引用填成父节点的 `ref`。
    fn finish(self) -> (Vec<Node>, u32, Vec<&'static str>) {
        let refs: Vec<String> = self
            .collected
            .iter()
            .map(|c| c.node.reference.clone())
            .collect();
        let mut nodes = Vec::new();
        for entry in self.collected {
            if !entry.keep {
                continue;
            }
            let mut node = entry.node;
            node.parent_ref = entry.parent.map(|at| refs[at].clone());
            nodes.push(node);
        }
        (nodes, self.visited, self.truncated_by)
    }
}

/// 一个节点过不过得了筛选。没有筛选条件时全过。
fn matches_select(select: &Select, node: &Node) -> bool {
    if let Some(role) = &select.role {
        if node.role != *role {
            return false;
        }
    }
    if let Some(text) = &select.name_contains {
        let needle = text.to_lowercase();
        let hit = node.name.to_lowercase().contains(&needle)
            || node.automation_id.to_lowercase().contains(&needle)
            || node
                .value
                .as_deref()
                .is_some_and(|v| v.to_lowercase().contains(&needle));
        if !hit {
            return false;
        }
    }
    true
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

/// 一个控件的身份。
///
/// RuntimeId 是首选；provider 不给时退到角色、名称与稳定标识的指纹，并在观察里把这个
/// 控件标成弱身份。**两种身份不相等**，哪怕字面量凑巧一样。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identity {
    Runtime(String),
    Attributes(String),
}

impl Identity {
    fn is_weak(&self) -> bool {
        matches!(self, Self::Attributes(_))
    }

    /// 写进 `ref` 的那一段。弱身份带 `~` 前缀，解码时据此分得开。
    fn encode(&self) -> String {
        match self {
            Self::Runtime(id) => id.clone(),
            Self::Attributes(print) => format!("~{print}"),
        }
    }

    fn decode(segment: &str) -> Self {
        match segment.strip_prefix('~') {
            Some(print) => Self::Attributes(print.to_owned()),
            None => Self::Runtime(segment.to_owned()),
        }
    }

    /// 回执里怎么称呼它。指纹是不透明串，说清它是按什么算的。
    fn describe(&self) -> String {
        match self {
            Self::Runtime(id) => format!("RuntimeId {id}"),
            Self::Attributes(print) => format!("属性指纹 {print}"),
        }
    }
}

/// 角色、名称与稳定标识的指纹。FNV-1a，够短且与输入一一对应到碰撞概率可忽略。
///
/// 三项用不会出现在取值里的分隔符拼起来再算：直接连接的话，`("ab","c")` 与 `("a","bc")`
/// 会算出同一个指纹。
fn fingerprint(role: &str, name: &str, automation_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in role
        .as_bytes()
        .iter()
        .chain(b"\x1f")
        .chain(name.as_bytes())
        .chain(b"\x1f")
        .chain(automation_id.as_bytes())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 从缓存读一个元素的身份。不发跨进程调用。
fn cached_identity(element: &IUIAutomationElement) -> Result<Identity, Failure> {
    let runtime = runtime_id(element)?;
    if !runtime.is_empty() {
        return Ok(Identity::Runtime(runtime));
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

/// `ref` 的编码：`w` 加逐层子节点下标，`#` 后是身份段。
fn encode_ref(path: &[usize], identity: &Identity) -> String {
    let mut out = String::from("w");
    for index in path {
        out.push('.');
        out.push_str(&index.to_string());
    }
    out.push('#');
    out.push_str(&identity.encode());
    out
}

fn decode_ref(reference: &str) -> Result<(Vec<usize>, Identity), String> {
    let Some((path, identity)) = reference.split_once('#') else {
        return Err(format!("bad_ref: {reference}"));
    };
    let mut segments = path.split('.');
    if segments.next() != Some("w") {
        return Err(format!("bad_ref: {reference}"));
    }
    let mut indexes = Vec::new();
    for segment in segments {
        let index = segment
            .parse::<usize>()
            .map_err(|_| format!("bad_ref: {reference}"))?;
        indexes.push(index);
    }
    Ok((indexes, Identity::decode(identity)))
}

/// UIA 控件类型常量从 50000 起连续编号，按偏移取名。
const ROLES: [&str; 41] = [
    "button",
    "calendar",
    "check_box",
    "combo_box",
    "edit",
    "hyperlink",
    "image",
    "list_item",
    "list",
    "menu",
    "menu_bar",
    "menu_item",
    "progress_bar",
    "radio_button",
    "scroll_bar",
    "slider",
    "spinner",
    "status_bar",
    "tab",
    "tab_item",
    "text",
    "tool_bar",
    "tool_tip",
    "tree",
    "tree_item",
    "custom",
    "group",
    "thumb",
    "data_grid",
    "data_item",
    "document",
    "split_button",
    "window",
    "pane",
    "header",
    "header_item",
    "table",
    "title_bar",
    "separator",
    "semantic_zoom",
    "app_bar",
];

fn role_name(control_type: i32) -> String {
    usize::try_from(control_type - 50_000)
        .ok()
        .and_then(|offset| ROLES.get(offset))
        .map_or_else(
            || format!("control_{control_type}"),
            |name| (*name).to_owned(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(role: &str, name: &str, automation_id: &str, value: Option<&str>) -> Node {
        Node {
            reference: "w.0#7".to_owned(),
            parent_ref: None,
            depth: 0,
            role: role.to_owned(),
            name: name.to_owned(),
            automation_id: automation_id.to_owned(),
            value: value.map(str::to_owned),
            enabled: true,
            offscreen: false,
            actions: Vec::new(),
            weak_identity: false,
        }
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

    #[test]
    fn ref_round_trips_through_encode_and_decode() {
        let strong = Identity::Runtime("42.1180674.4.1".to_owned());
        let encoded = encode_ref(&[0, 3, 1], &strong);
        assert_eq!(encoded, "w.0.3.1#42.1180674.4.1");
        assert_eq!(decode_ref(&encoded), Ok((vec![0, 3, 1], strong)));
        assert_eq!(
            decode_ref("w#7.1"),
            Ok((Vec::new(), Identity::Runtime("7.1".to_owned())))
        );
    }

    /// 弱身份在 `ref` 里带 `~` 前缀，解码时与 RuntimeId 分得开。
    #[test]
    fn a_weak_identity_survives_the_round_trip_and_stays_distinct() {
        let weak = Identity::Attributes("0123456789abcdef".to_owned());
        let encoded = encode_ref(&[2], &weak);
        assert_eq!(encoded, "w.2#~0123456789abcdef");
        assert_eq!(decode_ref(&encoded), Ok((vec![2], weak.clone())));
        // 字面量一样也不算同一种身份：那个位置从没有 RuntimeId 变成有了，就不是同一个控件。
        assert_ne!(weak, Identity::Runtime("0123456789abcdef".to_owned()));
        assert!(weak.is_weak());
        assert!(!Identity::Runtime("7.1".to_owned()).is_weak());
    }

    /// 三项任一变化都换指纹；拼接不能直接相连，否则挪一个字符就撞上同一个指纹。
    #[test]
    fn the_attribute_fingerprint_separates_the_three_fields() {
        let base = fingerprint("list_item", "item-alpha", "");
        assert_eq!(base, fingerprint("list_item", "item-alpha", ""));
        assert_ne!(base, fingerprint("list_item", "item-beta", ""));
        assert_ne!(base, fingerprint("button", "item-alpha", ""));
        assert_ne!(base, fingerprint("list_item", "item-alpha", "id"));
        assert_ne!(fingerprint("ab", "c", ""), fingerprint("a", "bc", ""));
        assert_eq!(base.len(), 16);
    }

    /// 回执要说清核对的是哪一种身份，弱身份还要说清它为什么不可靠。
    #[test]
    fn the_refusal_names_the_kind_of_identity_it_compared() {
        assert_eq!(
            Identity::Runtime("42.7".to_owned()).describe(),
            "RuntimeId 42.7"
        );
        assert_eq!(
            Identity::Attributes("abc".to_owned()).describe(),
            "属性指纹 abc"
        );
    }

    #[test]
    fn malformed_ref_is_refused_rather_than_guessed() {
        for bad in ["w.0.1", "x.0#7.1", "w.a#7.1", ""] {
            assert!(decode_ref(bad).is_err(), "{bad} 应当解析失败");
        }
    }

    #[test]
    fn role_name_maps_known_ids_and_keeps_unknown_ones_visible() {
        assert_eq!(role_name(50_000), "button");
        assert_eq!(role_name(50_004), "edit");
        assert_eq!(role_name(50_040), "app_bar");
        assert_eq!(role_name(50_041), "control_50041");
        assert_eq!(role_name(0), "control_0");
    }

    /// 没有筛选条件时一个都不挡。
    #[test]
    fn an_empty_selection_keeps_every_node() {
        let select = Select::default();
        assert!(matches_select(&select, &node("button", "保存", "save", None)));
        assert!(matches_select(&select, &node("edit", "", "", None)));
    }

    #[test]
    fn role_and_text_filters_apply_together() {
        let select = Select {
            role: Some("button".to_owned()),
            name_contains: Some("保存".to_owned()),
            ..Select::default()
        };
        assert!(matches_select(&select, &node("button", "保存", "save", None)));
        assert!(!matches_select(&select, &node("edit", "保存", "save", None)));
        assert!(!matches_select(
            &select,
            &node("button", "取消", "cancel", None)
        ));
    }

    /// 文本筛选看名称、稳定标识与值三处，且不分大小写。
    #[test]
    fn the_text_filter_looks_at_name_id_and_value_case_insensitively() {
        let select = Select {
            name_contains: Some("Save".to_owned()),
            ..Select::default()
        };
        assert!(matches_select(&select, &node("button", "SAVE AS", "x", None)));
        assert!(matches_select(&select, &node("button", "别的", "saveBtn", None)));
        assert!(matches_select(
            &select,
            &node("edit", "别的", "x", Some("autosave"))
        ));
        assert!(!matches_select(&select, &node("edit", "别的", "x", Some("无"))));
        // 没取值的节点不会因为值缺席就命中。
        assert!(!matches_select(&select, &node("edit", "别的", "x", None)));
    }
}
