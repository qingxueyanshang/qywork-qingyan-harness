---
name: linux-e2e-via-wsl
description: Mac/Linux 浏览器引擎与运行环境的改动在 WSL 中做 Linux 端到端：编译 Linux 外壳，Xvfb 下运行，从 Windows 经 localhost 转发驱动手机视口
metadata:
  type: reference
---

`apps/desktop/src-tauri/src/browser/chromium/` 只在 macOS 与 Linux 上编译，本机门禁覆盖不到。2026-11-25（0.3.27）在 WSL 中验证的做法：

- **代码进 WSL**：`git ls-files -co --exclude-standard -z | tar --null -T - -cf tree.tar` 打包工作区（含未提交改动），在 WSL 自己的
  检出目录（如 `~/qywork-claude-1124`）解开；`cargo build --target-dir .tmp/cargo-linux --bin qywork-dev` 增量约 8 秒。
- **运行**：Xvfb（`DISPLAY=:97`，清掉 `WAYLAND_DISPLAY`，独立的 `XDG_RUNTIME_DIR`），sidecar 以 `--credentials-stdin` 启动，外壳以
  `QYWORK_PORT`、`QYWORK_TOKEN`、`QYWORK_HOST_KEY`、`QYWORK_HOME` 连接它。进程号记入文件，结束时只按这些进程号结束（发行版共用）。
- **从 Windows 驱动**：WSL 中监听 127.0.0.1 的端口经 localhost 转发可从 Windows 访问（sidecar、Chromium 调试端口）；反方向不通，
  WSL 中的浏览器要访问的测试页须在 WSL 中提供。`.tmp/remote-probe/browser-probe.mjs` 的 `EXTERNAL_PORT`、`EXTERNAL_TOKEN`、`CDP_PORT`。
- **环境差异**：WSL 以 root 运行，Chromium 不加 `--no-sandbox` 拒绝启动；WSL 中没有 Chrome 与终端程序；WSL 的 Bun 是 1.3.14
  （发布用 1.4.2），`Bun.write(path, new Response(req.body))` 在 1.3 上不返回，个别按时间断言的用例在 1.3 上超时，不代表 CI 的结果。
- Mac 与 Linux 的引擎只在导航与加载时读取标题，断言脚本修改的标题要读 Chromium 调试端点的 `/json/list`。

相关：[[publish-release-via-api]]
