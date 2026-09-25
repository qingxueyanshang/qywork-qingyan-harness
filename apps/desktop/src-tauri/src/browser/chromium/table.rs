//! 这个浏览器进程里的页、会话与帧，按顶层页归拢。
//!
//! 每个页会话与它的跨站子帧会话都记到顶层页上，各会话报来的帧也记到顶层页上：
//! 下载事件只带 frameId，归属靠这张表从帧查到页、再查到 tabId。

use std::collections::HashMap;

/// 一个顶层页。
pub struct PageEntry {
    /// 宿主连接上这一页的会话。
    pub session: String,
    /// 宿主给它的 tabId。`None` = 不在存活集合里的页（用户在浏览器窗口里自己开的页）。
    pub tab: Option<String>,
    /// 最近一次报给宿主的地址与标题，来自 `Target.targetInfoChanged`。
    pub url: String,
    pub title: String,
    /// Page 域已开、已放行。宿主建页要等到这一步才注入标记。
    pub ready: bool,
    /// 主帧提交过一次非初始文档。
    pub committed: bool,
    /// 提交之后主帧停止加载。宿主建页以它为「导航完成」。
    pub loaded: bool,
    /// 页面自己开出来、开它的页在存活集合里：等主帧第一次提交时进存活集合。
    pub popup: Option<Popup>,
}

pub struct Popup {
    pub opener_tab: String,
    pub marker: String,
}

#[derive(Default)]
pub struct Table {
    pages: HashMap<String, PageEntry>,
    /// 会话 → 顶层页。页会话与子帧会话都在这里。
    sessions: HashMap<String, String>,
    /// 帧 → 顶层页。主帧的 id 就是页的 targetId，跨站子帧的 id 就是它的 targetId。
    frames: HashMap<String, String>,
}

impl Table {
    /// 一个顶层页附上来。
    pub fn page_attached(&mut self, target: &str, session: &str, url: &str, title: &str) {
        self.pages.insert(
            target.to_owned(),
            PageEntry {
                session: session.to_owned(),
                tab: None,
                url: url.to_owned(),
                title: title.to_owned(),
                ready: false,
                committed: false,
                loaded: false,
                popup: None,
            },
        );
        self.sessions.insert(session.to_owned(), target.to_owned());
        self.frames.insert(target.to_owned(), target.to_owned());
    }

    /// 某个已知会话下附上来一个跨站子帧会话。父会话不认识时返回 `false`，调用方只放行不跟踪。
    pub fn child_attached(&mut self, parent_session: &str, session: &str, target: &str) -> bool {
        let Some(top) = self.sessions.get(parent_session).cloned() else { return false };
        self.sessions.insert(session.to_owned(), top.clone());
        self.frames.insert(target.to_owned(), top);
        true
    }

    pub fn session_detached(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    /// 页没了。它的会话与帧一并摘掉，返回被摘掉的那一页。
    pub fn page_destroyed(&mut self, target: &str) -> Option<PageEntry> {
        let entry = self.pages.remove(target)?;
        self.sessions.retain(|_, top| top != target);
        self.frames.retain(|_, top| top != target);
        Some(entry)
    }

    /// 会话报来一个帧。会话不认识时不记：那不是这张表跟踪的页。
    pub fn frame_seen(&mut self, session: &str, frame: &str) {
        if let Some(top) = self.sessions.get(session).cloned() {
            self.frames.insert(frame.to_owned(), top);
        }
    }

    /// 帧被移除。换进程（`swap`）的帧在新会话下仍在，不摘。
    pub fn frame_removed(&mut self, frame: &str) {
        if self.pages.contains_key(frame) {
            return;
        }
        self.frames.remove(frame);
    }

    /// 这个会话下的这一帧是不是某个顶层页的主帧。是则返回那一页。
    pub fn main_frame(&mut self, session: &str, frame: &str) -> Option<&mut PageEntry> {
        let entry = self.pages.get_mut(frame)?;
        (entry.session == session).then_some(entry)
    }

    pub fn page(&self, target: &str) -> Option<&PageEntry> {
        self.pages.get(target)
    }

    pub fn page_mut(&mut self, target: &str) -> Option<&mut PageEntry> {
        self.pages.get_mut(target)
    }

    /// 一次下载来自哪个存活页。帧不属于任何顶层页，或那一页不在存活集合里，都是 `None`。
    pub fn tab_of_frame(&self, frame: &str) -> Option<String> {
        let top = self.frames.get(frame)?;
        self.pages.get(top)?.tab.clone()
    }

    pub fn tab_of_target(&self, target: &str) -> Option<String> {
        self.pages.get(target)?.tab.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::Table;

    fn table_with_tab() -> Table {
        let mut t = Table::default();
        t.page_attached("P1", "S1", "about:blank", "");
        t.page_mut("P1").unwrap().tab = Some("bt_1".into());
        t
    }

    /// 主帧、同进程子帧、跨站子帧、跨站子帧里的同进程子帧，四种来源的下载都归到同一页。
    #[test]
    fn downloads_from_every_kind_of_frame_resolve_to_the_top_page() {
        let mut t = table_with_tab();
        t.frame_seen("S1", "F-same");
        assert!(t.child_attached("S1", "S-oopif", "F-oopif"));
        t.frame_seen("S-oopif", "F-nested");
        for frame in ["P1", "F-same", "F-oopif", "F-nested"] {
            assert_eq!(t.tab_of_frame(frame).as_deref(), Some("bt_1"), "{frame}");
        }
        assert_eq!(t.tab_of_frame("F-unknown"), None);
    }

    /// 不在存活集合里的页（用户自己开的）有帧、没有 tabId：它的下载按用户下载处理。
    #[test]
    fn frames_of_an_untracked_page_have_no_tab() {
        let mut t = Table::default();
        t.page_attached("P2", "S2", "about:blank", "");
        t.frame_seen("S2", "F2");
        assert_eq!(t.tab_of_frame("F2"), None);
        assert!(!t.child_attached("S-unknown", "S3", "F3"), "父会话不认识的子帧不跟踪");
    }

    #[test]
    fn a_destroyed_page_takes_its_sessions_and_frames_with_it() {
        let mut t = table_with_tab();
        t.child_attached("S1", "S-oopif", "F-oopif");
        t.frame_seen("S-oopif", "F-nested");
        let entry = t.page_destroyed("P1").expect("页在表里");
        assert_eq!(entry.tab.as_deref(), Some("bt_1"));
        assert_eq!(t.tab_of_frame("F-nested"), None);
        t.frame_seen("S-oopif", "F-late");
        assert_eq!(t.tab_of_frame("F-late"), None, "会话随页一起摘掉");
        assert!(t.page_destroyed("P1").is_none());
    }

    #[test]
    fn removed_frames_leave_the_table_but_a_main_frame_stays() {
        let mut t = table_with_tab();
        t.frame_seen("S1", "F-same");
        t.frame_removed("F-same");
        t.frame_removed("P1");
        assert_eq!(t.tab_of_frame("F-same"), None);
        assert_eq!(t.tab_of_frame("P1").as_deref(), Some("bt_1"));
    }

    /// 主帧只认页会话上报的那一帧：子帧会话里的根帧不是顶层页的主帧。
    #[test]
    fn only_the_page_session_reports_the_main_frame() {
        let mut t = table_with_tab();
        t.child_attached("S1", "S-oopif", "F-oopif");
        assert!(t.main_frame("S1", "P1").is_some());
        assert!(t.main_frame("S-oopif", "P1").is_none());
        assert!(t.main_frame("S-oopif", "F-oopif").is_none());
    }
}
