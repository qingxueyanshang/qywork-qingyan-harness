# 写一个 qywork 插件

插件放在工作区的 `.qy/plugins/<任意目录名>/`，至少要有一个 `qywork.plugin.json`。
加载顺序按目录名字典序——插件之间存在先到先得的资源（工具名、预览器扩展名归属），
随机顺序会让同一份安装在不同机器上表现不同。

---

## 先说清边界

插件在**独立子进程**里跑，宿主这边只有一条 stdio 上的 RPC 通道。这道边界**实测**
挡住的是：

- 宿主的环境变量。插件进程只拿到 `PATH` 和几个必需项，看不到你的 API Key。
- 宿主的进程内对象。工具注册表、正文库句柄、权限回调都在另一个进程里。
- 崩溃与卡死。插件段错误不会带走宿主，调用超时只拒绝那一次调用。
- 越权使用宿主能力。每次 `host.*` 调用都按清单声明的权限校验。

### 强制隔离：两个维度，分开看

宿主报的不是一个「有没有沙箱」，是**两个独立的开关**——它们的成立条件不同，
合成一个的话「有沙箱」这句话在不同机器上就不是一个意思了。

| 维度 | 靠什么 | 需要 |
|---|---|---|
| **沙箱** | Node 权限模型（`--permission` / 20~22 上是 `--experimental-permission`） | node 20+ |
| **出网闸** | 拆掉插件进程里的直接出网通道 | node 22.15 / 23.5+ |

只声明 `workspace:read` 的插件，实测：

| 插件想做的事 | 结果 |
|---|---|
| 读工作区 | 允许（递归） |
| 读用户主目录 | **拒绝** |
| 写任何位置 | **拒绝**（需 `workspace:write`） |
| 起子进程 | **拒绝**（需 `process:exec`） |
| `import 'node:net'` / `http` / `tls` / `dgram` / `dns` | **拒绝**（出网闸） |
| `fetch` / `WebSocket` / `EventSource` | **拒绝**（出网闸） |

出网只剩一条路：`host.net.fetch`。它过 SSRF 校验和权限闸。
**声明了 `network` 权限也一样**——那个权限的含义是「可以通过 `host.net.fetch` 出网」，
不是「可以自己连」。前者过审计，后者什么都不过。

#### 出网闸不是什么

三条一起看：

1. **拿了 `process:exec` 就等于放开了网络。** 能起子进程就能跑 `curl`。
   这不是漏洞是定义。所以这种情况下宿主**如实报「出网闸 无」**，哪怕闸确实注入了。
2. **这是进程内的拆除，不是内核边界。** 准确的说法是
   「把顺手联网变成了必须刻意绕」，不是「插件绝对上不了网」。
3. **代价**：挡住 `node:module` 是必需的（否则插件能注册一个钩子把上表全部放行），
   所以插件用不了 `createRequire`。

`--allow-worker` 和 `--allow-addons` 任何权限都换不来——两者都能绕开权限模型本身。

**只有 bun 时两样都没有。** bun 既没有权限模型也没有出网闸所需的
`module.registerHooks`。这种情况下权限清单退回成**知情同意**：
它让你在安装前知道插件打算干什么，而不是拦住它干别的。

启动日志形如：

```
[com.example.tool] 运行时 /usr/bin/node（沙箱 有 · 出网闸 有）：文件系统与子进程已强制隔离；直接出网通道已拆除，出网只能走 host.net.fetch
[exec.plugin]     运行时 /usr/bin/node（沙箱 有 · 出网闸 无）：文件系统与子进程已强制隔离；出网闸已注入，但插件持有 process:exec —— 起个子进程就能出网，不视为已拦截
[other.plugin]    运行时 /usr/bin/bun（沙箱 无 · 出网闸 无）：bun 既没有权限模型也没有出网闸所需的 module.registerHooks；装一个 node 22.15+ 两样都能有
```

### 自查：`qy plugins`

```bash
qy plugins            # 装上了哪些、隔离到什么程度、哪些没装上及原因
qy plugins --tools    # 连带列出每个插件提供的工具，以及启动日志
```

```
✓ netprobe 出网探针 1.0.0 · 1 个工具 · 权限 network
    沙箱 有 · 出网闸 有 C:\Program Files
odejs
ode.exe
    文件系统与子进程已强制隔离；直接出网通道已拆除，出网只能走 host.net.fetch
✗ .qy/plugins/broken  清单缺少必填字段：main
```

有插件装不上时退非零，可以直接当 CI 里的一条检查（与 `qy mcp` 一致）。

**这条命令是隔离状态唯一的用户可见出口。** 在它之前，`sandboxed` / `netGuarded`
只出现在一行 stderr 里，而桌面外壳会把那些输出吞掉——用户装完插件之后
根本没法回答「它被关住了吗」。

### 需要 node 或 bun 在 PATH 上

插件跑在独立进程里，而 qywork 的发布产物是 Bun 编译的单文件二进制——
**它自己不能当 JS 运行时**。找不到 node 也找不到 bun 时插件会加载失败并说明原因，
不会拿一个不会执行 JS 的可执行文件去试。

---

## 清单

```json
{
  "manifestVersion": 1,
  "id": "com.example.mytool",
  "name": "我的工具",
  "version": "1.0.0",
  "description": "一句话说明它干什么",
  "main": "index.mjs",
  "permissions": ["workspace:read", "storage"],
  "contributes": {
    "tools": [
      {
        "name": "count_lines",
        "description": "统计一个文件有多少行",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"],
          "additionalProperties": false
        },
        "actionKind": "read",
        "objectLabel": "文件",
        "permissionEffect": "read"
      }
    ]
  }
}
```

- `id` 必须是 3~64 位小写字母、数字、点、横线或下划线。它同时是工具的命名空间前缀。
  **注册名会被消毒**：provider 只接受 `^[a-zA-Z0-9_-]+$`，所以点会换成下划线——
  上面这个工具的实际注册名是 `com_example_mytool__count_lines`。
  不消毒的话，装一个带点 id 的插件会让**之后每一轮 run 都被 400 打死**，
  而错误信息只说「tools[0].function.name 无效」，不说是谁干的。
  消毒可能制造碰撞（`a.b` 与 `a_b` 同名），撞了的那个会被丢弃并记进 failures。
- `permissions` 必须覆盖你所有工具的 `permissionEffect`——声明 `read` 的工具而清单里
  没有 `workspace:read`，加载期直接拒绝。用户在安装提示里看到的权限清单必须和插件
  实际能做的事自洽。
- 只贡献预览器且 `renders` 不是 `custom` 的插件不需要 `main`，也不会起进程。

`contributes` 还支持 `previewers`（按渲染族接管扩展名）、`roles`（给 Agent Team 加角色）、
`providers`（加模型供应商）。字段定义见 `packages/plugins/src/manifest.ts`。

---

## 协议

stdin/stdout 上的行分隔 JSON，每行一个对象。**stdout 只能走协议帧**——
调试打印用 `console.error`（stderr 会被宿主转发到日志）。解析不出来的行会被当作
日志忽略，不会报协议错误，所以一句手滑的 `console.log` 不会把通道搞崩，但也不会被处理。

启动后必须先发 `ready`，10 秒内不发就算启动失败：

```json
{"type":"ready"}
```

宿主调你的工具：

```json
{"type":"call","id":"<uuid>","method":"count_lines","params":{"path":"a.txt"}}
```

你回：

```json
{"id":"<uuid>","ok":true,"result":{"status":"success","message":"共 42 行","data":{"lines":42}}}
```

`result` 会被归一化成工具结果：`status` 不是 `"success"` 一律当失败；
`message` 缺失时补默认值；返回非对象直接判失败。第三方代码返回什么形状都有可能，
这个收敛必须在信任边界上做。

你调宿主能力：

```json
{"type":"host","id":"<uuid>","method":"fs.read","params":{"path":"a.txt"}}
```

宿主回：

```json
{"type":"host.result","id":"<uuid>","ok":true,"result":{"content":"...","encoding":"utf8"}}
```

单次工具调用超时 60 秒，超时只拒绝这一次调用，**不杀进程**——可能只是这次慢。

---

## 宿主能力

| 方法 | 需要权限 | 参数 | 返回 |
|---|---|---|---|
| `fs.read` | `workspace:read` | `path`, `encoding?`（`utf8`/`base64`） | `{content, encoding}` |
| `fs.list` | `workspace:read` | `path` | `{entries:[{name,kind}], truncated, total?}` |
| `fs.stat` | `workspace:read` | `path` | `{kind, size, mtimeMs}` |
| `fs.write` | `workspace:write` | `path`, `content`, `append?` | `{path, bytes}` |
| `fs.delete` | `workspace:write` | `path` | `{deleted}` |
| `net.fetch` | `network` | `url`, `method?`, `headers?`, `body?` | `{status, url, contentType, body, redirects}` |
| `exec.run` | `process:exec` | `command`, `cwd?`, `timeoutMs?` | `{exitCode, stdout, stderr, timedOut}` |
| `storage.get` / `set` / `delete` / `list` | `storage` | `key`, `value?` | 见实现 |

几条会咬人的限制：

- **所有 `path` 都锁在工作区内。** 声明了 `workspace:read` 不等于能读 `../../.ssh/id_rsa`；
  `..`、绝对路径、双重 URL 编码、符号链接逃逸都会被拒。
- **`fs.delete` 不删目录。** 误删一个文件和误删一棵目录树，后果差着数量级。
- **`net.fetch` 过 SSRF 闸。** 内网地址、云元数据端点（`169.254.169.254`）、
  非 http(s) 协议一律拒绝；每一跳重定向重新校验；跨源跳转会丢掉 `authorization`。
- **`exec.run` 不透传宿主环境变量。** 宿主费劲把你的进程环境洗干净了，
  从这里再漏出去就等于没洗。
- 配额：`fs.read` 4 MB、`fs.write` 8 MB、`exec` 输出 512 KB（读到上限就停，
  不是读完再截断）、私有存储 2 MB。

未登记的方法一律拒绝，而不是放行——忘了登记的后果是「新能力用不了」，
不是「新能力对所有插件无条件开放」。

私有存储落成 `.qy/plugin-data/<插件 id>.json`。不放 SQLite 是因为插件行为异常时
「用户能直接打开看、直接删」比性能重要得多。

---

## 一个能跑的最小例子

`.qy/plugins/lines/qywork.plugin.json`：

```json
{
  "manifestVersion": 1,
  "id": "demo.lines",
  "name": "行数统计",
  "version": "1.0.0",
  "description": "统计文件行数",
  "main": "index.mjs",
  "permissions": ["workspace:read"],
  "contributes": {
    "tools": [{
      "name": "count",
      "description": "统计一个文件有多少行",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] },
      "actionKind": "read",
      "objectLabel": "文件",
      "permissionEffect": "read"
    }]
  }
}
```

注册名是 `demo_lines__count`（`demo.lines` 里的点被消毒成了下划线）。

`.qy/plugins/lines/index.mjs`：

```js
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const waiting = new Map()

const host = (method, params) => {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    send({ type: 'host', id, method, params })
  })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }

    if (msg.type === 'host.result') {
      const w = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (w) msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error?.message))
    } else if (msg.type === 'call') {
      void handle(msg)
    }
  }
})

async function handle(msg) {
  try {
    const { content } = await host('fs.read', { path: msg.params.path })
    const lines = content.split('\n').length
    send({ id: msg.id, ok: true, result: { status: 'success', message: `共 ${lines} 行`, data: { lines } } })
  } catch (err) {
    send({ id: msg.id, ok: true, result: { status: 'failure', message: err.message } })
  }
}

send({ type: 'ready' })
```

加载失败不会让会话起不来，原因会打到 stderr 并出现在扩展清单的 `failures` 里——
静默跳过会让「装了插件但没生效」变成无法排查的现象。
