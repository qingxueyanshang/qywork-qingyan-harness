//! macOS 后端（`Ax`）：AX 负责窗口清单、控件树、后台语义动作、窗口动作、读文本与有界等待，
//! CGWindowList 负责层叠序、窗口编号与窗口几何，CGEvent 负责前台键鼠，ScreenCaptureKit 负责取图。
//!
//! 目录按编译范围分：`pure/` 是不调任何系统接口的换算与判定，在每个目标的单测里编译，Windows 与
//! Linux 的门禁照跑它们的测试；`ffi/` 是调 AX、CoreGraphics 与 ScreenCaptureKit 的那一层与后端
//! 本身，只在 macOS 上编译。不要把调系统接口的代码放进 `pure/`：那会让它在别的目标上编译失败。
//! `keys.rs` 留在这一层，外壳经 `#[path]` 按这个路径引入它。
//!
//! 五条边界：
//!
//! 1. 结构化路径不采集任何图像，也不调用置前台、设焦点或指针接口。前台动作只在前台模式开着、
//!    且窗口对应上 CG 窗口时列出与执行；取图与前台动作对没对应上的窗口一律拒绝。
//! 2. 本进程不是受信任的辅助功能客户端时，一切读取与动作都以 `accessibility_not_trusted`
//!    拒绝。每次现问：用户可以在 worker 运行期间开关授权。取图另要屏幕录制授权，同样每次现问。
//! 3. `ref` 是不透明串：从窗口元素出发的子节点下标路径、`@` 后的核对串（原始角色、子角色与
//!    稳定标识的指纹）、`#` 后的身份段（进程内身份表的编号）。动作前按路径重新定位并核对两者。
//! 4. 消息上界在握手时对系统范围元素设一次，对本进程的全部 AX 调用生效。不要改成对窗口或
//!    控件元素设：那只作用于那一个引用，逐层取出的子元素都是新引用。
//! 5. `AXUIElementPerformAction` 与写属性回 `kAXErrorCannotComplete` 记结果未知并照常重读，不重发：
//!    应用在动作回调里做模态处理时调用等不到回复，动作可能已经生效。

#[cfg(target_os = "macos")]
mod ffi;
mod keys;
mod pure;

#[cfg(target_os = "macos")]
pub use ffi::Ax;

/// ScreenCaptureKit 在 worker 的加载命令里必须是弱链接，见 `build.rs`。测试二进制与 worker
/// 按同一组链接参数链接，macOS 上读测试二进制自己的加载命令核对。
#[cfg(test)]
mod linkage {
    const MH_MAGIC_64: u32 = 0xfeed_facf;
    const LC_LOAD_DYLIB: u32 = 0xc;
    const LC_LOAD_WEAK_DYLIB: u32 = 0x8000_0018;

    /// 64 位 Mach-O 里每一条 dylib 加载命令：是不是弱链接、安装名。不是 64 位 Mach-O 时交回空表。
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

    /// 一条 dylib 加载命令：命令头、名字偏移 24、三个版本字段，名字补齐到 8 字节。
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

    /// 原始失败形状：强链接时 11.0–12.2 上 dyld 找不到这个框架，拒绝启动 worker。
    #[cfg(target_os = "macos")]
    #[test]
    fn screen_capture_kit_is_weakly_linked() {
        let exe = std::env::current_exe().expect("测试二进制路径");
        let image = std::fs::read(exe).expect("读得到测试二进制");
        let linked: Vec<(bool, String)> = dylibs(&image)
            .into_iter()
            .filter(|(_, name)| name.contains("/ScreenCaptureKit.framework/"))
            .collect();
        assert!(!linked.is_empty(), "测试二进制没有链接 ScreenCaptureKit");
        assert!(linked.iter().all(|(weak, _)| *weak), "{linked:?}");
    }
}
