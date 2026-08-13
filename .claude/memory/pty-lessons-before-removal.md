# 终端（PTY）如果重做，这三条是踩出来的

`apps/desktop/src-tauri/src/pty.rs` 已于 2026-08-12 删除——它有 4 个注册好的
Tauri command 但**零调用方**，而应用自定义命令不受 `capabilities` 约束，
等于给 WebView 里任何脚本留了一条 `invoke('pty_open')` 拿可写 shell 的路。
协议侧的能力声明更早就删了（`packages/core/src/protocol/transport.ts` 里写着
「全项目就没有终端功能」），所以它是契约删掉之后剩下的孤儿实现。

代码在 git 里，不必默写。真正难复得的是下面三条：

1. **PTY 必须在 Rust 侧，不能放 Bun sidecar。**
   Bun v1.3.5 起内建 PTY，但**只支持 POSIX，Windows 没有 ConPTY 实现**，
   而 Windows 是本项目主开发平台。`portable-pty` 在三平台分别走 ConPTY / openpty，
   行为一致。

2. **spawn 之后必须立刻丢掉 slave 端，只留 master。**
   留着 slave，子进程退出时 master 的读端收不到 EOF，**读线程永远挂着**。
   所以别存整个 `PtyPair`。

3. **读出来的字节只能 `from_utf8_lossy`，不能严格解码。**
   PTY 字节流会在多字节字符中间被切开，严格解码在中文输出上随机报错。

另有一条当时就写错的：`default_shell()` 注释说「PowerShell 优先，没有就退回 cmd」，
实现是 `env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe")`——Windows 上
COMSPEC 永远存在且指向 cmd.exe，优先级是反的。重做时别照抄。

重做时记得：能力边界要按 B5 走——手机端够不着 Tauri 进程，**握手声明 false、
界面不显示入口**，而不是显示一个点了报错的按钮。
