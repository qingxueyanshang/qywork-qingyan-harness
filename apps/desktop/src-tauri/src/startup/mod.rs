//! 启动失败的分类、诊断和呈现。诊断写入现有外壳日志，不读取配置或会话内容。

use std::error::Error;
use std::path::PathBuf;

#[cfg(windows)]
mod windows;

#[derive(Debug)]
pub(crate) struct LaunchError {
    pub executable: Option<PathBuf>,
    pub source: tauri_plugin_shell::Error,
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "启动 qy serve 失败：{}", self.source)
    }
}

impl Error for LaunchError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}

#[derive(Debug, serde::Serialize)]
struct Report {
    time: String,
    version: &'static str,
    platform: &'static str,
    arch: &'static str,
    shell: Option<PathBuf>,
    executable: Option<PathBuf>,
    os_error: Option<i32>,
    error_chain: Vec<String>,
    #[cfg(windows)]
    system_checks: windows::Probe,
}

impl Report {
    fn from_error(error: &(dyn Error + 'static)) -> Self {
        let mut report = Self {
            time: crate::logfile::utc_now(),
            version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            shell: std::env::current_exe().ok(),
            executable: None,
            os_error: None,
            error_chain: Vec::new(),
            #[cfg(windows)]
            system_checks: windows::Probe::default(),
        };
        let mut current = Some(error);
        while let Some(cause) = current {
            if let Some(launch) = cause.downcast_ref::<LaunchError>() {
                report.executable = launch.executable.clone();
                // shell 的透明 Io 变体可能直接转发 source()，须在此读取原始错误码。
                if let tauri_plugin_shell::Error::Io(io) = &launch.source {
                    report.os_error = io.raw_os_error();
                }
            }
            if let Some(io) = cause.downcast_ref::<std::io::Error>() {
                report.os_error = report.os_error.or(io.raw_os_error());
            }
            let message = cause.to_string();
            if report.error_chain.last() != Some(&message) {
                report.error_chain.push(message);
            }
            current = cause.source();
        }
        report
    }

    fn policy_blocked(&self) -> bool {
        cfg!(windows) && self.os_error == Some(4551)
    }

    fn summary(&self) -> &str {
        if self.policy_blocked() && self.executable.is_some() {
            "Windows 应用程序控制阻止了后台服务启动。"
        } else if self.policy_blocked() {
            "Windows 应用程序控制阻止了程序运行。"
        } else {
            "qywork 启动失败。"
        }
    }
}

pub(crate) fn report_and_show(error: &(dyn Error + 'static)) {
    #[allow(unused_mut)]
    let mut report = Report::from_error(error);
    log::error!("qywork 启动失败：{error}");
    #[cfg(windows)]
    {
        report.system_checks =
            windows::probe(report.executable.as_deref(), report.shell.as_deref());
    }
    let json = serde_json::to_string(&report).unwrap_or_else(|_| "{}".into());
    let saved = crate::logfile::append(&format!("{} ERROR [startup] {json}", report.time));
    let location = if saved {
        crate::logfile::data_dir()
            .map(|dir| format!("日志：{}", dir.join("logs/qywork.log").display()))
            .unwrap_or_default()
    } else {
        "诊断日志写入失败，请复制诊断信息。".into()
    };
    let details = format!(
        "{}\n{}\n{}",
        report.summary(),
        serde_json::to_string_pretty(&report).unwrap_or(json),
        location
    );
    #[cfg(windows)]
    windows::show(&report, &details, &location);
    #[cfg(not(windows))]
    eprintln!("{details}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_spawn_error_through_anyhow_and_box() {
        let error: Box<dyn Error> = anyhow::Error::new(LaunchError {
            executable: Some(PathBuf::from("C:/Program Files/qywork/qy.exe")),
            source: std::io::Error::from_raw_os_error(4551).into(),
        })
        .context("初始化桌面服务失败")
        .into();
        let report = Report::from_error(error.as_ref());
        assert_eq!(report.os_error, Some(4551));
        assert!(report.executable.unwrap().ends_with("qy.exe"));
        assert_eq!(report.error_chain[0], "初始化桌面服务失败");
    }

    #[test]
    fn does_not_classify_message_text_as_policy_evidence() {
        let error = std::io::Error::other("日志包含 4551 和应用程序控制");
        assert!(!Report::from_error(&error).policy_blocked());
        let error = std::io::Error::from_raw_os_error(5);
        assert!(!Report::from_error(&error).policy_blocked());
        let error = std::io::Error::from_raw_os_error(4551);
        assert_eq!(Report::from_error(&error).policy_blocked(), cfg!(windows));
    }
}
