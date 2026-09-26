//! 共享授权的状态：此刻生效的那一个会话、在等用户回答的那一次请求，以及上一次为什么结束。
//! 只做判定，不调任何接口；调接口与等回答在 `super`。
//!
//! 三条规则：
//!
//! 1. **生效的会话至多一个，在等回答的请求至多一个。** 新请求获准之后替换旧会话，旧会话由
//!    调用方关闭；等回答期间旧会话照常可用。
//! 2. **流与窗口按尺寸对应，两个方向都唯一才算对上。** portal 不告诉调用方用户选了哪个窗口，
//!    只给流；流里一帧的逻辑尺寸与恰好一个原生 Wayland 窗口的 AT-SPI 尺寸相同、且没有别的流
//!    同样大，才算对上。对上之后一直算数，直到会话结束。
//! 3. **判不出是哪一个窗口时不再弹窗。** 共享的窗口与目标窗口一样大却不唯一时如实拒绝：
//!    再问一次，用户选的还是同一个窗口，结论不变。

/// portal 的输入设备位：键盘与指针。
pub const KEYBOARD: u32 = 1;
pub const POINTER: u32 = 2;

/// 两个尺寸算同一个的误差上限，逻辑像素。流的逻辑尺寸由像素尺寸按缩放比换算，分数缩放下
/// 取整会差 1。
const SIZE_SLACK: i32 = 1;

/// 一条流共享的是哪个窗口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bound {
    /// 还没从这条流里取过帧，不知道它多大。
    Unmeasured,
    /// 取过帧，窗口的逻辑尺寸是这个，但没对上唯一一个窗口；`matches` 是同样大的窗口数。
    Measured { logical: (i32, i32), matches: usize },
    /// 对上了这个 AT-SPI frame（对象串）。
    Frame(String),
}

#[derive(Debug, Clone)]
pub struct Stream {
    /// PipeWire 节点号，也是 portal 输入接口里点名这条流的编号。
    pub node: u32,
    /// portal 给的 `size`：流的逻辑坐标范围。缺席时按缩放比 1 算。
    pub size: Option<(i32, i32)>,
    pub bound: Bound,
}

#[derive(Debug, Clone)]
pub struct Session {
    /// portal 的会话对象路径。
    pub handle: String,
    /// 用户允许的输入设备位。关掉「允许远程交互」时为 0，只能取图。
    pub devices: u32,
    pub streams: Vec<Stream>,
    /// 这个会话已经投过指针事件。见 `Ledger::first_pointer`。
    pub pointer_used: bool,
}

/// 一个窗口此刻被共享的方式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coverage {
    pub session: String,
    pub node: u32,
    pub size: Option<(i32, i32)>,
    pub keyboard: bool,
    pub pointer: bool,
}

/// 一次调用要这个窗口时该做什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Covered(Coverage),
    /// 先从这些流里各取一帧量出尺寸，再对应一次。每项是节点号与它的逻辑范围。
    Measure {
        session: String,
        nodes: Vec<(u32, Option<(i32, i32)>)>,
    },
    /// 已经问过用户，还没有回答。
    Pending,
    /// 有一条共享的流与目标窗口一样大，但同样大的窗口不止一个。
    Ambiguous(usize),
    /// 要问用户。`restore` 为真时可以带上存下的 restore token：此刻没有生效的会话。
    Ask {
        restore: bool,
    },
}

#[derive(Debug, Default)]
pub struct Ledger {
    active: Option<Session>,
    asking: bool,
    ended: Option<String>,
}

fn near(a: (i32, i32), b: (i32, i32)) -> bool {
    (a.0 - b.0).abs() <= SIZE_SLACK && (a.1 - b.1).abs() <= SIZE_SLACK
}

impl Ledger {
    /// 这个窗口此刻有没有被共享。只读已经对上的流，不取帧、不弹窗。
    pub fn covers(&self, key: &str) -> Option<Coverage> {
        let session = self.active.as_ref()?;
        let stream = session
            .streams
            .iter()
            .find(|s| s.bound == Bound::Frame(key.to_owned()))?;
        Some(Coverage {
            session: session.handle.clone(),
            node: stream.node,
            size: stream.size,
            keyboard: session.devices & KEYBOARD != 0,
            pointer: session.devices & POINTER != 0,
        })
    }

    /// `size` 是目标窗口此刻的 AT-SPI 尺寸。
    pub fn decide(&self, key: &str, size: (i32, i32)) -> Decision {
        if let Some(covered) = self.covers(key) {
            return Decision::Covered(covered);
        }
        if let Some(session) = &self.active {
            let nodes: Vec<(u32, Option<(i32, i32)>)> = session
                .streams
                .iter()
                .filter(|s| s.bound == Bound::Unmeasured)
                .map(|s| (s.node, s.size))
                .collect();
            if !nodes.is_empty() {
                return Decision::Measure {
                    session: session.handle.clone(),
                    nodes,
                };
            }
            let ambiguous = session.streams.iter().find_map(|s| match s.bound {
                Bound::Measured { logical, matches } if matches > 1 && near(logical, size) => {
                    Some(matches)
                }
                _ => None,
            });
            if let Some(matches) = ambiguous {
                return Decision::Ambiguous(matches);
            }
        }
        if self.asking {
            return Decision::Pending;
        }
        Decision::Ask {
            restore: self.active.is_none(),
        }
    }

    /// 记下开始问用户。已经在问时交回假，调用方不再发第二次请求。
    pub fn begin_ask(&mut self) -> bool {
        if self.asking {
            return false;
        }
        self.asking = true;
        true
    }

    pub fn asking(&self) -> bool {
        self.asking
    }

    /// 用户同意了：新会话生效，交回被替换的旧会话，由调用方关闭。
    pub fn granted(&mut self, session: Session) -> Option<Session> {
        self.asking = false;
        self.ended = None;
        self.active.replace(session)
    }

    /// 这次请求没有换来会话：用户取消、超时或 portal 出错。生效的旧会话不受影响。
    pub fn refused(&mut self, reason: String) {
        self.asking = false;
        self.ended = Some(reason);
    }

    /// 合成器或用户结束了一个会话。是生效的那一个才算数，交回真；调用方据此作废 restore token。
    pub fn closed(&mut self, handle: &str, reason: &str) -> bool {
        if self.active.as_ref().is_none_or(|s| s.handle != handle) {
            return false;
        }
        self.active = None;
        self.ended = Some(reason.to_owned());
        true
    }

    /// 上一次请求或会话为什么结束。
    pub fn ended(&self) -> Option<&str> {
        self.ended.as_deref()
    }

    /// 生效的会话 `handle` 是不是第一次投指针事件。是的话记下并交回真。
    ///
    /// 合成器在一个会话第一次投指针事件时才建它的虚拟指针设备，应用要等合成器通告了指针能力、
    /// 自己绑好指针之后才收得到事件；在那之前投的移动与按键应用收不到。
    pub fn first_pointer(&mut self, handle: &str) -> bool {
        match self.active.as_mut() {
            Some(session) if session.handle == handle && !session.pointer_used => {
                session.pointer_used = true;
                true
            }
            _ => false,
        }
    }

    /// 记下一条流里一帧的逻辑尺寸。流不在生效的会话里时不记：会话已经换过。
    pub fn measured(&mut self, session: &str, node: u32, logical: (i32, i32)) {
        let Some(active) = self.active.as_mut().filter(|s| s.handle == session) else {
            return;
        };
        if let Some(stream) = active.streams.iter_mut().find(|s| s.node == node) {
            stream.bound = Bound::Measured {
                logical,
                matches: 0,
            };
        }
    }

    /// 把量过尺寸、还没对上的流对到窗口上。`frames` 是此刻全部原生 Wayland 窗口的对象串与
    /// AT-SPI 尺寸；已经对上别的流的窗口不参与。
    pub fn bind(&mut self, frames: &[(String, (i32, i32))]) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        let taken: Vec<String> = active
            .streams
            .iter()
            .filter_map(|s| match &s.bound {
                Bound::Frame(key) => Some(key.clone()),
                _ => None,
            })
            .collect();
        let sizes: Vec<(u32, (i32, i32))> = active
            .streams
            .iter()
            .filter_map(|s| match s.bound {
                Bound::Measured { logical, .. } => Some((s.node, logical)),
                _ => None,
            })
            .collect();
        for stream in &mut active.streams {
            let Bound::Measured { logical, .. } = stream.bound else {
                continue;
            };
            let candidates: Vec<&String> = frames
                .iter()
                .filter(|(key, size)| near(*size, logical) && !taken.contains(key))
                .map(|(key, _)| key)
                .collect();
            let twins = sizes
                .iter()
                .filter(|(node, other)| *node != stream.node && near(*other, logical))
                .count();
            stream.bound = match candidates.as_slice() {
                [only] if twins == 0 => Bound::Frame((*only).clone()),
                _ => Bound::Measured {
                    logical,
                    matches: candidates
                        .len()
                        .max(twins + usize::from(!candidates.is_empty())),
                },
            };
        }
    }
}

/// 流里一帧的逻辑尺寸：帧的像素尺寸按「流的逻辑范围 / 视频尺寸」换算。
///
/// 按窗口共享的流，视频尺寸是整块显示器的像素，逻辑范围是那块显示器的逻辑尺寸，窗口只占
/// 帧左上角裁剪区那一块；两者之比就是缩放比。没有逻辑范围时按缩放比 1 算。
pub fn logical_size(crop: (u32, u32), video: (u32, u32), size: Option<(i32, i32)>) -> (i32, i32) {
    let scale = |pixels: u32, video: u32, logical: Option<i32>| -> i32 {
        match logical {
            Some(l) if video > 0 && l > 0 => {
                (f64::from(pixels) * f64::from(l) / f64::from(video)).round() as i32
            }
            _ => i32::try_from(pixels).unwrap_or(i32::MAX),
        }
    };
    (
        scale(crop.0, video.0, size.map(|s| s.0)),
        scale(crop.1, video.1, size.map(|s| s.1)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = ":1.5/org/a11y/atspi/accessible/3";
    const B: &str = ":1.7/org/a11y/atspi/accessible/9";

    fn session(handle: &str, streams: &[u32], devices: u32) -> Session {
        Session {
            handle: handle.to_owned(),
            devices,
            pointer_used: false,
            streams: streams
                .iter()
                .map(|node| Stream {
                    node: *node,
                    size: Some((1280, 800)),
                    bound: Bound::Unmeasured,
                })
                .collect(),
        }
    }

    fn frames(list: &[(&str, (i32, i32))]) -> Vec<(String, (i32, i32))> {
        list.iter().map(|(k, s)| ((*k).to_owned(), *s)).collect()
    }

    /// 原始失败形状：原生 Wayland 窗口没有取图与输入路径。第一次要它时去问用户，问的期间
    /// 不再发第二次请求；用户同意之后先量流、再对应，对上之后才交出流。
    #[test]
    fn a_window_is_covered_only_after_consent_measurement_and_binding() {
        let mut ledger = Ledger::default();
        assert_eq!(
            ledger.decide(A, (412, 389)),
            Decision::Ask { restore: true }
        );
        assert!(ledger.begin_ask());
        assert!(!ledger.begin_ask());
        assert_eq!(ledger.decide(A, (412, 389)), Decision::Pending);
        assert!(ledger.covers(A).is_none());

        assert!(ledger
            .granted(session("/s/1", &[44], KEYBOARD | POINTER))
            .is_none());
        assert_eq!(
            ledger.decide(A, (412, 389)),
            Decision::Measure {
                session: "/s/1".to_owned(),
                nodes: vec![(44, Some((1280, 800)))],
            }
        );
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389)), (B, (640, 480))]));
        let covered = Coverage {
            session: "/s/1".to_owned(),
            node: 44,
            size: Some((1280, 800)),
            keyboard: true,
            pointer: true,
        };
        assert_eq!(
            ledger.decide(A, (412, 389)),
            Decision::Covered(covered.clone())
        );
        assert_eq!(ledger.covers(A), Some(covered));
        // 别的窗口没被共享：再问一次，不带 restore token，旧会话照常可用。
        assert_eq!(
            ledger.decide(B, (640, 480)),
            Decision::Ask { restore: false }
        );
    }

    /// 用户关掉「允许远程交互」：只能取图，键盘与指针不可用。
    #[test]
    fn a_session_without_devices_covers_capture_only() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], 0));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389))]));
        let covered = ledger.covers(A).expect("取图仍然可用");
        assert!(!covered.keyboard && !covered.pointer);
    }

    /// 两个一样大的窗口：判不出共享的是哪一个，如实拒绝，不再弹窗。
    #[test]
    fn two_windows_of_the_shared_size_are_ambiguous_and_not_asked_again() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], KEYBOARD | POINTER));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389)), (B, (412, 389))]));
        assert!(ledger.covers(A).is_none() && ledger.covers(B).is_none());
        assert_eq!(ledger.decide(A, (412, 389)), Decision::Ambiguous(2));
        // 尺寸不同的窗口不在其列：它确实没被共享，照常去问。
        assert_eq!(
            ledger.decide(":1.9/x", (300, 200)),
            Decision::Ask { restore: false }
        );
    }

    /// 两条流一样大、只有一个窗口对得上：同样判不出，两条都不对应。
    #[test]
    fn two_streams_of_one_size_bind_to_nothing() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44, 45], KEYBOARD | POINTER));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.measured("/s/1", 45, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389))]));
        assert!(ledger.covers(A).is_none());
        assert_eq!(ledger.decide(A, (412, 389)), Decision::Ambiguous(2));
    }

    /// 已经对上一条流的窗口不参与下一条流的对应。
    #[test]
    fn a_bound_window_is_not_offered_to_another_stream() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44, 45], KEYBOARD | POINTER));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389))]));
        ledger.measured("/s/1", 45, (640, 480));
        ledger.bind(&frames(&[(A, (412, 389)), (B, (640, 481))]));
        assert_eq!(ledger.covers(A).map(|c| c.node), Some(44));
        assert_eq!(ledger.covers(B).map(|c| c.node), Some(45));
    }

    /// 取消、超时与出错：不留会话，记下原因；生效的旧会话不受影响。
    #[test]
    fn a_refused_request_keeps_the_previous_session() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], KEYBOARD | POINTER));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389))]));
        ledger.begin_ask();
        ledger.refused("consent_denied".to_owned());
        assert!(!ledger.asking());
        assert_eq!(ledger.ended(), Some("consent_denied"));
        assert!(ledger.covers(A).is_some());
    }

    /// 替换：新会话获准之后交回旧会话；旧会话随后发来的「已结束」不算数。
    #[test]
    fn a_replaced_session_is_handed_back_and_its_close_is_ignored() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], KEYBOARD | POINTER));
        ledger.begin_ask();
        let old = ledger.granted(session("/s/2", &[46], KEYBOARD | POINTER));
        assert_eq!(old.map(|s| s.handle).as_deref(), Some("/s/1"));
        assert!(!ledger.closed("/s/1", "portal_session_closed"));
        assert!(ledger.ended().is_none());
    }

    /// 撤销：合成器或用户结束生效的会话，能力随之撤回，下一次调用重新问用户。
    #[test]
    fn a_closed_session_drops_coverage() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], KEYBOARD | POINTER));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389))]));
        assert!(ledger.closed("/s/1", "portal_session_closed"));
        assert!(ledger.covers(A).is_none());
        assert_eq!(ledger.ended(), Some("portal_session_closed"));
        assert_eq!(
            ledger.decide(A, (412, 389)),
            Decision::Ask { restore: true }
        );
    }

    /// 每个会话只有第一次投指针事件时要等合成器通告指针能力；换了会话重新算。
    #[test]
    fn only_the_first_pointer_event_of_a_session_waits() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], KEYBOARD | POINTER));
        assert!(ledger.first_pointer("/s/1"));
        assert!(!ledger.first_pointer("/s/1"));
        assert!(!ledger.first_pointer("/s/0"));
        ledger.begin_ask();
        ledger.granted(session("/s/2", &[46], KEYBOARD | POINTER));
        assert!(ledger.first_pointer("/s/2"));
    }

    /// 会话换过之后，旧会话那条流的尺寸不记。
    #[test]
    fn a_measurement_for_a_replaced_session_is_ignored() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/2", &[44], KEYBOARD | POINTER));
        ledger.measured("/s/1", 44, (412, 389));
        assert!(matches!(
            ledger.decide(A, (412, 389)),
            Decision::Measure { .. }
        ));
    }

    /// 缩放比 1：逻辑尺寸就是裁剪区的像素尺寸；缩放比 2：减半；没有逻辑范围按 1 算。
    #[test]
    fn the_logical_size_follows_the_stream_scale() {
        assert_eq!(
            logical_size((412, 389), (1280, 800), Some((1280, 800))),
            (412, 389)
        );
        assert_eq!(
            logical_size((824, 778), (2560, 1600), Some((1280, 800))),
            (412, 389)
        );
        assert_eq!(logical_size((412, 389), (412, 389), None), (412, 389));
        // 1.25 倍：取整。
        assert_eq!(
            logical_size((515, 486), (1600, 1000), Some((1280, 800))),
            (412, 389)
        );
    }
}
