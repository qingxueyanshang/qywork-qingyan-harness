//! macOS 后端（`Ax`）：AX 负责窗口清单、控件树、后台语义动作、窗口动作、文本读取与有界等待，
//! CGWindowList 负责层叠序、窗口编号与窗口几何，CGEvent 负责前台键盘与指针输入，ScreenCaptureKit
//! 负责采图。
//!
//! 目录按编译范围划分：`pure/` 是不调用任何系统接口的换算与判定，在每个目标的单元测试中编译，
//! Windows 与 Linux 的门禁照常运行其测试；`ffi/` 是调用 AX、CoreGraphics 与 ScreenCaptureKit 的层
//! 与后端本身，只在 macOS 上编译。不要把调用系统接口的代码放入 `pure/`：那会使其在其他目标上
//! 编译失败。`keys.rs` 保留在本层，外壳经由 `#[path]` 按该路径引入。
//!
//! 五条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用切换前台、设置焦点或指针接口。前台动作只在前台模式开启、
//!    且窗口已对应 CG 窗口时列出与执行；采图与前台动作对未对应的窗口一律拒绝。
//! 2. 本进程不是受信任的辅助功能客户端时，一切读取与动作都以 `accessibility_not_trusted`
//!    拒绝；采图另需屏幕录制授权，缺少时以 `screen_recording_not_granted` 拒绝。每次实时查询：
//!    用户可以在 worker 运行期间开启或关闭授权。两个原因码都在 `protocol::refused_for_grant` 中，
//!    服务循环据此实时查询授权事实，运行中撤销的授权由本次被拒报告。
//! 3. `ref` 是不透明字符串：从窗口元素出发的子节点下标路径、`@` 后的核对串（原始角色、子角色与
//!    稳定标识的指纹）、`#` 后的身份段（进程内身份表的编号）。动作前按路径重新定位并核对两者。
//! 4. 消息上界在握手时对系统范围元素设置一次，对本进程的全部 AX 调用生效。不要改为对窗口或
//!    控件元素设置：那只作用于该引用，逐层取出的子元素都是新引用。
//! 5. `AXUIElementPerformAction` 与写属性返回 `kAXErrorCannotComplete` 时记为结果未知并照常重读，
//!    不重发：应用在动作回调中执行模态处理时调用收不到回复，动作可能已经生效。

#[cfg(target_os = "macos")]
mod ffi;
mod keys;
mod pure;

#[cfg(target_os = "macos")]
pub use ffi::{exit_with_parent, Ax};

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::keys::keycode;
    use super::pure::facts::{no_screen_recording, not_trusted};
    use crate::protocol::{key_names, refused_for_grant, Modifier};

    /// 缺少授权的两种拒绝都必须被服务循环识别：无法识别时，运行中撤销授权之后界面会持续显示
    /// 授权仍然有效。
    #[test]
    fn grant_refusals_trigger_an_access_recheck() {
        assert!(refused_for_grant(&not_trusted()), "{}", not_trusted());
        assert!(
            refused_for_grant(&no_screen_recording()),
            "{}",
            no_screen_recording()
        );
    }

    /// 词表中的每个键名、每个修饰键都有各自的键码，F21–F24 除外（macOS 没有这四个键）。
    /// 两个键名共用一个键码时，补发抬起无法区分抬起的是哪一个键。
    #[test]
    fn every_protocol_key_has_its_own_key_code() {
        let modifiers = [
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
            Modifier::Meta,
        ];
        let mut seen = HashMap::new();
        for name in key_names().chain(modifiers.map(|m| m.key_name().to_owned())) {
            let absent = ["f21", "f22", "f23", "f24"].contains(&name.as_str());
            match keycode(&name) {
                None => assert!(absent, "{name} 没有键码"),
                Some(code) => {
                    assert!(!absent, "{name} 在 macOS 上没有虚拟键码");
                    if let Some(other) = seen.insert(code, name.clone()) {
                        panic!("{name} 与 {other} 共用键码 {code:#04x}");
                    }
                }
            }
        }
    }
}

/// ScreenCaptureKit 在 worker 的加载命令中必须是弱链接，见 `build.rs`。测试二进制与 worker
/// 按同一组链接参数链接，在 macOS 上读取测试二进制自身的加载命令进行核对。
#[cfg(test)]
mod linkage {
    const MH_MAGIC_64: u32 = 0xfeed_facf;
    const LC_LOAD_DYLIB: u32 = 0xc;
    const LC_LOAD_WEAK_DYLIB: u32 = 0x8000_0018;

    /// 64 位 Mach-O 中的每一条 dylib 加载命令：是否为弱链接、安装名。不是 64 位 Mach-O 时返回空表。
    fn dylibs(image: &[u8]) -> Vec<(bool, String)> {
        let word = |at: usize| {
            image
                .get(at..at + 4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        };
        if word(0) != Some(MH_MAGIC_64) {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut at = 32usize;
        for _ in 0..word(16).unwrap_or(0) {
            let (Some(cmd), Some(size)) = (word(at), word(at + 4)) else {
                break;
            };
            if cmd == LC_LOAD_DYLIB || cmd == LC_LOAD_WEAK_DYLIB {
                let name = word(at + 8)
                    .and_then(|offset| image.get(at + offset as usize..at + size as usize))
                    .and_then(|bytes| bytes.split(|b| *b == 0).next())
                    .map(|bytes| String::from_utf8_lossy(bytes).into_owned());
                if let Some(name) = name {
                    out.push((cmd == LC_LOAD_WEAK_DYLIB, name));
                }
            }
            if size == 0 {
                break;
            }
            at += size as usize;
        }
        out
    }

    /// 一条 dylib 加载命令：命令头、名称偏移 24、三个版本字段，名称补齐到 8 字节。
    fn command(cmd: u32, name: &str) -> Vec<u8> {
        let mut path = name.as_bytes().to_vec();
        path.push(0);
        while (24 + path.len()) % 8 != 0 {
            path.push(0);
        }
        let size = u32::try_from(24 + path.len()).expect("长度");
        let mut out = Vec::new();
        for field in [cmd, size, 24, 2, 0x1_0000, 0x1_0000] {
            out.extend_from_slice(&field.to_le_bytes());
        }
        out.extend_from_slice(&path);
        out
    }

    #[test]
    fn dylib_load_commands_are_read_with_their_weak_flag() {
        let commands = [
            command(
                LC_LOAD_WEAK_DYLIB,
                "/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit",
            ),
            command(0x19, "__TEXT"),
            command(LC_LOAD_DYLIB, "/usr/lib/libSystem.B.dylib"),
        ];
        let body: Vec<u8> = commands.concat();
        let mut image = Vec::new();
        for field in [
            MH_MAGIC_64,
            0x0100_000c,
            0,
            2,
            3,
            u32::try_from(body.len()).expect("长度"),
            0,
            0,
        ] {
            image.extend_from_slice(&field.to_le_bytes());
        }
        image.extend_from_slice(&body);
        assert_eq!(
            dylibs(&image),
            vec![
                (
                    true,
                    "/System/Library/Frameworks/ScreenCaptureKit.framework/Versions/A/ScreenCaptureKit"
                        .to_owned()
                ),
                (false, "/usr/lib/libSystem.B.dylib".to_owned()),
            ]
        );
        assert!(dylibs(b"\x7fELF").is_empty());
    }

    /// 原始失败形状：强链接时 11.0–12.2 上 dyld 未找到该框架，拒绝启动 worker。
    #[cfg(target_os = "macos")]
    #[test]
    fn screen_capture_kit_is_weakly_linked() {
        let exe = std::env::current_exe().expect("测试二进制路径");
        let image = std::fs::read(exe).expect("读取测试二进制");
        let linked: Vec<(bool, String)> = dylibs(&image)
            .into_iter()
            .filter(|(_, name)| name.contains("/ScreenCaptureKit.framework/"))
            .collect();
        assert!(!linked.is_empty(), "测试二进制未链接 ScreenCaptureKit");
        assert!(linked.iter().all(|(weak, _)| *weak), "{linked:?}");
    }
}
