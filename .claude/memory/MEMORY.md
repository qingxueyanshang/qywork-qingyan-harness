# qywork — 项目记忆索引

qywork 自身的记忆存放于此，每条一个文件，下方每行对应一条：`- [标题](文件.md) — 一句话`。

**分层规则**（见 `CLAUDE.md` D3）：只与 qywork 代码有关的写在这里；
对整台机器都成立的陷阱（Windows 编码、Playwright 不可用、npm shim）和跨项目的工作偏好，
写入全局 `~/.claude/projects/.../memory/`。写新记忆前先读本文件，避免重复。

- [命中率只取最后一次调用](hit-rate-shows-latest-call.md) — 用户确定的口径，不要改为整轮累计；可以调整的只有「没回报按 0 算」那一处
- [排查先查本地数据库](diagnose-from-the-local-db.md) — `~/.qywork/qywork.sqlite3` 有每次工具调用的完整 args 与 outcome；`permission_audit` 为空表 = 未发生过任何权限裁决
- [dev server 必须显式绑定 IPv4](dev-server-must-bind-ipv4.md) — vite 不设 host 时只监听 `::1`，Tauri/PowerShell 探测 localhost 使用 IPv4，现象为 `tauri dev` 停滞 180 秒；`strictPort` 同样必须开启
- [桌面端 WebView 连接 CDP](tauri-webview-no-cdp.md) — 开发构建设置 `QYWORK_WEBVIEW_DEBUG_PORT` 并另行启动隔离实例；环境变量与策略注册表都不生效
- [修改 terminal.rs 前先读这四条](pty-lessons-before-removal.md) — PTY 必须在 Rust 侧、slave 端立即释放、字节流按累积缓冲 lossy 解码、默认 shell 固定为 powershell 且不读 COMSPEC
- [dev 状态下修改源码会作用于用户正在使用的窗口](dev-edits-hit-the-running-app.md) — 修改前端触发热更新、修改 core 触发整页刷新、修改 packages 在运行中的 run 结束后重启 dev.ts 的 sidecar、修改 Rust 重启整个应用；取证须另行启动隔离实例
- [PTY 是否存活以进程树为准](pty-alive-check-by-process-tree.md) — 外壳进程（开发实例 `qywork-dev.exe`）下有 `conhost.exe --headless` + shell 才视为存活；只有 webview 说明界面显示与实际不符
- [本地打包产物收集到 .tmp/installer/](local-installer-lands-in-tmp.md) — `tauri:build` 末尾自动收集；正式发布通过 GitHub Actions 草稿 Release，不要把本地 exe 当作发布产物
- [计时测试在机器高负载时成批超时](timing-tests-fail-under-machine-load.md) — followup / goal-loop / 插件 e2e 的 10s 上限；套件总时长翻倍且只有这几条失败即为负载所致，待负载回落后重新运行
- [在不影响用户窗口的前提下复现前端问题](probe-ui-with-isolated-instance.md) — 复制数据库到 .tmp/probe/home 并启动隔离 sidecar，`#t=token` 配对，用 Node 驱动 Playwright 获取 pageerror；外壳实例须用 `TAURI_CONFIG` 把 devUrl 改为 5181 再编译
- [真机电脑控制任务会操作任何已打开的窗口](desktop-live-runs-can-type-into-this-session.md) — 曾输入 `exit` 结束主会话、曾导航用户的 Edge；运行前确认 run-task.ts 会隐藏运行前已打开的全部窗口，结束后用 scan-touched.ts 检查
- [参照用的 agent 仓库位于 view-agent](reference-agents-in-view-agent.md) — 「看看开源项目」指桌面 view-agent 下的 pi / prime / cc-haha / deepseek-harness 四个仓库；出处只写入 docs/plans
- [云端仓库只用本地 git](cloud-repo-local-only.md) — `Desktop\qywork-cloud` 不推送、不建远程；用户未要求时不构建安装包，服务器由用户准备
- [云端仓库格式化须指定 biome 配置](cloud-biome-config-path.md) — 云端仓库没有 biome.json，不加 `--config-path ../qywork/biome.json` 会按默认配置重排整个文件，且无法再格式化恢复
- [商业化云服务使用独立账号](commercial-cloud-standalone-accounts.md) — 邮箱加密码注册登录，不接第三方登录；后台录入模型接口并查看用户数据
- [前一版本未发布时不升版本号](version-bump-only-after-publish.md) — v0.1.20 未公开时新改动并入 0.1.20，本地打包安装使用同一版本号，版本说明修改当前版本的那一份
- [正式发布经接口脚本完成](publish-release-via-api.md) — `.tmp/scratch/release-api.ps1` 用凭据管理器的令牌触发三个发布工作流并公开草稿，不需要 gh；Git Bash 中设置 `MSYS_NO_PATHCONV=1`
- [执行 qy 必须隔离数据目录](qy-needs-isolated-home.md) — 同一条命令中设置 `QYWORK_HOME` 指向 .tmp；钩子 `scripts/guard-real-home.ts` 拦截未设置的命令；单个测试文件用 `bun run test <文件>`，不要进入包目录再 `bun test`（不加载预载）；误用过三次用户真实数据
- [Git Bash 的 /tmp 指向已删除的测试目录](git-bash-tmp-points-at-deleted-test-dir.md) — bash 先输出「could not find /tmp」、shell 工具测试报「投递额度未开账」；用 `mount` 查看指向并重建该目录，不结束其他会话的 sh
- [与并行会话修改了同一批文件时只提交本会话的段](partial-commit-shared-files.md) — 按内容判定归属、从 HEAD 构造内容写入索引、临时工作树自检、按索引提交；带 pathspec 会把对方的段一并提交
- [常驻动画只能修改 transform / opacity](continuous-animation-cost.md) — 用户显示器 180Hz，CSS 重绘型动画开销为 60Hz 的三倍；画布流动虚线由 WebGL 绘制（抗锯齿虚线曲线的光栅化随条数增长），删除视觉效果前先问用户
- [刷新恢复的测试方法](refresh-restore-testing.md) — 带查询串重新导入模块模拟刷新；组件测试 afterEach 清空记录；性能对照构建把 sessionSignal 换成 createSignal
- [画布卡顿须在桌面外壳中按用户布局测量](canvas-perf-measure-in-shell.md) — 无头 Chrome 与窄面板都无法复现；先截取用户窗口核对缩放与主题；瓶颈是 180Hz 下 GPU 进程的光栅化；测量脚本已删除，按正文的方法重写
- [画布改写手写编号须可见](canvas-prompt-no-hidden-rewrite.md) — 发送前按型号写法改写手写编号，读取画布、回执与生成面板逐卡显示「发送时改写」；不可见的改写被否决过
- [拉取结果不提供引用写法](pull-no-mention-syntax.md) — 计费清单与第三方接口的型号目录都没有「@Image1 / @图片1」字段，拉取无法检测
- [截断内容沿用原有悬停提示](reuse-existing-hover-tooltip.md) — 显示全文用 `data-tip`，不新增点击浮层；用户以现有界面为参照时按参照的形式实现
- [.tmp/scratch 由并行会话共用](scratch-dir-shared-between-sessions.md) — 提交说明不用固定文件名，写入本会话私有的临时目录；曾被对方的同名文件覆盖导致说明错误
- [估算系数的实测方法](token-density-calibration.md) — 新增或补测型号用 .tmp/ctx-probe 脚本；Claude 经第三方接口时直接请求并读取首个事件，Qwen 关闭思考；三档未测仍用默认档
- [模型绕行时修复缺陷而不是添加限制](fix-capability-gap-not-prompt-ban.md) — 查明模型只能绕行的原因（缺少能力、无法看到结果）并修复；不在提示词或工具说明中写禁令，用户否决过「电脑控制只用于 qywork 以外」
- [Rust 源码不按 rustfmt 排版](rust-sources-not-rustfmt-formatted.md) — 不运行 cargo fmt：文件参数不限定范围，整个包被改写并混入其他会话未提交的改动；含还原方法
- [浏览器控制的真实模型评测与真实外壳验证](browser-live-eval.md) — `.tmp/browser-live/harness.ts` 11 个场景对照改动前后；`.tmp/popup-window-verify/` 用独立数据目录的开发外壳验证 WebView2 行为
- [放弃一项须以事实为理由](review-drop-reasons.md) — 「改动大」「与事故无关」「账本没有实例」不是理由；大改写明规模交用户确认，不改写为取消
- [业务选择不设默认值](no-default-for-business-choices.md) — 网页确认框等由工具报告、模型判断；不向用户提出「默认确定还是取消」
- [上下文只由压缩改变](no-trimming-model-context.md) — 到阈值自动或用户手动压缩是唯一入口；在其外折叠旧工具结果是并列入口且前提错误；慢的问题从调用次数入手
- [浏览器点击无响应先比较落点坐标](browser-click-lands-on-ancestor.md) — 命中判定接受祖先元素，落在圆角外缘的点击仍判为成功；全零 `point` 已按元素中心处理
- [会话流触摸滑动须实测](touch-scroll-probe.md) — 修改底部跟随后用 .tmp/probe/touch-follow.mjs 与 touch-static.mjs 以真实触摸序列实测；synthesizeScrollGesture 在无头模式下不派发 touchmove
- [CI 运行环境没有 rg](ci-runner-has-no-rg.md) — 断言 ripgrep 引擎的用例须以 Bun.which 为前提；0.3.23 发布门禁因此在三个平台失败
- [按请求计算缓存差额](cache-lag-by-request.md) — 上一次总输入减本次命中；固定差额等于系统提示词大小时是上游把它放在对话之后，客户端调整位置无效
