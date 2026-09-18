//! 电脑操作宿主的端到端夹具：只链接宿主模块，连一个本地起的服务端。
//!
//! 与真实启动路径的差别只有两处：worker 的路径由环境变量给，而不是经 Tauri 的
//! `externalBin` 定位；没有 Tauri 应用，因此退出钩子由本进程的 stdin 关闭代替。
//! 宿主模块、worker 子进程、宿主 WS 与两段协议的翻译都是产品那一份。
//!
//! 用法：`QYWORK_HOST_PORT` / `QYWORK_HOST_KEY` / `QYWORK_COMPUTER_HOST` 三个环境变量，
//! worker 换代时向 stdout 打一行 `WORKER_PID=<pid>`，驱动按它定位要杀的进程。

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

/// 日志转 stderr。产品里的 logger 装在 `run()` 里，这个夹具不走那条路径。
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

    let port: u16 = env("QYWORK_HOST_PORT").parse().expect("端口要是一个数");
    let key = env("QYWORK_HOST_KEY");
    let worker = PathBuf::from(env("QYWORK_COMPUTER_HOST"));
    let host = qywork_lib::desktop::start_with_worker(worker, port, key);

    // stdin 关闭即收尾：产品里这一步挂在 Tauri 的退出事件上。
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
