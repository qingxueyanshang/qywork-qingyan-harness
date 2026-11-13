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

/// Intel 版本是否由 Rosetta 转译运行，即本机是 Apple 芯片的 Mac。
///
/// Rosetta 在 macOS 15 之前不支持 AVX，Bun 运行时在其中以非法指令退出。
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn translated() -> bool {
    extern "C" {
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *mut std::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }
    let mut value: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    // SAFETY: 名称以 NUL 结尾，输出缓冲区与 size 一致，不写入新值。
    let status = unsafe {
        sysctlbyname(
            b"sysctl.proc_translated\0".as_ptr().cast(),
            (&mut value as *mut i32).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    status == 0 && value == 1
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn translated() -> bool {
    false
}

/// 对话框正文中错误原文的长度上限：对话框不支持滚动，文本超出屏幕高度时无法点击按钮。
const BRIEF_CHARS: usize = 700;

#[derive(Debug, serde::Serialize)]
struct Report {
    time: String,
    version: &'static str,
    platform: &'static str,
    arch: &'static str,
    shell: Option<PathBuf>,
    executable: Option<PathBuf>,
    os_error: Option<i32>,
    /// 见 `translated`。
    translated: bool,
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
            translated: translated(),
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
        } else if self.translated {
            "这台 Mac 使用 Apple 芯片，当前安装的是 Intel 版本。请下载 Apple 芯片版本（文件名含 aarch64）后重新安装。"
        } else {
            "qywork 启动失败。"
        }
    }

    /// 对话框正文中的错误原文：最外层的一条，截取到 `BRIEF_CHARS`。完整诊断在日志中。
    fn brief(&self) -> String {
        self.error_chain.first().into_iter().flat_map(|s| s.chars()).take(BRIEF_CHARS).collect()
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
    {
        // 完整诊断写入标准错误：没有图形会话时对话框无法显示。
        eprintln!("{details}");
        show(&format!("{}\n\n{}\n\n{location}", report.summary(), report.brief()));
    }
}

/// 非 Windows 平台的启动失败对话框。正文只含结论、错误原文与日志位置，不含完整诊断：
/// 对话框不支持滚动与复制，完整诊断由调用方写入日志与标准错误。
///
/// macOS 上 rfd 在主线程直接弹出，在其他线程时转交主线程；本函数只在主线程或应用事件循环
/// 运行期间调用，两种情况都能显示。
#[cfg(not(windows))]
fn show(details: &str) {
    // Linux 上 GTK 无法初始化（没有图形会话）时，rfd 的同步对话框永久阻塞，进程无法退出。
    // GTK 已初始化时 `gtk_init_check` 立即返回成功，不会重复初始化。
    #[cfg(target_os = "linux")]
    {
        // SAFETY: 两个参数为空指针时 GTK 不读取命令行参数。
        if unsafe { gtk_sys::gtk_init_check(std::ptr::null_mut(), std::ptr::null_mut()) } == 0 {
            return;
        }
    }
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("qywork 启动失败")
        .set_description(details)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
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

    /// 原始失败形状：Apple 芯片的 Mac 安装 Intel 版本后，对话框只显示运行时的崩溃输出。
    #[test]
    fn translated_intel_build_names_the_matching_package() {
        let error = std::io::Error::other("qy serve 在输出令牌前退出，code=None");
        let mut report = Report::from_error(&error);
        assert_eq!(report.summary(), "qywork 启动失败。");
        report.translated = true;
        assert!(report.summary().contains("aarch64"));
    }

    #[test]
    fn brief_is_the_outermost_error_and_bounded() {
        let error: Box<dyn Error> =
            anyhow::Error::new(std::io::Error::other("内层")).context("外".repeat(2000)).into();
        let brief = Report::from_error(error.as_ref()).brief();
        assert_eq!(brief.chars().count(), BRIEF_CHARS);
        assert!(brief.starts_with('外'));
    }
}
