//! 技能导入的本机选择器：同一列表同时显示目录与 ZIP。
//! 只负责列出来源，校验和安装仍由 sidecar 的 importSkills 执行。
//! 此能力只授予主 WebView，不能作为 HTTP 文件浏览接口向远端开放。

use std::path::PathBuf;
use tauri::Manager;

#[derive(serde::Serialize)]
pub struct Entry {
    name: String,
    path: PathBuf,
    directory: bool,
}

#[derive(serde::Serialize)]
pub struct Listing {
    path: PathBuf,
    parent: Option<PathBuf>,
    selected: Option<PathBuf>,
    entries: Vec<Entry>,
    locations: Vec<Entry>,
}

fn list_source(mut path: PathBuf, locations: Vec<Entry>) -> Result<Listing, String> {
    if !path.is_absolute() {
        return Err("请输入完整路径".into());
    }
    let info = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    let selected = if info.is_file()
        && path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        let selected = path.clone();
        path = path.parent().ok_or("未找到上级目录")?.to_path_buf();
        Some(selected)
    } else if info.is_dir() {
        None
    } else {
        return Err("请选择文件夹或 ZIP".into());
    };
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let source = entry.path();
        if kind.is_dir()
            || (kind.is_file()
                && source
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("zip")))
        {
            entries.push(Entry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: source,
                directory: kind.is_dir(),
            });
        }
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing {
        parent: path.parent().map(|p| p.to_path_buf()),
        path,
        selected,
        entries,
        locations,
    })
}

#[tauri::command]
pub async fn list_skill_sources(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<Listing, String> {
    let resolver = app.path();
    let candidates = [
        ("下载", resolver.download_dir()),
        ("桌面", resolver.desktop_dir()),
        ("主目录", resolver.home_dir()),
    ];
    // 慢磁盘与网络路径不能阻塞桌面运行时。
    tauri::async_runtime::spawn_blocking(move || {
        let locations: Vec<Entry> = candidates
            .into_iter()
            .filter_map(|(name, path)| {
                let path = path.ok()?;
                path.is_dir().then(|| Entry {
                    name: name.into(),
                    path,
                    directory: true,
                })
            })
            .collect();
        let source = match path.filter(|p| !p.trim().is_empty()) {
            Some(path) => PathBuf::from(path),
            None => locations.first().ok_or("未找到默认目录")?.path.clone(),
        };
        list_source(source, locations)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_and_zip_share_one_listing() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("qy-skill-picker-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("技能目录")).unwrap();
        std::fs::write(root.join("技能包.ZIP"), b"zip").unwrap();
        std::fs::write(root.join("notes.txt"), b"text").unwrap();
        let listing = list_source(root.clone(), vec![]).unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.entries[0].directory);
        assert_eq!(listing.entries[1].name, "技能包.ZIP");
        assert!(listing.selected.is_none());
        let zip = root.join("技能包.ZIP");
        let listing = list_source(zip.clone(), vec![]).unwrap();
        assert_eq!(listing.path, root);
        assert_eq!(listing.selected, Some(zip));
        assert!(list_source(root.join("notes.txt"), vec![]).is_err());
        assert!(list_source(root.join("missing"), vec![]).is_err());
        assert!(list_source(PathBuf::from("relative"), vec![]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
