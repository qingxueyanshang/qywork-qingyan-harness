//! 一次性下载授权表与 `on_download` 的裁决。
//!
//! 授权只在内存里，随消费、撤销、超时、断连消亡；它不是持久任务账。
//! 同一个标签页同时只允许一份授权。
//!
//! 钩子是同步的，没有「先延后再接续」：认不出授权的下载一律取消并回报，
//! 一次性生成的下载（POST 结果）会因此丢失一次，这是边界。

use std::collections::HashMap;
use std::path::PathBuf;

pub struct Arm {
    pub path: PathBuf,
    pub deadline_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// 人工标签页：沿用浏览器提议的默认路径放行。
    AllowDefault,
    /// 命中授权：写这个绝对路径。
    Allow(PathBuf),
    /// 取消，并按这个原因回报 `download.blocked`。
    Block(&'static str),
}

#[derive(Default)]
pub struct ArmTable {
    arms: HashMap<String, Arm>,
}

impl ArmTable {
    /// 登记一次性授权。同一 tab 的旧授权被顶掉——保留两份就分不出该消费哪一份。
    pub fn arm(&mut self, tab_id: String, arm: Arm) {
        self.arms.insert(tab_id, arm);
    }

    pub fn disarm(&mut self, tab_id: &str) -> bool {
        self.arms.remove(tab_id).is_some()
    }

    pub fn clear(&mut self) {
        self.arms.clear();
    }

    /// 裁决一次下载。命中即消费授权，失败也把该授权删掉——留着它下一次下载会误命中。
    ///
    /// `manual` = 这一页是用户页（不归任何 AI 会话）：走默认目录放行，不碰授权。
    /// 归 AI 的页必须有一份未过期、目标不存在的授权，否则取消。
    pub fn decide(&mut self, tab_id: &str, manual: bool, now_ms: u64) -> Decision {
        if manual {
            return Decision::AllowDefault;
        }
        let Some(arm) = self.arms.remove(tab_id) else {
            return Decision::Block("unauthorized");
        };
        if now_ms > arm.deadline_ms {
            return Decision::Block("expired");
        }
        if arm.path.exists() {
            return Decision::Block("exists");
        }
        Decision::Allow(arm.path)
    }
}

#[cfg(test)]
mod tests {
    use super::{Arm, ArmTable, Decision};
    use std::path::PathBuf;

    fn table_with(path: PathBuf, deadline_ms: u64) -> ArmTable {
        let mut t = ArmTable::default();
        t.arm("bt_1".into(), Arm { path, deadline_ms });
        t
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp/cargo-tests")
            .join(format!("downloads-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("临时目录要建得出来");
        dir.join(name)
    }

    #[test]
    fn authorized_download_consumes_the_arm_exactly_once() {
        let target = scratch("a.bin");
        let _ = std::fs::remove_file(&target);
        let mut t = table_with(target.clone(), 10_000);
        assert_eq!(t.decide("bt_1", false, 1), Decision::Allow(target));
        assert_eq!(t.decide("bt_1", false, 2), Decision::Block("unauthorized"));
    }

    #[test]
    fn unauthorized_and_expired_are_both_cancelled() {
        let target = scratch("b.bin");
        let _ = std::fs::remove_file(&target);
        let mut t = ArmTable::default();
        assert_eq!(t.decide("bt_1", false, 1), Decision::Block("unauthorized"));

        let mut t = table_with(target.clone(), 5);
        assert_eq!(t.decide("bt_1", false, 6), Decision::Block("expired"));
    }

    #[test]
    fn existing_target_is_refused_instead_of_overwritten() {
        let target = scratch("c.bin");
        std::fs::write(&target, b"old").expect("夹具文件要写得出来");
        let mut t = table_with(target.clone(), 10_000);
        assert_eq!(t.decide("bt_1", false, 1), Decision::Block("exists"));
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn manual_tab_keeps_the_default_destination_and_leaves_arms_alone() {
        let mut t = table_with(scratch("d.bin"), 10_000);
        assert_eq!(t.decide("bt_1", true, 1), Decision::AllowDefault);
        assert!(t.disarm("bt_1"), "用户页放行不消费 AI 授权");
    }
}
