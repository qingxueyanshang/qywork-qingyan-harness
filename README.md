# qywork

本地编码 agent。一个 Bun 单文件二进制是全部内核，桌面端（Tauri 2）和手机端都只是
它的前端，走同一套 WebSocket 协议。

```
Tauri(Rust) ──spawn──> qy serve ──┬── http://127.0.0.1:<port>
     └── WebView ─────────────────┤   ws://.../stream
 手机浏览器 ─── 局域网扫码 ────────┘
```

无账号、无云同步、无遥测。配置是本机一个 JSON 文件，模型走你自己的 API Key。

---

## 快速开始

需要 [Bun](https://bun.sh) 1.3+。

```bash
bun install
bun run scripts/sync-version.ts --check   # 可选：确认版本号一致
bun test                                   # 全量回归
```

配置一个模型（第一次用先跑这个）：

```bash
bun run packages/cli/src/index.ts init
```

它会问你用哪家（Anthropic / DeepSeek / OpenAI 兼容 / 本机 ollama）、模型 ID 和
API Key，然后把 `~/.qywork/config.json` 写出来。非交互环境（CI、Docker build）下
它不会卡住，而是把模板打到 stdout。

跑一次：

```bash
bun run packages/cli/src/index.ts exec "读一下 src/，说说这个项目在做什么"
```

### 编译成单文件二进制

```bash
bun run build:agent      # → apps/desktop/src-tauri/bin/qy-<target>.exe，约 95 MB
```

二进制自带 Bun 运行时，装了就能跑，不需要目标机器上有 Node 或 Bun。

**例外是插件**：插件跑在独立进程里，需要 PATH 上有 node 或 bun——单文件二进制
自己不能当 JS 运行时。装 node 20+ 还能让插件跑在强制隔离里。

### 桌面端

```bash
bun run build:web        # 前端产物
bun run build:agent      # sidecar
bun run tauri:build      # 安装包
```

---

## 命令

```
qy                      交互式（多轮，同一个会话；非 TTY 下打印用法）
qy init                 生成配置（--force 覆盖）
qy exec "<任务>"        执行一次任务
  --cwd <路径>          工作区，默认当前目录
  --json                输出 JSONL 事件流，供 CI 消费
qy serve                本地服务，桌面端与手机端都连它
  --port / --host / --cwd / --static
  --print-token         把令牌打到 stdout（供 Tauri 读取）
  --parent-pid <pid>    父进程退出时一并退出
qy doctor               一屏体检：配置、shell 沙箱、账本、MCP、插件
  --json                给脚本用（只有阻断项才退非零）
qy mcp                  检查 mcp.json 里的 server 连没连上
  --tools               连带列出每个 server 提供的工具
qy plugins              检查装了哪些插件、隔离到什么程度
  --tools               连带列出每个插件提供的工具与启动日志
qy usage                本机用量账本（账目不随会话删除而消失）
  --days <n> --by model|day|workspace|kind --json
qy export [<会话 id>]   导出会话（markdown 给人读 / --json 完整）
qy probe [<模型名>]     实测端点支持什么（--save 写回配置）
qy config               显示当前配置与配置文件路径
```

`qy exec --json` 的每一行是一个事件对象，类型定义在 `packages/core/src/protocol/`。
这是给 CI 消费的稳定接口。

---

## 配置

`~/.qywork/config.json`（可用 `QYWORK_HOME` 改位置）：

```json
{
  "active": { "provider": "deepseek", "model": "deepseek-v4-flash" },
  "providers": {
    "deepseek": {
      "kind": "openai_compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": {
        "deepseek-v4-flash": {},
        "deepseek-v4-pro": { "maxOutputTokens": 8192 }
      }
    },
    "anthropic": {
      "kind": "anthropic",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "models": { "claude-opus-5": {} }
    }
  },
  "effort": "high",
  "mode": "auto"
}
```

- **凭证挂在接口上，模型挂在接口下面。** 同一家的几个模型共用一把 key、一个端点，
  改一次端点只改一处。
- `active` 是**两段**（接口 + 模型），不是一个拼接串——模型 id 本身可能含斜杠
  （`anthropic/claude-3`），拼起来就拆不回去。
- `kind` 决定用哪套协议，**不按模型名猜厂商**——经中转站以 OpenAI 协议调 Claude
  是常见配置，按名字猜会路由到错误的协议上。
- `apiKeyEnv` 优先于同接口的 `apiKey`。明文 key 不该躺在配置文件里。
- `baseUrl` 指向本机回环（`127.0.0.1` / `localhost`）时允许不配 key，
  给 ollama / LM Studio / vLLM 用。
- `models` 里每一格可以放 `maxOutputTokens` 和 `capabilities`（`qy probe --save`
  或设置页的「校准思考」写进去的实测结论）。**它按「接口 × 模型」分格**：
  同一个模型经不同中转站走的协议可能不同，能力也就不同。
- `mode` 是权限模式，`auto`（默认）或 `full`。**老配置里的 `autoApprove` 已经失效**，
  它不会被自动映射成 `full`（那等于在你没表态时把防线拆掉），启动时会提示一次。
- **旧的扁平 `profiles` 不再加载**，也不自动迁移：一条旧档案要拆成「接口 + 模型」，
  而两条同协议同端点的档案该并成一个接口还是两个只能猜。模型那部分回到默认值，
  启动时点名提示，key 需要重填一次（旧的明文还在文件里，可以复制）。

还有几个可选项，都在 [`docs/permissions.md`](docs/permissions.md) 里：
`additionalDirectories`（放开工作区之外的目录）、`sandboxNetwork`（断掉 shell 出网）、
`envAllowList`（放行某个环境变量）。

### 命令跑哪个 shell

`run_command` **一律跑 bash**，没有第二种 shell：Windows 上用 Git for Windows 自带的
`bash.exe`（只认 Git 的安装目录，不查 PATH——那上面第一条常是 WSL 启动器，命令会进另一个
文件系统跑），其余平台按 `/opt/homebrew/bin/bash` → `/usr/local/bin/bash` → `/bin/bash`
→ `/usr/bin/bash` 找。**找不到就启动报错**，不降级成别的 shell。

bash 装在非常规位置（scoop / MSYS2 / Cygwin / 自定义盘符）时，用 `QYWORK_BASH_PATH`
指向那个可执行文件：

```bash
QYWORK_BASH_PATH=D:\msys64\usr\bin\bash.exe qy serve
```

它优先于上面所有位置。**指了但那个位置没有文件会直接报错**，不会退回自动搜索。

没有 bash 时服务照常起得来，只是**模型手里没有 `run_command` 这个工具**；
设置页「系统 · 位置」那一格会说明原因，Windows 上还带一个按钮，
点了会开一个终端窗口跑 `winget install --id Git.Git`。**装完要重启 qywork**
——当前进程的 `PATH` 是启动时的快照，看不到新装的 git。

---

## 能力

**工具**：`read_file` `write_file` `edit_file` `list_dir` `glob` `grep`
`run_command` `read_resource` `update_plan` `web_fetch` `web_search`
`memory` `list_skills` `read_skill`

**权限**只有两种模式，没有逐次审批弹窗：`auto`（默认，**只有一张静态拒绝清单**——
没有允许清单，也没有分类器）和 `full`（全放行）。`auto` 拦的是「不可逆且越出工作区」
那三类：越界写删、改系统状态、碰凭证文件；判不出属于这三类就放行。被拒不是弹窗，
是把理由作为工具失败交回给模型让它换做法。
凭证不进子进程、输出里的凭证明文屏蔽、文件工具的路径锁在工作区内——这三条 `full` 也生效。

裁决那三层全是**文本判断**，挡不住一条没想到的写法。真正的边界在内核层：
Linux / **WSL2** 用 bubblewrap，**macOS** 用 seatbelt——工作区外只读、
凭证目录读不到、网络默认不限（`sandboxNetwork: "deny"` 可整个断掉）。
**原生 Windows 目前没有**。`qy config` 会如实报出来，不合并成一个「有沙箱」，
而且报的是**实测结果**：启动时真跑一次空命令，跑不起来就降级并说明原因
（`bwrap` 在 PATH 里但内核禁掉了无特权命名空间，是常见的一种）。
要让 agent 碰工作区之外，用 `additionalDirectories` 显式列出目录——
它同时接进路径解析、静态规则和沙箱 bind 清单三层。
见 [`docs/permissions.md`](docs/permissions.md)。

**上下文管理**是拒绝驱动的：不按本地估算的阈值压缩，而是等 provider 亲口说超了
（由容量分类器证实）再压、再重发。压缩是**投影不是销毁**——原始消息一条不少地留在
库里，被压掉的那段只是在发给模型时换成摘要。

**技能与记忆**只把索引放进上下文，正文由模型按需拉取。两者都在尾区而不是冻结前缀里：
装一个技能就让整个 provider 缓存失效的代价，远大于它省下的那点 token。
技能、记忆、MCP、插件都有**三层**：内置（随程序发布，只读）> 用户级（工作区
`.agents/`，别的 CLI 也读得到）> 全局（`~/.qywork/`），同名先认领的赢。
逐条开关在对话右侧面板里，**只影响当前那一条会话**。

**插件**跑在独立子进程里，走 stdio 上的行分隔 JSON-RPC，不继承宿主的
`process.env`，宿主能力按权限清单闸门（fail-closed）。强制隔离分**两个维度、
分开上报**：node 20+ 给沙箱（只声明 `workspace:read` 的插件读不到主目录、
写不了盘、起不了子进程），node 22.15+ 再给出网闸（拆掉进程内的直接出网通道，
出网只剩过 SSRF 校验的 `host.net.fetch`）。
两条已知边界：拿到 `process:exec` 就等于放开网络（能起子进程就能跑 curl，
所以那种情况如实报「出网闸 无」），以及这是**进程内的拆除不是内核边界**。
`qy plugins` 可以直接看当前是哪种。见 [`docs/plugins.md`](docs/plugins.md)。

**MCP** 客户端：接外部 MCP server 的工具，本地 stdio 与远端 streamable HTTP 都支持，
`qy mcp` 查连通性。server 声明的 `readOnlyHint` 不会用来放宽权限——
见 [`docs/mcp.md`](docs/mcp.md)。

**Agent Team** 多角色编排，后端可以是本进程的 agent 或外挂的 codex / claude CLI，
见 [`docs/team.md`](docs/team.md)。

**用量账本**独立于会话：删会话不掉账，`qy usage` 能答「这个月花了多少」「哪个模型最贵」。
压缩用的那次摘要调用也记账——在账本出现之前那笔钱完全看不见。

**冻结前缀审计**：前缀漂移会让整段提示缓存按全价重算，而这件事**完全静默**。
现在有静态扫描（日期、绝对路径、uuid 不许进前缀）加运行时哈希比对，变了就指出第几段。

**能力探测**：`qy probe` 用几个极小的请求实测端点支持什么。探不出来的一律标
「未探测」而不是「不支持」——把没验过的写成结论，比不写更糟。

**会话导出**：`qy export`。markdown 给人读（失败的工具展开带正文），
json 给脚本读（完全不裁剪）。两种格式的取舍相反，所以不合并成一种。

**交互模式**：`qy` 不带参数进多轮循环，跨轮复用同一个会话（模型看得到上一轮，
缓存也能命中）。跑的时候 Ctrl-C 只中断这一轮。

**供应商**：Anthropic、OpenAI 兼容（DeepSeek / Kimi / 中转站 / ollama）、
OpenAI Responses 三套协议。

**联网**过 SSRF 闸：每一跳重定向都重新校验，按解析后的 IP 分类，展开
IPv4-mapped IPv6，跨源跳转丢弃 `authorization`。

细节和取舍见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，未落地项见 [`ROADMAP.md`](ROADMAP.md)。

---

## 仓库结构

```
docs/
  plugins.md  写一个插件：清单、RPC 协议、宿主能力与权限边界
  mcp.md      接外部 MCP server：配置、权限、限制
  team.md     多角色编排：后端、角色、计划、规则
  permissions.md 权限两模式、裁决三层、已知边界
packages/
  core      协议类型与事件定义（无运行时依赖）
  ai        provider 适配器、模型目录、错误与容量分类
  agent     agent 循环、工具注册表、权限闸
  tools     内置工具
  store     SQLite 账本 + 内容寻址正文库
  runtime   配置、会话装配、提示词分层、压缩
  server    HTTP + WebSocket、配对、断线补发
  plugins   插件子进程隔离
  mcp       MCP 客户端（stdio / streamable HTTP）
  team      多 agent 编排
  cli       qy 本体
apps/
  web       Solid + Vite 前端
  desktop   Tauri 2 外壳
scripts/    构建、冒烟、保真度测试
```

---

## 测试

```bash
bun test                                  # 单元测试
bun run typecheck                         # 全仓库类型检查
bun run scripts/smoke-serve.ts            # 端到端：起服务、跑真实一轮、断线补发、崩溃恢复
bun run scripts/smoke-responses.ts        # Responses 协议对着真实端点：思考回传、工具两轮、缓存口径
bun run scripts/compaction-fidelity.ts    # 压缩保真度：压完之后模型还记不记得关键事实
```

后三个会真的调用模型，需要配好 key。没有 key 时 `smoke-responses.ts` 明确跳过并说出来，
不静默通过——一个永远绿的冒烟比没有冒烟更危险。

`smoke-serve.ts` 历史上**不是稳定绿的**：实测 5 次里有 2 次在「跑一轮真实 agent」
那段失败。失败时看 `本轮没有 provider 错误` 这一条给出的错误码，以及 stderr 上
`容量拒绝触发压缩` 那行。

2026-08 修掉了一个可能相关的原因（Bun 的传输层错误此前全部被判成不可重试，
一次网络抖动就终结整轮 run），之后连跑三次全绿。但**三次不构成证据**——
按旧频率，连中三绿本来就有约 22% 的概率。详见 ROADMAP §18.1 与 §21-3，
没查清的事不写成结论。

`compaction-fidelity.ts` 值得单独说：它在一段 40 轮对话里埋 5 条可验证的事实，压缩后
再问模型，看它还答不答得上来。上一版压缩曾在 17 个单测全绿的情况下把上下文压到了
原来的 213%——单测能测「触发了压缩」，测不出「压缩之后模型还记不记得」。

---

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
