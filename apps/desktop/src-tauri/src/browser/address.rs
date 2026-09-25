//! 地址栏与建页共用的地址解析。两种引擎按同一条规则放行地址。

use std::path::Path;

use tauri::Url;

/// 用户新开一页时的落点。地址栏空着，由用户输入真实地址。
///
/// 这一页没有要等的目标文档：标记在用户导航出的那个文档上注入，AI 要认页也只可能认那一个。
pub const BLANK: &str = "about:blank";

/// 绝对文件路径保留字面字符，file URL 保留查询与锚点。
pub fn navigation_url(raw: &str) -> Result<Url, String> {
    let value = raw.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(value);
    if Path::new(value).is_absolute() {
        return Url::from_file_path(value).map_err(|_| "本地文件路径无法解析".to_owned());
    }
    // 裸域名与 localhost:端口沿用地址栏的 HTTP 补全；其他协议交给下面统一裁决。
    let has_port = value.split_once(':').is_some_and(|(_, tail)| {
        tail.split(['/', '?', '#'])
            .next()
            .is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
    });
    let parsed = if !value.contains(':') || value.starts_with('[') || has_port {
        Url::parse(&format!("http://{value}"))
    } else {
        Url::parse(value)
    }
    .map_err(|e| format!("地址无法解析：{e}"))?;
    if matches!(parsed.scheme(), "http" | "https" | "file") || parsed.as_str() == BLANK {
        Ok(parsed)
    } else {
        Err("只能打开 HTTP、HTTPS 或本地文件".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{navigation_url, BLANK};

    /// 路径写法按本机平台取：Windows 的盘符路径在 unix 上不是绝对路径。
    #[test]
    fn local_paths_and_file_urls_keep_literal_characters() {
        #[cfg(windows)]
        let path = r"C:\Users\test\鹈鹕 骑车 #100%20.html";
        #[cfg(not(windows))]
        let path = "/home/test/鹈鹕 骑车 #100%20.html";
        let url = navigation_url(path).unwrap();
        assert_eq!(url.scheme(), "file");
        assert_eq!(url.to_file_path().unwrap(), std::path::PathBuf::from(path));
        assert_eq!(navigation_url(&format!("\"{path}\"")).unwrap(), url);
        let with_suffix = format!("{url}?preview=1#scene");
        assert_eq!(navigation_url(&with_suffix).unwrap().as_str(), with_suffix);
    }

    #[test]
    fn web_addresses_and_blank_page_keep_working() {
        for (input, expected) in [
            ("localhost:8766/pelican-bike.html", "http://localhost:8766/pelican-bike.html"),
            ("localhost:8766?preview=1", "http://localhost:8766/?preview=1"),
            ("[::1]:8766", "http://[::1]:8766/"),
            ("example.com", "http://example.com/"),
            ("https://example.com/a", "https://example.com/a"),
            (BLANK, BLANK),
        ] {
            assert_eq!(navigation_url(input).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn executable_and_other_schemes_are_rejected() {
        for input in ["javascript:alert(1)", "data:text/html,test", "ftp://host/a"] {
            assert!(navigation_url(input).is_err(), "{input}");
        }
    }
}
