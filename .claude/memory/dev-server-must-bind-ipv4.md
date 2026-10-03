---
name: dev-server-must-bind-ipv4
description: 本机上 dev server 不显式绑定 127.0.0.1 时只监听 ::1，Tauri/PowerShell 探测 localhost 使用 IPv4，因而无法连接
metadata: 
  node_type: memory
  type: project
  originSessionId: 05999b74-ea23-4dc4-ad35-72313e189798
  modified: 2026-08-11T03:41:01.498Z
---

Windows 上 `localhost` 的解析结果与 dev server 的默认监听地址不一致：

- vite 不写 `host` 时只监听 `::1`（IPv6）
- Tauri CLI 探测 `devUrl` 里的 `localhost`、PowerShell 的 `Invoke-WebRequest`
  都使用 IPv4

结果是 `tauri dev` 停滞满 180 秒后报
「Could not connect to http://localhost:5180/」。**现象类似编译慢或端口占用，
实际原因是两端不在同一个协议栈上。**

固定做法（`apps/web/vite.config.ts` 已按此配置）：

```ts
server: { port: 5180, host: '127.0.0.1', strictPort: true, ... }
```

`strictPort` 同样重要：不设置时，端口被占用后 vite 会顺延到 5181，而 `devUrl`
仍指向 5180，报出**完全相同**的错误信息，排查方向会被误导。
排查这类现象时先确认占用该端口的进程。
