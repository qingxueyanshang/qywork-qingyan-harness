---
name: art-video-probe
description: Art 页面中视频的真实浏览器验证：.tmp/probe/art-video 以真实引导页与界面的 loadArtPage / connectArt 在无头 Edge 中截取
metadata:
  type: project
---

修改 Art 页面的运行时（`apps/web/src/components/canvas/art.ts` 的 `artRuntime`）、引导页（`server/src/art.ts` 的 `HOST_PAGE`）
或页面文件的载入方式后，用 `.tmp/probe/art-video/` 在真实 Chromium 中验证，组件测试（happy-dom）不解码视频、不运行沙箱 iframe。

- `serve.ts`：打包 `entry.ts`，以真实的 `serveArt` 提供引导页与库文件，`/api/files/raw` 读取 `ws/` 下的文件，`/render-html` 返回
  `prepareArtForRender` 的结果。端口为 0，启动后在日志中打印 `ready <端口>`。
- `entry.ts`：界面真实的 `loadArtPage` 与 `connectArt`，手动模式按页面时刻截取，实时模式播放后截取，并测录制 30 帧的耗时。
- `run.mjs` 与 `render.mjs` 由 node 运行（Playwright 只能由 Node 驱动），后者验证内部渲染路径。
- 测试视频每秒一色（红、绿、蓝），由 imageio_ffmpeg 自带的 ffmpeg 生成，截取的中心像素即可判断视频进度。

2026-11-26 实测：沙箱内 Blob 视频可以播放，手动模式的截取与页面时刻一致，录制每帧约 13 ms。
未在 macOS / Linux 的 WebKit 外壳中验证。见 [[probe-ui-with-isolated-instance]]。
