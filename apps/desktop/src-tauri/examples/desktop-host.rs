//! 电脑控制宿主的端到端夹具：只链接宿主模块，连接一个本地启动的服务端。
//!
//! 与真实启动路径只有两处差别：worker 的路径由环境变量指定，而不是经 Tauri 的
//! `externalBin` 定位；没有 Tauri 应用，因此退出钩子由本进程的 stdin 关闭代替。
//! 宿主模块、worker 子进程、宿主 WS 与两段协议的转换都使用产品代码。
//!
//! 用法：设置 `QYWORK_HOST_PORT` / `QYWORK_HOST_KEY` / `QYWORK_COMPUTER_HOST` 三个环境变量；
//! worker 更换时向 stdout 输出一行 `WORKER_PID=<pid>`，测试驱动据此定位要终止的进程。

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

/// 日志输出到 stderr。产品的 logger 在 `run()` 中安装，本夹具不经过该路径。
struct Stderr;

impl log::Log for Stderr {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        eprintln!("[{}] {}", record.level(), record.args());
    }

    fn flush(&self) {}
}

static LOGGER: Stderr = Stderr;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("端到端夹具需要环境变量 {name}"))
}

fn main() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);

    let port: u16 = env("QYWORK_HOST_PORT").parse().expect("端口必须是数字");
    let key = env("QYWORK_HOST_KEY");
    let worker = PathBuf::from(env("QYWORK_COMPUTER_HOST"));
    let host = qywork_lib::desktop::start_with_worker(worker, port, key);

    // stdin 关闭即收尾：产品中这一步由 Tauri 的退出事件触发。
    std::thread::spawn(|| {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(text) if !text.trim().is_empty() => continue,
                _ => break,
            }
        }
        qywork_lib::desktop::shutdown();
        std::process::exit(0);
    });

    let mut last: Option<u32> = None;
    loop {
        let pid = host.worker_pid();
        if pid != last {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(
                out,
                "WORKER_PID={}",
                pid.map_or_else(|| "none".to_owned(), |p| p.to_string())
            );
            let _ = out.flush();
            last = pid;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
