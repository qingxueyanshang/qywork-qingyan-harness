//! 一次性下载授权表与每次下载的裁决。
//!
//! 授权只保存在内存中，在被消费、撤销、超时或连接断开时失效；它不是持久化的任务记录。
//! 同一个标签页同时只允许一份授权，同一个目标路径同时只允许一份授权。
//!
//! 每份授权携带一个由服务端生成、不复用的 `download_id`。裁决消费授权时返回该值，
//! 由引擎绑定到本次下载并随终态上报：缺少该值时，同一页上前一次调用迟到的终态会被
//! 下一次调用认领。
//!
//! 裁决是同步的，不支持延后裁决后再继续下载：没有匹配授权的下载一律取消并上报，
//! 一次性生成的下载（POST 结果）因此会丢失一次，这是已知边界。

use std::collections::HashMap;
use std::path::PathBuf;

pub struct Arm {
    pub path: PathBuf,
    pub deadline_ms: u64,
    pub download_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// 用户页：使用浏览器建议的默认路径放行。
    AllowDefault,
    /// 命中授权：写入该绝对路径，终态按该 `download_id` 上报。
    Allow(PathBuf, String),
    /// 取消下载，并以该原因上报 `download.blocked`。
    /// 带 `download_id` 表示消费了一份授权，等待该授权的调用按此结果结算。
    Block(&'static str, Option<String>),
}

#[derive(Default)]
pub struct ArmTable {
    arms: HashMap<String, Arm>,
}

impl ArmTable {
    /// 登记一次性授权。
    ///
    /// 同一 tab 的旧授权被新授权替换：同时保留两份时无法确定应消费哪一份。
    /// 目标路径已被另一个 tab 的授权占用时拒绝：两份授权写入同一个文件时，
    /// 先写入的一份会使另一份遇到「目标已存在」，而调用方无法区分文件由哪一份写入。
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

    /// 撤销授权。给定 `download_id` 时只撤销该份授权：迟到的撤销不得删除同一页上新登记的授权。
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

    /// 裁决一次下载。命中即消费授权，裁决失败时同样删除该授权：保留它会使下一次下载误命中。
    ///
    /// `manual` 表示该页是用户页（不属于任何 AI 会话）：使用默认目录放行，不访问授权。
    /// 属于 AI 会话的页必须有一份未过期且目标文件不存在的授权，否则取消。
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
        std::fs::create_dir_all(&dir).expect("必须能创建临时目录");
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
        std::fs::write(&target, b"old").expect("必须能写入夹具文件");
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
        // 其他路径正常登记；重新登记本 tab 的授权不视为与自身冲突。
        assert!(t
            .arm("bt_2".into(), arm_of(scratch("f.bin"), 10_000, "dl_3"))
            .is_ok());
        assert!(t.arm("bt_1".into(), arm_of(target, 10_000, "dl_4")).is_ok());
    }

    #[test]
    fn a_stale_disarm_cannot_remove_the_arm_registered_after_it() {
        let mut t = table_with(scratch("g.bin"), 10_000);
        t.arm("bt_1".into(), arm_of(scratch("h.bin"), 10_000, "dl_9"))
            .expect("重新登记覆盖旧授权");
        assert!(!t.disarm("bt_1", Some("dl_1")), "旧身份无法撤销新授权");
        assert!(t.disarm("bt_1", Some("dl_9")));
    }
}
