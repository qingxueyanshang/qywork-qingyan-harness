---
name: dev-server-must-bind-ipv4
description: 这台机器上 dev server 不显式绑 127.0.0.1 就只听 ::1，Tauri/PowerShell 探测 localhost 走 IPv4 会连不上
metadata: 
  node_type: memory
  type: project
  originSessionId: 05999b74-ea23-4dc4-ad35-72313e189798
  modified: 2026-08-11T03:41:01.498Z
---

Windows 上 `localhost` 的解析结果与 dev server 的默认监听地址对不上：

- vite 不写 `host` 时只监听 `::1`（IPv6）
- Tauri CLI 探测 `devUrl` 里的 `localhost`、PowerShell 的 `Invoke-WebRequest`
  都走 IPv4

结果是 `tauri dev` 卡满 180 秒后报
「Could not connect to http://localhost:5180/」——**看起来像编译慢或端口占用，
其实是两边根本没在同一个协议栈上碰面。**

固定做法（`apps/web/vite.config.ts` 已经这么写了）：

```ts
server: { port: 5180, host: '127.0.0.1', strictPort: true, ... }
```

`strictPort` 同样重要：不写的话端口被占时 vite 会顺延到 5181，而 `devUrl`
还指着 5180，报出**一模一样**的错误信息，排查方向会被带偏。
排查这类现象时先确认端口上趴的是谁。
