/**
 * `qy plugins` —— 看一眼工作区里的插件到底装没装上、被关住了没有。
 *
 * ## 为什么必须有这条命令
 *
 * `sandboxed` 和 `netGuarded` 这两个值以前**在 `packages/plugins` 之外一个消费者都没有**，
 * 唯一的出口是 `PluginHost.start()` 里的一行 stderr。也就是说用户装完插件之后，
 * 想知道「它加载了吗、被隔离了吗」，只能起一轮真实 run 然后去日志里翻——
 * 而桌面外壳会把那些输出吞掉。
 *
 * 这是这个项目反复出现的那类问题的又一例：**算出来了，但没有任何人消费**。
 * 隔壁 MCP 有 `qy mcp`，插件一直没有对应的东西。
 *
 * ## 为什么隔离状态要逐条打，而不是一句「已隔离」
 *
 * 两个维度的成立条件不同（版本要求不同，bun 上一个都没有），而且
 * `process:exec` 会架空出网闸。合成一句话的话，「已隔离」在不同机器上
 * 就不是一个意思了——那正是 ARCHITECTURE §17.1 纠正过的错误。
 *
 * 加载失败也要**逐条把原因打出来**：清单写错、入口文件缺失、权限声明非法，
 * 每一种的处置办法都不同，只说「有 2 个插件没装上」等于让用户自己猜。
 */

import { relative, resolve } from 'node:path'
import { loadExtensions } from '@qywork/runtime'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'

export async function runPlugins(args: string[]): Promise<number> {
  const cwdFlag = args.indexOf('--cwd')
  const workspaceRoot = resolve(cwdFlag >= 0 ? (args[cwdFlag + 1] ?? '.') : '.')
  const verbose = args.includes('--tools')

  process.stderr.write(`工作区：${workspaceRoot}\n配置：.qy/plugins/<名字>/qywork.plugin.json\n\n`)

  const ext = await loadExtensions(workspaceRoot, (line) => {
    if (verbose) process.stderr.write(`${DIM}${line}${RESET}\n`)
  })
  const reg = ext.plugins

  try {
    if (reg.plugins.length === 0 && reg.failures.length === 0) {
      process.stderr.write(
        '没有装任何插件。插件放在工作区的 .qy/plugins/<名字>/ 下，\n' +
          `目录里要有 ${BOLD}qywork.plugin.json${RESET}${DIM}（不是 plugin.json）${RESET}和清单里 main 指向的入口。\n` +
          `${DIM}详见 docs/plugins.md${RESET}\n`,
      )
      return 0
    }

    for (const p of reg.plugins) {
      const tools = reg.toolSpecs.filter((t) => t.name.startsWith(`${p.manifest.id}__`))
      const perms = p.manifest.permissions ?? []
      process.stderr.write(
        `${GREEN}✓${RESET} ${BOLD}${p.manifest.id}${RESET} ` +
          `${DIM}${p.manifest.name} ${p.manifest.version} · ${tools.length} 个工具 · ` +
          `权限 ${perms.length ? perms.join('、') : '（无）'}${RESET}\n`,
      )

      // 纯声明式插件（只贡献预览器/角色）没有进程，也就无所谓隔离。
      // 说清楚是「不适用」而不是「没有隔离」——后者会让人以为出了问题。
      const rt = p.host?.runtime
      if (!p.host) {
        process.stderr.write(`    ${DIM}纯声明式插件，没有代码进程${RESET}\n`)
      } else if (!rt) {
        process.stderr.write(`    ${DIM}进程未启动，隔离状态未知${RESET}\n`)
      } else {
        const mark = (ok: boolean) => (ok ? `${GREEN}有${RESET}` : `${YELLOW}无${RESET}`)
        process.stderr.write(
          `    沙箱 ${mark(rt.sandboxed)} · 出网闸 ${mark(rt.netGuarded)} ` +
            `${DIM}${rt.command}${RESET}\n` +
            `    ${DIM}${rt.note}${RESET}\n`,
        )
      }

      if (verbose) {
        for (const t of tools) {
          process.stderr.write(`    ${t.name}${DIM} — ${t.description}${RESET}\n`)
        }
      }
    }

    for (const f of reg.failures) {
      // 路径收敛成工作区相对的。`f.reason` 里通常已经带了清单的绝对路径，
      // 再把 `f.dir` 的绝对路径原样打一遍，一行里同一条路径出现两次、
      // 各占七八十列，真正有用的那句「缺少 version」被挤到看不见。
      const where = relative(workspaceRoot, f.dir) || f.dir
      const why = f.reason.split(`${f.dir}\\`).join('').split(`${f.dir}/`).join('')
      process.stderr.write(`${RED}✗${RESET} ${BOLD}${where}${RESET} ${why}\n`)
    }

    if (!verbose && reg.plugins.length) {
      process.stderr.write(`\n${DIM}加 --tools 看每个插件提供哪些工具，以及启动日志${RESET}\n`)
    }

    // 有插件装不上时退非零：CI 里 `qy plugins` 就能当一条检查用，与 `qy mcp` 一致。
    return reg.failures.length > 0 ? 1 : 0
  } finally {
    // 探测完就把子进程收掉。留着的话这条命令会挂住不返回。
    ext.stop()
  }
}
