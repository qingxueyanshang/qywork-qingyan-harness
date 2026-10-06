// Windows 发布版不显示控制台窗口；debug 构建保留控制台，便于查看 sidecar 的日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    qywork_lib::run()
}
