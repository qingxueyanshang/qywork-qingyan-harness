//! 安装包的检查、验签下载和更新退出；任务退出时机由 Sidecar 裁决。

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const ENDPOINT: &str = "https://github.com/qingxueyanshang/qywork-qingyan-harness/releases/latest/download/latest.json";
const CHECK_INTERVAL: u64 = 6 * 60 * 60 * 1000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    mode: &'static str,
    current_version: String,
    stage: &'static str,
    version: Option<String>,
    notes: String,
    progress: Option<f64>,
    checked_at: Option<u64>,
    error: Option<String>,
    retry: &'static str,
}

struct Inner {
    snapshot: Snapshot,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    working: bool,
}

pub struct Owner {
    inner: Mutex<Inner>,
    cancelled: AtomicBool,
    download_paused: AtomicBool,
    pub key: String,
    sidecar: Mutex<Option<crate::sidecar::SidecarInfo>>,
}

pub type UpdateOwner = Arc<Owner>;

pub fn installing(app: &AppHandle) -> bool {
    app.state::<UpdateOwner>().inner.lock().snapshot.stage == "installing"
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn preferences(raw: &str) -> Option<(bool, bool)> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let config = value.as_object()?;
    match config.get("updates") {
        None => Some((true, true)),
        Some(prefs) => Some((
            prefs.get("autoCheck")?.as_bool()?,
            prefs.get("autoDownload")?.as_bool()?,
        )),
    }
}

pub fn owner() -> UpdateOwner {
    #[cfg(windows)]
    let key = crate::browser::new_host_key();
    #[cfg(not(windows))]
    let key = String::new();
    let enabled = cfg!(windows)
        && !tauri::is_dev()
        && option_env!("QYWORK_UPDATER_PUBLIC_KEY").is_some_and(|s| !s.trim().is_empty());
    Arc::new(Owner {
        inner: Mutex::new(Inner {
            snapshot: Snapshot {
                mode: if enabled { "installed" } else { "manual" },
                current_version: env!("CARGO_PKG_VERSION").into(),
                stage: "idle",
                version: None,
                notes: String::new(),
                progress: None,
                checked_at: None,
                error: None,
                retry: "check",
            },
            update: None,
            bytes: None,
            working: false,
        }),
        cancelled: AtomicBool::new(false),
        download_paused: AtomicBool::new(false),
        key,
        sidecar: Mutex::new(None),
    })
}

async fn claim(owner: &Owner, action: &str) -> Result<bool, String> {
    let info = owner.sidecar.lock().clone().ok_or("服务尚未就绪")?;
    let value = reqwest::Client::new()
        .post(format!("{}/internal/app-update", info.base))
        .header("x-qywork-update-key", &owner.key)
        .json(&serde_json::json!({"action":action}))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    Ok(value.get("claimed").and_then(|v| v.as_bool()) == Some(true))
}

fn begin(app: &AppHandle, owner: &UpdateOwner, action: &'static str) {
    {
        let mut inner = owner.inner.lock();
        if inner.working || inner.snapshot.mode != "installed" {
            return;
        }
        inner.working = true;
        inner.snapshot.error = None;
        inner.snapshot.retry = action;
        inner.snapshot.progress = None;
        inner.snapshot.stage = match action {
            "check" => "checking",
            "download" => "downloading",
            _ => "waiting",
        };
        owner.cancelled.store(false, Ordering::SeqCst);
        if matches!(action, "check" | "download") {
            owner.download_paused.store(false, Ordering::SeqCst);
        }
    }
    let owner = owner.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = execute(&app, &owner, action).await;
        let mut inner = owner.inner.lock();
        inner.working = false;
        if let Err(error) = result {
            if owner.cancelled.load(Ordering::SeqCst) {
                inner.snapshot.stage = if inner.bytes.is_some() {
                    "ready"
                } else if inner.update.is_some() {
                    "available"
                } else {
                    "idle"
                };
            } else {
                inner.snapshot.stage = "error";
                inner.snapshot.error = Some(error);
            }
        }
    });
}

async fn execute(app: &AppHandle, owner: &UpdateOwner, action: &str) -> Result<(), String> {
    if action == "check" {
        {
            let mut inner = owner.inner.lock();
            inner.snapshot.checked_at = Some(now());
            inner.update = None;
            inner.bytes = None;
            inner.snapshot.version = None;
            inner.snapshot.notes.clear();
        }
        let exit_app = app.clone();
        let update = app
            .updater_builder()
            .pubkey(
                option_env!("QYWORK_UPDATER_PUBLIC_KEY")
                    .unwrap_or_default()
                    .trim(),
            )
            .endpoints(vec![ENDPOINT.parse().map_err(|_| "更新地址无效")?])
            .map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(120))
            .on_before_exit(move || {
                crate::terminal::shutdown(&exit_app.state::<crate::terminal::TerminalHandle>());
                // WebView 随外壳退出释放；此时安装程序仍可能启动失败，不能永久关闭浏览器宿主。
                crate::sidecar::stop_for_update(&exit_app);
            })
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        let mut inner = owner.inner.lock();
        if let Some(update) = update {
            inner.snapshot.version = Some(update.version.clone());
            inner.snapshot.notes = update.body.clone().unwrap_or_default();
            inner.snapshot.stage = "available";
            inner.update = Some(update);
        } else {
            inner.snapshot.stage = "latest";
        }
    } else if action == "download" {
        let update = owner.inner.lock().update.clone().ok_or("请先检查更新")?;
        let mut received: u64 = 0;
        let downloaded = update.download(
            |chunk, total| {
                received += chunk as u64;
                owner.inner.lock().snapshot.progress = total
                    .filter(|t| *t > 0)
                    .map(|t| (received as f64 / t as f64 * 100.0).min(100.0));
            },
            || {},
        );
        let bytes = tokio::select! {
            result = downloaded => result.map_err(|e| e.to_string())?,
            _ = async {
                while !owner.cancelled.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => return Err("下载已取消".into()),
        };
        if owner.cancelled.load(Ordering::SeqCst) {
            return Err("下载已取消".into());
        }
        let mut inner = owner.inner.lock();
        inner.bytes = Some(bytes);
        inner.snapshot.stage = "ready";
        inner.snapshot.progress = Some(100.0);
    } else {
        let (update, bytes) = {
            let inner = owner.inner.lock();
            (
                inner.update.clone().ok_or("请先检查更新")?,
                inner.bytes.clone().ok_or("请先下载更新")?,
            )
        };
        loop {
            if owner.cancelled.load(Ordering::SeqCst) {
                return Err("更新已取消".into());
            }
            let claimed = claim(owner, "claim").await?;
            if owner.cancelled.load(Ordering::SeqCst) {
                if claimed {
                    claim(owner, "cancel").await?;
                }
                return Err("更新已取消".into());
            }
            if claimed {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let cancelled = {
            let mut inner = owner.inner.lock();
            let cancelled = owner.cancelled.load(Ordering::SeqCst);
            if !cancelled {
                inner.snapshot.stage = "installing";
            }
            cancelled
        };
        if cancelled {
            claim(owner, "cancel").await?;
            return Err("更新已取消".into());
        }
        if let Err(error) = update.install(bytes) {
            // 安装程序可能在清理子进程后启动失败；解除安装态，原监督器恢复服务。
            owner.inner.lock().snapshot.stage = "error";
            let _ = claim(owner, "cancel").await;
            return Err(error.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn app_update(app: AppHandle, action: String) -> Result<Snapshot, String> {
    let owner = app.state::<UpdateOwner>();
    match action.as_str() {
        "status" => {}
        "check" => begin(&app, &owner, "check"),
        "download" => begin(&app, &owner, "download"),
        "install" => begin(&app, &owner, "install"),
        "cancel" => {
            let inner = owner.inner.lock();
            if matches!(inner.snapshot.stage, "downloading" | "waiting") {
                if inner.snapshot.stage == "downloading" {
                    owner.download_paused.store(true, Ordering::SeqCst);
                }
                owner.cancelled.store(true, Ordering::SeqCst);
            }
        }
        _ => return Err("更新操作无效".into()),
    }
    let snapshot = owner.inner.lock().snapshot.clone();
    Ok(snapshot)
}

pub fn start(app: &AppHandle, info: &crate::sidecar::SidecarInfo) {
    let owner = app.state::<UpdateOwner>().inner().clone();
    *owner.sidecar.lock() = Some(info.clone());
    if owner.inner.lock().snapshot.mode != "installed" {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Some(path) = crate::logfile::data_dir().map(|p| p.join("config.json")) {
                let raw = std::fs::read_to_string(path).or_else(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        Ok("{}".to_string())
                    } else {
                        Err(error)
                    }
                });
                if let Ok(raw) = raw {
                    if let Some((auto_check, auto_download)) = preferences(&raw) {
                        let snapshot = owner.inner.lock().snapshot.clone();
                        if auto_check
                            && !matches!(snapshot.stage, "available" | "ready")
                            && now().saturating_sub(snapshot.checked_at.unwrap_or(0))
                                >= CHECK_INTERVAL
                        {
                            begin(&app, &owner, "check");
                        }
                        if !auto_download {
                            owner.download_paused.store(false, Ordering::SeqCst);
                        }
                        if auto_download
                            && !owner.download_paused.load(Ordering::SeqCst)
                            && snapshot.stage == "available"
                        {
                            begin(&app, &owner, "download");
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::preferences;

    #[test]
    fn preferences_default_on_and_respect_disabled_values() {
        assert_eq!(preferences("{}"), Some((true, true)));
        assert_eq!(
            preferences(r#"{"updates":{"autoCheck":false,"autoDownload":true}}"#),
            Some((false, true))
        );
        assert_eq!(
            preferences(r#"{"updates":{"autoCheck":true,"autoDownload":false}}"#),
            Some((true, false))
        );
    }

    #[test]
    fn invalid_config_does_not_trigger_automatic_operations() {
        for value in [
            "",
            "null",
            "[]",
            r#"{"updates":null}"#,
            r#"{"updates":{"autoCheck":"false"}}"#,
        ] {
            assert_eq!(preferences(value), None);
        }
    }
}
