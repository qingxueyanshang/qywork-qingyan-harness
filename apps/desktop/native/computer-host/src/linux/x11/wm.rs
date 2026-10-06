//! 经由窗口管理器的前台请求（EWMH 与 ICCCM 的客户端消息）及其结果读取、落点命中，以及等待
//! 目标应用处理完已送达事件的同步点。
//!
//! 两条边界：
//!
//! 1. **请求一律发给根窗口，来源标记为 2**（代表用户操作的工具）：窗口管理器对来源 1（应用
//!    自身）的激活请求按防抢焦点规则裁决，可能忽略。窗口管理器异步处理请求，是否生效只以读取
//!    结果为准。
//! 2. **关闭发送的是 `_NET_CLOSE_WINDOW`**：窗口管理器将其转换为 `WM_DELETE_WINDOW` 交给应用
//!    自行处理，不是 `XKillClient`。

use std::time::{Duration, Instant};

use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ClientMessageEvent, ConnectionExt as _, EventMask,
    MapState, Window,
};
use x11rb::protocol::Event;

use super::{words, Display};
use crate::geometry::{ScreenPoint, ScreenRect};
use crate::protocol::WindowState;

/// 客户端消息中的来源标识：代表用户操作的工具。
const SOURCE_TOOL: u32 = 2;
/// ICCCM 的 `IconicState`，`WM_CHANGE_STATE` 用它请求最小化。
const ICONIC_STATE: u32 = 3;
/// `_NET_WM_STATE` 的动作：移除与添加。
const STATE_REMOVE: u32 = 0;
const STATE_ADD: u32 = 1;
/// `_NET_MOVERESIZE_WINDOW` 的重力取 NorthWest：x、y 指外框左上角。
const GRAVITY_NORTH_WEST: u32 = 1;
/// 应用不支持 `_NET_WM_PING` 时，同步点改为等待的固定时长。
const PING_FALLBACK: Duration = Duration::from_millis(60);

/// `popups`（`Display::popups` 的结果，从下到上）中能完整容纳 `content` 的最上层弹出窗口。
///
/// 弹出窗口中的内容可以比窗口略小：Qt 组合框的下拉列表在其弹出窗口中四周各缩进 1 像素。
pub fn holding(popups: &[(Window, ScreenRect)], content: ScreenRect) -> Option<Window> {
    popups
        .iter()
        .rev()
        .find(|(_, rect)| rect.intersect(&content) == Some(content))
        .map(|(window, _)| *window)
}

/// 窗口管理器可以拒绝的窗口动作，对应 `_NET_WM_ALLOWED_ACTIONS` 中的项。
#[derive(Debug, Clone, Copy)]
pub enum WmAction {
    Minimize,
    Maximize,
    Move,
    Resize,
    Close,
}

impl Display {
    /// 系统前台窗口：根窗口上的 `_NET_ACTIVE_WINDOW`。没有时为 0。
    pub fn active_window(&self) -> Window {
        self.property(
            self.root,
            self.atoms.net_active_window,
            AtomEnum::WINDOW.into(),
        )
        .and_then(|b| words(&b).next())
        .unwrap_or(0)
    }

    /// 核对键盘焦点位于该窗口或其子窗口上。
    pub fn focus_within(&self, window: Window) -> Result<(), String> {
        let focus = self
            .conn
            .get_input_focus()
            .map_err(|e| e.to_string())
            .and_then(|c| c.reply().map_err(|e| e.to_string()))
            .map_err(|e| format!("读取键盘焦点失败 {e}"))?
            .focus;
        let mut current = focus;
        // 0 表示没有焦点，1 表示焦点跟随指针：两者都无法确定输入发往哪个窗口。
        for _ in 0..16 {
            if current == window {
                return Ok(());
            }
            if current <= 1 || current == self.root {
                break;
            }
            let Ok(Ok(tree)) = self.conn.query_tree(current).map(|c| c.reply()) else {
                break;
            };
            current = tree.parent;
        }
        Err(format!("not_focused: 键盘焦点在窗口 {focus} 上"))
    }

    /// 窗口仍在窗口管理器的清单中。
    pub fn managed(&self, window: Window) -> bool {
        self.property(
            self.root,
            self.atoms.client_list_stacking,
            AtomEnum::WINDOW.into(),
        )
        .is_some_and(|b| words(&b).any(|w| w == window))
    }

    /// 窗口当前的显示状态。窗口已不存在时缺失。
    pub fn window_state(&self, window: Window) -> Option<WindowState> {
        let attributes = self.conn.get_window_attributes(window).ok()?.reply().ok()?;
        if attributes.map_state != MapState::VIEWABLE
            || self.has_state(window, self.atoms.net_wm_state_hidden)
        {
            return Some(WindowState::Minimized);
        }
        if self.maximized(window) {
            return Some(WindowState::Maximized);
        }
        Some(WindowState::Normal)
    }

    fn maximized(&self, window: Window) -> bool {
        self.has_state(window, self.atoms.net_wm_state_maximized_vert)
            && self.has_state(window, self.atoms.net_wm_state_maximized_horz)
    }

    /// 窗口管理器是否允许该动作。窗口上没有 `_NET_WM_ALLOWED_ACTIONS` 时视为允许：
    /// 该属性由窗口管理器选择性地设置，缺失不表示禁止。
    pub fn allows(&self, window: Window, action: WmAction) -> bool {
        let Some(list) = self.property(
            window,
            self.atoms.net_wm_allowed_actions,
            AtomEnum::ATOM.into(),
        ) else {
            return true;
        };
        let a = &self.atoms;
        let need: &[u32] = match action {
            WmAction::Minimize => &[a.net_wm_action_minimize],
            WmAction::Maximize => &[a.net_wm_action_maximize_horz, a.net_wm_action_maximize_vert],
            WmAction::Move => &[a.net_wm_action_move],
            WmAction::Resize => &[a.net_wm_action_resize],
            WmAction::Close => &[a.net_wm_action_close],
        };
        need.iter().all(|n| words(&list).any(|w| w == *n))
    }

    /// 向窗口管理器发送一条客户端消息。
    fn message(&self, window: Window, kind: u32, data: [u32; 5]) -> Result<(), String> {
        let event = ClientMessageEvent::new(32, window, kind, data);
        self.conn
            .send_event(
                false,
                self.root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            )
            .map_err(|e| format!("x11_failed: {e}"))?;
        self.conn.flush().map_err(|e| format!("x11_failed: {e}"))
    }

    pub fn request_activate(&self, window: Window) -> Result<(), String> {
        self.message(
            window,
            self.atoms.net_active_window,
            [SOURCE_TOOL, 0, 0, 0, 0],
        )
    }

    /// 请求一个显示状态。
    ///
    /// 从最小化恢复按 ICCCM 映射客户窗口：窗口管理器收到映射请求即取消最小化。
    /// 最大化标记在最小化期间保留，恢复为普通状态时必须同时移除该标记。
    pub fn request_state(&self, window: Window, target: WindowState) -> Result<(), String> {
        let a = &self.atoms;
        let axes = |action: u32| {
            [
                action,
                a.net_wm_state_maximized_vert,
                a.net_wm_state_maximized_horz,
                SOURCE_TOOL,
                0,
            ]
        };
        if target != WindowState::Minimized
            && self.window_state(window) == Some(WindowState::Minimized)
        {
            self.conn
                .map_window(window)
                .map_err(|e| format!("x11_failed: {e}"))?;
            self.conn.flush().map_err(|e| format!("x11_failed: {e}"))?;
        }
        match target {
            WindowState::Minimized => {
                self.message(window, a.wm_change_state, [ICONIC_STATE, 0, 0, 0, 0])
            }
            WindowState::Maximized => self.message(window, a.net_wm_state, axes(STATE_ADD)),
            WindowState::Normal if self.maximized(window) => {
                self.message(window, a.net_wm_state, axes(STATE_REMOVE))
            }
            WindowState::Normal => Ok(()),
        }
    }

    /// 请求外框左上角移到 `(x, y)`。
    pub fn request_move(&self, window: Window, x: i32, y: i32) -> Result<(), String> {
        let flags = GRAVITY_NORTH_WEST | (0b0011 << 8) | (SOURCE_TOOL << 12);
        self.message(
            window,
            self.atoms.net_moveresize_window,
            [flags, x as u32, y as u32, 0, 0],
        )
    }

    /// 请求客户区尺寸。EWMH 的宽高指客户区，不含窗口管理器的边框。
    pub fn request_client_size(
        &self,
        window: Window,
        width: i32,
        height: i32,
    ) -> Result<(), String> {
        let flags = GRAVITY_NORTH_WEST | (0b1100 << 8) | (SOURCE_TOOL << 12);
        self.message(
            window,
            self.atoms.net_moveresize_window,
            [flags, 0, 0, width as u32, height as u32],
        )
    }

    pub fn request_close(&self, window: Window) -> Result<(), String> {
        self.message(
            window,
            self.atoms.net_close_window,
            [0, SOURCE_TOOL, 0, 0, 0],
        )
    }

    /// 落点处最上层的顶层窗口及其所有者，供 `lands_on_target` 判定。
    ///
    /// 命中由 X 服务器按实际层叠序与输入形状计算（`TranslateCoordinates` 返回根窗口下包含该点的
    /// 最上层子窗口），弹出菜单等不由窗口管理器管理的窗口也计算在内。命中窗口管理器的外框时
    /// 换为框内的客户窗口；所有者沿 `WM_TRANSIENT_FOR` 上溯，没有时即窗口自身。
    ///
    /// 屏幕外的点没有命中：XTest 把指针限制在屏幕边缘，按下时落在另一个位置。
    pub fn hit(&self, point: ScreenPoint) -> Result<(i64, i64), String> {
        let (Ok(x), Ok(y)) = (i16::try_from(point.x), i16::try_from(point.y)) else {
            return Err(format!("point_unowned: {},{}", point.x, point.y));
        };
        if !self.screen.contains(point) {
            return Err(format!("point_unowned: {},{} 位于屏幕外", point.x, point.y));
        }
        let child = self
            .conn
            .translate_coordinates(self.root, self.root, x, y)
            .map_err(|e| e.to_string())
            .and_then(|c| c.reply().map_err(|e| e.to_string()))
            .map_err(|e| format!("读取落点所在窗口失败 {e}"))?
            .child;
        if child == x11rb::NONE {
            return Err(format!("point_unowned: {},{}", point.x, point.y));
        }
        let hit = self.client_in(child).unwrap_or(child);
        Ok((i64::from(hit), i64::from(self.owner(hit))))
    }

    /// 窗口沿 `WM_TRANSIENT_FOR` 上溯到的顶端，没有时即窗口自身。
    fn owner(&self, window: Window) -> Window {
        let mut owner = window;
        for _ in 0..8 {
            let Some(next) = self
                .property(
                    owner,
                    AtomEnum::WM_TRANSIENT_FOR.into(),
                    AtomEnum::WINDOW.into(),
                )
                .and_then(|b| words(&b).next())
                .filter(|w| *w != 0 && *w != owner)
            else {
                break;
            };
            owner = next;
        }
        owner
    }

    /// 归 `owner` 所有、当前已映射的 override-redirect 顶层窗口（弹出菜单、组合框的下拉列表）
    /// 及其含边框的屏幕矩形，按层叠序从下到上。
    pub fn popups(&self, owner: Window) -> Vec<(Window, ScreenRect)> {
        let Ok(Ok(tree)) = self.conn.query_tree(self.root).map(|c| c.reply()) else {
            return Vec::new();
        };
        tree.children
            .into_iter()
            .filter(|w| {
                self.conn
                    .get_window_attributes(*w)
                    .ok()
                    .and_then(|c| c.reply().ok())
                    .is_some_and(|a| a.override_redirect && a.map_state == MapState::VIEWABLE)
            })
            .filter(|w| *w != owner && self.owner(*w) == owner)
            .filter_map(|w| {
                let g = self.conn.get_geometry(w).ok()?.reply().ok()?;
                let border = i32::from(g.border_width);
                Some((
                    w,
                    ScreenRect {
                        x: i32::from(g.x),
                        y: i32::from(g.y),
                        width: i32::from(g.width) + border * 2,
                        height: i32::from(g.height) + border * 2,
                    },
                ))
            })
            .collect()
    }

    /// 外框中的客户窗口：沿子窗口向下查找第一个位于窗口管理器清单中的窗口。不是外框时返回 `None`。
    fn client_in(&self, top: Window) -> Option<Window> {
        let list = self.property(
            self.root,
            self.atoms.client_list_stacking,
            AtomEnum::WINDOW.into(),
        )?;
        let managed: Vec<Window> = words(&list).collect();
        let mut level = vec![top];
        for _ in 0..4 {
            if let Some(found) = level.iter().find(|w| managed.contains(w)) {
                return Some(*found);
            }
            level = level
                .iter()
                .filter_map(|w| self.conn.query_tree(*w).ok()?.reply().ok())
                .flat_map(|t| t.children)
                .collect();
            if level.is_empty() {
                break;
            }
        }
        None
    }

    /// 等待目标应用处理完此前送达的全部事件：向其窗口发送一次 `_NET_WM_PING`，等待应用把该消息
    /// 送回根窗口。
    ///
    /// 应用按到达顺序处理事件，回应到达即说明排在该消息之前的按键与键盘映射变化都已被应用读取
    /// 并换算为字符。窗口的 `WM_PROTOCOLS` 中没有 `_NET_WM_PING` 时改为等待 `PING_FALLBACK`。
    pub fn ping(&self, window: Window, limit: Duration) -> Result<(), String> {
        let supported = self
            .property(window, self.atoms.wm_protocols, AtomEnum::ATOM.into())
            .is_some_and(|b| words(&b).any(|a| a == self.atoms.net_wm_ping));
        if !supported {
            std::thread::sleep(PING_FALLBACK);
            return Ok(());
        }
        let token = self.ping_token.get();
        self.ping_token.set(token.wrapping_add(1).max(1));
        // 回应发往根窗口，掩码是 SubstructureRedirect 加 SubstructureNotify（GTK）或加
        // StructureNotify（Qt）。SubstructureRedirect 由窗口管理器独占，因此两种 Notify 都订阅，缺少
        // 任一种即收不到对应类型应用的回应。只在等待期间订阅，避免本连接平时积累根窗口上的全部
        // 结构事件。
        let listen = |mask: EventMask| {
            self.conn
                .change_window_attributes(
                    self.root,
                    &ChangeWindowAttributesAux::new().event_mask(mask),
                )
                .map_err(|e| format!("x11_failed: {e}"))
        };
        listen(EventMask::SUBSTRUCTURE_NOTIFY | EventMask::STRUCTURE_NOTIFY)?;
        let ping = ClientMessageEvent::new(
            32,
            window,
            self.atoms.wm_protocols,
            [self.atoms.net_wm_ping, token, window, 0, 0],
        );
        let sent = self
            .conn
            .send_event(false, window, EventMask::NO_EVENT, ping)
            .map_err(|e| format!("x11_failed: {e}"))
            .and_then(|_| self.conn.flush().map_err(|e| format!("x11_failed: {e}")));
        let answered = sent.is_ok()
            && self.wait_event(Instant::now() + limit, |event| {
                matches!(event, Event::ClientMessage(e)
                    if e.type_ == self.atoms.wm_protocols
                        && e.data.as_data32()[..3] == [self.atoms.net_wm_ping, token, window])
            });
        let _ = listen(EventMask::NO_EVENT);
        let _ = self.conn.flush();
        sent?;
        if answered {
            Ok(())
        } else {
            Err(format!(
                "not_responding: 目标应用在 {} ms 内未处理完已送达的输入",
                limit.as_millis()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    /// GTK 组合框的下拉菜单与其弹出窗口大小相同；Qt 的下拉列表四周缩进 1 像素。两者都能识别。
    #[test]
    fn a_dropdown_is_held_by_its_popup() {
        let gtk = [(0x40_005f, rect(173, 173, 396, 124))];
        assert_eq!(holding(&gtk, rect(173, 173, 396, 124)), Some(0x40_005f));
        let qt = [(0x40_0011, rect(712, 171, 398, 90))];
        assert_eq!(holding(&qt, rect(713, 172, 396, 88)), Some(0x40_0011));
    }

    /// 内容超出弹出窗口，或弹出窗口只覆盖内容的一部分：该内容不属于这个弹出窗口。
    #[test]
    fn content_outside_a_popup_is_not_held() {
        let popups = [(0x40_005f, rect(173, 173, 396, 124))];
        assert_eq!(holding(&popups, rect(161, 160, 420, 300)), None);
        assert_eq!(holding(&popups, rect(500, 280, 120, 40)), None);
        assert_eq!(holding(&[], rect(173, 173, 10, 10)), None);
    }

    /// 两个弹出窗口都能容纳内容时取层叠序最上层的一个。
    #[test]
    fn the_topmost_popup_that_holds_the_content_wins() {
        let popups = [
            (0x40_0001, rect(100, 100, 400, 400)),
            (0x40_0002, rect(150, 150, 200, 200)),
        ];
        assert_eq!(holding(&popups, rect(160, 160, 50, 50)), Some(0x40_0002));
        assert_eq!(holding(&popups, rect(110, 110, 50, 50)), Some(0x40_0001));
    }
}
