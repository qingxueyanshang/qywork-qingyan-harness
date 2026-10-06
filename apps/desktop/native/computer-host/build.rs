//! 在 macOS 目标上把 ScreenCaptureKit 改为弱链接。
//!
//! `objc2-screen-capture-kit` 以 `-framework ScreenCaptureKit` 强链接；应用最低支持 macOS 11.0，
//! 而该框架从 12.3 起才提供，强链接时 dyld 在 11.0–12.2 上直接拒绝启动 worker，电脑控制
//! 随之完全不可用。链接器同时收到 `-weak_framework` 时该框架记为 `LC_LOAD_WEAK_DYLIB`，没有该框架的
//! 系统上正常启动，截图在运行时检查 `SCScreenshotManager` 类是否存在。`macos::linkage` 的测试在
//! macOS 上读取测试二进制自身的加载命令核对这一点。
//!
//! Rust 的 `#[link]` 没有弱链接修饰符，只能经由链接参数指定。

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=ScreenCaptureKit");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
