//! 连本机 X 服务器。
//!
//! worker 与外壳（worker 退出后补发抬起）要用同一条建连路径，外壳经 `#[path]` 引入本文件。
//! 不要在外壳里另写一份：只在一侧补了抽象套接字的话，另一侧在同一个环境里连不上。
//! 因此本文件只依赖标准库与 x11rb，不引用任何 crate 内的路径。

use x11rb::rust_connection::RustConnection;

/// 先按 x11rb 的地址顺序连（文件系统上的套接字、TCP），都失败而显示在本机时再连同名的
/// 抽象套接字。返回连接与默认屏幕号。
///
/// 不要删掉第二步：`/tmp/.X11-unix` 不可写的环境里 X 服务器只在抽象命名空间监听（WSL 的
/// 这个目录是 WSLg 的只读挂载），libxcb 先连抽象套接字，x11rb 0.14 只连文件系统上的那个。
pub fn open() -> Result<(RustConnection, usize), String> {
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
