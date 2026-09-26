//! Wayland 会话里原生 Wayland 窗口的取图与前台键鼠，经 xdg-desktop-portal 的 ScreenCast
//! （按窗口共享）与 RemoteDesktop（键盘与指针）同一个会话。
//!
//! 五条边界：
//!
//! 1. **一个进程一个共享授权。** 执行线程与等待线程共用 `Portal`；会话、在等回答的请求与
//!    流到窗口的对应都记在 `ledger`，判定也只在那里做。
//! 2. **授权由用户在系统授权框里给，worker 不替用户点，也不无限期地等。** 要授权的调用立刻以
//!    `consent_pending` 拒绝，后台线程等用户回答，上限 `CONSENT_LIMIT`；同意之后下一次调用
//!    照常执行。
//! 3. **只对已经对上流的窗口取图与投递。** 对应规则见 `ledger`；对不上一律拒绝，不猜。
//! 4. **坐标是流的逻辑坐标**：原点是窗口左上角，单位是合成器的逻辑像素。Wayland 没有全局坐标，
//!    这类窗口的图像几何 `screen` 与按图定位的落点都在这一套坐标里，只对这一个窗口成立。
//! 5. **没有 RemoteDesktop 的合成器与没有 libpipewire 的系统如实报不可用**，不弹授权框。

mod act;
mod capture;
mod dbus;
mod ledger;
mod pipewire;
mod pod;
mod token;

pub use act::{perform, screen, Target};
pub use capture::capture;

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crate::geometry::{ScreenRect, WindowFrame};
use dbus::{Bus, Caps, RESPONSE_CANCELLED, RESPONSE_SUCCESS};
use ledger::{Decision, Ledger};

pub use ledger::Coverage;

/// 等用户在授权框里回答的上限。到点即关掉那个授权框，下一次调用重新问。
const CONSENT_LIMIT: Duration = Duration::from_secs(180);
/// 发出请求之后本次调用等多久。带着有效 restore token 时 portal 不弹框、在这段时间内就回答，
/// 本次调用即可继续；要弹框时到点即以 `consent_pending` 拒绝。
const QUICK_GRANT: Duration = Duration::from_millis(1_500);

const CONSENT_DENIED: &str = "consent_denied: 用户在系统授权框里取消了共享";
const SESSION_CLOSED: &str =
    "portal_session_closed: 共享已经结束（用户停止了共享，或共享的窗口已关闭）";

/// 本进程的共享授权。
struct Portal {
    bus: Arc<Bus>,
    caps: Caps,
    ledger: Mutex<Ledger>,
    /// 一次请求有了结论时通知在等的调用。
    changed: Condvar,
}

static PORTAL: Mutex<Option<Arc<Portal>>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 本进程的共享授权，第一次要用时建。建不成时不缓存：portal 可能稍后才启动。
fn portal(call: Duration) -> Result<Arc<Portal>, String> {
    let mut slot = lock(&PORTAL);
    if let Some(portal) = slot.as_ref() {
        return Ok(Arc::clone(portal));
    }
    let bus = Bus::open(call)?;
    let caps = bus.caps()?;
    let portal = Arc::new(Portal {
        bus,
        caps,
        ledger: Mutex::new(Ledger::default()),
        changed: Condvar::new(),
    });
    *slot = Some(Arc::clone(&portal));
    Ok(portal)
}

impl Portal {
    /// 取得账目，先记下收到的「会话已结束」。生效的会话被结束时作废存下的 token。
    fn ledger(&self) -> MutexGuard<'_, Ledger> {
        let mut ledger = lock(&self.ledger);
        for handle in self.bus.take_closed() {
            if ledger.closed(&handle, SESSION_CLOSED) {
                token::discard();
                eprintln!("Wayland 共享会话 {handle} 已结束，存下的 restore token 已作废");
            }
        }
        ledger
    }

    /// 发一次请求。`restore` 为真时带上存下的 token。已经有请求在等回答时不再发。
    fn ask(self: &Arc<Self>, restore: bool, call: Duration) {
        if !self.ledger().begin_ask() {
            return;
        }
        let saved = if restore { token::take() } else { None };
        let portal = Arc::clone(self);
        std::thread::spawn(move || {
            let outcome = portal.request(saved.as_deref(), call);
            let replaced = {
                let mut ledger = portal.ledger();
                match outcome {
                    Ok((session, fresh)) => {
                        match fresh {
                            Some(t) => token::store(&t),
                            None => token::discard(),
                        }
                        eprintln!(
                            "Wayland 共享已获准：会话 {}，{} 条流，设备位 {}",
                            session.handle,
                            session.streams.len(),
                            session.devices
                        );
                        ledger.granted(session)
                    }
                    Err(reason) => {
                        eprintln!("Wayland 共享没有获准：{reason}");
                        ledger.refused(reason);
                        None
                    }
                }
            };
            portal.changed.notify_all();
            if let Some(old) = replaced {
                portal.bus.close_session(&old.handle);
            }
        });
    }

    /// 建会话并等用户回答。
    fn request(
        &self,
        restore: Option<&str>,
        call: Duration,
    ) -> Result<(ledger::Session, Option<String>), String> {
        let started = self.bus.negotiate(self.caps, restore, call)?;
        let answer = started.reply.recv_timeout(CONSENT_LIMIT);
        let outcome = match answer {
            Ok((RESPONSE_SUCCESS, results)) => dbus::started(started.session.clone(), &results),
            Ok((RESPONSE_CANCELLED, _)) => Err(CONSENT_DENIED.to_owned()),
            Ok((code, _)) => Err(format!("portal_failed: 系统授权框回答码 {code}")),
            Err(_) => {
                self.bus.close_request(&started.request);
                Err(format!(
                    "consent_expired: 系统授权框 {} 秒内没有得到回答，已关闭",
                    CONSENT_LIMIT.as_secs()
                ))
            }
        };
        if outcome.is_err() {
            self.bus.close_session(&started.session);
        }
        outcome
    }

    /// 等在途的请求有结论，至多 `limit`。
    fn await_answer(&self, limit: Duration) {
        let until = Instant::now() + limit;
        let mut ledger = self.ledger();
        while ledger.asking() {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            ledger = self
                .changed
                .wait_timeout(ledger, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

/// 一个窗口此刻有没有被共享。只读状态：不建连接、不取帧、不弹窗。
pub fn covers(key: &str) -> Option<Coverage> {
    let portal = lock(&PORTAL).clone()?;
    let covered = portal.ledger().covers(key);
    covered
}

/// 要取图或投递的那个原生 Wayland 窗口。
pub struct Want<'a> {
    /// AT-SPI frame 的对象串。
    pub key: &'a str,
    pub title: &'a str,
    /// 它此刻的 AT-SPI 尺寸。
    pub size: (i32, i32),
    /// 此刻全部原生 Wayland 窗口的对象串与 AT-SPI 尺寸，流按它们对应。
    pub frames: &'a [(String, (i32, i32))],
}

/// 一个已经被共享的窗口，以及投递它要用的连接。
pub struct Grant {
    portal: Arc<Portal>,
    pub coverage: Coverage,
}

impl Grant {
    fn bus(&self) -> &Bus {
        &self.portal.bus
    }

    /// 这个会话是不是第一次投指针事件，见 `Ledger::first_pointer`。
    fn first_pointer(&self) -> bool {
        self.portal.ledger().first_pointer(&self.coverage.session)
    }
}

/// 拿到这个窗口的共享授权。没有时按 `ledger` 的判定去量流、对应或问用户，见本模块第 2 条。
///
/// `call` 是方法调用上界，`budget` 是量流时等一帧的上界。
pub fn grant(want: &Want<'_>, call: Duration, budget: Duration) -> Result<Grant, String> {
    pipewire::available()?;
    let portal = portal(call)?;
    let mut asked = false;
    loop {
        let decision = portal.ledger().decide(want.key, want.size);
        match decision {
            Decision::Covered(coverage) => {
                return Ok(Grant {
                    portal: Arc::clone(&portal),
                    coverage,
                })
            }
            Decision::Measure { session, nodes } => {
                for (node, size) in nodes {
                    let remote = portal.bus.pipewire_remote(&session)?;
                    let frame = pipewire::pull(remote, node, budget)?;
                    let logical = ledger::logical_size(frame.crop, frame.video, size);
                    portal.ledger().measured(&session, node, logical);
                }
                portal.ledger().bind(want.frames);
            }
            Decision::Pending => return Err(pending(want.title, portal.ledger().ended())),
            Decision::Ambiguous(n) => {
                return Err(format!(
                    "portal_ambiguous: 共享的窗口与 {n} 个窗口一样大，判不出是不是「{}」",
                    want.title
                ))
            }
            Decision::Ask { .. } if asked => {
                return Err(format!(
                    "portal_window_not_shared: 用户共享的窗口里没有「{}」；下一次调用会重新请求",
                    want.title
                ))
            }
            Decision::Ask { restore } => {
                asked = true;
                portal.ask(restore, call);
                portal.await_answer(QUICK_GRANT);
                // 这次请求很快就没换来会话（凭 token 恢复时记住的窗口不在、portal 出错）：原因照报，
                // 不要落到下面的 `portal_window_not_shared`。
                let ledger = portal.ledger();
                if let (false, Some(ended)) = (ledger.asking(), ledger.ended()) {
                    return Err(format!("{ended}；下一次调用会重新请求"));
                }
            }
        }
    }
}

fn pending(title: &str, ended: Option<&str>) -> String {
    let mut reason = format!(
        "consent_pending: 已在系统授权框里请求共享窗口并允许远程控制，等用户选择「{title}」并点「共享」；\
         用户同意之后重试这一步"
    );
    if let Some(ended) = ended {
        reason.push_str("；上一次请求：");
        reason.push_str(ended);
    }
    reason
}

/// 原生 Wayland 窗口的几何代际：AT-SPI 尺寸与流的节点号。窗口缩放或换了一条流即变。
///
/// 只用 AT-SPI 尺寸：它在动作前读得到，不必再从流里取一帧。
pub fn generation(size: (i32, i32), node: u32) -> String {
    let window = ScreenRect {
        x: 0,
        y: 0,
        width: size.0,
        height: size.1,
    };
    WindowFrame {
        window,
        visible: window,
        dpi: 96,
        monitor: i64::from(node),
    }
    .generation()
}
