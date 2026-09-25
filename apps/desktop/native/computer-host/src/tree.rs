//! 控件树里不分平台的那一部分：控件身份与 `ref` 编解码、遍历结果展平、首次读取的稳定判定、
//! 等待 `appears` 的匹配。
//!
//! 本模块不调用任何 OS 接口。各后端读出平台的控件树，按这里的规则编出 `ref`、组出控件表。

use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::protocol::Node;

/// 一个控件的身份。
///
/// `Stable` 是平台给的、控件存在期间不变的标识（Windows 是 RuntimeId）；平台给不出时
/// 退到角色、名称与稳定标识的指纹，并在观察里把这个控件标成弱身份。**两种身份不相等**，
/// 哪怕字面量凑巧一样。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    Stable(String),
    Attributes(String),
}

impl Identity {
    pub fn is_weak(&self) -> bool {
        matches!(self, Self::Attributes(_))
    }

    /// 写进 `ref` 的那一段。弱身份带 `~` 前缀，解码时据此分得开。
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

/// 角色、名称与稳定标识的指纹。FNV-1a，够短且与输入一一对应到碰撞概率可忽略。
///
/// 三项用不会出现在取值里的分隔符拼起来再算：直接连接的话，`("ab","c")` 与 `("a","bc")`
/// 会算出同一个指纹。
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

/// `ref` 的编码：`w` 加逐层子节点下标，`#` 后是身份段。
pub fn encode_ref(path: &[usize], identity: &Identity) -> String {
    let mut out = String::from("w");
    for index in path {
        out.push('.');
        out.push_str(&index.to_string());
    }
    out.push('#');
    out.push_str(&identity.encode());
    out
}

pub fn decode_ref(reference: &str) -> Result<(Vec<usize>, Identity), String> {
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

/// 一个节点连同它在前序表里的父节点下标。
pub struct Collected {
    pub node: Node,
    pub parent: Option<usize>,
}

/// 展平收集到的节点：把父节点下标换成父节点的 `ref`，顺序不变。
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

/// 这个稳定身份在本次遍历里是不是第一次出现，并登记它。
///
/// 空串是没有稳定身份的弱身份，一律算第一次：弱身份按属性指纹认，两个不同的控件可能
/// 指纹相同，按它去重会丢掉真实控件。集合只在一次遍历内有效：稳定身份跨时刻可复用。
pub fn first_sighting(seen: &mut HashSet<String>, stable: &str) -> bool {
    stable.is_empty() || seen.insert(stable.to_owned())
}

/// 一个节点满不满足等待 `appears` 的条件。两项都没给时任何节点都满足。
///
/// 角色逐字比较：调用方给的角色要是协议词表（`protocol::Role`）里的名字，
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

/// 隔 `interval` 重读，直到相邻两次的计数相同或到 `limit`，交回最后一份。
///
/// 后端第一次读一个窗口时用它：Chromium 系应用在第一次收到无障碍请求时才建树，
/// 第一次读到的只有外框，且不算截断。
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

    /// 单测用的控件，除给出的四项外全部取缺席或假。
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

    /// 遍历读到的节点全部交回，顺序不变；根在第一项，范围与窗口可用状态都按它取。
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

    /// Edge 第一次读只有 47 个外框节点，0.3 s 后 52 个：读到相邻两次计数相同才交回。
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

    #[test]
    fn ref_round_trips_through_encode_and_decode() {
        let strong = Identity::Stable("42.1180674.4.1".to_owned());
        let encoded = encode_ref(&[0, 3, 1], &strong);
        assert_eq!(encoded, "w.0.3.1#42.1180674.4.1");
        assert_eq!(decode_ref(&encoded), Ok((vec![0, 3, 1], strong)));
        assert_eq!(
            decode_ref("w#7.1"),
            Ok((Vec::new(), Identity::Stable("7.1".to_owned())))
        );
    }

    /// 弱身份在 `ref` 里带 `~` 前缀，解码时与稳定身份分得开。
    #[test]
    fn a_weak_identity_survives_the_round_trip_and_stays_distinct() {
        let weak = Identity::Attributes("0123456789abcdef".to_owned());
        let encoded = encode_ref(&[2], &weak);
        assert_eq!(encoded, "w.2#~0123456789abcdef");
        assert_eq!(decode_ref(&encoded), Ok((vec![2], weak.clone())));
        // 字面量一样也不算同一种身份：那个位置从没有稳定身份变成有了，就不是同一个控件。
        assert_ne!(weak, Identity::Stable("0123456789abcdef".to_owned()));
        assert!(weak.is_weak());
        assert!(!Identity::Stable("7.1".to_owned()).is_weak());
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

    #[test]
    fn malformed_ref_is_refused_rather_than_guessed() {
        for bad in ["w.0.1", "x.0#7.1", "w.a#7.1", ""] {
            assert!(decode_ref(bad).is_err(), "{bad} 应当解析失败");
        }
    }

    /// `appears` 两项条件都没给时任何节点都满足。
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

    /// 文字条件看名称、稳定标识与值三处，且不分大小写。
    #[test]
    fn the_appears_text_looks_at_name_id_and_value_case_insensitively() {
        let text = Some("Save");
        assert!(matches_target(None, text, &node("button", "SAVE AS", "x", None)));
        assert!(matches_target(None, text, &node("button", "别的", "saveBtn", None)));
        assert!(matches_target(None, text, &node("edit", "别的", "x", Some("autosave"))));
        assert!(!matches_target(None, text, &node("edit", "别的", "x", Some("无"))));
        // 没取值的节点不会因为值缺席就命中。
        assert!(!matches_target(None, text, &node("edit", "别的", "x", None)));
    }

    #[test]
    fn a_stable_identity_is_emitted_once_per_walk_and_weak_identities_are_never_merged() {
        // Edge 内容面板的子节点列表：自己的子节点之后接着父窗口的全部子节点，含它自己。
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
        // 弱身份每次都算第一次。
        assert!(first_sighting(&mut seen, ""));
        assert!(first_sighting(&mut seen, ""));
        // 集合只属于一次遍历：新的遍历从空集合开始。
        assert!(first_sighting(&mut HashSet::new(), "42.460938"));
    }
}
