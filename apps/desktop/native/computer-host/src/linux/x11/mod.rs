//! X11 一侧：EWMH 窗口清单与层叠序、标题、进程号、类名、客户区与外框矩形，以及取图
//! （`capture`）、前台输入（`sink`）与窗口管理器请求（`wm`）。
//!
//! 全是本机 X 服务器的往返调用，不经过任何应用，目标应用卡死时照常应答。坐标一律是根窗口
//! 坐标，即屏幕物理像素。

mod capture;
mod connect;
pub(in crate::linux) mod keys;
pub mod sink;
mod wm;

pub use wm::{holding, WmAction};

use connect::open;

use std::cell::{Cell, OnceCell};

use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, MapState, Window};
use x11rb::rust_connection::RustConnection;

use crate::geometry::{fully_covered, ScreenRect, WindowFrame};

/// 按名字取的 atom。只在建连时取一次。
struct Atoms {
    client_list_stacking: u32,
    net_wm_name: u32,
    net_wm_pid: u32,
    net_wm_state: u32,
    net_wm_state_hidden: u32,
    utf8_string: u32,
    net_active_window: u32,
    net_wm_state_maximized_vert: u32,
    net_wm_state_maximized_horz: u32,
    net_moveresize_window: u32,
    net_close_window: u32,
    net_wm_allowed_actions: u32,
    net_wm_action_minimize: u32,
    net_wm_action_maximize_horz: u32,
    net_wm_action_maximize_vert: u32,
    net_wm_action_move: u32,
    net_wm_action_resize: u32,
    net_wm_action_close: u32,
    wm_change_state: u32,
    wm_protocols: u32,
    net_wm_ping: u32,
}

/// 一个窗口在根窗口下的那一层祖先：有重设父窗口的窗口管理器时是它的外框窗口，
/// 没有时是窗口自己。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Top {
    pub window: Window,
    /// 含 X 边框宽度的外框矩形。
    pub outer: ScreenRect,
    pub border: i32,
}

/// 一个被窗口管理器管理的顶层窗口。
#[derive(Debug, Clone)]
pub struct Client {
    pub window: Window,
    pub title: String,
    /// `_NET_WM_PID`，没设置时为 0。flatpak 应用给的是沙箱内的进程号。
    pub pid: u32,
    /// `WM_CLASS` 的类名部分。
    pub class_name: String,
    /// 客户区的屏幕矩形。窗口已销毁或未映射时读不到。
    pub client: Option<ScreenRect>,
    /// 根窗口下的那一层祖先。
    pub top: Option<Top>,
    /// 最小化，或未映射。
    pub hidden: bool,
}

impl Client {
    /// 含窗口管理器边框的外框矩形。
    pub fn outer(&self) -> Option<ScreenRect> {
        self.top.map(|t| t.outer)
    }
}

pub struct Display {
    conn: RustConnection,
    root: Window,
    /// `DISPLAY` 里的屏幕号。
    screen_number: usize,
    screen: ScreenRect,
    atoms: Atoms,
    /// 取图要用的扩展协商结果。第一次取图时协商。
    extensions: OnceCell<Result<(), String>>,
    /// 下一次 `_NET_WM_PING` 带的标记，见 `Display::ping`。
    ping_token: Cell<u32>,
}

impl Display {
    /// 连接 `DISPLAY` 指定的 X 服务器。
    pub fn connect() -> Result<Self, String> {
        let (conn, number) = open()?;
        let screen = conn
            .setup()
            .roots
            .get(number)
            .ok_or_else(|| format!("X 服务器没有第 {number} 块屏幕"))?;
        let root = screen.root;
        let bounds = ScreenRect {
            x: 0,
            y: 0,
            width: i32::from(screen.width_in_pixels),
            height: i32::from(screen.height_in_pixels),
        };
        let [client_list_stacking, net_wm_name, net_wm_pid, net_wm_state, net_wm_state_hidden, utf8_string, net_active_window, net_wm_state_maximized_vert, net_wm_state_maximized_horz, net_moveresize_window, net_close_window, net_wm_allowed_actions, net_wm_action_minimize, net_wm_action_maximize_horz, net_wm_action_maximize_vert, net_wm_action_move, net_wm_action_resize, net_wm_action_close, wm_change_state, wm_protocols, net_wm_ping] =
            intern(
                &conn,
                [
                    b"_NET_CLIENT_LIST_STACKING",
                    b"_NET_WM_NAME",
                    b"_NET_WM_PID",
                    b"_NET_WM_STATE",
                    b"_NET_WM_STATE_HIDDEN",
                    b"UTF8_STRING",
                    b"_NET_ACTIVE_WINDOW",
                    b"_NET_WM_STATE_MAXIMIZED_VERT",
                    b"_NET_WM_STATE_MAXIMIZED_HORZ",
                    b"_NET_MOVERESIZE_WINDOW",
                    b"_NET_CLOSE_WINDOW",
                    b"_NET_WM_ALLOWED_ACTIONS",
                    b"_NET_WM_ACTION_MINIMIZE",
                    b"_NET_WM_ACTION_MAXIMIZE_HORZ",
                    b"_NET_WM_ACTION_MAXIMIZE_VERT",
                    b"_NET_WM_ACTION_MOVE",
                    b"_NET_WM_ACTION_RESIZE",
                    b"_NET_WM_ACTION_CLOSE",
                    b"WM_CHANGE_STATE",
                    b"WM_PROTOCOLS",
                    b"_NET_WM_PING",
                ],
            )?;
        Ok(Self {
            conn,
            root,
            screen_number: number,
            screen: bounds,
            atoms: Atoms {
                client_list_stacking,
                net_wm_name,
                net_wm_pid,
                net_wm_state,
                net_wm_state_hidden,
                utf8_string,
                net_active_window,
                net_wm_state_maximized_vert,
                net_wm_state_maximized_horz,
                net_moveresize_window,
                net_close_window,
                net_wm_allowed_actions,
                net_wm_action_minimize,
                net_wm_action_maximize_horz,
                net_wm_action_maximize_vert,
                net_wm_action_move,
                net_wm_action_resize,
                net_wm_action_close,
                wm_change_state,
                wm_protocols,
                net_wm_ping,
            },
            extensions: OnceCell::new(),
            ping_token: Cell::new(1),
        })
    }

    /// X 服务器是 XWayland：它登记了 `XWAYLAND` 扩展。
    ///
    /// XWayland 是 Wayland 合成器的一个客户端：原生 Wayland 窗口不在它的窗口树里，
    /// XTest 指针事件的投递还要看合成器的指针此刻在不在它的某个 surface 上。
    pub fn xwayland(&self) -> bool {
        self.conn
            .query_extension(b"XWAYLAND")
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|r| r.present)
    }

    /// 窗口管理器管理的顶层窗口，按层叠序从下到上。
    ///
    /// 清单取 `_NET_CLIENT_LIST_STACKING`。根窗口上没有这一项说明没有遵循 EWMH 的窗口管理器
    /// （WSLg 的 Weston 也不设），如实失败：不要改成枚举根窗口的子窗口，那一层在有窗口管理器
    /// 时全是边框窗口。
    pub fn clients(&self) -> Result<Vec<Client>, String> {
        let list = self
            .property(
                self.root,
                self.atoms.client_list_stacking,
                AtomEnum::WINDOW.into(),
            )
            .ok_or("no_window_manager: 根窗口上没有 _NET_CLIENT_LIST_STACKING")?;
        Ok(words(&list).filter_map(|w| self.client(w)).collect())
    }

    /// 一个顶层窗口此刻的事实。窗口已销毁时交回 `None`。
    pub fn client(&self, window: Window) -> Option<Client> {
        let attributes = self.conn.get_window_attributes(window).ok()?.reply().ok()?;
        let title = self
            .property(window, self.atoms.net_wm_name, self.atoms.utf8_string)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .filter(|t| !t.is_empty())
            .or_else(|| {
                self.property(window, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into())
                    .map(|b| b.iter().map(|&c| char::from(c)).collect())
            })
            .unwrap_or_default();
        let pid = self
            .property(window, self.atoms.net_wm_pid, AtomEnum::CARDINAL.into())
            .and_then(|b| words(&b).next())
            .unwrap_or(0);
        let class_name = self
            .property(window, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into())
            .map(|b| class_part(&b))
            .unwrap_or_default();
        let hidden = attributes.map_state != MapState::VIEWABLE
            || self.has_state(window, self.atoms.net_wm_state_hidden);
        Some(Client {
            window,
            title,
            pid,
            class_name,
            client: self.client_rect(window),
            top: self.top(window),
            hidden,
        })
    }

    /// 客户区的屏幕矩形：窗口原点换算到根窗口坐标，尺寸取窗口自己的几何。
    fn client_rect(&self, window: Window) -> Option<ScreenRect> {
        let origin = self
            .conn
            .translate_coordinates(window, self.root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
        Some(ScreenRect {
            x: i32::from(origin.dst_x),
            y: i32::from(origin.dst_y),
            width: i32::from(geometry.width),
            height: i32::from(geometry.height),
        })
    }

    /// 根窗口下的那一层祖先与它的外框矩形：沿父窗口上溯到根窗口下的那一层，取它的几何
    /// （含边框宽度）。
    ///
    /// 不要改成客户区加 `_NET_FRAME_EXTENTS`：不是每个窗口管理器都设它，而父窗口链在任何
    /// 重设父窗口的窗口管理器下都成立。没有窗口管理器重设父窗口时外框就是客户区自己。
    fn top(&self, window: Window) -> Option<Top> {
        let mut current = window;
        for _ in 0..16 {
            let tree = self.conn.query_tree(current).ok()?.reply().ok()?;
            if tree.parent == self.root || tree.parent == x11rb::NONE {
                let g = self.conn.get_geometry(current).ok()?.reply().ok()?;
                let border = i32::from(g.border_width);
                return Some(Top {
                    window: current,
                    outer: ScreenRect {
                        x: i32::from(g.x),
                        y: i32::from(g.y),
                        width: i32::from(g.width) + border * 2,
                        height: i32::from(g.height) + border * 2,
                    },
                    border,
                });
            }
            current = tree.parent;
        }
        None
    }

    /// 窗口此刻的几何事实，采图与按图定位的动作共用这一份。
    ///
    /// X11 的坐标就是物理像素、没有按显示器的缩放，DPI 一律按 96 记；显示器标识取屏幕号。
    pub fn frame(&self, client: &Client) -> Result<WindowFrame, String> {
        let (Some(top), Some(area)) = (client.top, client.client) else {
            return Err("target_lost: 读不出窗口几何".to_owned());
        };
        Ok(WindowFrame {
            window: top.outer,
            visible: area,
            dpi: 96,
            monitor: i64::try_from(self.screen_number).unwrap_or(0),
        })
    }

    /// 读一个窗口属性的全部字节。属性缺席、类型不符或窗口已销毁时交回 `None`。
    fn property(&self, window: Window, property: u32, kind: u32) -> Option<Vec<u8>> {
        let reply = self
            .conn
            .get_property(false, window, property, kind, 0, u32::MAX / 4)
            .ok()?
            .reply()
            .ok()?;
        (reply.type_ == kind && !reply.value.is_empty()).then_some(reply.value)
    }

    /// `_NET_WM_STATE` 里有没有这一项。
    fn has_state(&self, window: Window, state: u32) -> bool {
        self.property(window, self.atoms.net_wm_state, AtomEnum::ATOM.into())
            .is_some_and(|b| words(&b).any(|a| a == state))
    }

    /// 窗口此刻在屏幕上是否一点都看不见：最小化或未映射，或外框与屏幕的交集被层叠序在它
    /// 上面、未隐藏的窗口的外框完全盖住。`stack` 是 `clients` 的结果，从下到上。
    ///
    /// 读不出几何时按没盖住报：盖住是需要证据的结论。
    pub fn covered(&self, window: Window, stack: &[Client]) -> bool {
        let Some(at) = stack.iter().position(|c| c.window == window) else {
            return false;
        };
        let target = &stack[at];
        if target.hidden {
            return true;
        }
        let Some(frame) = target.outer().or(target.client) else {
            return false;
        };
        let Some(visible) = frame.intersect(&self.screen) else {
            return true;
        };
        let covers: Vec<ScreenRect> = stack[at + 1..]
            .iter()
            .filter(|c| !c.hidden)
            .filter_map(|c| c.outer().or(c.client))
            .collect();
        fully_covered(visible, &covers)
    }
}

/// 一次往返取回全部 atom：请求先全部发出，再逐个收回执。
fn intern<const N: usize>(conn: &RustConnection, names: [&[u8]; N]) -> Result<[u32; N], String> {
    let cookies = names.map(|name| conn.intern_atom(false, name));
    let mut out = [0u32; N];
    for ((slot, cookie), name) in out.iter_mut().zip(cookies).zip(names) {
        *slot = cookie
            .map_err(|e| e.to_string())
            .and_then(|c| c.reply().map_err(|e| e.to_string()))
            .map(|r| r.atom)
            .map_err(|e| format!("取 atom {} 失败：{e}", String::from_utf8_lossy(name)))?;
    }
    Ok(out)
}

/// 32 位格式的属性值按本机字节序切成字。
fn words(bytes: &[u8]) -> impl Iterator<Item = u32> + '_ {
    bytes
        .chunks_exact(4)
        .map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
}

/// `WM_CLASS` 是「实例名\0类名\0」，取类名。只有一段时取那一段。
fn class_part(bytes: &[u8]) -> String {
    let mut parts = bytes.split(|b| *b == 0).filter(|p| !p.is_empty());
    let instance = parts.next().unwrap_or_default();
    let class = parts.next().unwrap_or(instance);
    String::from_utf8_lossy(class).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_class_name_is_the_second_part_of_wm_class() {
        assert_eq!(class_part(b"gtk_form.py\0Gtk_form.py\0"), "Gtk_form.py");
        assert_eq!(class_part(b"xterm\0"), "xterm");
        assert_eq!(class_part(b""), "");
    }
}
