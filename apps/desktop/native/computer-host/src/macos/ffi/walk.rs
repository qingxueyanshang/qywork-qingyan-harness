//! 经 AX 读控件树：一个元素的事实、深度优先遍历、按 `ref` 重新定位、窗口发现、窗口几何与读文本，
//! 以及进程内的身份表。
//!
//! 子节点顺序只有一处来源：`AXChildren`。遍历从批量读取里取它，重新定位单独读它，两处读的是
//! 同一个属性，`ref` 里的下标才对得上；不要在一处改用 `AXVisibleChildren` 或按位置取子元素的接口。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::ax::{self, Element};
use crate::macos::pure::associate::{self, AxSide, CgWindow, Unmatched};
use crate::macos::pure::facts::{
    attr, clip_utf16, utf16_slice, wants_value, Facts, Failure, Frame, Value, BATCH, TARGET_LOST,
};
use crate::macos::pure::identity::{Identities, MAX_IDENTITIES};
use crate::macos::pure::node::{self, kind, Context, Fields};
use crate::macos::pure::plan::Setting;
use crate::macos::pure::screen::{self, Mapping, Placed};
use crate::protocol::{
    now_ms, Bounds, Completeness, Node, Observation, Select, Text, TextSelection, REF_STALE,
};
use crate::tree::{decode_ref, first_sighting, flatten, Collected};

/// 进程内唯一的一张身份表。执行线程与每条等待线程各自构造后端实例，编号必须出自同一张表：
/// 等待线程拿到的 `ref` 是执行线程那一次读取编出来的。
fn table() -> &'static Mutex<Identities<Element>> {
    static TABLE: OnceLock<Mutex<Identities<Element>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(Identities::new(MAX_IDENTITIES)))
}

pub fn intern(element: &Element, check: &str) -> u64 {
    table()
        .lock()
        .expect("身份表锁")
        .intern(element.clone(), check)
}

fn lookup(id: u64) -> Option<(Element, String)> {
    table().lock().expect("身份表锁").get(id)
}

/// 把 AX 错误码包成 `Failure`。进程在不在只在出错时查一次。
fn fail(step: &'static str, pid: i32) -> impl Fn(i32) -> Failure {
    move |code| Failure::from_ax(step, code, ax::alive(pid))
}

/// 一项可选读取：应用不应答或元素已经消失照常交出去，其余失败按读不到算。
///
/// 不要改成一律交出去：应用声明了属性而读不出来是常态，交出去会让整窗读取为一个节点失败。
fn optional<T>(read: Result<T, Failure>) -> Result<Option<T>, Failure> {
    match read {
        Ok(v) => Ok(Some(v)),
        Err(f) if f.is_timeout() || matches!(f, Failure::Gone { .. }) => Err(f),
        Err(_) => Ok(None),
    }
}

/// 只读批量那一次：角色、名称、状态、矩形与子节点，没有值、动作表与可写性。
///
/// 窗口清单、窗口根与窗口状态只用得到这几项；读全部事实每个窗口要多付几次跨进程调用。
fn batch_facts(element: &Element, pid: i32) -> Result<(Facts, Vec<Element>), Failure> {
    let (values, children) = element
        .batch(&BATCH, attr::CHILDREN)
        .map_err(fail("读属性", pid))?;
    Ok((Facts::decode(&values), children))
}

/// 窗口元素的事实，见 `batch_facts`。
pub fn window_facts(element: &Element, pid: i32) -> Result<Facts, Failure> {
    batch_facts(element, pid).map(|(facts, _)| facts)
}

/// 父元素里与子节点可用动作有关的事实：批量读取加选中集合的可写性。
fn context_of(parent: &Element, pid: i32) -> Result<Context, Failure> {
    let (mut facts, _) = batch_facts(parent, pid)?;
    for attribute in node::container_queries(&facts) {
        let settable = optional(parent.settable(attribute).map_err(fail("读可写性", pid)))?;
        facts.settable.record(attribute, settable.unwrap_or(false));
    }
    Ok(Context::of(&facts))
}

/// 读一个元素的事实与子节点。`whole` 为真时不论多长都读值，见 `facts::wants_value`。
///
/// 批量读取必须成功，读不到即这个节点失败；值、动作表与可写性各是一次可选读取。
pub fn facts(
    element: &Element,
    pid: i32,
    context: Context,
    whole: bool,
) -> Result<(Facts, Vec<Element>), Failure> {
    let (mut facts, children) = batch_facts(element, pid)?;
    if wants_value(facts.characters, whole) {
        if let Some(raw) = optional(element.raw(attr::VALUE).map_err(fail("读值", pid)))? {
            facts.value = Value::of(&raw);
        }
    }
    facts.actions =
        optional(element.action_names().map_err(fail("读动作表", pid)))?.unwrap_or_default();
    for attribute in node::settable_queries(&facts, context) {
        let settable = optional(element.settable(attribute).map_err(fail("读可写性", pid)))?;
        facts.settable.record(attribute, settable.unwrap_or(false));
    }
    Ok((facts, children))
}

/// 读控件树用的根：窗口元素、所在应用的进程号、对应上的 CG 窗口与窗口矩形。
pub struct Root {
    pub element: Element,
    pub pid: i32,
    pub cg: Option<u32>,
    /// AX 的窗口矩形，单位是点。
    pub frame: Option<Frame>,
    /// 对应上的 CG 窗口此刻的几何。没对应上、或读不出 CG 矩形时缺席。
    pub placed: Option<Placed>,
}

/// 一个 CG 窗口此刻的几何，见 `screen::place`。窗口已经不在或读不出矩形时缺席。
///
/// 矩形取 CGWindowList 而不取 AX：取图、按图定位与控件包围盒要用同一份矩形算代际与换算，
/// 而窗口服务器在应用卡住时照常应答。
pub fn placed(number: u32) -> Option<Placed> {
    placed_in(&ax::cg_windows(), number)
}

fn placed_in(cgs: &[CgWindow], number: u32) -> Option<Placed> {
    let bounds = cgs.iter().find(|w| w.number == number)?.bounds?;
    screen::place(&ax::displays(), screen::frame_of(bounds))
}

/// 按 `ref` 重新定位的结果，或一次遍历的起点。
pub struct Located {
    pub element: Element,
    pub id: u64,
    pub path: Vec<usize>,
    pub facts: Facts,
    pub children: Vec<Element>,
    /// 父元素的事实。目标就是窗口根时取默认值：根没有可经父元素改的选中。
    pub context: Context,
    /// 父元素。目标就是窗口根时缺席。
    pub parent: Option<Element>,
}

/// 窗口根本身作为遍历起点。
pub fn at_root(root: &Root) -> Result<Located, Failure> {
    let (facts, children) = facts(&root.element, root.pid, Context::default(), false)?;
    let id = intern(&root.element, &node::check(&facts));
    Ok(Located {
        element: root.element.clone(),
        id,
        path: Vec::new(),
        facts,
        children,
        context: Context::default(),
        parent: None,
    })
}

/// 从窗口根出发按下标路径重新定位，并核对身份段与核对串，见 `node::verify`。
pub fn locate(root: &Root, reference: &str, whole: bool) -> Result<Located, Failure> {
    let expected = decode_ref(reference).map_err(Failure::Refused)?;
    let mut element = root.element.clone();
    let mut parent: Option<Element> = None;
    for (depth, index) in expected.path.iter().enumerate() {
        let kids = element
            .elements(attr::CHILDREN)
            .map_err(fail("读子节点", root.pid))?;
        let Some(child) = kids.get(*index).cloned() else {
            return Err(Failure::Refused(format!(
                "{REF_STALE}: 第 {depth} 层没有下标 {index} 的子节点"
            )));
        };
        parent = Some(std::mem::replace(&mut element, child));
    }
    let context = match &parent {
        Some(p) => context_of(p, root.pid)?,
        None => Context::default(),
    };
    let (facts, children) = facts(&element, root.pid, context, whole)?;
    let check = node::check(&facts);
    let id = intern(&element, &check);
    node::verify(&expected, id, &check).map_err(Failure::Refused)?;
    Ok(Located {
        element,
        id,
        path: expected.path,
        facts,
        children,
        context,
        parent,
    })
}

/// 一次遍历的结果。
pub struct Walked {
    pub nodes: Vec<Node>,
    pub completeness: Completeness,
}

/// 从 `start` 开始深度优先读，三个上限限的是遍历过的节点数。
pub fn walk(
    start: &Located,
    root: &Root,
    select: &Select,
    bounds: Bounds,
    fields: Fields,
) -> Result<Walked, Failure> {
    let mut walk = Walk {
        pid: root.pid,
        window: root.frame,
        mapping: root.placed.map(|p| p.mapping),
        bounds,
        fields,
        until: Instant::now() + Duration::from_millis(bounds.time_budget_ms),
        visited: 0,
        truncated_by: Vec::new(),
        collected: Vec::new(),
        seen: HashSet::new(),
    };
    let mut path = start.path.clone();
    // 根节点读不到就整体失败：没有根就没有这次观察。
    walk.visit(
        &start.element,
        Some((start.facts.clone(), start.children.clone())),
        start.context,
        &mut path,
        0,
        None,
    )?;
    Ok(Walked {
        completeness: Completeness {
            complete: walk.truncated_by.is_empty(),
            truncated_by: walk.truncated_by,
            filtered_by: select.describe(),
            visited: walk.visited,
        },
        nodes: flatten(walk.collected),
    })
}

struct Walk {
    pid: i32,
    window: Option<Frame>,
    mapping: Option<Mapping>,
    bounds: Bounds,
    fields: Fields,
    until: Instant,
    visited: u32,
    truncated_by: Vec<&'static str>,
    collected: Vec<Collected>,
    /// 本次遍历已输出的身份表编号。应用交回的子节点里可能含祖先，照常展开会逐层复制同一棵子树。
    seen: HashSet<String>,
}

impl Walk {
    fn mark(&mut self, why: &'static str) {
        if !self.truncated_by.contains(&why) {
            self.truncated_by.push(why);
        }
    }

    /// 子节点级失败的处置：超时即整体失败，后面每个节点会各等一次；元素在遍历途中消失是
    /// 常态，记一条截断原因后接着走。
    fn tolerate(&mut self, failure: Failure) -> Result<(), Failure> {
        if failure.is_timeout() {
            return Err(failure);
        }
        if matches!(failure, Failure::Gone { app: false, .. }) {
            self.mark("node_unavailable");
            return Ok(());
        }
        Err(failure)
    }

    fn visit(
        &mut self,
        element: &Element,
        known: Option<(Facts, Vec<Element>)>,
        context: Context,
        path: &mut Vec<usize>,
        depth: u32,
        parent: Option<usize>,
    ) -> Result<(), Failure> {
        let (facts, children) = match known {
            Some(read) => read,
            None => facts(element, self.pid, context, false)?,
        };
        let id = intern(element, &node::check(&facts));
        if !first_sighting(&mut self.seen, &id.to_string()) {
            return Ok(());
        }
        let mut node = node::node(
            &facts,
            context,
            path,
            id,
            self.window,
            self.mapping.as_ref(),
            self.fields,
        );
        node.depth = depth;
        self.visited += 1;
        let index = self.collected.len();
        self.collected.push(Collected { node, parent });
        if depth >= self.bounds.max_depth {
            if !children.is_empty() {
                self.mark("max_depth");
            }
            return Ok(());
        }
        let own = Context::of(&facts);
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
            let built = self.visit(child, None, own, path, depth + 1, Some(index));
            path.pop();
            if let Err(f) = built {
                self.tolerate(f)?;
            }
        }
        Ok(())
    }
}

/// 窗口清单里的一个 AX 窗口。
pub struct Listed {
    /// 协议里的窗口编号：对应上的是 CGWindowID，对不上的是身份表编号的相反数。
    pub window: i64,
    pub pid: i32,
    pub title: String,
    pub subrole: String,
}

/// 此刻的全部窗口：先按层叠序列对应上的，再列对不上的。
///
/// 候选应用取 CGWindowList 里有 0 层窗口的进程；每个应用只问一次 `AXWindows`，第一次调用就
/// 失败的应用跳过：后面每一次都会再等一个消息上界。
pub fn discover() -> Vec<Listed> {
    let cgs = ax::cg_windows();
    let mut pids: Vec<i32> = Vec::new();
    for w in cgs.iter().filter(|w| w.layer == 0) {
        if !pids.contains(&w.pid) {
            pids.push(w.pid);
        }
    }
    let mut found: Vec<(Listed, AxSide)> = Vec::new();
    for pid in pids {
        let windows = match Element::application(pid).elements(attr::WINDOWS) {
            Ok(w) => w,
            Err(code) => {
                eprintln!(
                    "跳过进程 {pid}：{}",
                    fail("读窗口表", pid)(code).into_reason()
                );
                continue;
            }
        };
        for element in windows {
            let Ok(facts) = window_facts(&element, pid) else {
                continue;
            };
            let id = intern(&element, &node::check(&facts));
            found.push((
                Listed {
                    window: associate::unassociated_window(id),
                    pid,
                    title: facts.title.clone(),
                    subrole: facts.subrole.clone(),
                },
                AxSide {
                    pid,
                    frame: facts.frame.map(|f| f.rounded()),
                },
            ));
        }
    }
    let sides: Vec<AxSide> = found.iter().map(|(_, side)| *side).collect();
    let mut ordered: Vec<(usize, Listed)> = found
        .into_iter()
        .enumerate()
        .map(
            |(i, (mut listed, _))| match associate::cg_of(i, &sides, &cgs) {
                Some(at) => {
                    listed.window = i64::from(cgs[at].number);
                    (at, listed)
                }
                None => (usize::MAX, listed),
            },
        )
        .collect();
    // 稳定排序：对不上的窗口保持发现顺序排在最后。
    ordered.sort_by_key(|(at, _)| *at);
    ordered.into_iter().map(|(_, listed)| listed).collect()
}

/// 窗口编号对应的根。
///
/// 负数编号直接查身份表，并核对那一项仍是窗口、核对串没变：身份表里也有控件元素，编号
/// 取错时不能把一个按钮当窗口根。正数编号是 CGWindowID，现读 CG 清单与那个进程的 AX 窗口表，
/// 按 `associate` 的规则找唯一对应的 AX 窗口。
pub fn root(window: i64) -> Result<Root, Failure> {
    if let Some(id) = associate::identity_of_window(window) {
        let lost = || Failure::Refused(format!("{TARGET_LOST}: 编号 {window} 的窗口已经不在"));
        let (element, check) = lookup(id).ok_or_else(lost)?;
        let pid = element.pid().map_err(|_| lost())?;
        let facts = match window_facts(&element, pid) {
            Ok(facts) => facts,
            Err(f) if f.is_gone() => return Err(lost()),
            Err(f) => return Err(f),
        };
        if facts.role != kind::WINDOW || node::check(&facts) != check {
            return Err(lost());
        }
        return Ok(Root {
            element,
            pid,
            cg: None,
            frame: facts.frame,
            placed: None,
        });
    }
    let number = u32::try_from(window)
        .map_err(|_| Failure::Refused(format!("bad_window: {window} 不是 CGWindowID")))?;
    let cgs = ax::cg_windows();
    let Some(at) = cgs.iter().position(|w| w.number == number) else {
        return Err(Failure::Refused(format!(
            "{TARGET_LOST}: 窗口 {window} 已经不在"
        )));
    };
    let pid = cgs[at].pid;
    let windows = Element::application(pid)
        .elements(attr::WINDOWS)
        .map_err(fail("读窗口表", pid))?;
    let mut read = Vec::new();
    for element in windows {
        if let Some(facts) = optional(window_facts(&element, pid))? {
            read.push((element, facts));
        }
    }
    let sides: Vec<AxSide> = read
        .iter()
        .map(|(_, f)| AxSide {
            pid,
            frame: f.frame.map(|f| f.rounded()),
        })
        .collect();
    match associate::ax_of(at, &sides, &cgs) {
        Ok(i) => {
            let (element, facts) = read.swap_remove(i);
            Ok(Root {
                element,
                pid,
                cg: Some(number),
                frame: facts.frame,
                placed: placed_in(&cgs, number),
            })
        }
        Err(Unmatched::None) => Err(Failure::Refused(
            "window_unassociated: 这个窗口没有位置尺寸一致的 AX 窗口".to_owned(),
        )),
        Err(Unmatched::Ambiguous(n)) => Err(Failure::Refused(format!(
            "window_unassociated: 这个窗口的位置尺寸对应 {n} 个 AX 窗口，判不出是哪一个；\
             窗口清单另列了这些窗口，按它们的编号读控件树"
        ))),
    }
}

/// 窗口此刻是否一点都看不见：最小化，或对应上的 CG 窗口不在屏幕上、被前面的窗口完全盖住。
/// 对不上 CG 窗口的只认最小化。
pub fn covered(root: &Root, window: &Facts) -> bool {
    if window.minimized == Some(true) {
        return true;
    }
    let Some(number) = root.cg else {
        return false;
    };
    let cgs: Vec<CgWindow> = ax::cg_windows();
    cgs.iter()
        .position(|w| w.number == number)
        .is_some_and(|at| associate::covered(at, &cgs))
}

/// 这个应用第一次被读控件树之前，请它向 AX 交出完整的树。
///
/// 只对 Electron 应用有效，别的应用回属性不支持，结果不看。不要改写 `AXEnhancedUserInterface`：
/// 应用把它当作读屏软件在场的信号并改变自身行为。
pub fn expose(pid: i32) {
    let _ = Element::application(pid).set(attr::MANUAL_ACCESSIBILITY, &Setting::Bool(true));
}

/// 读一个控件的全文与选区。选区只有一段：`AXSelectedTextRange` 是单个区间，长度为 0 是插入点，
/// 不算选区。
pub fn read_text(
    root: &Root,
    window: i64,
    reference: &str,
    max_chars: u32,
) -> Result<Observation, Failure> {
    let located = locate(root, reference, true)?;
    if located.facts.characters.is_none() {
        return Err(Failure::Refused(
            "pattern_missing: 这个控件没有文本模型（AXNumberOfCharacters）".to_owned(),
        ));
    }
    let Value::Text(text) = &located.facts.value else {
        return Err(Failure::Refused(
            "pattern_missing: 这个控件的 AXValue 不是文本".to_owned(),
        ));
    };
    let (body, clipped) = clip_utf16(text, max_chars);
    let selection = located
        .facts
        .text_range
        .filter(|(_, length)| *length > 0)
        .map(|(start, length)| {
            let (piece, truncated) = clip_utf16(&utf16_slice(text, start, length), max_chars);
            TextSelection {
                start,
                text: piece,
                truncated,
            }
        })
        .into_iter()
        .collect();
    Ok(Observation::Text(Text {
        window,
        captured_at: now_ms(),
        scope: reference.to_owned(),
        text: body,
        truncated: clipped,
        selection_support: if node::text_selectable(&located.facts) {
            "single"
        } else {
            "none"
        },
        selection,
    }))
}
