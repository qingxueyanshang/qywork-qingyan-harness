//! 一次性下载授权表与逐下载裁决。
//!
//! 授权只在内存里，随消费、撤销、超时、断连消亡；它不是持久任务账。
//! 同一个标签页同时只允许一份授权，同一个目标路径同时只允许一份授权。
//!
//! 每份授权带一个服务端生成的不复用 `download_id`。裁决消费授权时把它交出来，
//! 由引擎绑到这一次下载上并随终态回报：少了它，同一页上一次调用的迟到终态会被
//! 下一次调用认领。
//!
//! 裁决是同步的，没有「先延后再接续」：认不出授权的下载一律取消并回报，
//! 一次性生成的下载（POST 结果）会因此丢失一次，这是边界。

use std::collections::HashMap;
use std::path::PathBuf;

pub struct Arm {
    pub path: PathBuf,
    pub deadline_ms: u64,
    pub download_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// 人工标签页：沿用浏览器提议的默认路径放行。
    AllowDefault,
    /// 命中授权：写这个绝对路径，终态按这个 `download_id` 回报。
    Allow(PathBuf, String),
    /// 取消，并按这个原因回报 `download.blocked`。
    /// 带 `download_id` 表示消费掉了一份授权，等着它的调用按这条结算。
    Block(&'static str, Option<String>),
}

#[derive(Default)]
pub struct ArmTable {
    arms: HashMap<String, Arm>,
}

impl ArmTable {
    /// 登记一次性授权。
    ///
    /// 同一 tab 的旧授权被顶掉——保留两份就分不出该消费哪一份。
    /// 目标路径已被另一个 tab 的授权占着时拒绝：两份授权写同一个文件，
    /// 先落地的那一份会让另一份撞上「目标已存在」，而调用方分不出是谁写的。
    pub fn arm(&mut self, tab_id: String, arm: Arm) -> Result<(), String> {
        if let Some((holder, _)) = self
            .arms
            .iter()
            .find(|(id, existing)| *id != &tab_id && existing.path == arm.path)
        {
            return Err(format!("目标路径已被标签页 {holder} 的下载授权占用"));
        }
        self.arms.insert(tab_id, arm);
        Ok(())
    }

    /// 撤销授权。给了 `download_id` 就只撤这一份——迟到的撤销不能删掉同一页上新登记的授权。
    pub fn disarm(&mut self, tab_id: &str, download_id: Option<&str>) -> bool {
        match download_id {
            Some(wanted) => {
                if self.arms.get(tab_id).map(|a| a.download_id.as_str()) != Some(wanted) {
                    return false;
                }
                self.arms.remove(tab_id).is_some()
            }
            None => self.arms.remove(tab_id).is_some(),
        }
    }

    pub fn clear(&mut self) {
        self.arms.clear();
    }

    #[cfg_attr(windows, allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.arms.is_empty()
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
            return Decision::Block("unauthorized", None);
        };
        if now_ms > arm.deadline_ms {
            return Decision::Block("expired", Some(arm.download_id));
        }
        if arm.path.exists() {
            return Decision::Block("exists", Some(arm.download_id));
        }
        Decision::Allow(arm.path, arm.download_id)
    }
}

#[cfg(test)]
mod tests {
    use super::{Arm, ArmTable, Decision};
    use std::path::PathBuf;

    fn arm_of(path: PathBuf, deadline_ms: u64, id: &str) -> Arm {
        Arm {
            path,
            deadline_ms,
            download_id: id.to_owned(),
        }
    }

    fn table_with(path: PathBuf, deadline_ms: u64) -> ArmTable {
        let mut t = ArmTable::default();
        t.arm("bt_1".into(), arm_of(path, deadline_ms, "dl_1"))
            .expect("首次登记不会冲突");
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
        assert_eq!(
            t.decide("bt_1", false, 1),
            Decision::Allow(target, "dl_1".into())
        );
        assert_eq!(
            t.decide("bt_1", false, 2),
            Decision::Block("unauthorized", None)
        );
    }

    #[test]
    fn unauthorized_and_expired_are_both_cancelled() {
        let target = scratch("b.bin");
        let _ = std::fs::remove_file(&target);
        let mut t = ArmTable::default();
        assert_eq!(
            t.decide("bt_1", false, 1),
            Decision::Block("unauthorized", None)
        );

        let mut t = table_with(target.clone(), 5);
        assert_eq!(
            t.decide("bt_1", false, 6),
            Decision::Block("expired", Some("dl_1".into()))
        );
    }

    #[test]
    fn existing_target_is_refused_instead_of_overwritten() {
        let target = scratch("c.bin");
        std::fs::write(&target, b"old").expect("夹具文件要写得出来");
        let mut t = table_with(target.clone(), 10_000);
        assert_eq!(
            t.decide("bt_1", false, 1),
            Decision::Block("exists", Some("dl_1".into()))
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn manual_tab_keeps_the_default_destination_and_leaves_arms_alone() {
        let mut t = table_with(scratch("d.bin"), 10_000);
        assert_eq!(t.decide("bt_1", true, 1), Decision::AllowDefault);
        assert!(t.disarm("bt_1", None), "用户页放行不消费 AI 授权");
    }

    #[test]
    fn two_tabs_cannot_hold_arms_on_the_same_target_path() {
        let target = scratch("e.bin");
        let mut t = table_with(target.clone(), 10_000);
        assert!(t
            .arm("bt_2".into(), arm_of(target.clone(), 10_000, "dl_2"))
            .is_err());
        // 另一个路径照常登记；重登记本 tab 的授权也不算与自己冲突。
        assert!(t
            .arm("bt_2".into(), arm_of(scratch("f.bin"), 10_000, "dl_3"))
            .is_ok());
        assert!(t.arm("bt_1".into(), arm_of(target, 10_000, "dl_4")).is_ok());
    }

    #[test]
    fn a_stale_disarm_cannot_remove_the_arm_registered_after_it() {
        let mut t = table_with(scratch("g.bin"), 10_000);
        t.arm("bt_1".into(), arm_of(scratch("h.bin"), 10_000, "dl_9"))
            .expect("重登记覆盖旧授权");
        assert!(!t.disarm("bt_1", Some("dl_1")), "旧身份撤不掉新授权");
        assert!(t.disarm("bt_1", Some("dl_9")));
    }
}
