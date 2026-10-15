//! Windows 启动诊断和原生对话框；不依赖 Tauri 窗口或后台服务。

use super::Report;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use windows::core::{w, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND, LPARAM, S_FALSE, S_OK, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Controls::*;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, SetDlgItemTextW, MB_ICONERROR, MB_OK, SW_SHOWNORMAL,
};

const COPY: i32 = 100;
const SECURITY: i32 = 101;
const CLOSE: i32 = 102;

#[derive(Debug, Default, serde::Serialize)]
pub(super) struct Probe {
    records: Vec<serde_json::Value>,
    unavailable: Option<String>,
}

pub(super) fn probe(target: Option<&Path>, shell: Option<&Path>) -> Probe {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return Probe {
            unavailable: Some("SystemRoot 未设置".into()),
            ..Default::default()
        };
    };
    let mut command =
        Command::new(Path::new(&root).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        include_str!("probe.ps1"),
    ]);
    command.env("QYWORK_DIAGNOSTIC_TARGET", target.unwrap_or(Path::new("")));
    command.env("QYWORK_DIAGNOSTIC_SHELL", shell.unwrap_or(Path::new("")));
    // PowerShell 7 的模块目录不能传给系统自带的 Windows PowerShell。
    command.env_remove("PSModulePath");
    command.creation_flags(0x0800_0000);
    collect(&mut command, Duration::from_secs(8))
}

/// 先排空有界输出再等待进程，避免管道写满。超时结束诊断进程，保留已输出的记录。
fn collect(command: &mut Command, timeout: Duration) -> Probe {
    let mut result = Probe::default();
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            result.unavailable = Some(format!("启动系统诊断失败：{error}"));
            return result;
        }
    };
    let output = child.stdout.take().expect("诊断 stdout 已配置为管道");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = output.take(64 * 1024).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    result.unavailable = Some(format!("系统诊断退出：{status}"));
                }
                break;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            status => {
                result.unavailable = Some(match status {
                    Err(error) => format!("等待系统诊断失败：{error}"),
                    _ => "系统诊断超时".into(),
                });
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    // 管道由诊断进程持有；额外限时防止意外继承句柄使读取线程无法结束。
    match rx.recv_timeout(Duration::from_millis(200)) {
        Ok(bytes) => {
            for line in String::from_utf8_lossy(&bytes)
                .trim_start_matches('\u{feff}')
                .lines()
            {
                match serde_json::from_str(line) {
                    Ok(value) => result.records.push(value),
                    Err(_) => result.unavailable = Some("系统诊断输出不完整".into()),
                }
            }
            if result.records.is_empty() && result.unavailable.is_none() {
                result.unavailable = Some("系统诊断未返回信息".into());
            }
        }
        Err(_) => result.unavailable = Some("系统诊断输出读取超时".into()),
    }
    result
}

fn copy(hwnd: HWND, text: &str) -> windows::core::Result<()> {
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    // SAFETY: 内存大小与 UTF-16 数据一致；成功后内存所有权转给系统，否则在本函数释放。
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, text.len() * 2)?;
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            let error = windows::core::Error::from_win32();
            let _ = GlobalFree(Some(memory));
            return Err(error);
        }
        std::ptr::copy_nonoverlapping(text.as_ptr(), pointer.cast(), text.len());
        let _ = GlobalUnlock(memory);
        let result = OpenClipboard(Some(hwnd)).and_then(|()| {
            let result = EmptyClipboard()
                .and_then(|()| SetClipboardData(13, Some(HANDLE(memory.0))).map(|_| ()));
            let _ = CloseClipboard();
            result
        });
        if result.is_err() {
            let _ = GlobalFree(Some(memory));
        }
        result
    }
}

unsafe extern "system" fn callback(
    hwnd: HWND,
    message: TASKDIALOG_NOTIFICATIONS,
    button: WPARAM,
    _: LPARAM,
    data: isize,
) -> HRESULT {
    if message != TDN_BUTTON_CLICKED {
        return S_OK;
    }
    if button.0 == COPY as usize {
        // SAFETY: show 中的 String 在 TaskDialogIndirect 返回之前一直有效。
        let details = unsafe { &*(data as *const String) };
        let label = if copy(hwnd, details).is_ok() {
            w!("已复制诊断信息")
        } else {
            w!("复制失败，请重试")
        };
        let _ = unsafe { SetDlgItemTextW(hwnd, COPY, label) };
        return S_FALSE;
    }
    if button.0 == SECURITY as usize {
        // SAFETY: 固定系统 URI；不执行诊断内容中的路径或命令。
        let opened = unsafe {
            ShellExecuteW(
                Some(hwnd),
                w!("open"),
                w!("windowsdefender://appbrowser"),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if opened.0 as isize <= 32 {
            let _ = unsafe { SetDlgItemTextW(hwnd, SECURITY, w!("无法打开安全中心")) };
        }
        return S_FALSE;
    }
    S_OK
}

pub(super) fn show(report: &Report, details: &str, location: &str) {
    let details = details.to_owned();
    let summary = HSTRING::from(report.summary());
    let target = report
        .executable
        .as_ref()
        .map(|path| format!("程序：{}\n", path.display()))
        .unwrap_or_default();
    let content = if report.policy_blocked() {
        format!("{target}请复制诊断信息联系开发者；单位设备请联系管理员。\n{location}")
    } else {
        let error: String = report
            .error_chain
            .first()
            .into_iter()
            .flat_map(|s| s.chars())
            .take(700)
            .collect();
        format!("{error}\n{location}")
    };
    let content = HSTRING::from(content);
    let mut buttons = vec![TASKDIALOG_BUTTON {
        nButtonID: COPY,
        pszButtonText: w!("复制诊断信息"),
    }];
    if report.policy_blocked() {
        buttons.push(TASKDIALOG_BUTTON {
            nButtonID: SECURITY,
            pszButtonText: w!("打开安全中心"),
        });
    }
    buttons.push(TASKDIALOG_BUTTON {
        nButtonID: CLOSE,
        pszButtonText: w!("关闭"),
    });
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
        pszWindowTitle: w!("qywork 启动失败"),
        pszMainInstruction: PCWSTR(summary.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        Anonymous1: TASKDIALOGCONFIG_0 {
            pszMainIcon: TD_ERROR_ICON,
        },
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: CLOSE,
        pfCallback: Some(callback),
        lpCallbackData: &details as *const String as isize,
        cxWidth: 420,
        ..Default::default()
    };
    // SAFETY: 所有字符串、按钮及回调上下文均存活至模态对话框关闭。
    if let Err(error) = unsafe { TaskDialogIndirect(&config, None, None, None) } {
        log::error!("启动诊断对话框创建失败：{error}");
        let message = HSTRING::from(format!("{}\n{}", report.summary(), content));
        unsafe {
            MessageBoxW(None, &message, w!("qywork 启动失败"), MB_OK | MB_ICONERROR);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn powershell(script: &str) -> Command {
        let mut command = Command::new(
            Path::new(&std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env_remove("PSModulePath")
            .creation_flags(0x0800_0000);
        command
    }

    #[test]
    fn probe_timeout_preserves_partial_information() {
        let mut command =
            powershell("[Console]::WriteLine('{\"section\":\"test\"}'); Start-Sleep -Seconds 30");
        let start = Instant::now();
        let result = collect(&mut command, Duration::from_secs(2));
        assert!(start.elapsed() < Duration::from_secs(5));
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.unavailable.as_deref(), Some("系统诊断超时"));
    }

    #[test]
    fn unavailable_probe_retains_a_reason() {
        let result = collect(
            &mut Command::new("Q:/missing/qywork-diagnostic.exe"),
            Duration::from_secs(1),
        );
        assert!(result.unavailable.unwrap().contains("启动系统诊断失败"));
    }

    #[test]
    fn real_probe_handles_missing_target_without_losing_os_details() {
        let shell = Path::new(&std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let result = probe(
            Some(Path::new("Q:/不存在/引号'和空格/qy.exe")),
            Some(&shell),
        );
        assert!(result.records.iter().any(|r| r["section"] == "windows"));
        assert!(result
            .records
            .iter()
            .any(|r| r["section"] == "signature" && r["data"]["unavailable"].is_string()));
        assert!(result
            .records
            .iter()
            .any(|r| r["section"] == "signature" && r["data"]["status"] == "Valid"));
    }

    #[test]
    fn event_probe_filters_other_apps_and_correlates_signature_events() {
        let fixture = r#"
function Get-WinEvent {
    foreach ($entry in @(@(3077, 'qy', '\Device\HarddiskVolume3\Apps\qywork\qy.exe', ''), @(3089, 'qy', '', ''), @(3077, 'dll', 'C:\Apps\qywork\dependency.dll', 'C:\Apps\qywork\qy.exe'), @(3089, 'dll', '', ''), @(3077, 'other', 'C:\Other\qy.exe', 'C:\Other\parent.exe'))) {
        $item = [pscustomobject]@{ Id = $entry[0]; TimeCreated = [DateTime]::Now; Xml = "<Event><System><Correlation ActivityID='$($entry[1])'/></System><EventData><Data Name='FileName'>$($entry[2])</Data><Data Name='ProcessName'>$($entry[3])</Data><Data Name='PolicyName'>Test policy</Data></EventData></Event>" }
        $item | Add-Member ScriptMethod ToXml { $this.Xml }
        $item
    }
}
"#;
        let mut command = powershell(&format!("{fixture}\n{}", include_str!("probe.ps1")));
        command.env("QYWORK_DIAGNOSTIC_TARGET", "C:\\Apps\\qywork\\qy.exe");
        command.env_remove("QYWORK_DIAGNOSTIC_SHELL");
        let result = collect(&mut command, Duration::from_secs(8));
        let events = result
            .records
            .iter()
            .find(|r| r["section"] == "code_integrity")
            .unwrap();
        assert_eq!(events["data"]["status"], "ok");
        let events = events["data"]["events"].as_array().unwrap();
        assert_eq!(events.len(), 4);
        assert!(events
            .iter()
            .all(|e| e["activity"] == "qy" || e["activity"] == "dll"));
    }

    #[test]
    fn event_access_denial_is_reported_without_discarding_os_data() {
        let mut command = powershell(&format!(
            "function Get-WinEvent {{ throw 'Access denied fixture' }}\n{}",
            include_str!("probe.ps1")
        ));
        command
            .env_remove("QYWORK_DIAGNOSTIC_TARGET")
            .env_remove("QYWORK_DIAGNOSTIC_SHELL");
        let result = collect(&mut command, Duration::from_secs(8));
        assert!(result.records.iter().any(|r| r["section"] == "windows"));
        let events = result
            .records
            .iter()
            .find(|r| r["section"] == "code_integrity")
            .unwrap();
        assert_eq!(events["data"]["status"], "unavailable");
        assert_eq!(events["data"]["reason"], "Access denied fixture");
    }
}
