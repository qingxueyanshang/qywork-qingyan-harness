//! X11 一侧的窗口事实：EWMH 窗口清单与层叠序、标题、进程号、类名，以及客户区与外框矩形。
//!
//! 全是本机 X 服务器的往返调用，不经过任何应用，目标应用卡死时照常应答。

use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, MapState, Window};
use x11rb::rust_connection::RustConnection;

use crate::geometry::{fully_covered, ScreenRect};

/// 按名字取的 atom。只在建连时取一次。
struct Atoms {
    client_list_stacking: u32,
    net_wm_name: u32,
    net_wm_pid: u32,
    net_wm_state: u32,
    net_wm_state_hidden: u32,
    utf8_string: u32,
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
    /// 含窗口管理器边框的外框矩形：客户区在根窗口下的那一层祖先窗口。
    pub outer: Option<ScreenRect>,
    /// 最小化，或未映射。
    pub hidden: bool,
}

pub struct Display {
    conn: RustConnection,
    root: Window,
    screen: ScreenRect,
    atoms: Atoms,
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
        let intern = |name: &[u8]| -> Result<u32, String> {
            conn.intern_atom(false, name)
                .map_err(|e| e.to_string())
                .and_then(|c| c.reply().map_err(|e| e.to_string()))
                .map(|r| r.atom)
                .map_err(|e| format!("取 atom {} 失败：{e}", String::from_utf8_lossy(name)))
        };
        let atoms = Atoms {
            client_list_stacking: intern(b"_NET_CLIENT_LIST_STACKING")?,
            net_wm_name: intern(b"_NET_WM_NAME")?,
            net_wm_pid: intern(b"_NET_WM_PID")?,
            net_wm_state: intern(b"_NET_WM_STATE")?,
            net_wm_state_hidden: intern(b"_NET_WM_STATE_HIDDEN")?,
            utf8_string: intern(b"UTF8_STRING")?,
        };
        Ok(Self {
            conn,
            root,
            screen: bounds,
            atoms,
        })
    }

    /// 窗口管理器管理的顶层窗口，按层叠序从下到上。
    ///
    /// 清单取 `_NET_CLIENT_LIST_STACKING`。根窗口上没有这一项说明没有遵循 EWMH 的窗口管理器，
    /// 如实失败：不要改成枚举根窗口的子窗口，那一层在有窗口管理器时全是边框窗口。
    pub fn clients(&self) -> Result<Vec<Client>, String> {
        let list = self
            .property(
                self.root,
                self.atoms.client_list_stacking,
                AtomEnum::WINDOW.into(),
            )
            .ok_or("no_window_manager: 根窗口上没有 _NET_CLIENT_LIST_STACKING")?;
        let windows: Vec<Window> = list
            .chunks_exact(4)
            .map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        Ok(windows.into_iter().filter_map(|w| self.client(w)).collect())
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
            .and_then(|b| {
                b.get(..4)
                    .map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
            })
            .unwrap_or(0);
        let class_name = self
            .property(window, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into())
            .map(|b| class_part(&b))
            .unwrap_or_default();
        let hidden = attributes.map_state != MapState::VIEWABLE
            || self
                .property(window, self.atoms.net_wm_state, AtomEnum::ATOM.into())
                .is_some_and(|b| {
                    b.chunks_exact(4).any(|a| {
                        u32::from_ne_bytes([a[0], a[1], a[2], a[3]])
                            == self.atoms.net_wm_state_hidden
                    })
                });
        Some(Client {
            window,
            title,
            pid,
            class_name,
            client: self.client_rect(window),
            outer: self.outer_rect(window),
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

    /// 外框矩形：沿父窗口上溯到根窗口下的那一层，取它的几何（含边框宽度）。
    ///
    /// 不要改成客户区加 `_NET_FRAME_EXTENTS`：不是每个窗口管理器都设它，而父窗口链在任何
    /// 重设父窗口的窗口管理器下都成立。没有窗口管理器重设父窗口时外框就是客户区自己。
    fn outer_rect(&self, window: Window) -> Option<ScreenRect> {
        let mut current = window;
        for _ in 0..16 {
            let tree = self.conn.query_tree(current).ok()?.reply().ok()?;
            if tree.parent == self.root || tree.parent == x11rb::NONE {
                let g = self.conn.get_geometry(current).ok()?.reply().ok()?;
                let border = i32::from(g.border_width) * 2;
                return Some(ScreenRect {
                    x: i32::from(g.x),
                    y: i32::from(g.y),
                    width: i32::from(g.width) + border,
                    height: i32::from(g.height) + border,
                });
            }
            current = tree.parent;
        }
        None
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
        let Some(frame) = target.outer.or(target.client) else {
            return false;
        };
        let Some(visible) = frame.intersect(&self.screen) else {
            return true;
        };
        let covers: Vec<ScreenRect> = stack[at + 1..]
            .iter()
            .filter(|c| !c.hidden)
            .filter_map(|c| c.outer.or(c.client))
            .collect();
        fully_covered(visible, &covers)
    }
}

/// 先按 x11rb 的地址顺序连（文件系统上的套接字、TCP），都失败而显示在本机时再连同名的
/// 抽象套接字。
///
/// 不要删掉第二步：`/tmp/.X11-unix` 不可写的环境里 X 服务器只在抽象命名空间监听（WSL 的
/// 这个目录是 WSLg 的只读挂载），libxcb 先连抽象套接字，x11rb 0.14 只连文件系统上的那个。
fn open() -> Result<(RustConnection, usize), String> {
    x11rb::connect(None).or_else(|first| {
        abstract_socket()
            .map_err(|second| format!("连接 X 服务器失败：{first}；抽象套接字：{second}"))
    })
}

fn abstract_socket() -> Result<(RustConnection, usize), String> {
    use std::os::linux::net::SocketAddrExt;
    use x11rb::reexports::x11rb_protocol::{parse_display, xauth};
    let parsed = parse_display::parse_display(None).map_err(|e| e.to_string())?;
    if !parsed.host.is_empty() {
        return Err("显示不在本机".to_owned());
    }
    let name = format!("/tmp/.X11-unix/X{}", parsed.display);
    let address = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())
        .map_err(|e| e.to_string())?;
    let socket =
        std::os::unix::net::UnixStream::connect_addr(&address).map_err(|e| e.to_string())?;
    let (stream, (family, peer)) = x11rb::rust_connection::DefaultStream::from_unix_stream(socket)
        .map_err(|e| e.to_string())?;
    // 与 x11rb 自己建连时同一个取法：读不到授权信息就不带授权连。
    let (auth_name, auth_data) = xauth::get_auth(family, &peer, parsed.display)
        .ok()
        .flatten()
        .unwrap_or_default();
    let screen = usize::from(parsed.screen);
    RustConnection::connect_to_stream_with_auth_info(stream, screen, auth_name, auth_data)
        .map(|conn| (conn, screen))
        .map_err(|e| e.to_string())
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
