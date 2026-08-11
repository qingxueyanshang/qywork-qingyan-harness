// Windows 发布版不要弹出控制台窗口；debug 下保留，方便看 sidecar 的日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    qywork_lib::run()
}
