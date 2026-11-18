//! 界面调用内置浏览器的命令。
//!
//! 界面是宿主状态的投影：标签页清单、地址、标题、控制归属都由宿主经
//! `browser:tabs` 事件推送，此处只有向宿主发出的请求。**前端不生成 tabId，
//! 也不自行修改地址**：两者由宿主管理，前端另写一份即形成第二本账。
//!
//! 移动端没有浏览器宿主，每条命令返回同一条错误。界面按握手中的
//! `capabilities.browser` 决定是否显示入口，不会调用此处。

use serde::Serialize;

/// 界面可见的页面。**只有 id / 地址 / 标题 / 工作区 / 创建序号 / 缩放比例 / 能否后退与前进 / 打开它的页 / 是否隐藏**：
/// 会话归属由协调器负责，工具栏是标准浏览器 chrome，不区分人工页面与 AI 页面。
/// 包含工作区，是因为界面按它决定该页面是否显示在当前页签条上；
/// 创建序号与终端会话共用一个计数器，界面按它把两份清单合并排列为一条页签条。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub workspace_id: String,
    pub created_seq: u64,
    /// 1 为 100%。页面位于独立窗口中时恒为 1，界面不显示。
    pub zoom: f64,
    /// 页面位于独立窗口中时恒为假，界面不据此禁用按钮。
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// 页面请求的新窗口为打开它的页，其余为 `None`。打开它的页显示在面板中时，界面切换到新页。
    pub opener_tab_id: Option<String>,
    /// 不列入页签条的页：文件页的 HTML 预览与服务端内部渲染用的页。界面只摆放自己打开的隐藏页。
    pub hidden: bool,
}

#[cfg(not(desktop))]
const UNSUPPORTED: &str = "当前平台没有内置浏览器";

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

/// 新建页面。`url` 缺省时为空白标签页；`workspaceId` 为必填，该页面此后归属该工作区。
/// `hidden` 为真时不列入页签条，由打开它的界面组件摆放与关闭（文件页的 HTML 预览）。
///
/// **必须是 async**：新建页面需要等待主线程或 CDP 响应，同步命令运行在主线程上会死锁。
#[tauri::command]
pub async fn browser_open(
    app: tauri::AppHandle,
    url: Option<String>,
    workspace_id: String,
    hidden: Option<bool>,
) -> Result<TabView, String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            super::user_open(&app, url.as_deref(), &workspace_id, hidden.unwrap_or(false))
        })
        .await
        .map_err(|e| format!("新建页面任务失败：{e}"))?
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, url, workspace_id, hidden);
        Err(UNSUPPORTED.to_owned())
    }
}

/// 关闭页面与导航在 Chromium 引擎上需要等待 CDP 响应，理由与新建页面相同，因此放到阻塞线程上执行。
#[tauri::command]
pub async fn browser_close(tab_id: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        tauri::async_runtime::spawn_blocking(move || super::user_close(&tab_id))
            .await
            .map_err(|e| format!("关闭页面任务失败：{e}"))?
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

/// 按档位放大（`in`）或缩小（`out`）页面，`reset` 恢复为 100%。只有页面嵌在面板中的 Windows 支持；
/// 主线程执行缩放期间阻塞等待，理由同新建页面。
#[tauri::command]
pub async fn browser_zoom(tab_id: String, action: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || super::user_zoom(&tab_id, &action))
            .await
            .map_err(|e| format!("缩放任务失败：{e}"))?
    }
    #[cfg(all(desktop, not(windows)))]
    {
        let _ = (tab_id, action);
        Err("浏览器页面位于独立窗口中，在该窗口中缩放".to_owned())
    }
    #[cfg(not(desktop))]
    {
        let _ = (tab_id, action);
        Err(UNSUPPORTED.to_owned())
    }
}

/// 把页面所在的浏览器窗口置于前台。只有页面位于独立窗口的 macOS 与 Linux 需要此操作；
/// Windows 的页面嵌在面板中，界面不会调用此处。需要等待 CDP 响应，理由同新建页面。
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
        Err("浏览器页面嵌在面板中，没有独立窗口".to_owned())
    }
    #[cfg(not(desktop))]
    {
        let _ = tab_id;
        Err(UNSUPPORTED.to_owned())
    }
}

/// 放置子视图。矩形使用**物理像素**（DOM 矩形乘以 `devicePixelRatio`），原点为窗口客户区左上角。
///
/// `tabId` 缺省表示此刻不应显示任何页面：面板收起、切换到其他页签、浮层覆盖，以及界面
/// 整体加载时收起上一次界面放置的子视图。原生子视图是窗口的子 HWND，渲染在所有 DOM 之上，
/// CSS 的层叠对其无效。
///
/// macOS 与 Linux 的页面位于浏览器自身的窗口中，面板中没有放置的页面：收起全部的请求直接视为完成，
/// 放置某个页面无法完成，如实报错。界面加载时尚不知道宿主类型，因此两类宿主都必须接受收起全部的请求。
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
            Some(_) => Err("浏览器页面位于独立窗口中，不在面板内放置".to_owned()),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (tab_id, x, y, width, height);
        Err(UNSUPPORTED.to_owned())
    }
}
