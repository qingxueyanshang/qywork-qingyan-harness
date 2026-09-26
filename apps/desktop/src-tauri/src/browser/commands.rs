//! 界面调内置浏览器的那几条命令。
//!
//! 界面是宿主状态的投影：标签页清单、地址、标题、控制归属都由宿主经
//! `browser:tabs` 事件推过来，这里只有「请宿主做一件事」。**前端不生成 tabId，
//! 也不自己改地址**——那两样在宿主手里，前端写一份就是第二本账。
//!
//! 移动端没有浏览器宿主，每条命令回同一句话。界面按握手里的
//! `capabilities.browser` 决定入口显示与否，不会调到这里。

use serde::Serialize;

/// 界面看得见的一页。**只有 id / 地址 / 标题 / 工作区 / 创建序号**：会话归属是协调器的事，
/// 工具栏是标准浏览器 chrome，不区分人工页与 AI 页。
/// 工作区在这里出现，是因为界面要按它决定这一页在不在当前页签条上；
/// 创建序号与终端会话共用一个计数器，界面按它把两份清单排成一条页签条。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub workspace_id: String,
    pub created_seq: u64,
}

#[cfg(not(desktop))]
const UNSUPPORTED: &str = "这个平台没有内置浏览器";

#[tauri::command]
pub fn browser_tabs() -> Vec<TabView> {
    #[cfg(desktop)]
    {
        super::tab_views()
    }
    #[cfg(not(desktop))]
    {
        Vec::new()
    }
}

/// 新开一页。`url` 缺席即一页空标签；`workspaceId` 必带，这一页从此归那个工作区。
///
/// **必须是 async**：建页要等主线程或 CDP 回包，同步命令跑在主线程上会死锁。
#[tauri::command]
pub async fn browser_open(
    app: tauri::AppHandle,
    url: Option<String>,
    workspace_id: String,
) -> Result<TabView, String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            super::user_open(&app, url.as_deref(), &workspace_id)
        })
        .await
        .map_err(|e| format!("建页任务失败：{e}"))?
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, url, workspace_id);
        Err(UNSUPPORTED.to_owned())
    }
}

/// 关页与导航在 Chromium 引擎上要等 CDP 回包，与建页同一条理由放到阻塞线程上。
#[tauri::command]
pub async fn browser_close(tab_id: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || super::user_close(&tab_id))
            .await
            .map_err(|e| format!("关页任务失败：{e}"))?
    }
    #[cfg(not(desktop))]
    {
        let _ = tab_id;
        Err(UNSUPPORTED.to_owned())
    }
}

#[tauri::command]
pub async fn browser_navigate(
    tab_id: String,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            super::user_navigate(&tab_id, &action, url.as_deref())
        })
        .await
        .map_err(|e| format!("导航任务失败：{e}"))?
    }
    #[cfg(not(desktop))]
    {
        let _ = (tab_id, action, url);
        Err(UNSUPPORTED.to_owned())
    }
}

/// 把一页所在的浏览器窗口提到前面。只有页在独立窗口里的 macOS 与 Linux 有这件事；
/// Windows 的页嵌在面板里，界面不会调到这里。要等 CDP 回包，理由同建页。
#[tauri::command]
pub async fn browser_activate(tab_id: String) -> Result<(), String> {
    #[cfg(all(desktop, not(windows)))]
    {
        tauri::async_runtime::spawn_blocking(move || super::user_activate(&tab_id))
            .await
            .map_err(|e| format!("切换窗口任务失败：{e}"))?
    }
    #[cfg(windows)]
    {
        let _ = tab_id;
        Err("浏览器页嵌在面板里，没有独立窗口".to_owned())
    }
    #[cfg(not(desktop))]
    {
        let _ = tab_id;
        Err(UNSUPPORTED.to_owned())
    }
}

/// 摆放子视图。矩形是**物理像素**（DOM 矩形乘 `devicePixelRatio`），原点是窗口客户区左上角。
///
/// `tabId` 缺席表示这一刻一页都不该露出来：面板收起、翻到别的页、浮层盖上来，以及界面
/// 整页加载时收起上一份页面摆出来的子视图。原生子视图是窗口的子 HWND，画在所有 DOM 之上，
/// CSS 的层叠对它无效。
///
/// macOS 与 Linux 的页在浏览器自己的窗口里，面板里本来没有摆出来的页：收起全部即已成立，
/// 摆放某一页做不到，如实报错。界面加载时还不知道宿主是哪一种，所以收起全部两端都要接。
#[tauri::command]
pub fn browser_layout(
    tab_id: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        super::engine::layout(tab_id.as_deref(), x, y, width, height)
    }
    #[cfg(all(desktop, not(windows)))]
    {
        let _ = (x, y, width, height);
        match tab_id {
            None => Ok(()),
            Some(_) => Err("浏览器页在独立窗口里，不在面板内摆放".to_owned()),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (tab_id, x, y, width, height);
        Err(UNSUPPORTED.to_owned())
    }
}
