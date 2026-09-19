//! 剪贴板投递：保存用户的内容、写入本次文字、发 Ctrl+V、再把原内容放回去。
//!
//! 五条边界：
//!
//! 1. **只经 `Board` 碰剪贴板。** 真实实现调 Win32，单测换成替身，测试不动系统剪贴板。
//! 2. **恢复前后各读一次序列号。** 写入之后记下的那个此刻还成立才恢复；不成立说明这
//!    期间有别人往剪贴板放了内容，恢复会把它盖掉，那时宁可不恢复并如实回执。
//! 3. **任何中止路径都要走一遍恢复**，规则同上。写进去的是本次的临时内容，留在用户的
//!    剪贴板里是副作用。
//! 4. **拿不到剪贴板就记未派发**，不回退去用会把字打错的注入路径。
//! 5. **本模块不做前台核对**：目标窗口是不是前台由调用方在发 Ctrl+V 之前判。

use crate::input::{key_stroke, Hold, Sink};

/// `Ctrl` 与 `V` 的虚拟键码。组合键序列由 `input::key_stroke` 组装。
const VK_CONTROL: (u16, bool) = (0x11, false);
const VK_V: (u16, bool) = (0x56, false);

/// 从剪贴板拷出来的一份内容。
///
/// `formats` 是能整块拷出来的那些（格式号与字节）；`skipped` 是拷不出来的格式号——
/// 延迟渲染的格式在所有者不响应时取不到句柄，非内存句柄的格式（位图）拷不了字节。
/// **`skipped` 非空表示这一份恢复不全**，调用方要在回执里说出来。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Saved {
    pub formats: Vec<(u32, Vec<u8>)>,
    pub skipped: Vec<u32>,
}

/// 这个剪贴板格式的数据是不是一块可移动内存。
///
/// **不是的一律不碰**：`GetClipboardData` 对它们回的是 GDI 句柄或显示用的私有句柄，
/// 拿它去调 `GlobalSize` / `GlobalLock` 的行为未定义，实测会让 worker 进程直接消失，
/// 请求永远没有回执。位图不必为此遗憾：`CF_DIB` 是内存格式，恢复它之后系统会自己合成
/// `CF_BITMAP`。
pub const fn copyable(format: u32) -> bool {
    !matches!(
        format,
        // CF_BITMAP / CF_METAFILEPICT / CF_PALETTE / CF_ENHMETAFILE
        2 | 3 | 9 | 14
        // CF_OWNERDISPLAY / CF_DSPBITMAP / CF_DSPMETAFILEPICT / CF_DSPENHMETAFILE
        | 0x0080 | 0x0082 | 0x0083 | 0x008E
        // CF_GDIOBJFIRST..=CF_GDIOBJLAST
        | 0x0300..=0x03FF
    )
}

/// 把系统会自己合成回来的格式从「没放回去」的清单里去掉。
///
/// `CF_BITMAP` 与 `CF_PALETTE` 是 GDI 句柄，拷不了，但只要 `CF_DIB` 或 `CF_DIBV5` 放回去了
/// 系统就会按它们合成这两个。**不去掉的代价是回执说了一件没发生的事**：一张图片的剪贴板
/// 每次都会被报成「有格式没能放回」，而格式清单恢复之后与粘贴前一模一样。
fn prune_synthesized(saved: &mut Saved) {
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;
    const CF_BITMAP: u32 = 2;
    const CF_PALETTE: u32 = 9;
    let has_dib = saved
        .formats
        .iter()
        .any(|(f, _)| *f == CF_DIB || *f == CF_DIBV5);
    if has_dib {
        saved
            .skipped
            .retain(|f| *f != CF_BITMAP && *f != CF_PALETTE);
    }
}

/// 剪贴板的系统接口。
pub trait Board {
    /// `GetClipboardSequenceNumber`。每次有人改剪贴板它就变。
    fn sequence(&self) -> u32;
    /// 把当前全部格式拷出来。
    fn save(&self) -> Result<Saved, String>;
    /// 写入一段纯文本，并带上不进剪贴板历史的标记格式。
    fn put_text(&self, text: &str) -> Result<(), String>;
    /// 清空剪贴板并把 `save` 拷出来的内容放回去。
    fn restore(&self, saved: &Saved) -> Result<(), String>;
}

/// 原内容有没有放回去。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Restored {
    /// 已放回。`partial` 为真时有拷不出来的格式没能一起回去。
    Done { partial: bool },
    /// 这期间别人往剪贴板放了新内容，没有恢复——恢复会把那份内容盖掉。
    Foreign,
    /// 恢复调用失败。
    Failed(String),
}

impl Restored {
    /// 用户的剪贴板此刻是不是还留着本次写进去的临时文字。
    pub const fn left_behind(&self) -> bool {
        !matches!(self, Self::Done { .. })
    }
}

/// 一次粘贴投递的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pasted {
    /// 真的进了输入队列的 Ctrl+V 事件数。
    pub sent: u32,
    /// 这次请求的 Ctrl+V 事件数。
    pub requested: u32,
    pub restored: Restored,
}

/// 写剪贴板、发 Ctrl+V、恢复原内容。
///
/// `ready` 在发 Ctrl+V 之前再核一次前台，返回 `Err` 即中止；中止路径同样走恢复。
/// `settle` 给目标读剪贴板留出时间——目标处理 `WM_PASTE` 是异步的，恢复得太早它读到的
/// 是已经放回去的旧内容。
///
/// 返回 `Err` 表示**一个输入事件都没有发出**：剪贴板没拿到或写入失败，调用方据此记
/// 未派发。返回 `Ok` 时 `sent` 才是执行事实。
pub fn paste(
    board: &dyn Board,
    sink: &dyn Sink,
    text: &str,
    ready: &dyn Fn() -> Result<(), String>,
    settle: &dyn Fn(),
) -> Result<Pasted, String> {
    let saved = board.save()?;
    board.put_text(text)?;
    // 写入之后的序列号是恢复的判据：恢复前再读一次，不一致就是这期间有别人写过。
    let after_write = board.sequence();

    if let Err(reason) = ready() {
        let restored = put_back(board, &saved, after_write);
        return Err(format!("{reason}{}", clipboard_note(&restored)));
    }

    let events = key_stroke(VK_V, &[VK_CONTROL]);
    let requested = u32::try_from(events.len()).unwrap_or(u32::MAX);
    // 记账在派发之前：整条序列自带抬起，但只发出去一半时 Ctrl 会停在按下状态。
    let mut hold = Hold::record(sink, Vec::new(), vec![VK_CONTROL, VK_V]);
    let sent = sink.send(&events);
    if sent >= requested {
        hold.clear();
    } else {
        hold.release();
    }

    // 一个事件都没进队列时目标不会去读剪贴板，不必等。
    if sent > 0 {
        settle();
    }
    let restored = put_back(board, &saved, after_write);
    Ok(Pasted {
        sent,
        requested,
        restored,
    })
}

/// 恢复原内容，判据是写入之后记下的序列号此刻还成立。
fn put_back(board: &dyn Board, saved: &Saved, after_write: u32) -> Restored {
    if board.sequence() != after_write {
        return Restored::Foreign;
    }
    match board.restore(saved) {
        Ok(()) => Restored::Done {
            partial: !saved.skipped.is_empty(),
        },
        Err(reason) => Restored::Failed(reason),
    }
}

/// 回执里关于剪贴板的那一句。已经原样放回时不写——没有要告诉调用方的事。
pub fn clipboard_note(restored: &Restored) -> String {
    match restored {
        Restored::Done { partial: false } => String::new(),
        Restored::Done { partial: true } => {
            "；剪贴板已恢复，但有取不出来的格式没能一起放回".to_owned()
        }
        Restored::Foreign => {
            "；这期间剪贴板被别的程序改过，没有恢复，里面现在是本次粘贴的文字".to_owned()
        }
        Restored::Failed(reason) => {
            format!("；剪贴板恢复失败（{reason}），里面现在是本次粘贴的文字")
        }
    }
}

// ── 真实实现 ──

#[cfg(windows)]
mod os {
    use std::time::{Duration, Instant};

    use ::windows::core::PCWSTR;
    use ::windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
    use ::windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
        GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use ::windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };

    use super::{Board, Saved};

    /// `CF_UNICODETEXT`。
    const CF_UNICODETEXT: u32 = 13;
    /// 打开剪贴板的重试上限。剪贴板一次只有一个进程拿得到，别的程序正在读写时会失败。
    const OPEN_LIMIT: Duration = Duration::from_millis(600);
    const OPEN_RETRY_MS: u64 = 20;

    /// 让这段临时内容不进剪贴板历史与云剪贴板的三个注册格式。
    ///
    /// 写入时把它们一起放上去，值是一个 `u32` 的 0。**名字是注册格式不是常量编号**，
    /// 每次要用 `RegisterClipboardFormatW` 现问。
    const EXCLUDE_FORMATS: [&str; 3] = [
        "ExcludeClipboardContentFromMonitorProcessing",
        "CanIncludeInClipboardHistory",
        "CanUploadToCloudClipboard",
    ];

    pub struct SystemBoard;

    /// 一次打开剪贴板的持有。`Drop` 关掉，任何中途返回都不会把它留在打开状态。
    struct Open;

    impl Open {
        fn get() -> Result<Self, String> {
            let until = Instant::now() + OPEN_LIMIT;
            loop {
                // SAFETY: 无窗口所有者的打开，参数合法。
                if unsafe { OpenClipboard(Some(HWND(std::ptr::null_mut()))) }.is_ok() {
                    return Ok(Self);
                }
                if Instant::now() >= until {
                    return Err(
                        "clipboard_busy: 剪贴板被别的程序占着，这次输入没有发出".to_owned()
                    );
                }
                std::thread::sleep(Duration::from_millis(OPEN_RETRY_MS));
            }
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: 只在本进程确实打开过剪贴板时构造，配对关闭。
            let _ = unsafe { CloseClipboard() };
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 把字节拷进一块可移动内存并交给剪贴板。交出去之后所有权归系统，不能再释放。
    fn hand_over(format: u32, bytes: &[u8]) -> Result<(), String> {
        // SAFETY: 分配长度由字节数给出，随后整块写满。
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) }
            .map_err(|e| format!("剪贴板内存分配失败：{e}"))?;
        // SAFETY: 句柄来自上一行，锁定期间独占。
        let ptr = unsafe { GlobalLock(handle) };
        if ptr.is_null() {
            return Err("剪贴板内存锁定失败".to_owned());
        }
        // SAFETY: 目标块的长度不小于源，两块不重叠。
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.cast::<u8>(), bytes.len()) };
        // SAFETY: 与上面的锁定配对。
        let _ = unsafe { GlobalUnlock(handle) };
        // SAFETY: 调用成功后句柄归系统，本函数不再碰它。
        unsafe { SetClipboardData(format, Some(HANDLE(handle.0))) }
            .map_err(|e| format!("写剪贴板格式 {format} 失败：{e}"))?;
        Ok(())
    }

    fn registered(name: &str) -> u32 {
        let wide = wide(name);
        // SAFETY: 字符串在调用期间存活且以 0 结尾。
        unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) }
    }

    impl Board for SystemBoard {
        fn sequence(&self) -> u32 {
            // SAFETY: 无参只读查询，不需要打开剪贴板。
            unsafe { GetClipboardSequenceNumber() }
        }

        fn save(&self) -> Result<Saved, String> {
            let _open = Open::get()?;
            let mut saved = Saved::default();
            let mut format = 0u32;
            loop {
                // SAFETY: 顺序枚举，0 表示从头开始。
                format = unsafe { EnumClipboardFormats(format) };
                if format == 0 {
                    break;
                }
                if !super::copyable(format) {
                    saved.skipped.push(format);
                    continue;
                }
                // SAFETY: 剪贴板已打开，格式号来自枚举。句柄归剪贴板所有，只读不释放。
                let Ok(handle) = (unsafe { GetClipboardData(format) }) else {
                    saved.skipped.push(format);
                    continue;
                };
                if handle.0.is_null() {
                    saved.skipped.push(format);
                    continue;
                }
                let global = HGLOBAL(handle.0);
                // SAFETY: 非内存句柄（位图一类）在这里返回 0，据此判定拷不了。
                let size = unsafe { GlobalSize(global) };
                if size == 0 {
                    saved.skipped.push(format);
                    continue;
                }
                // SAFETY: 句柄来自剪贴板，锁定期间只读。
                let ptr = unsafe { GlobalLock(global) };
                if ptr.is_null() {
                    saved.skipped.push(format);
                    continue;
                }
                // SAFETY: 长度由 `GlobalSize` 给出，读的是同一块内存。
                let bytes =
                    unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), size) }.to_vec();
                // SAFETY: 与上面的锁定配对。
                let _ = unsafe { GlobalUnlock(global) };
                saved.formats.push((format, bytes));
            }
            super::prune_synthesized(&mut saved);
            Ok(saved)
        }

        fn put_text(&self, text: &str) -> Result<(), String> {
            let _open = Open::get()?;
            // SAFETY: 剪贴板已打开。清空之后本进程是所有者。
            unsafe { EmptyClipboard() }.map_err(|e| format!("清空剪贴板失败：{e}"))?;
            let units = wide(text);
            let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
            hand_over(CF_UNICODETEXT, &bytes)?;
            for name in EXCLUDE_FORMATS {
                let format = registered(name);
                if format != 0 {
                    // 标记格式取不到内存时不算这次投递失败：它只影响进不进剪贴板历史。
                    let _ = hand_over(format, &0u32.to_le_bytes());
                }
            }
            Ok(())
        }

        fn restore(&self, saved: &Saved) -> Result<(), String> {
            let _open = Open::get()?;
            // SAFETY: 剪贴板已打开。
            unsafe { EmptyClipboard() }.map_err(|e| format!("清空剪贴板失败：{e}"))?;
            for (format, bytes) in &saved.formats {
                hand_over(*format, bytes)?;
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
pub use os::SystemBoard;

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::sync::Mutex;

    use super::*;
    use crate::input::Event;

    /// 按下状态账是进程级的，读写它的用例要排队跑。
    static LEDGER_TESTS: Mutex<()> = Mutex::new(());

    /// 单测用的剪贴板替身。它不碰系统剪贴板。
    struct FakeBoard {
        seq: RefCell<u32>,
        saved: Saved,
        /// 写入之后、恢复之前把序列号再加一次，构造「别人也改了剪贴板」。
        foreign_write: bool,
        /// `save` 失败。
        save_fails: bool,
        /// `restore` 失败。
        restore_fails: bool,
        log: RefCell<Vec<String>>,
    }

    impl Default for FakeBoard {
        fn default() -> Self {
            Self {
                seq: RefCell::new(7),
                saved: Saved {
                    formats: vec![(13, b"old".to_vec())],
                    skipped: Vec::new(),
                },
                foreign_write: false,
                save_fails: false,
                restore_fails: false,
                log: RefCell::new(Vec::new()),
            }
        }
    }

    impl Board for FakeBoard {
        fn sequence(&self) -> u32 {
            let seq = *self.seq.borrow();
            if self.foreign_write && self.log.borrow().iter().any(|l| l == "put_text") {
                // 第二次读（恢复前那次）才抬号：第一次读是写入之后记下的那个。
                let reads = self.log.borrow().iter().filter(|l| *l == "seq").count();
                self.log.borrow_mut().push("seq".to_owned());
                if reads >= 1 {
                    return seq + 1;
                }
                return seq;
            }
            self.log.borrow_mut().push("seq".to_owned());
            seq
        }

        fn save(&self) -> Result<Saved, String> {
            self.log.borrow_mut().push("save".to_owned());
            if self.save_fails {
                return Err("clipboard_busy: 剪贴板被别的程序占着，这次输入没有发出".to_owned());
            }
            Ok(self.saved.clone())
        }

        fn put_text(&self, text: &str) -> Result<(), String> {
            self.log.borrow_mut().push("put_text".to_owned());
            *self.seq.borrow_mut() += 1;
            assert!(!text.is_empty());
            Ok(())
        }

        fn restore(&self, saved: &Saved) -> Result<(), String> {
            self.log.borrow_mut().push("restore".to_owned());
            if self.restore_fails {
                return Err("写剪贴板格式 13 失败".to_owned());
            }
            assert_eq!(saved, &self.saved);
            Ok(())
        }
    }

    impl FakeBoard {
        fn steps(&self) -> Vec<String> {
            self.log
                .borrow()
                .iter()
                .filter(|l| *l != "seq")
                .cloned()
                .collect()
        }
    }

    #[derive(Default)]
    struct Recorder {
        sent: Mutex<Vec<Event>>,
        accept: Option<u32>,
    }

    impl Sink for Recorder {
        fn send(&self, events: &[Event]) -> u32 {
            let count = u32::try_from(events.len()).unwrap_or(u32::MAX);
            let taken = self.accept.map_or(count, |limit| limit.min(count));
            if let Ok(mut log) = self.sent.lock() {
                log.extend_from_slice(&events[..taken as usize]);
            }
            taken
        }
    }

    impl Recorder {
        fn events(&self) -> Vec<Event> {
            self.sent.lock().expect("记录器锁").clone()
        }
    }

    fn ok() -> impl Fn() -> Result<(), String> {
        || Ok(())
    }

    /// 顺序是保存 → 写入 → Ctrl+V → 恢复，一步都不能少也不能换位置。
    #[test]
    fn a_paste_saves_writes_sends_then_restores() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard::default();
        let sink = Recorder::default();
        let settled = RefCell::new(0);
        let out = paste(&board, &sink, "哦哦行，", &ok(), &|| {
            *settled.borrow_mut() += 1;
        })
        .expect("这一次应当发出去");
        assert_eq!(board.steps(), vec!["save", "put_text", "restore"]);
        assert_eq!(out.restored, Restored::Done { partial: false });
        assert_eq!(out.sent, out.requested);
        assert_eq!(*settled.borrow(), 1, "发出去了就要给目标读剪贴板的时间");
        // Ctrl 先按下、V 按下抬起、Ctrl 后抬起。
        assert_eq!(
            sink.events(),
            key_stroke(VK_V, &[VK_CONTROL]),
            "发的是 Ctrl+V 的完整序列"
        );
        assert_eq!(crate::input::held(), crate::protocol::HeldInput::default());
    }

    /// 写入之后剪贴板又被别人改过时不恢复，回执说得出剪贴板里现在是本次的文字。
    #[test]
    fn a_clipboard_written_by_someone_else_is_not_overwritten() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard {
            foreign_write: true,
            ..FakeBoard::default()
        };
        let sink = Recorder::default();
        let out = paste(&board, &sink, "，", &ok(), &|| {}).expect("这一次应当发出去");
        assert_eq!(out.restored, Restored::Foreign);
        assert!(out.restored.left_behind());
        assert!(!board.steps().contains(&"restore".to_owned()));
        assert!(clipboard_note(&out.restored).contains("没有恢复"));
    }

    /// 拷不出来的格式记在 `skipped` 里，恢复之后回执说得出这一份没回全。
    #[test]
    fn formats_that_could_not_be_copied_are_reported_after_the_restore() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard {
            saved: Saved {
                formats: vec![(13, b"old".to_vec())],
                skipped: vec![2],
            },
            ..FakeBoard::default()
        };
        let sink = Recorder::default();
        let out = paste(&board, &sink, "。", &ok(), &|| {}).expect("这一次应当发出去");
        assert_eq!(out.restored, Restored::Done { partial: true });
        // 没回全仍然算恢复过：用户的剪贴板里不是本次的临时文字。
        assert!(!out.restored.left_behind());
        assert!(clipboard_note(&out.restored).contains("没能一起放回"));
    }

    /// 恢复失败要如实带回原因，不能吞掉。
    #[test]
    fn a_failed_restore_is_reported_with_its_reason() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard {
            restore_fails: true,
            ..FakeBoard::default()
        };
        let sink = Recorder::default();
        let out = paste(&board, &sink, "、", &ok(), &|| {}).expect("这一次应当发出去");
        assert!(matches!(out.restored, Restored::Failed(_)));
        assert!(out.restored.left_behind());
        assert!(clipboard_note(&out.restored).contains("恢复失败"));
    }

    /// 剪贴板拿不到时一个输入事件都不发，也不回退去用注入。
    #[test]
    fn a_clipboard_that_cannot_be_opened_sends_no_input_at_all() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard {
            save_fails: true,
            ..FakeBoard::default()
        };
        let sink = Recorder::default();
        let err = paste(&board, &sink, "，", &ok(), &|| {}).expect_err("这一次不该发出去");
        assert!(err.starts_with("clipboard_busy"));
        assert!(sink.events().is_empty());
        assert_eq!(board.steps(), vec!["save"]);
    }

    /// 发 Ctrl+V 之前前台变了就中止，中止路径同样把原内容放回去。
    #[test]
    fn an_aborted_paste_still_puts_the_clipboard_back() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard::default();
        let sink = Recorder::default();
        let err = paste(
            &board,
            &sink,
            "，",
            &|| Err("not_foreground: 系统前台窗口不是目标窗口".to_owned()),
            &|| {},
        )
        .expect_err("这一次不该发出去");
        assert!(err.starts_with("not_foreground"));
        assert!(sink.events().is_empty());
        assert_eq!(board.steps(), vec!["save", "put_text", "restore"]);
    }

    /// Ctrl+V 只发出去一半时修饰键要释放，账也要清干净。
    #[test]
    fn a_partly_dispatched_paste_releases_the_modifier() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard::default();
        let sink = Recorder {
            accept: Some(2),
            ..Recorder::default()
        };
        let out = paste(&board, &sink, "，", &ok(), &|| {}).expect("这一次应当发出去");
        assert_eq!(out.sent, 2);
        assert!(out.sent < out.requested);
        assert_eq!(crate::input::held(), crate::protocol::HeldInput::default());
        // 释放补发的抬起跟在只发出去的那两个事件后面。
        assert!(sink.events().len() > 2);
        assert!(matches!(
            sink.events().last(),
            Some(Event::Key { vk: 0x11, .. })
        ));
    }

    /// 一个事件都没进队列时不必给目标读剪贴板的时间。
    #[test]
    fn a_blocked_paste_does_not_wait_for_the_target() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard::default();
        let sink = Recorder {
            accept: Some(0),
            ..Recorder::default()
        };
        let settled = RefCell::new(0);
        let out = paste(&board, &sink, "，", &ok(), &|| {
            *settled.borrow_mut() += 1;
        })
        .expect("这一次应当返回结果");
        assert_eq!(out.sent, 0);
        assert_eq!(*settled.borrow(), 0);
        assert_eq!(out.restored, Restored::Done { partial: false });
    }

    /// GDI 句柄类的格式一律不拷。拿它们去调 `GlobalSize` 会让整个进程消失。
    #[test]
    fn handle_based_formats_are_never_copied() {
        // CF_BITMAP / CF_METAFILEPICT / CF_PALETTE / CF_ENHMETAFILE 与显示用的那几个。
        for format in [2, 3, 9, 14, 0x0080, 0x0082, 0x0083, 0x008E, 0x0300, 0x03FF] {
            assert!(!copyable(format), "格式 {format} 不该被拷出来");
        }
        // CF_TEXT / CF_UNICODETEXT / CF_DIB / CF_HDROP / CF_DIBV5 与注册格式都是内存块。
        for format in [1, 13, 8, 15, 17, 49_350] {
            assert!(copyable(format), "格式 {format} 应当拷得出来");
        }
    }

    /// 位图与调色板由系统按 DIB 合成，不算「没放回去」；DIB 也拷不到时才算。
    #[test]
    fn formats_the_system_synthesizes_are_not_reported_as_lost() {
        let mut with_dib = Saved {
            formats: vec![(8, vec![1]), (13, vec![2])],
            skipped: vec![2, 9, 0x0082],
        };
        prune_synthesized(&mut with_dib);
        assert_eq!(with_dib.skipped, vec![0x0082]);

        let mut without_dib = Saved {
            formats: vec![(13, vec![2])],
            skipped: vec![2, 9],
        };
        prune_synthesized(&mut without_dib);
        assert_eq!(without_dib.skipped, vec![2, 9]);
    }

    /// 鼠标键不参与粘贴：这里只按 Ctrl 与 V。
    #[test]
    fn a_paste_presses_no_mouse_button() {
        let _guard = LEDGER_TESTS.lock().expect("用例锁");
        let board = FakeBoard::default();
        let sink = Recorder::default();
        let _ = paste(&board, &sink, "，", &ok(), &|| {});
        assert!(!sink
            .events()
            .iter()
            .any(|e| matches!(e, Event::Button { .. })));
        assert!(crate::input::held().buttons.is_empty());
    }
}
