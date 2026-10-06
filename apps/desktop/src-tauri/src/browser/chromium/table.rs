//! 本浏览器进程中的页面、会话与帧，按顶层页面归类。
//!
//! 每个页面会话及其跨站子帧会话都记录到顶层页面上，各会话报告的帧也记录到顶层页面上：
//! 下载事件只带 frameId，归属依靠本表从帧查到页面、再查到 tabId。

use std::collections::HashMap;

/// 顶层页面。
pub struct PageEntry {
    /// 宿主连接上该页面的会话。
    pub session: String,
    /// 宿主分配的 tabId。`None` = 不在存活集合中的页面（用户在浏览器窗口中自行打开的页面）。
    pub tab: Option<String>,
    /// 浏览器最近一次报告的地址与标题，经 `page_info` 写入。
    pub url: String,
    pub title: String,
    /// Page 域已启用、已放行。宿主新建页面时须等到此步骤才注入标记。
    pub ready: bool,
    /// 主帧提交过一次非初始文档。
    pub committed: bool,
    /// 提交之后主帧停止加载。宿主新建页面时以此作为导航完成。
    pub loaded: bool,
    /// 由页面自行打开、且打开它的页面在存活集合中：主帧首次提交时加入存活集合。
    pub popup: Option<Popup>,
}

pub struct Popup {
    pub opener_tab: String,
    pub marker: String,
}

/// 一次地址与标题投影中需要报告给宿主的变化，只含变化的项。
#[derive(Debug, PartialEq, Eq)]
pub struct InfoChange {
    pub tab: String,
    pub url: Option<String>,
    pub title: Option<String>,
}

#[derive(Default)]
pub struct Table {
    pages: HashMap<String, PageEntry>,
    /// 会话 → 顶层页面。页面会话与子帧会话都在此表中。
    sessions: HashMap<String, String>,
    /// 帧 → 顶层页面。主帧的 id 即页面的 targetId，跨站子帧的 id 即其自身的 targetId。
    frames: HashMap<String, String>,
}

impl Table {
    /// 顶层页面附加。
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

    /// 已知会话下附加了一个跨站子帧会话。父会话未知时返回 `false`，调用方只放行不跟踪。
    pub fn child_attached(&mut self, parent_session: &str, session: &str, target: &str) -> bool {
        let Some(top) = self.sessions.get(parent_session).cloned() else { return false };
        self.sessions.insert(session.to_owned(), top.clone());
        self.frames.insert(target.to_owned(), top);
        true
    }

    pub fn session_detached(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    /// 页面已销毁。其会话与帧一并移除，返回被移除的页面。
    pub fn page_destroyed(&mut self, target: &str) -> Option<PageEntry> {
        let entry = self.pages.remove(target)?;
        self.sessions.retain(|_, top| top != target);
        self.frames.retain(|_, top| top != target);
        Some(entry)
    }

    /// 会话报告一个帧。会话未知时不记录：该帧不属于本表跟踪的页面。
    pub fn frame_seen(&mut self, session: &str, frame: &str) {
        if let Some(top) = self.sessions.get(session).cloned() {
            self.frames.insert(frame.to_owned(), top);
        }
    }

    /// 帧被移除。更换进程（`swap`）的帧在新会话下仍存在，不移除。
    pub fn frame_removed(&mut self, frame: &str) {
        if self.pages.contains_key(frame) {
            return;
        }
        self.frames.remove(frame);
    }

    /// 该会话下的该帧是否为某个顶层页面的主帧。是则返回该页面。
    pub fn main_frame(&mut self, session: &str, frame: &str) -> Option<&mut PageEntry> {
        let entry = self.pages.get_mut(frame)?;
        (entry.session == session).then_some(entry)
    }

    /// 该会话是否为某个顶层页面自身的会话。是则返回该页面的 targetId；子帧会话不计入。
    pub fn page_of_session(&self, session: &str) -> Option<&str> {
        let top = self.sessions.get(session)?;
        (self.pages.get(top)?.session == session).then_some(top.as_str())
    }

    /// 记录浏览器报告的页面当前地址与标题。存活集合中的页面有变化时返回需要报告的项；
    /// 不在存活集合中的页面只记录不报告。
    pub fn page_info(&mut self, target: &str, url: &str, title: &str) -> Option<InfoChange> {
        let entry = self.pages.get_mut(target)?;
        let url_changed = entry.url != url;
        let title_changed = entry.title != title;
        url.clone_into(&mut entry.url);
        title.clone_into(&mut entry.title);
        let tab = entry.tab.clone()?;
        (url_changed || title_changed).then(|| InfoChange {
            tab,
            url: url_changed.then(|| url.to_owned()),
            title: title_changed.then(|| title.to_owned()),
        })
    }

    pub fn page(&self, target: &str) -> Option<&PageEntry> {
        self.pages.get(target)
    }

    pub fn page_mut(&mut self, target: &str) -> Option<&mut PageEntry> {
        self.pages.get_mut(target)
    }

    /// 下载来自哪个存活页面。帧不属于任何顶层页面，或该页面不在存活集合中时，均为 `None`。
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
    use super::{InfoChange, Table};

    fn table_with_tab() -> Table {
        let mut t = Table::default();
        t.page_attached("P1", "S1", "about:blank", "");
        t.page_mut("P1").unwrap().tab = Some("bt_1".into());
        t
    }

    /// 主帧、同进程子帧、跨站子帧、跨站子帧中的同进程子帧，四种来源的下载都归属同一页面。
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

    /// 不在存活集合中的页面（用户自行打开）有帧、没有 tabId：其下载按用户下载处理。
    #[test]
    fn frames_of_an_untracked_page_have_no_tab() {
        let mut t = Table::default();
        t.page_attached("P2", "S2", "about:blank", "");
        t.frame_seen("S2", "F2");
        assert_eq!(t.tab_of_frame("F2"), None);
        assert!(!t.child_attached("S-unknown", "S3", "F3"), "父会话未知的子帧不跟踪");
    }

    #[test]
    fn a_destroyed_page_takes_its_sessions_and_frames_with_it() {
        let mut t = table_with_tab();
        t.child_attached("S1", "S-oopif", "F-oopif");
        t.frame_seen("S-oopif", "F-nested");
        let entry = t.page_destroyed("P1").expect("页面在表中");
        assert_eq!(entry.tab.as_deref(), Some("bt_1"));
        assert_eq!(t.tab_of_frame("F-nested"), None);
        t.frame_seen("S-oopif", "F-late");
        assert_eq!(t.tab_of_frame("F-late"), None, "会话随页面一并移除");
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

    /// 导航提交时浏览器报告的标题仍是地址，文档标题要在之后重新读取时才能取得：重新读取到的标题必须作为一次
    /// 标题变化报告，相同的读数再次出现时不报告。
    #[test]
    fn a_title_read_after_the_commit_is_reported_once() {
        let mut t = table_with_tab();
        assert_eq!(
            t.page_info("P1", "http://h/one", "h/one"),
            Some(InfoChange {
                tab: "bt_1".into(),
                url: Some("http://h/one".into()),
                title: Some("h/one".into()),
            })
        );
        assert_eq!(
            t.page_info("P1", "http://h/one", "标题一"),
            Some(InfoChange { tab: "bt_1".into(), url: None, title: Some("标题一".into()) })
        );
        assert_eq!(t.page_info("P1", "http://h/one", "标题一"), None);
        assert_eq!(t.page("P1").unwrap().title, "标题一");
    }

    /// 不在存活集合中的页面只记录不报告；新建页面等待导航完成时读取的正是此记录。
    #[test]
    fn untracked_and_unknown_pages_report_nothing() {
        let mut t = Table::default();
        t.page_attached("P2", "S2", "about:blank", "");
        assert_eq!(t.page_info("P2", "http://h/x", "X"), None);
        assert_eq!(t.page("P2").unwrap().title, "X");
        assert_eq!(t.page_info("P-unknown", "http://h/x", "X"), None);
    }

    /// 只对顶层页面自身的会话重新读取：子帧会话报告的加载事件不属于该页面。
    #[test]
    fn only_the_page_session_maps_back_to_its_page() {
        let mut t = table_with_tab();
        t.child_attached("S1", "S-oopif", "F-oopif");
        assert_eq!(t.page_of_session("S1"), Some("P1"));
        assert_eq!(t.page_of_session("S-oopif"), None);
        assert_eq!(t.page_of_session("S-unknown"), None);
    }

    /// 主帧只认页面会话报告的帧：子帧会话中的根帧不是顶层页面的主帧。
    #[test]
    fn only_the_page_session_reports_the_main_frame() {
        let mut t = table_with_tab();
        t.child_attached("S1", "S-oopif", "F-oopif");
        assert!(t.main_frame("S1", "P1").is_some());
        assert!(t.main_frame("S-oopif", "P1").is_none());
        assert!(t.main_frame("S-oopif", "F-oopif").is_none());
    }
}
