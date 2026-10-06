#!/usr/bin/env bun
/**
 * Claude Code 的 PreToolUse 钩子（Bash 与 PowerShell）：拦截未设置 `QYWORK_HOME` 即执行 `qy` 的命令。
 *
 * 未设置时 `qy` 读写用户真实的 `~/.qywork`：配置中的密钥、账本、会话列表。`qy exec` 会按当前目录创建工作区与会话，
 * 并使用用户的模型发出真实请求。开发与验收一律把 `QYWORK_HOME` 指向仓库 `.tmp/` 下的隔离目录。
 *
 * 只识别执行位置上的 `qy` / `qy.exe` / `qy-<三元组>.exe` 与 `bun … packages/cli/src/index.ts`；
 * 读取、搜索该文件的命令不拦截。命令中任何位置出现 `QYWORK_HOME` 即放行（前缀赋值与 `$env:` 两种写法）。
 * 退出码 2 表示拦截，stderr 的内容交给模型。
 */

const CLI_ENTRY = /(^|[\\/])packages[\\/]cli[\\/]src[\\/]index\.ts$/i
const QY_BINARY = /^qy(\.exe)?$|^qy-[\w.-]+\.exe$/i
const RUNNER = /^bun(\.exe)?$/i

function basename(token: string): string {
  return (
    token
      .replace(/^['"]|['"]$/g, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

/** 判断该命令是否会在没有隔离数据目录的情况下执行 qy。 */
export function runsQyAgainstRealHome(
  command: string,
  env: Record<string, string | undefined> = {},
): boolean {
  if (env.QYWORK_HOME || /QYWORK_HOME/.test(command)) return false
  for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    while (tokens[0] && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift()
    const first = tokens[0]
    if (!first) continue
    if (QY_BINARY.test(basename(first))) return true
    if (
      RUNNER.test(basename(first)) &&
      tokens.some((t) => CLI_ENTRY.test(t.replace(/^['"]|['"]$/g, '')))
    ) {
      return true
    }
  }
  return false
}

if (import.meta.main) {
  const input = JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: unknown } }
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (runsQyAgainstRealHome(command, process.env)) {
    process.stderr.write(
      '已拦下：这条命令会用用户真实的 ~/.qywork（配置、账本、会话）执行 qy。' +
        '在同一条命令里把 QYWORK_HOME 指到仓库 .tmp/ 下的隔离目录再执行，' +
        '例如 QYWORK_HOME="$PWD/.tmp/qy-home" bun packages/cli/src/index.ts …\n',
    )
    process.exit(2)
  }
}
