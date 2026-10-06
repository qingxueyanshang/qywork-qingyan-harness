//! 共享授权的状态：当前生效的会话、等待用户答复的请求，以及上一次结束的原因。
//! 只做判定，不调用任何接口；调用接口与等待响应在 `super` 中完成。
//!
//! 三条规则：
//!
//! 1. **生效的会话至多一个，等待答复的请求至多一个。** 新请求获准之后替换旧会话，旧会话由
//!    调用方关闭；等待答复期间旧会话照常可用。
//! 2. **流与窗口按尺寸对应，两个方向都唯一才视为匹配。** portal 不告知调用方用户选择了哪个
//!    窗口，只提供流；流中一帧的逻辑尺寸与恰好一个原生 Wayland 窗口的 AT-SPI 尺寸相同，且没有
//!    其他流尺寸相同，才视为匹配。匹配之后持续有效，直到会话结束。
//! 3. **无法判定是哪一个窗口时不再弹出授权框。** 共享的窗口与目标窗口尺寸相同但不唯一时如实
//!    拒绝：再次询问时用户选择的仍是同一个窗口，结论不变。

/// portal 的输入设备位：键盘与指针。
pub const KEYBOARD: u32 = 1;
pub const POINTER: u32 = 2;

/// 两个尺寸视为相同的误差上限，单位为逻辑像素。流的逻辑尺寸由像素尺寸按缩放比换算，分数缩放下
/// 取整会相差 1。
const SIZE_SLACK: i32 = 1;

/// 一条流共享的窗口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bound {
    /// 尚未从该流中取过帧，尺寸未知。
    Unmeasured,
    /// 已取过帧，`logical` 为窗口的逻辑尺寸，但未匹配到唯一一个窗口；`matches` 是尺寸相同的窗口数。
    Measured { logical: (i32, i32), matches: usize },
    /// 已匹配到该 AT-SPI frame（对象串）。
    Frame(String),
}

#[derive(Debug, Clone)]
pub struct Stream {
    /// PipeWire 节点号，也是 portal 输入接口中指定该流的编号。
    pub node: u32,
    /// portal 提供的 `size`：流的逻辑坐标范围。缺失时按缩放比 1 计算。
    pub size: Option<(i32, i32)>,
    pub bound: Bound,
}

#[derive(Debug, Clone)]
pub struct Session {
    /// portal 的会话对象路径。
    pub handle: String,
    /// 用户允许的输入设备位。关闭「允许远程交互」时为 0，只能采图。
    pub devices: u32,
    pub streams: Vec<Stream>,
    /// 该会话已投递过指针事件。见 `Ledger::first_pointer`。
    pub pointer_used: bool,
}

/// 一个窗口当前被共享的方式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coverage {
    pub session: String,
    pub node: u32,
    pub size: Option<(i32, i32)>,
    pub keyboard: bool,
    pub pointer: bool,
}

/// 一次调用请求该窗口时应执行的操作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Covered(Coverage),
    /// 先从这些流中各取一帧测量尺寸，再执行一次对应。每项是节点号与其逻辑范围。
    Measure {
        session: String,
        nodes: Vec<(u32, Option<(i32, i32)>)>,
    },
    /// 已询问用户，尚未得到答复。
    Pending,
    /// 有一条共享的流与目标窗口尺寸相同，但尺寸相同的窗口不止一个。
    Ambiguous(usize),
    /// 需要询问用户。`restore` 为真时可以携带已保存的 restore token：当前没有生效的会话。
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
    /// 该窗口当前是否被共享。只读取已匹配的流，不取帧、不弹出授权框。
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

    /// `size` 是目标窗口当前的 AT-SPI 尺寸。
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

    /// 记录开始询问用户。已在询问时返回假，调用方不再发送第二次请求。
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

    /// 用户已同意：新会话生效，返回被替换的旧会话，由调用方关闭。
    pub fn granted(&mut self, session: Session) -> Option<Session> {
        self.asking = false;
        self.ended = None;
        self.active.replace(session)
    }

    /// 本次请求未取得会话：用户取消、超时或 portal 出错。生效的旧会话不受影响。
    pub fn refused(&mut self, reason: String) {
        self.asking = false;
        self.ended = Some(reason);
    }

    /// 合成器或用户结束了一个会话。仅当该会话是生效的会话时才处理并返回真；调用方据此作废 restore token。
    pub fn closed(&mut self, handle: &str, reason: &str) -> bool {
        if self.active.as_ref().is_none_or(|s| s.handle != handle) {
            return false;
        }
        self.active = None;
        self.ended = Some(reason.to_owned());
        true
    }

    /// 上一次请求或会话结束的原因。
    pub fn ended(&self) -> Option<&str> {
        self.ended.as_deref()
    }

    /// 生效的会话 `handle` 是否首次投递指针事件。是首次时记录并返回真。
    ///
    /// 合成器在一个会话首次投递指针事件时才创建该会话的虚拟指针设备，应用在合成器通告指针能力、
    /// 且应用绑定指针之后才能收到事件；在此之前投递的移动与按键，应用收不到。
    pub fn first_pointer(&mut self, handle: &str) -> bool {
        match self.active.as_mut() {
            Some(session) if session.handle == handle && !session.pointer_used => {
                session.pointer_used = true;
                true
            }
            _ => false,
        }
    }

    /// 记录一条流中一帧的逻辑尺寸。流不在生效的会话中时不记录：会话已更换。
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

    /// 将已测量尺寸、尚未匹配的流对应到窗口上。`frames` 是当前全部原生 Wayland 窗口的对象串与
    /// AT-SPI 尺寸；已与其他流匹配的窗口不参与。
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

/// 流中一帧的逻辑尺寸：帧的像素尺寸按「流的逻辑范围 / 视频尺寸」换算。
///
/// 按窗口共享的流中，视频尺寸是整块显示器的像素尺寸，逻辑范围是该显示器的逻辑尺寸，窗口只占据
/// 帧左上角的裁剪区；两者之比即缩放比。没有逻辑范围时按缩放比 1 计算。
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

    /// 原始失败形状：原生 Wayland 窗口没有采图与输入路径。首次请求该窗口时询问用户，询问期间
    /// 不再发送第二次请求；用户同意之后先测量流尺寸、再执行对应，匹配之后才提供流。
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
        // 其他窗口未被共享：再次询问，不携带 restore token，旧会话照常可用。
        assert_eq!(
            ledger.decide(B, (640, 480)),
            Decision::Ask { restore: false }
        );
    }

    /// 用户关闭「允许远程交互」：只能采图，键盘与指针不可用。
    #[test]
    fn a_session_without_devices_covers_capture_only() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], 0));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389))]));
        let covered = ledger.covers(A).expect("采图仍然可用");
        assert!(!covered.keyboard && !covered.pointer);
    }

    /// 两个尺寸相同的窗口：无法判定共享的是哪一个，如实拒绝，不再弹出授权框。
    #[test]
    fn two_windows_of_the_shared_size_are_ambiguous_and_not_asked_again() {
        let mut ledger = Ledger::default();
        ledger.begin_ask();
        ledger.granted(session("/s/1", &[44], KEYBOARD | POINTER));
        ledger.measured("/s/1", 44, (412, 389));
        ledger.bind(&frames(&[(A, (412, 389)), (B, (412, 389))]));
        assert!(ledger.covers(A).is_none() && ledger.covers(B).is_none());
        assert_eq!(ledger.decide(A, (412, 389)), Decision::Ambiguous(2));
        // 尺寸不同的窗口不在其列：该窗口确实未被共享，照常询问。
        assert_eq!(
            ledger.decide(":1.9/x", (300, 200)),
            Decision::Ask { restore: false }
        );
    }

    /// 两条流尺寸相同、只有一个窗口匹配：同样无法判定，两条流都不对应。
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

    /// 已匹配一条流的窗口不参与下一条流的对应。
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

    /// 取消、超时与出错：不保留会话，记录原因；生效的旧会话不受影响。
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

    /// 替换：新会话获准之后返回旧会话；旧会话随后发来的「已结束」信号不予处理。
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

    /// 撤销：合成器或用户结束生效的会话，能力随之撤回，下一次调用重新询问用户。
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

    /// 每个会话只有首次投递指针事件时需要等待合成器通告指针能力；更换会话后重新计算。
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

    /// 会话更换之后，不记录旧会话中流的尺寸。
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

    /// 缩放比 1：逻辑尺寸即裁剪区的像素尺寸；缩放比 2：尺寸减半；没有逻辑范围时按 1 计算。
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
