# MCP：接入外部工具

qywork 是 MCP **客户端**：把别人写的 MCP server 提供的工具接进来给模型用。
配置在工作区的 `.qy/mcp.json`。

```bash
qy mcp            # 看每个 server 连没连上
qy mcp --tools    # 连带列出它们提供哪些工具
```

`qy mcp` 在有 server 连不上时退非零，可以直接当 CI 里的一条检查。

---

## 配置

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    },
    "暂时停用的": {
      "command": "npx",
      "args": ["-y", "some-server"],
      "enabled": false
    }
  }
}
```

`servers` 和 `mcpServers` 两个键名都认——后者是别的 MCP 客户端普遍用的写法，
配置多半是从那边整段复制过来的，为一个键名让人重打一遍不值得。

**不透传宿主环境变量。** server 拿不到你的 `ANTHROPIC_API_KEY`——它需要什么凭证，
就在 `env` 里显式给。这样「这个 server 能拿到什么」是写在配置里、看得见的。

---

## 两种传输

按有没有 `url` 判断，不需要额外写 `transport`。

| | 本地进程（stdio） | 远端（streamable HTTP） |
|---|---|---|
| 判据 | 有 `command` | 有 `url` |
| 字段 | `command`（必填）、`args`、`env`、`cwd`、`enabled` | `url`（必填）、`headers`、`enabled` |

```json
{
  "mcpServers": {
    "远端的": {
      "url": "https://example.com/mcp",
      "headers": { "authorization": "Bearer ..." }
    }
  }
}
```

`url` 只接受 `http` / `https`。**`command` 和 `url` 同时写会被拒绝并报出来**——
那是歧义不是二选一，替你挑一个的话，你改了没被采用的那个字段，
然后会对着一个毫无变化的现象查半天。

远端 server**不在你的机器上**，所以失败的种类和本地完全不同。
错误信息按这个区分，因为下一步动作不一样：

| 现象 | 说明 | 你该做什么 |
|---|---|---|
| HTTP 401 / 403 | 鉴权被拒 | 检查 `headers` |
| HTTP 404，还没建立会话 | 端点不存在 | 检查 `url` |
| HTTP 404，已有会话 | 会话被服务端丢了（重启 / 过期） | 重连即可，配置没问题 |
| HTTP 5xx | 对面内部错误 | 等，或者找 server 的人 |
| 连接被拒绝 / 域名解析失败 | 根本没连上 | 查地址、网络、代理 |
| 响应流中途结束 | 连接被掐断 | 查反代超时设置 |

会话 id（`Mcp-Session-Id`）由 server 在握手时下发，之后每条请求自动带上；
关闭时会发一个 `DELETE` 结束会话。这些都不需要你配。

---

## 权限

MCP 工具注册名是 `mcp__<server>__<tool>`，权限 scope 是
`execute:mcp:<server>/<tool>`。

注册名会被消毒成 `^[a-zA-Z0-9_-]+$`：server 名来自你的配置、工具名来自第三方 server，
两者都可能带 `.` `:` `/`，而 provider 会直接 400 拒掉整个请求。所以配置里写
`"my.server"` 的话，工具是 `mcp__my_server__xxx`——但 `autoApprove` 匹配的是
**权限 scope**（`execute:mcp:my.server/`），那里用的是原名。

**默认每次调用都问。** 想少弹窗，在 `~/.qywork/config.json` 的 `autoApprove` 里
加前缀：

```json
{ "autoApprove": ["read:", "execute:mcp:filesystem/"] }
```

### 为什么不看 `readOnlyHint`

MCP 的工具定义里有 `annotations.readOnlyHint`，看起来正好能拿来决定要不要弹授权。
**这里刻意不用它放宽权限**，因为那个字段是 server 自己填的，而 server 是第三方代码——
一个恶意（或只是写错了）的 server 声明 `readOnlyHint: true` 的工具照样可以删库。
拿它决定要不要过闸，等于让被审查者自己签发通行证。MCP 规范自己也写明客户端
不得据此做安全决策。

规则是单向的：

- `destructiveHint: true` 会让权限**更严**（走 delete 闸）；
- 任何 hint 都**不能**让权限更松。

放宽只能来自 `autoApprove`——那是**你的**判断，写在你自己的配置文件里。

---

## 会踩到的几件事

**结果里的图片只留一行占位。** base64 进上下文能瞬间吃掉几万 token，而模型多半
用不上。文本内容原样传，未知的内容块类型留 `[类型名]` 占位而不是丢掉。

**`isError` 是工具失败，不是调用失败。** MCP 把工具自己的错误放在结果里而不是
JSON-RPC error 里，就是为了让模型看得见失败详情并自己改参数重试。qywork 原样传下去，
只把状态标成 failure。

**MCP 工具不并行。** 外部进程对并发的处理我们一无所知，并行的收益远小于
「两个调用互相踩」的排查成本。

**传输层失败时 `executed` 取 true。** 超时或进程退出的情况下，副作用到底发没发生
是判定不了的，崩溃恢复和重试都依赖这个字段，只能往保守的方向报。

**server 连不上不影响会话启动。** 失败逐条记录，`qy mcp` 和桌面端都能看到原因。
Windows 上 `npx` 之类是 `.cmd`，走 shell 启动——「命令不存在」不会触发 error 事件，
而是 cmd 退出码 1 加一行 stderr，所以失败原因里会带上最近几行 stderr。

**工具名撞了不覆盖。** 插件工具先到先得，MCP 撞名的那个被丢弃并记 failure——
静默覆盖会让「装了但没生效」变成无法排查的现象。

---

## resources：两个工具，一个字节不进上下文

server 声明了 `capabilities.resources` 时，自动多出两个工具：

| 工具 | 干什么 |
|---|---|
| `mcp__<server>__list_resources` | 列出 uri、名称、类型。**不返回正文** |
| `mcp__<server>__fetch_resource` | 按 uri 读一个 resource 的正文 |

**不把 resource 注入上下文**是刻意的。全量注入的话，一个暴露整个知识库的 server
能瞬间吃掉整个窗口，而且它会进冻结前缀——于是每一轮都在为一份可能一次都用不上的
数据付钱，而 resource 列表随时会变，一变缓存全失效。

按需读的代价是模型多一次工具调用，收益是**上下文占用与 resource 数量无关**。

`fetch_resource` 与内置的 `read_resource` **不是一回事**：后者读的是 qywork
自己落盘的中间产物（命令输出、大文件被截断的部分）。

二进制 resource 只给一行占位，不内联 base64。

---

## 握手声明的能力会被显示出来

```bash
qy mcp
```

server 声明了、而 qywork 没接的能力（目前是 `prompts` 和 `logging` 之类）
会明确列出来。**这一条是为了消灭一种静默失败**：一个只提供 `prompts` 的 server
会连上、握手成功、注册 0 个工具、不报任何错——用户看到「配了但什么都没发生」，
而日志干干净净。

同理，握手成功但一个工具都没注册出来，会作为 failure 报出来并说明 server
声明了什么。

---

## 目前不做的

- **SSE / streamable HTTP 传输。** 本地工具用 stdio 就够；远程 server 涉及鉴权、
  重连、会话恢复，是另一件事。
- **把 qywork 暴露成 MCP server。** 反方向，与本文无关。
- **`prompts/*`。** 它是给「用户从菜单里挑一条提示词」用的，而我们没有那个交互位——
  `qy exec` 根本没有人在场。硬接的话只能由模型自己挑，那与它直接读 resource
  没有区别，却多一套协议。
- **`notifications/tools/list_changed`。** 收到会记日志，但不会重扫工具表——
  重扫意味着会话中途工具集变化，而冻结前缀里的工具 schema 一变整个缓存就失效。
