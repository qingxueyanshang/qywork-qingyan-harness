//! 经总线读控件树：一个对象的事实、子节点、深度优先遍历、按 `ref` 重新定位，以及注册表
//! 上的应用与它们的顶层 frame。
//!
//! 子节点顺序只有一处来源：`children` 的 `GetChildren`，窗口根再接上 `root_children` 里的弹出
//! 窗口。读树与重新定位共用它们，`ref` 里的下标才对得上；不要在一处改用 `GetChildAtIndex`，
//! 两者的顺序不保证一致。

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

/// 一个对象的子节点，顺序即回复里的顺序，空引用不计。每一格各自成败：读不出的那一格只丢它
/// 自己，占着的下标不让给后面的兄弟。
///
/// 回复按 `a(so)` 原样取，不要改用 atspi 的 `get_children`：它的引用类型要求总线名是唯一名，
/// 一格众所周知名就让整条回复解析失败，总线名为空的一格则直接 panic。
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

/// 接口上的一项可选读取：应用不应答或对象已经消失照常交出去，其余失败按读不到算。
///
/// 不要改成一律交出去：应用声明了接口而某个属性读不出来是常态（Chrome 的部分节点声明
/// Value 接口，读 `MinimumValue` 回 `Get failed`），交出去会让整窗读取为一个节点失败。
fn optional<T>(read: Result<T, Failure>) -> Result<Option<T>, Failure> {
    match read {
        Ok(v) => Ok(Some(v)),
        Err(f) if f.is_timeout() || matches!(f, Failure::Gone { .. }) => Err(f),
        Err(_) => Ok(None),
    }
}

/// 读一个对象的事实。`fields.value` 为假时不读文本；数值只在要状态、或对象是滚动条时读。
///
/// 角色、状态、接口与名称必须读到，读不到即这个节点失败；其余各接口的读取见 `optional`。
pub fn facts(conn: &Connection, obj: &Obj, fields: Fields) -> Result<Facts, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let role = accessible.get_role().map_err(dbus("读角色"))?;
    let states = accessible.get_state().map_err(dbus("读状态"))?;
    let interfaces = accessible.get_interfaces().map_err(dbus("读接口"))?;
    let name = accessible.name().map_err(dbus("读名称"))?;
    // 2.34 之前的 AT-SPI 没有这一项：读不到按空串算，与应用没设置同一个含义。
    let accessible_id =
        optional(accessible.accessible_id().map_err(dbus("读稳定标识")))?.unwrap_or_default();
    let extents = if interfaces.contains(Interface::Component) {
        let component: ComponentProxyBlocking = obj.proxy(conn)?;
        optional(
            component
                .get_extents(CoordType::Screen)
                .map_err(dbus("读包围盒")),
        )?
        .and_then(|(x, y, w, h)| node::extents(x, y, w, h))
    } else {
        None
    };
    let actions = if interfaces.contains(Interface::Action) {
        let action: ActionProxyBlocking = obj.proxy(conn)?;
        // 动作名缺一个就整张不要：下标对不上时按名字挑出来的是别的动作。
        optional((|| {
            let n = action.n_actions().map_err(dbus("读动作数"))?;
            (0..n)
                .map(|index| action.get_name(index).map_err(dbus("读动作名")))
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
            let count = text.character_count().map_err(dbus("读字符数"))?;
            if (0..=VALUE_TEXT_LIMIT).contains(&count) {
                text.get_text(0, count).map(Some).map_err(dbus("读文本"))
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

/// 对象此刻的屏幕包围盒。读不出或尚未摆放时缺席，读取见 `optional`。
fn screen_rect(conn: &Connection, obj: &Obj) -> Result<Option<ScreenRect>, Failure> {
    let component: ComponentProxyBlocking = obj.proxy(conn)?;
    Ok(optional(
        component
            .get_extents(CoordType::Screen)
            .map_err(dbus("读包围盒")),
    )?
    .and_then(|(x, y, w, h)| node::extents(x, y, w, h)))
}

/// Value 接口此刻的四个数。
pub fn numbers(conn: &Connection, obj: &Obj) -> Result<Numbers, Failure> {
    let value: ValueProxyBlocking = obj.proxy(conn)?;
    Ok(Numbers {
        current: value.current_value().map_err(dbus("读当前值"))?,
        min: value.minimum_value().map_err(dbus("读下界"))?,
        max: value.maximum_value().map_err(dbus("读上界"))?,
        increment: value.minimum_increment().map_err(dbus("读步长"))?,
    })
}

/// 父对象里与子节点可用动作有关的事实，`grandparent` 是父对象的父对象。
pub fn context_of(
    conn: &Connection,
    obj: &Obj,
    grandparent: Option<&Obj>,
) -> Result<Context, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let role = accessible.get_role().map_err(dbus("读父节点角色"))?;
    let states = accessible.get_state().map_err(dbus("读父节点状态"))?;
    let interfaces = accessible.get_interfaces().map_err(dbus("读父节点接口"))?;
    let above = match grandparent {
        Some(grandparent) => {
            let accessible: AccessibleProxyBlocking = grandparent.proxy(conn)?;
            let role = accessible
                .get_role()
                .map_err(dbus("读父节点的父节点角色"))?;
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

/// 目标窗口拥有的一个弹出窗口：应用顶层里的那个对象与它的屏幕矩形。读树与重新定位把它们接在
/// 窗口根自己的子节点后面，下标从窗口根的子节点数往后排。
#[derive(Debug, Clone)]
pub struct Popup {
    pub obj: Obj,
    pub rect: ScreenRect,
}

/// 窗口根在树里的子节点：它自己的子节点，接上目标窗口拥有的弹出窗口。第二项是自己的子节点数。
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
    /// 父对象的事实。目标就是窗口根时取默认值：根没有可经父对象改的选择。
    pub context: Context,
    /// 父对象。目标就是窗口根时缺席。
    pub parent: Option<Obj>,
    /// 目标画在弹出窗口里时，那个弹出窗口里内容的屏幕矩形：目标所在的组合框下拉列表，或路径
    /// 起头的那个弹出窗口。不在弹出窗口里或读不出时缺席。
    pub popup: Option<ScreenRect>,
}

/// 从窗口根出发按下标路径重新定位，并核对身份段与核对串，见 `node::verify`。`popups` 与读树时
/// 接在窗口根后面的是同一份，见 `Popup`。
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

/// 一个应用顶层对象是不是它自己那些子节点的父对象。GTK 把组合框下拉菜单所在的弹出窗口也列成
/// 应用顶层，而下拉菜单把组合框报成父对象：那份内容已经在组合框底下，不再接一次。
pub fn owns_children(conn: &Connection, top: &Obj) -> Result<bool, Failure> {
    let Some(first) = children(conn, top)?.into_iter().next() else {
        return Ok(false);
    };
    let accessible: AccessibleProxyBlocking = first?.proxy(conn)?;
    let (name, path): (String, OwnedObjectPath) = accessible
        .inner()
        .get_property("Parent")
        .map_err(dbus("读父对象"))?;
    let parent = Reference::parse(&name, path.as_str()).resolve(|name| bus::owner(conn, name));
    Ok(matches!(parent, Some(Ok(p)) if p == *top))
}

/// 一次遍历的结果。
pub struct Walked {
    pub nodes: Vec<Node>,
    pub completeness: Completeness,
}

/// 从 `root`（位于窗口里 `root_path` 处）开始深度优先读，三个上限限的是遍历过的节点数。
/// 从窗口根读时 `popups` 接在它自己的子节点后面，见 `Popup`。
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
    // 根节点读不到就整体失败：没有根就没有这次观察。
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
    /// 本次遍历已输出的对象。应用交回的子节点里可能含祖先，照常展开会逐层复制同一棵子树。
    seen: HashSet<String>,
}

impl Walk<'_> {
    fn mark(&mut self, why: &'static str) {
        if !self.truncated_by.contains(&why) {
            self.truncated_by.push(why);
        }
    }

    /// 子节点级失败的处置：超时即整体失败，后面每个节点会各等一次；对象在遍历途中消失是
    /// 常态，记一条截断原因后接着走。
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
        // 下标照常递增：跳过一个子节点不能让它后面的兄弟换 ref。引用读不出的一格与读到一半
        // 消失的子节点同样处置。
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
    /// 总线连接的进程号，由总线守护进程给出，不经应用。读不到时为 0。
    pub pid: u32,
}

/// 注册表上的全部应用，每个根对象只出现一次。只问注册表与总线守护进程，不经任何应用。
pub fn apps(conn: &Connection) -> Result<Vec<App>, Failure> {
    let registry = Obj::root_of(REGISTRY);
    let roots = unique(
        children(conn, &registry)?
            .into_iter()
            .filter_map(|root| {
                root.map_err(|e| eprintln!("跳过注册表里的一项：{}", e.into_reason()))
                    .ok()
            })
            .collect(),
    );
    let daemon = DBusProxy::new(conn).map_err(dbus("建总线守护进程代理"))?;
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

/// 同一个对象（总线唯一名 + 对象路径）只留第一次出现的那一个，其余顺序不变。
///
/// 注册表会把同一个应用列两遍（无障碍总线重启、应用重新注册之后实测如此）。不去重的话它的
/// 每个 frame 都出现两次：两份同标题同位置的 frame 让窗口关联判成不唯一，窗口清单里同一个
/// 编号列两遍。
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

/// 一组应用此刻可见的顶层 frame。
///
/// 应用的根对象的子节点就是它的顶层窗口，角色不定（Qt 的普通顶层控件报 `filler`），所以
/// 不按角色筛，只留带 `visible` 的。一个应用第一次调用就超时，跳过它剩下的调用：
/// 后面每一次都会再等一个上界。
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
    let states = accessible.get_state().map_err(dbus("读 frame 状态"))?;
    if !states.contains(State::Visible) {
        return Ok(None);
    }
    let title = accessible.name().map_err(dbus("读 frame 名称"))?;
    let component: ComponentProxyBlocking = obj.proxy(conn)?;
    let rect = optional(
        component
            .get_extents(CoordType::Screen)
            .map_err(dbus("读 frame 包围盒")),
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

    /// 可选读取只吞掉「读不出来」，不吞超时与对象消失：前者要整体失败，后者要记截断。
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

    /// 注册表把同一个应用列两遍时只留一个，别的应用与顺序不动；总线名相同而路径不同的是两个对象。
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
