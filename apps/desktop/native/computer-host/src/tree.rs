//! 控件树中与平台无关的部分：控件身份与 `ref` 编解码、遍历结果展平、首次读取的稳定判定、
//! 等待 `appears` 的匹配。
//!
//! 本模块不调用任何 OS 接口。各后端读取平台的控件树，按本模块的规则生成 `ref` 并组成控件表。

use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::protocol::Node;

/// 一个控件的身份。
///
/// `Stable` 是平台提供的、控件存在期间不变的标识（Windows 为 RuntimeId）；平台无法提供时
/// 回退到角色、名称与稳定标识的指纹，并在观察中把该控件标记为弱身份。**两种身份不相等**，
/// 即使字面量恰好相同。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    Stable(String),
    Attributes(String),
}

impl Identity {
    pub fn is_weak(&self) -> bool {
        matches!(self, Self::Attributes(_))
    }

    /// 写入 `ref` 的身份段。弱身份带 `~` 前缀，解码时据此区分。
    fn encode(&self) -> String {
        match self {
            Self::Stable(id) => id.clone(),
            Self::Attributes(print) => format!("~{print}"),
        }
    }

    fn decode(segment: &str) -> Self {
        match segment.strip_prefix('~') {
            Some(print) => Self::Attributes(print.to_owned()),
            None => Self::Stable(segment.to_owned()),
        }
    }
}

/// 角色、名称与稳定标识的指纹。使用 FNV-1a：长度足够短，且碰撞概率可忽略。
///
/// 三项用不会出现在取值中的分隔符拼接后再计算：直接连接时，`("ab","c")` 与 `("a","bc")`
/// 会得到同一个指纹。
pub fn fingerprint(role: &str, name: &str, automation_id: &str) -> String {
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

/// 解码后的 `ref`：下标路径、可选的核对串与身份段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefParts {
    pub path: Vec<usize>,
    /// 重新定位时与身份段一起核对的字符串。只有身份段本身无法识别对象复用的后端才携带此项。
    pub check: Option<String>,
    pub identity: Identity,
}

/// `ref` 的编码：`w` 加逐层子节点下标，可选的 `@核对串`，`#` 后是身份段。
///
/// 核对串放在 `#` 之前：协调器按 `#` 之后的身份段分配短编号，放入身份段的内容一旦变化，
/// 编号随之改变。不带核对串的 `ref` 只含下标路径与身份段。
pub fn encode_ref(path: &[usize], check: Option<&str>, identity: &Identity) -> String {
    let mut out = String::from("w");
    for index in path {
        out.push('.');
        out.push_str(&index.to_string());
    }
    if let Some(check) = check {
        out.push('@');
        out.push_str(check);
    }
    out.push('#');
    out.push_str(&identity.encode());
    out
}

pub fn decode_ref(reference: &str) -> Result<RefParts, String> {
    let bad = || format!("bad_ref: {reference}");
    let Some((head, identity)) = reference.split_once('#') else {
        return Err(bad());
    };
    let (path, check) = match head.split_once('@') {
        Some((_, "")) => return Err(bad()),
        Some((path, check)) => (path, Some(check.to_owned())),
        None => (head, None),
    };
    let mut segments = path.split('.');
    if segments.next() != Some("w") {
        return Err(bad());
    }
    let mut indexes = Vec::new();
    for segment in segments {
        indexes.push(segment.parse::<usize>().map_err(|_| bad())?);
    }
    Ok(RefParts {
        path: indexes,
        check,
        identity: Identity::decode(identity),
    })
}

/// 一个节点及其父节点在前序表中的下标。
pub struct Collected {
    pub node: Node,
    pub parent: Option<usize>,
}

/// 展平收集到的节点：把父节点下标替换为父节点的 `ref`，顺序不变。
pub fn flatten(collected: Vec<Collected>) -> Vec<Node> {
    let refs: Vec<String> = collected.iter().map(|c| c.node.reference.clone()).collect();
    collected
        .into_iter()
        .map(|entry| {
            let mut node = entry.node;
            node.parent_ref = entry.parent.map(|at| refs[at].clone());
            node
        })
        .collect()
}

/// 判断该稳定身份在本次遍历中是否首次出现，并登记该身份。
///
/// 空串表示没有稳定身份的弱身份，一律视为首次出现：弱身份按属性指纹识别，两个不同的控件
/// 可能指纹相同，按指纹去重会丢失真实控件。集合只在一次遍历内有效：稳定身份在不同时刻可能被复用。
pub fn first_sighting(seen: &mut HashSet<String>, stable: &str) -> bool {
    stable.is_empty() || seen.insert(stable.to_owned())
}

/// 判断一个节点是否满足等待 `appears` 的条件。两项均未给出时任何节点都满足。
///
/// 角色逐字比较：调用方给出的角色必须是协议词表（`protocol::Role`）中的名称，
/// 写法不同的角色（`Button`）不会命中任何节点。
pub fn matches_target(role: Option<&str>, name_contains: Option<&str>, node: &Node) -> bool {
    if let Some(role) = role {
        if node.role != role {
            return false;
        }
    }
    if let Some(text) = name_contains {
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

/// 每隔 `interval` 重读一次，直到相邻两次的计数相同或达到 `limit`，返回最后一次的结果。
///
/// 后端首次读取一个窗口时使用：Chromium 系应用在首次收到无障碍请求时才构建控件树，
/// 首次读取到的只有外框，且不计为截断。
pub fn settle<T, E>(
    read: impl Fn() -> Result<T, E>,
    count: impl Fn(&T) -> u32,
    interval: Duration,
    limit: Duration,
) -> Result<T, E> {
    let until = Instant::now() + limit;
    let mut last = read()?;
    while Instant::now() + interval <= until {
        std::thread::sleep(interval);
        let next = read()?;
        let stable = count(&next) == count(&last);
        last = next;
        if stable {
            break;
        }
    }
    Ok(last)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 单元测试使用的控件，除给出的四项外全部取缺失或假。
    pub fn node(role: &str, name: &str, automation_id: &str, value: Option<&str>) -> Node {
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
            focused: false,
            rect: None,
            actions: Vec::new(),
            range: None,
            toggle: None,
            expand: None,
            selected: None,
            selection: None,
            scroll: None,
            text: false,
            weak_identity: false,
        }
    }

    fn collected(reference: &str, parent: Option<usize>) -> Collected {
        let mut n = node("button", "按钮", "", None);
        n.reference = reference.to_owned();
        Collected { node: n, parent }
    }

    /// 遍历读取到的节点全部返回，顺序不变；根节点在第一项，范围与窗口可用状态都按根节点取值。
    #[test]
    fn every_visited_node_is_returned_in_order_with_parent_refs() {
        let nodes = flatten(vec![
            collected("w#1", None),
            collected("w.0#3", Some(0)),
            collected("w.0.0#4", Some(1)),
            collected("w.1#5", Some(0)),
        ]);
        let refs: Vec<&str> = nodes.iter().map(|n| n.reference.as_str()).collect();
        assert_eq!(refs, ["w#1", "w.0#3", "w.0.0#4", "w.1#5"]);
        let parents: Vec<Option<&str>> = nodes.iter().map(|n| n.parent_ref.as_deref()).collect();
        assert_eq!(parents, [None, Some("w#1"), Some("w.0#3"), Some("w#1")]);
    }

    /// Edge 首次读取只有 47 个外框节点，0.3 s 后为 52 个：读取到相邻两次计数相同时才返回。
    #[test]
    fn first_read_settles_once_the_count_stops_changing() {
        let counts = [47u32, 52, 52, 60];
        let reads = std::cell::Cell::new(0usize);
        let got = settle::<_, ()>(
            || {
                let n = counts[reads.get()];
                reads.set(reads.get() + 1);
                Ok(n)
            },
            |n| *n,
            Duration::from_millis(1),
            Duration::from_secs(1),
        );
        assert_eq!(got.ok(), Some(52));
        assert_eq!(reads.get(), 3);
    }

    #[test]
    fn settle_hands_back_the_last_read_at_the_limit() {
        let reads = std::cell::Cell::new(0u32);
        let got = settle::<_, ()>(
            || {
                reads.set(reads.get() + 1);
                Ok(reads.get())
            },
            |n| *n,
            Duration::from_millis(5),
            Duration::from_millis(30),
        );
        assert_eq!(got.ok(), Some(reads.get()));
        assert!(reads.get() <= 7);
    }

    #[test]
    fn a_failed_read_during_settling_is_returned() {
        let got: Result<u32, &str> = settle(
            || Err("target_lost"),
            |n| *n,
            Duration::from_millis(1),
            Duration::from_secs(1),
        );
        assert!(got.is_err());
    }

    fn parts(path: Vec<usize>, check: Option<&str>, identity: Identity) -> RefParts {
        RefParts {
            path,
            check: check.map(str::to_owned),
            identity,
        }
    }

    /// 不带核对串的 `ref` 只含下标路径与身份段：Windows 后端生成的就是这一种。
    #[test]
    fn ref_round_trips_through_encode_and_decode() {
        let strong = Identity::Stable("42.1180674.4.1".to_owned());
        let encoded = encode_ref(&[0, 3, 1], None, &strong);
        assert_eq!(encoded, "w.0.3.1#42.1180674.4.1");
        assert_eq!(decode_ref(&encoded), Ok(parts(vec![0, 3, 1], None, strong)));
        assert_eq!(
            decode_ref("w#7.1"),
            Ok(parts(Vec::new(), None, Identity::Stable("7.1".to_owned())))
        );
    }

    /// 核对串位于 `#` 之前，因此身份段不随核对串变化；解码分别返回三部分。
    #[test]
    fn a_check_sits_before_the_identity_segment() {
        let object = Identity::Stable(":1.2/org/a11y/atspi/accessible/7".to_owned());
        let encoded = encode_ref(&[0, 3], Some("0123456789abcdef"), &object);
        assert_eq!(encoded, "w.0.3@0123456789abcdef#:1.2/org/a11y/atspi/accessible/7");
        assert_eq!(
            decode_ref(&encoded),
            Ok(parts(vec![0, 3], Some("0123456789abcdef"), object.clone()))
        );
        assert_eq!(
            encode_ref(&[], Some("ab"), &object),
            "w@ab#:1.2/org/a11y/atspi/accessible/7"
        );
        // 身份段中可以含有 `@`：只有 `#` 之前的 `@` 是核对串的分隔符。
        assert_eq!(
            decode_ref("w.1#:1.2/a@b"),
            Ok(parts(vec![1], None, Identity::Stable(":1.2/a@b".to_owned())))
        );
        for bad in ["w.0@#x", "x@ab#y", "w.a@ab#y"] {
            assert!(decode_ref(bad).is_err(), "{bad} 应当解析失败");
        }
    }

    /// 弱身份在 `ref` 中带 `~` 前缀，解码时可与稳定身份区分。
    #[test]
    fn a_weak_identity_survives_the_round_trip_and_stays_distinct() {
        let weak = Identity::Attributes("0123456789abcdef".to_owned());
        let encoded = encode_ref(&[2], None, &weak);
        assert_eq!(encoded, "w.2#~0123456789abcdef");
        assert_eq!(decode_ref(&encoded), Ok(parts(vec![2], None, weak.clone())));
        // 字面量相同也不视为同一种身份：同一位置从没有稳定身份变为有稳定身份时，已不是同一个控件。
        assert_ne!(weak, Identity::Stable("0123456789abcdef".to_owned()));
        assert!(weak.is_weak());
        assert!(!Identity::Stable("7.1".to_owned()).is_weak());
    }

    /// 三项中任一项变化都会改变指纹；拼接时不能直接相连，否则在两项之间移动一个字符会得到相同的指纹。
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

    #[test]
    fn malformed_ref_is_refused_rather_than_guessed() {
        for bad in ["w.0.1", "x.0#7.1", "w.a#7.1", ""] {
            assert!(decode_ref(bad).is_err(), "{bad} 应当解析失败");
        }
    }

    /// `appears` 的两项条件均未给出时任何节点都满足。
    #[test]
    fn an_empty_appears_condition_matches_every_node() {
        assert!(matches_target(None, None, &node("button", "保存", "save", None)));
        assert!(matches_target(None, None, &node("edit", "", "", None)));
    }

    #[test]
    fn appears_role_and_text_apply_together() {
        let (role, text) = (Some("button"), Some("保存"));
        assert!(matches_target(role, text, &node("button", "保存", "save", None)));
        assert!(!matches_target(role, text, &node("edit", "保存", "save", None)));
        assert!(!matches_target(role, text, &node("button", "取消", "cancel", None)));
    }

    /// 文字条件匹配名称、稳定标识与值三处，且不区分大小写。
    #[test]
    fn the_appears_text_looks_at_name_id_and_value_case_insensitively() {
        let text = Some("Save");
        assert!(matches_target(None, text, &node("button", "SAVE AS", "x", None)));
        assert!(matches_target(None, text, &node("button", "别的", "saveBtn", None)));
        assert!(matches_target(None, text, &node("edit", "别的", "x", Some("autosave"))));
        assert!(!matches_target(None, text, &node("edit", "别的", "x", Some("无"))));
        // 未读取值的节点不会因为值缺失而命中。
        assert!(!matches_target(None, text, &node("edit", "别的", "x", None)));
    }

    #[test]
    fn a_stable_identity_is_emitted_once_per_walk_and_weak_identities_are_never_merged() {
        // Edge 内容面板的子节点列表：自身的子节点之后紧接父窗口的全部子节点，其中包括面板自身。
        let mut seen = HashSet::new();
        for id in ["42.263932", "42.460938", "42.198318", "42.263932.4.0.0.179"] {
            assert!(first_sighting(&mut seen, id));
        }
        for id in ["42.263932.4.0.0.181", "42.592008"] {
            assert!(first_sighting(&mut seen, id));
        }
        for id in ["42.460938", "42.198318", "42.263932.4.0.0.179"] {
            assert!(!first_sighting(&mut seen, id), "{id} 已输出过，不再展开");
        }
        // 弱身份每次都视为首次出现。
        assert!(first_sighting(&mut seen, ""));
        assert!(first_sighting(&mut seen, ""));
        // 集合只属于一次遍历：新的遍历从空集合开始。
        assert!(first_sighting(&mut HashSet::new(), "42.460938"));
    }
}
