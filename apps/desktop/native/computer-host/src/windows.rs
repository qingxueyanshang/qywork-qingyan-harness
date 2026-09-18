//! Windows UI Automation 后端：窗口发现、控件树读取、ValuePattern 设值、InvokePattern 调用。
//!
//! 四条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。
//! 2. 窗口发现走 Win32 枚举而不是 UIA 根元素：`GetWindowTextW` 对无响应的跨进程窗口
//!    返回缓存标题而不阻塞，UIA 根元素的子节点枚举要等每个 provider 应答。
//! 3. `ref` 是不透明串，含从窗口元素出发的子节点下标路径与 RuntimeId。动作前按路径重新
//!    定位并核对 RuntimeId，不允许拿旧编号操作当前树里换过位置的另一个节点。
//! 4. UIA 全是跨进程调用，上界只能靠 IUIAutomation2 的连接与事务超时；本模块不另起线程
//!    等待，挂起的 provider 由这两个设置收尾。

use std::ffi::c_void;
use std::time::{Duration, Instant};

use ::windows::core::{Interface, BOOL, BSTR};
use ::windows::Win32::Foundation::{HWND, LPARAM, TRUE};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, SAFEARRAY,
};
use ::windows::Win32::System::Ole::{
    SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use ::windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement,
    IUIAutomationInvokePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
    UIA_InvokePatternId, UIA_ValuePatternId, UIA_E_ELEMENTNOTAVAILABLE, UIA_E_TIMEOUT,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
};

use crate::protocol::{now_ms, Completeness, Node, Observation, WindowInfo};

pub const BACKEND: &str = "windows-uia";

/// 一次动作尝试的事实。`Refused` 表示没有向 provider 发出调用，`Called` 表示调用已经发出。
///
/// 两者必须分开：`Called(Err)` 的动作可能已经生效，不能与「模式缺失」「只读」归为同一类。
pub enum Attempt {
    Refused(String),
    Called(Result<(), String>),
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
        matches!(self, Self::Uia { code, .. } if *code == ELEMENT_GONE_HRESULT)
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

pub struct Backend {
    automation: IUIAutomation,
    options: IUIAutomation2,
    walker: IUIAutomationTreeWalker,
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
        let walker = unsafe { automation.ControlViewWalker() }
            .map_err(|e| format!("取 ControlViewWalker 失败：{e}"))?;
        Ok(Self {
            automation,
            options,
            walker,
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

    fn element_from_window(&self, window: i64) -> Result<IUIAutomationElement, Failure> {
        let hwnd = HWND(window as *mut c_void);
        unsafe { self.automation.ElementFromHandle(hwnd) }.map_err(uia("窗口取 UIA 元素"))
    }

    /// 按 `ref` 里的下标路径重新定位，并核对 RuntimeId。一并交回路径，动作后重读要用它。
    fn locate(
        &self,
        window: i64,
        reference: &str,
    ) -> Result<(IUIAutomationElement, Vec<usize>), Failure> {
        let (path, expected) = decode_ref(reference).map_err(Failure::Refused)?;
        let mut element = self.element_from_window(window)?;
        for (depth, index) in path.iter().enumerate() {
            element = self.nth_child(&element, *index).map_err(|_| {
                Failure::Refused(format!("ref_stale: 第 {depth} 层没有下标 {index} 的子节点"))
            })?;
        }
        let actual = runtime_id(&element)?;
        if actual != expected {
            return Err(Failure::Refused(format!(
                "ref_stale: 该位置的 RuntimeId 现在是 {actual}，ref 里记的是 {expected}"
            )));
        }
        Ok((element, path))
    }

    fn nth_child(
        &self,
        parent: &IUIAutomationElement,
        index: usize,
    ) -> Result<IUIAutomationElement, Failure> {
        let mut current = optional(unsafe { self.walker.GetFirstChildElement(parent) })
            .map_err(uia("取首个子节点"))?;
        for _ in 0..index {
            let Some(element) = current else {
                return Err(Failure::Refused("子节点数量不足".to_owned()));
            };
            current = optional(unsafe { self.walker.GetNextSiblingElement(&element) })
                .map_err(uia("取兄弟节点"))?;
        }
        current.ok_or_else(|| Failure::Refused("子节点数量不足".to_owned()))
    }

    /// 读一个节点的属性，不含子节点。
    fn read_node(&self, element: &IUIAutomationElement, path: &[usize]) -> Result<Node, Failure> {
        unsafe {
            let control_type = element.CurrentControlType().map_err(uia("读控件类型"))?;
            let name = element.CurrentName().map_err(uia("读名称"))?;
            let automation_id = element
                .CurrentAutomationId()
                .map_err(uia("读 AutomationId"))?;
            let enabled = element.CurrentIsEnabled().map_err(uia("读可用状态"))?;
            let offscreen = element.CurrentIsOffscreen().map_err(uia("读可见状态"))?;

            let mut actions = Vec::new();
            let mut value = None;
            if let Some(pattern) = optional(element.GetCurrentPattern(UIA_ValuePatternId))
                .map_err(uia("取 ValuePattern"))?
            {
                let value_pattern: IUIAutomationValuePattern =
                    pattern.cast().map_err(uia("ValuePattern 转换"))?;
                value = Some(
                    value_pattern
                        .CurrentValue()
                        .map_err(uia("读控件值"))?
                        .to_string(),
                );
                if !value_pattern
                    .CurrentIsReadOnly()
                    .map_err(uia("读只读标志"))?
                    .as_bool()
                {
                    actions.push("set_value");
                }
            }
            if optional(element.GetCurrentPattern(UIA_InvokePatternId))
                .map_err(uia("取 InvokePattern"))?
                .is_some()
            {
                actions.push("invoke");
            }

            Ok(Node {
                reference: encode_ref(path, &runtime_id(element)?),
                role: role_name(control_type.0),
                name: name.to_string(),
                automation_id: automation_id.to_string(),
                value,
                enabled: enabled.as_bool(),
                offscreen: offscreen.as_bool(),
                actions,
                children: Vec::new(),
            })
        }
    }

    pub fn read_tree(
        &self,
        window: i64,
        max_nodes: u32,
        max_depth: u32,
        time_budget_ms: u64,
    ) -> Result<Observation, String> {
        let root_element = self
            .element_from_window(window)
            .map_err(|f| f.into_reason(window))?;
        let mut walk = Walk {
            backend: self,
            max_nodes,
            max_depth,
            until: Instant::now() + Duration::from_millis(time_budget_ms),
            count: 0,
            truncated_by: Vec::new(),
        };
        let captured_at = now_ms();
        // 根节点读不到就整体失败：没有根就没有这次观察，不存在可以跳过它继续的走法。
        let root = walk
            .node(&root_element, &mut Vec::new(), 0)
            .map_err(|f| f.into_reason(window))?;
        Ok(Observation::Tree {
            window,
            captured_at,
            completeness: Completeness {
                complete: walk.truncated_by.is_empty(),
                truncated_by: walk.truncated_by,
            },
            node_count: walk.count,
            root,
        })
    }

    pub fn read_element(&self, window: i64, reference: &str) -> Result<Observation, String> {
        let read = || {
            let (element, path) = self.locate(window, reference)?;
            self.read_node(&element, &path)
        };
        Ok(Observation::Element {
            window,
            captured_at: now_ms(),
            element: read().map_err(|f| f.into_reason(window))?,
        })
    }

    pub fn set_value(&self, window: i64, reference: &str, value: &str) -> Attempt {
        let element = match self.locate(window, reference) {
            Ok((e, _)) => e,
            Err(f) => return Attempt::Refused(f.into_reason(window)),
        };
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
        match unsafe { value_pattern.CurrentIsReadOnly() }.map_err(uia("读只读标志")) {
            Ok(read_only) if read_only.as_bool() => {
                return Attempt::Refused("read_only".to_owned())
            }
            Ok(_) => {}
            Err(f) => return Attempt::Refused(f.into_reason(window)),
        }
        Attempt::Called(
            unsafe { value_pattern.SetValue(&BSTR::from(value)) }.map_err(|e| e.to_string()),
        )
    }

    pub fn invoke(&self, window: i64, reference: &str) -> Attempt {
        let element = match self.locate(window, reference) {
            Ok((e, _)) => e,
            Err(f) => return Attempt::Refused(f.into_reason(window)),
        };
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
        Attempt::Called(unsafe { invoke_pattern.Invoke() }.map_err(|e| e.to_string()))
    }
}

/// 深度优先遍历的状态。三个上限与消失的节点各记一条截断原因，调用方据此判断观察是否完整。
struct Walk<'a> {
    backend: &'a Backend,
    max_nodes: u32,
    max_depth: u32,
    until: Instant,
    count: u32,
    truncated_by: Vec<&'static str>,
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
    ) -> Result<Node, Failure> {
        let mut node = self.backend.read_node(element, path)?;
        self.count += 1;
        if depth >= self.max_depth {
            self.mark("max_depth");
            return Ok(node);
        }
        let mut child = match optional(unsafe { self.backend.walker.GetFirstChildElement(element) })
            .map_err(uia("取首个子节点"))
        {
            Ok(c) => c,
            Err(f) => {
                self.tolerate(f)?;
                None
            }
        };
        // 下标照常递增：跳过一个子节点不能让它后面的兄弟换 ref。
        let mut index = 0usize;
        while let Some(current) = child {
            if self.count >= self.max_nodes {
                self.mark("max_nodes");
                break;
            }
            if Instant::now() >= self.until {
                self.mark("time_budget");
                break;
            }
            path.push(index);
            let built = self.node(&current, path, depth + 1);
            path.pop();
            match built {
                Ok(child_node) => node.children.push(child_node),
                Err(f) => self.tolerate(f)?,
            }
            child = match optional(unsafe { self.backend.walker.GetNextSiblingElement(&current) })
                .map_err(uia("取兄弟节点"))
            {
                Ok(c) => c,
                Err(f) => {
                    self.tolerate(f)?;
                    None
                }
            };
            index += 1;
        }
        Ok(node)
    }
}

/// 顶层可见窗口清单。纯 Win32 调用，不进 UIA，也不涉及图像。
///
/// 标题为空的可见窗口一律不收：那一类是工具窗口与消息宿主窗口，不是可操作目标。代价是
/// 标题恰好为空的应用窗口在这里也看不见，调用方拿不到它的句柄。
pub fn list_windows() -> Result<Observation, String> {
    let mut found: Vec<WindowInfo> = Vec::new();
    // SAFETY: 回调只在本次调用期间运行，lparam 指向本栈帧上的 found。
    unsafe {
        EnumWindows(
            Some(collect),
            LPARAM(std::ptr::addr_of_mut!(found) as isize),
        )
    }
    .map_err(|e| format!("枚举窗口失败：{e}"))?;
    Ok(Observation::Windows {
        captured_at: now_ms(),
        windows: found,
    })
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

fn runtime_id(element: &IUIAutomationElement) -> Result<String, Failure> {
    unsafe {
        let array = element.GetRuntimeId().map_err(uia("读 RuntimeId"))?;
        // SAFEARRAY 归调用方释放。读取拆成一个函数，是为了让出错的早退路径也走到下面那行
        // Destroy——每读一个节点就调一次，漏掉它等于按节点数漏内存。
        let parts = read_i32_array(array);
        let _ = SafeArrayDestroy(array);
        Ok(parts?.join("."))
    }
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

/// `ref` 的编码：`w` 加逐层子节点下标，`#` 后是 RuntimeId。
fn encode_ref(path: &[usize], runtime_id: &str) -> String {
    let mut out = String::from("w");
    for index in path {
        out.push('.');
        out.push_str(&index.to_string());
    }
    out.push('#');
    out.push_str(runtime_id);
    out
}

fn decode_ref(reference: &str) -> Result<(Vec<usize>, String), String> {
    let Some((path, runtime_id)) = reference.split_once('#') else {
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
    Ok((indexes, runtime_id.to_owned()))
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
        let refused = Failure::Refused("ref_stale: …".to_owned());
        assert!(!refused.is_timeout() && !refused.is_element_gone());
    }

    #[test]
    fn ref_round_trips_through_encode_and_decode() {
        let encoded = encode_ref(&[0, 3, 1], "42.1180674.4.1");
        assert_eq!(encoded, "w.0.3.1#42.1180674.4.1");
        assert_eq!(
            decode_ref(&encoded),
            Ok((vec![0, 3, 1], "42.1180674.4.1".to_owned()))
        );
        assert_eq!(decode_ref("w#7.1"), Ok((Vec::new(), "7.1".to_owned())));
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
}
