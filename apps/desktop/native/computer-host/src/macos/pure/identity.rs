//! worker 进程内的控件身份表。AX 没有「控件存在期间不变」的标识，元素引用只能按 `CFEqual`
//! 比较，身份因此由本表分配：元素首次出现时分配一个递增编号，此后同一元素且核对串
//! 不变时返回同一编号。编号写入 `ref` 的身份段，协调器据此分配稳定短编号。
//!
//! 三条边界：
//!
//! 1. **编号只增不减，不复用。** 已淘汰的元素再次出现时分配新编号，旧 `ref` 按 `ref_stale` 拒绝，
//!    不会指向其他控件。
//! 2. **同一元素的核对串改变即视为另一个控件。** 列表行视图会被复用，同一元素引用的
//!    角色或稳定标识可能改变：旧编号作废、分配新编号，旧 `ref` 随之失效。
//! 3. **表只属于当前进程。** worker 进程与宿主代际一一对应，代际变更即更换进程，表随之清空。
//!
//! 本模块不调用 AX：比较与散列由 `Handle` 提供，单测使用假句柄。

use std::collections::{BTreeMap, HashMap};

/// 表项上限，与协调器每个窗口编号表的上限相同。
///
/// 单次读取的节点数上限远低于该值，同一次读取中的元素不会相互淘汰。超过上限即淘汰最久未出现的
/// 一项；该元素再次出现时分配新编号，旧 `ref` 按边界 1 失效。
pub const MAX_IDENTITIES: usize = 8192;

/// 身份表使用的元素句柄。
pub trait Handle {
    /// 散列值。`same` 为真的两个句柄必须返回相同的值；反之不要求。
    fn hash(&self) -> u64;
    /// 两个句柄是否指向同一元素。
    fn same(&self, other: &Self) -> bool;
}

struct Entry<H> {
    handle: H,
    hash: u64,
    check: String,
    tick: u64,
}

pub struct Identities<H> {
    entries: HashMap<u64, Entry<H>>,
    /// 散列值 → 该散列下的编号。散列相同不等于同一元素，桶内逐个用 `same` 比较。
    buckets: HashMap<u64, Vec<u64>>,
    /// 最近一次出现的时刻 → 编号。最小的一项即下一个淘汰对象。
    order: BTreeMap<u64, u64>,
    next_id: u64,
    tick: u64,
    cap: usize,
}

impl<H: Handle + Clone> Identities<H> {
    pub fn new(cap: usize) -> Self {
        Self {
            entries: HashMap::new(),
            buckets: HashMap::new(),
            order: BTreeMap::new(),
            next_id: 1,
            tick: 0,
            cap: cap.max(1),
        }
    }

    /// 返回该元素在该核对串下的编号，并将其记为最近出现。
    ///
    /// 同一元素的核对串改变时旧编号作废并分配新编号，见文件头边界 2。
    pub fn intern(&mut self, handle: H, check: &str) -> u64 {
        let hash = handle.hash();
        let found = self.buckets.get(&hash).and_then(|ids| {
            ids.iter()
                .copied()
                .find(|id| self.entries.get(id).is_some_and(|e| e.handle.same(&handle)))
        });
        if let Some(id) = found {
            if self.entries.get(&id).is_some_and(|e| e.check == check) {
                self.touch(id);
                return id;
            }
            self.remove(id);
        }
        let id = self.next_id;
        self.next_id += 1;
        self.tick += 1;
        self.entries.insert(
            id,
            Entry {
                handle,
                hash,
                check: check.to_owned(),
                tick: self.tick,
            },
        );
        self.buckets.entry(hash).or_default().push(id);
        self.order.insert(self.tick, id);
        while self.entries.len() > self.cap {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            self.forget(oldest);
        }
        id
    }

    /// 返回编号对应的元素与分配编号时的核对串，并将其记为最近出现。编号已作废或已淘汰时缺席。
    pub fn get(&mut self, id: u64) -> Option<(H, String)> {
        let entry = self.entries.get(&id)?;
        let found = (entry.handle.clone(), entry.check.clone());
        self.touch(id);
        Some(found)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    fn touch(&mut self, id: u64) {
        self.tick += 1;
        let tick = self.tick;
        if let Some(entry) = self.entries.get_mut(&id) {
            self.order.remove(&entry.tick);
            entry.tick = tick;
            self.order.insert(tick, id);
        }
    }

    fn remove(&mut self, id: u64) {
        if let Some(entry) = self.entries.get(&id) {
            self.order.remove(&entry.tick);
        }
        self.forget(id);
    }

    /// 从表与散列桶中移除一项。该项在 `order` 中的记录由调用方移除。
    fn forget(&mut self, id: u64) {
        let Some(entry) = self.entries.remove(&id) else {
            return;
        };
        if let Some(ids) = self.buckets.get_mut(&entry.hash) {
            ids.retain(|i| *i != id);
            if ids.is_empty() {
                self.buckets.remove(&entry.hash);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假句柄：`key` 相同即同一元素，散列取 `bucket`，可使不同元素产生相同的散列。
    #[derive(Debug, Clone)]
    struct Fake {
        key: u32,
        bucket: u64,
    }

    impl Handle for Fake {
        fn hash(&self) -> u64 {
            self.bucket
        }
        fn same(&self, other: &Self) -> bool {
            self.key == other.key
        }
    }

    fn fake(key: u32) -> Fake {
        Fake {
            key,
            bucket: u64::from(key),
        }
    }

    /// 同一元素连续两次观察得到同一编号；另一元素得到不同编号。
    #[test]
    fn the_same_element_keeps_its_number() {
        let mut table = Identities::new(16);
        let a = table.intern(fake(1), "c");
        assert_eq!(table.intern(fake(1), "c"), a);
        let b = table.intern(fake(2), "c");
        assert_ne!(a, b);
        assert_eq!(table.len(), 2);
    }

    /// 散列相同的两个元素不合并：桶内按 `same` 逐个比较。
    #[test]
    fn a_hash_collision_does_not_merge_two_elements() {
        let mut table = Identities::new(16);
        let a = table.intern(Fake { key: 1, bucket: 7 }, "c");
        let b = table.intern(Fake { key: 2, bucket: 7 }, "c");
        assert_ne!(a, b);
        assert_eq!(table.intern(Fake { key: 1, bucket: 7 }, "c"), a);
        assert_eq!(table.intern(Fake { key: 2, bucket: 7 }, "c"), b);
    }

    /// 原始失败形状：列表行视图被复用，同一元素的角色改变。旧编号作废并分配新编号，旧编号无法查到。
    #[test]
    fn a_reused_element_with_a_new_check_gets_a_new_number() {
        let mut table = Identities::new(16);
        let row = table.intern(fake(1), "AXRow.AXTableRow");
        let reused = table.intern(fake(1), "AXGroup.");
        assert_ne!(row, reused);
        assert!(table.get(row).is_none());
        assert_eq!(
            table.get(reused).map(|(_, c)| c).as_deref(),
            Some("AXGroup.")
        );
        assert_eq!(table.len(), 1);
    }

    /// 编号只增不减：已淘汰的元素再次出现时分配更大的新编号，旧编号不再指向任何元素。
    #[test]
    fn evicted_numbers_are_never_reissued() {
        let mut table = Identities::new(2);
        let a = table.intern(fake(1), "c");
        let b = table.intern(fake(2), "c");
        // 读取一次 a 之后，被淘汰的是 b。
        assert!(table.get(a).is_some());
        let c = table.intern(fake(3), "c");
        assert_eq!(table.len(), 2);
        assert!(table.get(b).is_none());
        assert!(table.get(a).is_some() && table.get(c).is_some());
        let b_again = table.intern(fake(2), "c");
        assert!(b_again > c && b_again != b);
    }

    /// 上限与协调器一致，一次读取的节点全部保留在表中。
    #[test]
    fn one_full_read_fits_in_the_table() {
        let mut table = Identities::new(MAX_IDENTITIES);
        let ids: Vec<u64> = (0..4000).map(|k| table.intern(fake(k), "c")).collect();
        let again: Vec<u64> = (0..4000).map(|k| table.intern(fake(k), "c")).collect();
        assert_eq!(ids, again);
    }
}
