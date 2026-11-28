---
name: drive-user-apps-via-host
description: 用户要求操作其已打开的 Edge 或 QyWork 时，用 .tmp/scratch/edge-token/host.ts 直接驱动 qy-computer-host，不经模型；前台动作要在信封中置 foreground
metadata:
  type: project
---

`.tmp/scratch/edge-token/host.ts` 直接驱动 `qy-computer-host`：`list` 列窗口，`tree <标题> [名称正则]` 读树，
`act <标题> <角色> <名称正则> <动作 JSON>` 在同一进程内读树、按角色与名称找到控件后执行；标题以 `=` 开头时全文匹配
（「QyWork」同时匹配宠物窗口与标题含 QyWork 的 Edge 标签页）。`shot.ts` 用 `capture_image` 截取窗口。

- 点击、输入、按键、`activate` 的请求信封须 `foreground: true`，否则回执为 `foreground_disabled`；回执的 `dispatch` 为 `submitted` 才表示已送达。
- Edge 地址栏：先点击取得焦点，再 `set_value`，再 `press_key Enter`；只 `set_value` 加回车不会跳转。网页按钮点击无效时改用 `invoke`。
- QyWork 输入框旁的型号菜单按 Esc 不关闭，点击菜单外的文字（如「运行于」）关闭；菜单开着时输入的文字不会进入输入框。
- 窗口被遮挡时 WebView 不重绘，截图停在旧画面；先 `activate` 再截图核对。

2026-11-27 用它完成：在 Edge 中建立 GitHub 细粒度令牌（身份验证码由用户填写）、在正式后台审核页点「通过」、在用户的 QyWork 中新建对话测试内置技能。
操作前确认目标窗口与标签页，不往用户正在进行的会话中输入；全局记忆 probe-input-only-verified-window 同样适用。
