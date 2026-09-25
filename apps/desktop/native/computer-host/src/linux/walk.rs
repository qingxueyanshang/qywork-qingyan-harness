//! 经总线读控件树：一个对象的事实、子节点、深度优先遍历、按 `ref` 重新定位，以及注册表
//! 上的应用与它们的顶层 frame。
//!
//! 子节点顺序只有一处来源：`children` 的 `GetChildren`。读树与重新定位共用它，`ref` 里的
//! 下标才对得上；不要在一处改用 `GetChildAtIndex`，两者的顺序不保证一致。

use std::collections::HashSet;
use std::time::{Duration, Instant};

use atspi::proxy::accessible::AccessibleProxyBlocking;
use atspi::proxy::action::ActionProxyBlocking;
use atspi::proxy::component::ComponentProxyBlocking;
use atspi::proxy::text::TextProxyBlocking;
use atspi::proxy::value::ValueProxyBlocking;
use atspi::{CoordType, Interface, State};
use zbus::blocking::fdo::DBusProxy;
use zbus::blocking::Connection;

use super::bus::{dbus, Failure, Obj};
use super::node::{self, Context, Facts, Fields, Numbers, VALUE_TEXT_LIMIT};
use crate::protocol::{Bounds, Completeness, Node, Select, REF_STALE};
use crate::tree::{decode_ref, first_sighting, flatten, Collected, Identity};

/// 注册表的根对象：它的子节点是各应用的根。
const REGISTRY: &str = "org.a11y.atspi.Registry";

pub fn children(conn: &Connection, obj: &Obj) -> Result<Vec<Obj>, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let refs = accessible.get_children().map_err(dbus("取子节点"))?;
    Ok(refs.iter().filter_map(Obj::from_ref).collect())
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
    let accessible_id = optional(accessible.accessible_id().map_err(dbus("读稳定标识")))?
        .unwrap_or_default();
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

/// 父对象里与子节点可用动作有关的事实：接口与状态，两次调用。
pub fn context_of(conn: &Connection, obj: &Obj) -> Result<Context, Failure> {
    let accessible: AccessibleProxyBlocking = obj.proxy(conn)?;
    let states = accessible.get_state().map_err(dbus("读父节点状态"))?;
    let interfaces = accessible.get_interfaces().map_err(dbus("读父节点接口"))?;
    Ok(Context {
        selection: interfaces.contains(Interface::Selection),
        showing: states.contains(State::Showing),
        multiselectable: states.contains(State::Multiselectable),
    })
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
}

/// 从窗口根出发按下标路径重新定位，并核对身份段：对象串与指纹都要对上。
pub fn locate(
    conn: &Connection,
    root: &Obj,
    reference: &str,
    fields: Fields,
) -> Result<Located, Failure> {
    let (path, expected) = decode_ref(reference).map_err(Failure::Refused)?;
    let mut obj = root.clone();
    let mut parent: Option<Obj> = None;
    for (depth, index) in path.iter().enumerate() {
        let kids = children(conn, &obj)?;
        let Some(child) = kids.get(*index).cloned() else {
            return Err(Failure::Refused(format!(
                "{REF_STALE}: 第 {depth} 层没有下标 {index} 的子节点"
            )));
        };
        parent = Some(std::mem::replace(&mut obj, child));
    }
    let facts = facts(conn, &obj, fields)?;
    let actual = node::identity(&obj.key(), &facts);
    if actual != expected {
        return Err(Failure::Refused(format!(
            "{REF_STALE}: 该位置现在是 {}，ref 里记的是 {}；对象路径与角色、名称、稳定标识都一致才算同一个控件，请重新观察",
            describe(&actual),
            describe(&expected)
        )));
    }
    let context = match &parent {
        Some(parent) => context_of(conn, parent)?,
        None => Context::default(),
    };
    Ok(Located {
        obj,
        path,
        facts,
        context,
        parent,
    })
}

fn describe(identity: &Identity) -> String {
    match identity {
        Identity::Stable(id) => id.clone(),
        Identity::Attributes(print) => format!("~{print}"),
    }
}

/// 一次遍历的结果。
pub struct Walked {
    pub nodes: Vec<Node>,
    pub completeness: Completeness,
}

/// 从 `root`（位于窗口里 `root_path` 处）开始深度优先读，三个上限限的是遍历过的节点数。
pub fn walk(
    conn: &Connection,
    root: &Located,
    select: &Select,
    bounds: Bounds,
    fields: Fields,
) -> Result<Walked, Failure> {
    let mut walk = Walk {
        conn,
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
        let kids = match children(self.conn, obj) {
            Ok(k) => k,
            Err(f) => return self.tolerate(f),
        };
        let own = Context::of(&facts);
        // 下标照常递增：跳过一个子节点不能让它后面的兄弟换 ref。
        for (offset, child) in kids.iter().enumerate() {
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

/// 注册表上的一个应用。
pub struct App {
    pub root: Obj,
    /// 总线连接的进程号，由总线守护进程给出，不经应用。读不到时为 0。
    pub pid: u32,
}

/// 注册表上的全部应用。只问注册表与总线守护进程，不经任何应用。
pub fn apps(conn: &Connection) -> Result<Vec<App>, Failure> {
    let registry = Obj::root_of(REGISTRY);
    let roots = children(conn, &registry)?;
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
        for obj in tops {
            match frame(conn, &obj, app.pid) {
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
}
