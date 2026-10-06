//! 经由总线读取控件树：对象的事实、子节点、深度优先遍历、按 `ref` 重新定位，以及注册表
//! 上的应用与其顶层 frame。
//!
//! 子节点顺序只有一处来源：`children` 的 `GetChildren`；窗口根的子节点之后再追加 `root_children`
//! 中的弹出窗口。读树与重新定位共用这两个函数，`ref` 中的下标才能一致；不要在其中一处改用
//! `GetChildAtIndex`，两者的顺序不保证一致。

use std::collections::HashSet;
use std::time::{Duration, Instant};

use atspi::proxy::accessible::AccessibleProxyBlocking;
use atspi::proxy::action::ActionProxyBlocking;
use atspi::proxy::component::ComponentProxyBlocking;
use atspi::proxy::text::TextProxyBlocking;
use atspi::proxy::value::ValueProxyBlocking;
use atspi::{CoordType, Interface, InterfaceSet, State, StateSet};
use zbus::blocking::fdo::DBusProxy;
use zbus::blocking::Connection;
use zbus::zvariant::OwnedObjectPath;

use super::bus::{self, dbus, Failure, Obj, Reference};
use super::node::{self, Context, Facts, Fields, Numbers, VALUE_TEXT_LIMIT};
use crate::geometry::ScreenRect;
use crate::protocol::{Bounds, Completeness, Node, Select, REF_STALE};
use crate::tree::{decode_ref, first_sighting, flatten, Collected};

/// 注册表的根对象：它的子节点是各应用的根。
const REGISTRY: &str = "org.a11y.atspi.Registry";

/// 对象的子节点，顺序即回复中的顺序，空引用不计入。每一项独立成败：无法读取的一项只丢弃
/// 该项本身，其下标保留，不让给后续的兄弟节点。
///
/// 回复按 `a(so)` 原样读取，不要改用 atspi 的 `get_children`：它的引用类型要求总线名是唯一名，
/// 一项众所周知名即会使整条回复解析失败，总线名为空的一项则直接 panic。
pub fn children(conn: &Connection, obj: &Obj) -> Result<Vec<Result<Obj, Failure>>, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let refs: Vec<(String, OwnedObjectPath)> = accessible
        .inner()
        .call("GetChildren", &())
        .map_err(dbus("取子节点"))?;
    Ok(refs
        .iter()
        .filter_map(|(name, path)| {
            Reference::parse(name, path.as_str()).resolve(|name| bus::owner(conn, name))
        })
        .collect())
}

/// 接口上的一项可选读取：应用不应答或对象已经消失时照常向上返回失败，其余失败视为无法读取。
///
/// 不要改为一律向上返回：应用声明了接口而某个属性无法读取是常见情况（Chrome 的部分节点声明
/// Value 接口，读取 `MinimumValue` 时返回 `Get failed`），向上返回会使整个窗口的读取因一个节点而失败。
fn optional<T>(read: Result<T, Failure>) -> Result<Option<T>, Failure> {
    match read {
        Ok(v) => Ok(Some(v)),
        Err(f) if f.is_timeout() || matches!(f, Failure::Gone { .. }) => Err(f),
        Err(_) => Ok(None),
    }
}

/// 读取对象的事实。`fields.value` 为假时不读取文本；数值只在请求状态或对象是滚动条时读取。
///
/// 角色、状态、接口与名称必须读取成功，无法读取即该节点失败；其余各接口的读取见 `optional`。
pub fn facts(conn: &Connection, obj: &Obj, fields: Fields) -> Result<Facts, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let role = accessible.get_role().map_err(dbus("读取角色"))?;
    let states = accessible.get_state().map_err(dbus("读取状态"))?;
    let interfaces = accessible.get_interfaces().map_err(dbus("读取接口"))?;
    let name = accessible.name().map_err(dbus("读取名称"))?;
    // 2.34 之前的 AT-SPI 没有该属性：无法读取时按空串处理，与应用未设置含义相同。
    let accessible_id =
        optional(accessible.accessible_id().map_err(dbus("读取稳定标识")))?.unwrap_or_default();
    let extents = if interfaces.contains(Interface::Component) {
        let component: ComponentProxyBlocking = obj.proxy(conn)?;
        optional(
            component
                .get_extents(CoordType::Screen)
                .map_err(dbus("读取包围盒")),
        )?
        .and_then(|(x, y, w, h)| node::extents(x, y, w, h))
    } else {
        None
    };
    let actions = if interfaces.contains(Interface::Action) {
        let action: ActionProxyBlocking = obj.proxy(conn)?;
        // 任一动作名无法读取即丢弃整张动作表：下标不一致时按名称选中的是其他动作。
        optional((|| {
            let n = action.n_actions().map_err(dbus("读取动作数"))?;
            (0..n)
                .map(|index| action.get_name(index).map_err(dbus("读取动作名")))
                .collect::<Result<Vec<_>, _>>()
        })())?
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let value = if interfaces.contains(Interface::Value)
        && (fields.state || role == atspi::Role::ScrollBar)
    {
        optional(numbers(conn, obj))?
    } else {
        None
    };
    let text = if interfaces.contains(Interface::Text) && fields.value {
        let text: TextProxyBlocking = obj.proxy(conn)?;
        optional((|| {
            let count = text.character_count().map_err(dbus("读取字符数"))?;
            if (0..=VALUE_TEXT_LIMIT).contains(&count) {
                text.get_text(0, count).map(Some).map_err(dbus("读取文本"))
            } else {
                Ok(None)
            }
        })())?
        .flatten()
    } else {
        None
    };
    Ok(Facts {
        role,
        name,
        accessible_id,
        states,
        interfaces,
        actions,
        extents,
        value,
        text,
    })
}

/// 对象当前的屏幕包围盒。无法读取或尚未布局时缺失，读取规则见 `optional`。
fn screen_rect(conn: &Connection, obj: &Obj) -> Result<Option<ScreenRect>, Failure> {
    let component: ComponentProxyBlocking = obj.proxy(conn)?;
    Ok(optional(
        component
            .get_extents(CoordType::Screen)
            .map_err(dbus("读取包围盒")),
    )?
    .and_then(|(x, y, w, h)| node::extents(x, y, w, h)))
}

/// Value 接口当前的四个数值。
pub fn numbers(conn: &Connection, obj: &Obj) -> Result<Numbers, Failure> {
    let value: ValueProxyBlocking = obj.proxy(conn)?;
    Ok(Numbers {
        current: value.current_value().map_err(dbus("读取当前值"))?,
        min: value.minimum_value().map_err(dbus("读取下界"))?,
        max: value.maximum_value().map_err(dbus("读取上界"))?,
        increment: value.minimum_increment().map_err(dbus("读取步长"))?,
    })
}

/// 父对象中与子节点可用动作相关的事实，`grandparent` 是父对象的父对象。
pub fn context_of(
    conn: &Connection,
    obj: &Obj,
    grandparent: Option<&Obj>,
) -> Result<Context, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let role = accessible.get_role().map_err(dbus("读取父节点角色"))?;
    let states = accessible.get_state().map_err(dbus("读取父节点状态"))?;
    let interfaces = accessible.get_interfaces().map_err(dbus("读取父节点接口"))?;
    let above = match grandparent {
        Some(grandparent) => {
            let accessible: AccessibleProxyBlocking = grandparent.proxy(conn)?;
            let role = accessible
                .get_role()
                .map_err(dbus("读取父节点的父节点角色"))?;
            Context::of(
                role,
                StateSet::empty(),
                InterfaceSet::empty(),
                Context::default(),
            )
        }
        None => Context::default(),
    };
    Ok(Context::of(role, states, interfaces, above))
}

/// 目标窗口拥有的弹出窗口：应用顶层中对应的对象及其屏幕矩形。读树与重新定位将弹出窗口追加在
/// 窗口根自身的子节点之后，下标从窗口根的子节点数开始递增。
#[derive(Debug, Clone)]
pub struct Popup {
    pub obj: Obj,
    pub rect: ScreenRect,
}

/// 窗口根在树中的子节点：其自身的子节点，后接目标窗口拥有的弹出窗口。第二项是自身的子节点数。
fn root_children(
    conn: &Connection,
    root: &Obj,
    popups: &[Popup],
) -> Result<(Vec<Result<Obj, Failure>>, usize), Failure> {
    let mut kids = children(conn, root)?;
    let own = kids.len();
    kids.extend(popups.iter().map(|p| Ok(p.obj.clone())));
    Ok((kids, own))
}

/// 按 `ref` 重新定位的结果。
pub struct Located {
    pub obj: Obj,
    pub path: Vec<usize>,
    pub facts: Facts,
    /// 父对象的事实。目标即窗口根时取默认值：根节点没有可经由父对象更改的选择。
    pub context: Context,
    /// 父对象。目标即窗口根时缺失。
    pub parent: Option<Obj>,
    /// 目标绘制在弹出窗口中时，该弹出窗口内容的屏幕矩形：目标所在的组合框下拉列表，或路径
    /// 起始处的弹出窗口。目标不在弹出窗口中或无法读取时缺失。
    pub popup: Option<ScreenRect>,
}

/// 从窗口根出发按下标路径重新定位，并核对身份段与核对串，见 `node::verify`。`popups` 与读树时
/// 追加在窗口根之后的是同一份，见 `Popup`。
pub fn locate(
    conn: &Connection,
    root: &Obj,
    popups: &[Popup],
    reference: &str,
    fields: Fields,
) -> Result<Located, Failure> {
    let expected = decode_ref(reference).map_err(Failure::Refused)?;
    let mut obj = root.clone();
    let mut parent: Option<Obj> = None;
    let mut grandparent: Option<Obj> = None;
    let mut popup = None;
    for (depth, index) in expected.path.iter().enumerate() {
        let kids = if depth == 0 {
            let (kids, own) = root_children(conn, &obj, popups)?;
            popup = index
                .checked_sub(own)
                .and_then(|i| popups.get(i))
                .map(|p| p.rect);
            kids
        } else {
            children(conn, &obj)?
        };
        let Some(child) = kids.into_iter().nth(*index) else {
            return Err(Failure::Refused(format!(
                "{REF_STALE}: 第 {depth} 层没有下标 {index} 的子节点"
            )));
        };
        grandparent = parent.replace(std::mem::replace(&mut obj, child?));
    }
    let facts = facts(conn, &obj, fields)?;
    node::verify(&expected, &obj.key(), &facts).map_err(Failure::Refused)?;
    let context = match &parent {
        Some(parent) => context_of(conn, parent, grandparent.as_ref())?,
        None => Context::default(),
    };
    if context.dropdown {
        if let Some(parent) = &parent {
            popup = screen_rect(conn, parent)?;
        }
    }
    Ok(Located {
        obj,
        path: expected.path,
        facts,
        context,
        parent,
        popup,
    })
}

/// 判断应用顶层对象是否为其子节点的父对象。GTK 把组合框下拉菜单所在的弹出窗口也列为
/// 应用顶层，而下拉菜单把组合框报告为父对象：该内容已位于组合框之下，不再追加一次。
pub fn owns_children(conn: &Connection, top: &Obj) -> Result<bool, Failure> {
    let Some(first) = children(conn, top)?.into_iter().next() else {
        return Ok(false);
    };
    let accessible: AccessibleProxyBlocking = first?.proxy(conn)?;
    let (name, path): (String, OwnedObjectPath) = accessible
        .inner()
        .get_property("Parent")
        .map_err(dbus("读取父对象"))?;
    let parent = Reference::parse(&name, path.as_str()).resolve(|name| bus::owner(conn, name));
    Ok(matches!(parent, Some(Ok(p)) if p == *top))
}

/// 一次遍历的结果。
pub struct Walked {
    pub nodes: Vec<Node>,
    pub completeness: Completeness,
}

/// 从 `root`（位于窗口中 `root_path` 处）开始深度优先读取，三个上限针对的是已遍历的节点数。
/// 从窗口根读取时 `popups` 追加在其自身的子节点之后，见 `Popup`。
pub fn walk(
    conn: &Connection,
    root: &Located,
    popups: &[Popup],
    select: &Select,
    bounds: Bounds,
    fields: Fields,
) -> Result<Walked, Failure> {
    let mut walk = Walk {
        conn,
        popups,
        bounds,
        fields,
        until: Instant::now() + Duration::from_millis(bounds.time_budget_ms),
        visited: 0,
        truncated_by: Vec::new(),
        collected: Vec::new(),
        seen: HashSet::new(),
    };
    let mut path = root.path.clone();
    // 根节点无法读取即整体失败：没有根节点，本次观察不成立。
    walk.visit(
        &root.obj,
        Some(&root.facts),
        root.context,
        &mut path,
        0,
        None,
    )?;
    let completeness = Completeness {
        complete: walk.truncated_by.is_empty(),
        truncated_by: walk.truncated_by,
        filtered_by: select.describe(),
        visited: walk.visited,
    };
    Ok(Walked {
        nodes: flatten(walk.collected),
        completeness,
    })
}

struct Walk<'a> {
    conn: &'a Connection,
    popups: &'a [Popup],
    bounds: Bounds,
    fields: Fields,
    until: Instant,
    visited: u32,
    truncated_by: Vec<&'static str>,
    collected: Vec<Collected>,
    /// 本次遍历已输出的对象。应用返回的子节点中可能包含祖先，照常展开会逐层复制同一棵子树。
    seen: HashSet<String>,
}

impl Walk<'_> {
    fn mark(&mut self, why: &'static str) {
        if !self.truncated_by.contains(&why) {
            self.truncated_by.push(why);
        }
    }

    /// 子节点级失败的处理：超时即整体失败，否则后续每个节点都会各等待一次超时；对象在遍历过程中
    /// 消失属于常见情况，记录一条截断原因后继续遍历。
    fn tolerate(&mut self, failure: Failure) -> Result<(), Failure> {
        if failure.is_timeout() {
            return Err(failure);
        }
        if matches!(failure, Failure::Gone { .. }) {
            self.mark("node_unavailable");
            return Ok(());
        }
        Err(failure)
    }

    fn visit(
        &mut self,
        obj: &Obj,
        known: Option<&Facts>,
        context: Context,
        path: &mut Vec<usize>,
        depth: u32,
        parent: Option<usize>,
    ) -> Result<(), Failure> {
        let key = obj.key();
        if !first_sighting(&mut self.seen, &key) {
            return Ok(());
        }
        let facts = match known {
            Some(f) => f.clone(),
            None => facts(self.conn, obj, self.fields)?,
        };
        let mut node = node::node(&facts, context, path, &key, self.fields);
        node.depth = depth;
        self.visited += 1;
        let index = self.collected.len();
        self.collected.push(Collected { node, parent });
        if depth >= self.bounds.max_depth {
            self.mark("max_depth");
            return Ok(());
        }
        let kids = if path.is_empty() {
            root_children(self.conn, obj, self.popups).map(|(kids, _)| kids)
        } else {
            children(self.conn, obj)
        };
        let kids = match kids {
            Ok(k) => k,
            Err(f) => return self.tolerate(f),
        };
        let own = Context::of(facts.role, facts.states, facts.interfaces, context);
        // 下标照常递增：跳过一个子节点不得改变其后兄弟节点的 ref。引用无法读取的一项与读取中途
        // 消失的子节点按同样方式处理。
        for (offset, child) in kids.into_iter().enumerate() {
            if self.visited >= self.bounds.max_nodes {
                self.mark("max_nodes");
                break;
            }
            if Instant::now() >= self.until {
                self.mark("time_budget");
                break;
            }
            path.push(offset);
            let built =
                child.and_then(|child| self.visit(&child, None, own, path, depth + 1, Some(index)));
            path.pop();
            if let Err(f) = built {
                self.tolerate(f)?;
            }
        }
        Ok(())
    }
}

/// 注册表上的一个应用。
pub struct App {
    pub root: Obj,
    /// 总线连接的进程号，由总线守护进程给出，不经应用。无法读取时为 0。
    pub pid: u32,
}

/// 注册表上的全部应用，每个根对象只出现一次。只查询注册表与总线守护进程，不经由任何应用。
pub fn apps(conn: &Connection) -> Result<Vec<App>, Failure> {
    let registry = Obj::root_of(REGISTRY);
    let roots = unique(
        children(conn, &registry)?
            .into_iter()
            .filter_map(|root| {
                root.map_err(|e| eprintln!("跳过注册表中的一项：{}", e.into_reason()))
                    .ok()
            })
            .collect(),
    );
    let daemon = DBusProxy::new(conn).map_err(dbus("创建总线守护进程代理"))?;
    Ok(roots
        .into_iter()
        .map(|root| {
            let pid = zbus::names::BusName::try_from(root.bus.as_str())
                .ok()
                .and_then(|name| daemon.get_connection_unix_process_id(name).ok())
                .unwrap_or(0);
            App { root, pid }
        })
        .collect())
}

/// 同一对象（总线唯一名 + 对象路径）只保留首次出现的一项，其余顺序不变。
///
/// 注册表会把同一个应用列出两次（无障碍总线重启、应用重新注册之后实测如此）。不去重时该应用的
/// 每个 frame 都出现两次：标题与位置相同的两个 frame 使窗口关联判定为不唯一，窗口清单中同一个
/// 编号出现两次。
fn unique(objs: Vec<Obj>) -> Vec<Obj> {
    let mut seen = HashSet::new();
    objs.into_iter().filter(|o| seen.insert(o.clone())).collect()
}

/// 一个应用的顶层 frame。
pub struct Frame {
    pub obj: Obj,
    pub title: String,
    pub pid: u32,
    pub rect: Option<crate::geometry::ScreenRect>,
}

/// 一组应用当前可见的顶层 frame。
///
/// 应用根对象的子节点即其顶层窗口，角色不固定（Qt 的普通顶层控件报告为 `filler`），因此
/// 不按角色筛选，只保留带 `visible` 状态的项。某个应用的调用一旦超时，即跳过该应用其余的调用：
/// 否则后续每次调用都会再等待一个超时上限。
pub fn frames<'a>(conn: &Connection, apps: impl IntoIterator<Item = &'a App>) -> Vec<Frame> {
    let mut out = Vec::new();
    for app in apps {
        let tops = match children(conn, &app.root) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("跳过应用 {}：{}", app.root.bus, e.into_reason());
                continue;
            }
        };
        for top in tops {
            match top.and_then(|obj| frame(conn, &obj, app.pid)) {
                Ok(Some(f)) => out.push(f),
                Ok(None) => {}
                Err(e) if e.is_timeout() => {
                    eprintln!("跳过应用 {}：{}", app.root.bus, e.into_reason());
                    break;
                }
                Err(_) => {}
            }
        }
    }
    out
}

fn frame(conn: &Connection, obj: &Obj, pid: u32) -> Result<Option<Frame>, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let states = accessible.get_state().map_err(dbus("读取 frame 状态"))?;
    if !states.contains(State::Visible) {
        return Ok(None);
    }
    let title = accessible.name().map_err(dbus("读取 frame 名称"))?;
    let component: ComponentProxyBlocking = obj.proxy(conn)?;
    let rect = optional(
        component
            .get_extents(CoordType::Screen)
            .map_err(dbus("读取 frame 包围盒")),
    )?
    .and_then(|(x, y, w, h)| node::extents(x, y, w, h));
    Ok(Some(Frame {
        obj: obj.clone(),
        title,
        pid,
        rect,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 可选读取只忽略普通读取失败，不忽略超时与对象消失：前者须整体失败，后者须记录截断。
    #[test]
    fn an_optional_read_swallows_only_plain_failures() {
        assert!(matches!(optional(Ok::<_, Failure>(3)), Ok(Some(3))));
        assert!(matches!(
            optional::<u8>(Err(Failure::Bus("Get failed".to_owned()))),
            Ok(None)
        ));
        assert!(optional::<u8>(Err(Failure::Timeout("t".to_owned()))).is_err());
        let gone = Failure::Gone {
            app: false,
            text: "g".to_owned(),
        };
        assert!(optional::<u8>(Err(gone)).is_err());
    }

    /// 注册表把同一个应用列出两次时只保留一项，其他应用与顺序不变；总线名相同而路径不同的是两个对象。
    #[test]
    fn a_registry_entry_listed_twice_is_kept_once() {
        let obj = |bus: &str, path: &str| Obj {
            bus: bus.to_owned(),
            path: path.to_owned(),
        };
        let root = "/org/a11y/atspi/accessible/root";
        let listed = vec![
            obj(":1.4", root),
            obj(":1.9", root),
            obj(":1.9", root),
            obj(":1.4", root),
            obj(":1.9", "/org/a11y/atspi/accessible/7"),
        ];
        assert_eq!(
            unique(listed),
            vec![
                obj(":1.4", root),
                obj(":1.9", root),
                obj(":1.9", "/org/a11y/atspi/accessible/7"),
            ]
        );
    }
}
