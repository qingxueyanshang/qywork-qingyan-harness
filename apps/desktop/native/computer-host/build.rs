//! macOS 目标上把 ScreenCaptureKit 改成弱链接。
//!
//! `objc2-screen-capture-kit` 以 `-framework ScreenCaptureKit` 强链接；应用最低支持 macOS 11.0，
//! 而这个框架从 12.3 起才有，强链接时 dyld 在 11.0–12.2 上直接拒绝启动 worker，整条电脑控制
//! 随之不可用。链接器同时收到 `-weak_framework` 时这个框架记为 `LC_LOAD_WEAK_DYLIB`，没有它的
//! 系统上照常启动，取图在运行时查 `SCScreenshotManager` 类在不在。`macos::linkage` 的测试在
//! macOS 上读测试二进制自己的加载命令核对这一条。
//!
//! Rust 的 `#[link]` 没有弱链接修饰符，只能经链接参数给。

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=ScreenCaptureKit");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
