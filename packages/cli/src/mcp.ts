/**
 * `qy mcp`：查看工作区中的 MCP server 是否已连接。
 *
 * 没有该命令时，「已配置但工具未出现」只能通过查阅 `qy serve` 的日志排查，
 * 而这些日志混在启动输出中，且会被桌面外壳丢弃。MCP 的失败较为常见：
 * 命令未安装、包名错误、未提供所需凭证，每一种的处置办法都不同，
 * 因此要**逐条输出原因**，而不是只说「有 2 个 server 无法连接」。
 */

import { resolve } from 'node:path'
import { loadWorkspaceMcp, MCP_CONFIG, toolNamePrefix } from '@qywork/runtime'

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

  process.stderr.write(`工作区：${workspaceRoot}\n配置：${MCP_CONFIG}\n\n`)

  const reg = await loadWorkspaceMcp(workspaceRoot, (line) => {
    if (verbose) process.stderr.write(`${DIM}${line}${RESET}\n`)
  })

  try {
    if (reg.servers.length === 0 && reg.failures.length === 0) {
      process.stderr.write(
        `没有配置 MCP server。在工作区创建 ${MCP_CONFIG}：\n\n` +
          `${DIM}{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n    }\n  }\n}${RESET}\n`,
      )
      return 0
    }

    for (const s of reg.servers) {
      const tools = reg.toolSpecs.filter((t) => t.name.startsWith(toolNamePrefix(s.name)))
      // 输出传输类型：本地进程和远端 server 的排查方向完全不同，
      // 直接显示类型比事后推断可靠。
      process.stderr.write(
        `${GREEN}✓${RESET} ${BOLD}${s.name}${RESET} ` +
          `${DIM}${s.client.transportKind} · ${s.serverInfo.name ?? '?'} ${s.serverInfo.version ?? ''} · 协议 ${s.protocolVersion || '未回报'} · ${tools.length} 个工具${RESET}\n`,
      )
      /*
       * server 已声明而本仓库未接入的能力**必须显示**，且不能只在 --tools 下显示。
       *
       * 这是「配置了 MCP 但没有任何效果」这一现象的唯一线索：只提供
       * `prompts` 的 server 能够连接、完成握手、注册 0 个工具，
       * 此处若不说明，用户没有任何可查的线索。
       */
      if (s.unsupported.length > 0) {
        process.stderr.write(
          `${YELLOW}  ⚠ 该 server 另外声明了 qywork 尚未支持的能力：${s.unsupported.join('、')}` +
            `（它们提供的内容不会出现在工具列表中）${RESET}\n`,
        )
      }
      if (verbose) {
        for (const t of s.tools) {
          process.stderr.write(`    ${t.name}${DIM} — ${t.description ?? ''}${RESET}\n`)
        }
        // resource 工具不在 s.tools 中（由本仓库合成，不是 server 声明的），
        // 但对用户而言它们属于该 server 提供的能力。
        for (const t of tools.filter((x) => !s.tools.some((d) => x.name.endsWith(`__${d.name}`)))) {
          process.stderr.write(`    ${t.name}${DIM} — ${t.description}${RESET}\n`)
        }
      }
    }

    for (const f of reg.failures) {
      process.stderr.write(`${RED}✗${RESET} ${BOLD}${f.server}${RESET} ${f.reason}\n`)
    }

    if (!verbose && reg.servers.length) {
      process.stderr.write(`\n${DIM}加 --tools 查看每个 server 提供的工具${RESET}\n`)
    }

    // 有 server 无法连接时返回非零：`qy mcp` 因此可在 CI 中用作一项检查。
    return reg.failures.length > 0 ? 1 : 0
  } finally {
    // 探测完成后终止子进程，否则该命令会阻塞而不返回。
    await reg.stopAll()
  }
}
