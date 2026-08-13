/**
 * `qy mcp` —— 看一眼工作区里的 MCP server 到底连没连上。
 *
 * 没有这条命令的话，「配了但工具没出现」只能靠翻 `qy serve` 的日志排查，
 * 而那些日志混在启动输出里、还会被桌面外壳吞掉。MCP 的失败又特别常见：
 * 命令没装、包名写错、要的凭证没给——每一种的处置办法都不同，
 * 所以要**逐条把原因打出来**，而不是只说「有 2 个 server 连不上」。
 */

import { resolve } from 'node:path'
import { loadWorkspaceMcp, toolNamePrefix } from '@qywork/runtime'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'

export async function runMcp(args: string[]): Promise<number> {
  const cwdFlag = args.indexOf('--cwd')
  const workspaceRoot = resolve(cwdFlag >= 0 ? (args[cwdFlag + 1] ?? '.') : '.')
  const verbose = args.includes('--tools')

  process.stderr.write(`工作区：${workspaceRoot}\n配置：.qy/mcp.json\n\n`)

  const reg = await loadWorkspaceMcp(workspaceRoot, (line) => {
    if (verbose) process.stderr.write(`${DIM}${line}${RESET}\n`)
  })

  try {
    if (reg.servers.length === 0 && reg.failures.length === 0) {
      process.stderr.write(
        '没有配置 MCP server。在工作区建 .qy/mcp.json：\n\n' +
          `${DIM}{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n    }\n  }\n}${RESET}\n`,
      )
      return 0
    }

    for (const s of reg.servers) {
      const tools = reg.toolSpecs.filter((t) => t.name.startsWith(toolNamePrefix(s.name)))
      // 报出传输种类：本地进程和远端 server 的排查方向完全不同，
      // 一眼看出来是哪种，比事后猜省事。
      process.stderr.write(
        `${GREEN}✓${RESET} ${BOLD}${s.name}${RESET} ` +
          `${DIM}${s.client.transportKind} · ${s.serverInfo.name ?? '?'} ${s.serverInfo.version ?? ''} · 协议 ${s.protocolVersion || '未回报'} · ${tools.length} 个工具${RESET}\n`,
      )
      /*
       * server 声明了、我们没接的能力**必须显示**，而且不能只在 --tools 下显示。
       *
       * 这是「配了 MCP 但什么都没发生」这条现象的唯一线索：一个只提供
       * `prompts` 的 server 连得上、握得了手、注册 0 个工具，
       * 如果这里不说，用户手上就没有任何可查的东西。
       */
      if (s.unsupported.length > 0) {
        process.stderr.write(
          `${YELLOW}  ⚠ 该 server 还声明了 qywork 尚未支持的能力：${s.unsupported.join('、')}` +
            `（它们提供的东西不会出现在工具列表里）${RESET}\n`,
        )
      }
      if (verbose) {
        for (const t of s.tools) {
          process.stderr.write(`    ${t.name}${DIM} — ${t.description ?? ''}${RESET}\n`)
        }
        // resource 工具不在 s.tools 里（它们是我们合成的，不是 server 报的），
        // 但对用户来说它们就是「这个 server 能干什么」的一部分。
        for (const t of tools.filter((x) => !s.tools.some((d) => x.name.endsWith(`__${d.name}`)))) {
          process.stderr.write(`    ${t.name}${DIM} — ${t.description}${RESET}\n`)
        }
      }
    }

    for (const f of reg.failures) {
      process.stderr.write(`${RED}✗${RESET} ${BOLD}${f.server}${RESET} ${f.reason}\n`)
    }

    if (!verbose && reg.servers.length) {
      process.stderr.write(`\n${DIM}加 --tools 看每个 server 提供哪些工具${RESET}\n`)
    }

    // 有 server 连不上时退非零：CI 里 `qy mcp` 就能当一条检查用。
    return reg.failures.length > 0 ? 1 : 0
  } finally {
    // 探测完就把子进程收掉。留着的话这条命令会挂住不返回。
    reg.stopAll()
  }
}
