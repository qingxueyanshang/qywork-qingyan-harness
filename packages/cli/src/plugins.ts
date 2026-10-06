/**
 * `qy plugins`：查看已安装的插件及其隔离程度。
 *
 * **该命令的必要性。** 它是 `sandboxed` 与 `netGuarded` **唯一面向用户的出口**。没有它，这两
 * 个值在 `packages/plugins` 之外没有任何消费者，唯一的记录是 `PluginHost.start()` 中的一行
 * stderr：用户安装插件后要确认「是否已加载、是否已隔离」，只能发起一轮真实 run 再查阅日志，而桌面
 * 外壳会丢弃这些输出。
 *
 * **隔离状态逐项输出，不合并为「已隔离」。** 两个维度的成立条件不同（版本要求不同，bun 上两者
 * 都不具备），且 `process:exec` 会使网络访问限制失效。合并为一句话后，「已隔离」在不同机器上
 * 含义不同（见 ARCHITECTURE.md §17.1）。
 *
 * 加载失败同样**逐条输出原因**：清单错误、入口文件缺失、权限声明非法，
 * 每一种的处置办法都不同，只说「有 2 个插件加载失败」会使用户只能自行推测。
 */

import { relative, resolve } from 'node:path'
import { globalPluginsDir, loadExtensions, pluginToolPrefix } from '@qywork/runtime'

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

  process.stderr.write(`工作区：${workspaceRoot}\n插件目录：${globalPluginsDir()}\n\n`)

  const ext = await loadExtensions(workspaceRoot, (line) => {
    if (verbose) process.stderr.write(`${DIM}${line}${RESET}\n`)
  })
  const reg = ext.plugins

  try {
    if (reg.plugins.length === 0 && reg.failures.length === 0) {
      process.stderr.write(
        `未安装任何插件。插件位于 ${globalPluginsDir()} 下的 <名称>/ 目录，\n` +
          `目录中需要包含 ${BOLD}qywork.plugin.json${RESET}${DIM}（不是 plugin.json）${RESET}以及清单中 main 指向的入口文件。\n` +
          `${DIM}详见 docs/plugins.md${RESET}\n`,
      )
      return 0
    }

    for (const p of reg.plugins) {
      const tools = reg.toolSpecs.filter((t) => t.name.startsWith(pluginToolPrefix(p.manifest.id)))
      const perms = p.manifest.permissions ?? []
      process.stderr.write(
        `${GREEN}✓${RESET} ${BOLD}${p.manifest.id}${RESET} ` +
          `${DIM}${p.manifest.name} ${p.manifest.version} · ${tools.length} 个工具 · ` +
          `权限 ${perms.length ? perms.join('、') : '（无）'}${RESET}\n`,
      )

      // 纯声明式插件（只提供预览器、角色）没有进程，不涉及隔离。
      // 应表述为不适用，而不是「没有隔离」：后者会被理解为一处故障。
      /*
       * `previewers` / `roles` / `providers` **当前没有任何消费者**。
       *
       * 若只显示绿勾并附「纯声明式插件，没有代码进程」，会被理解为已安装且
       * 正在生效，而这些贡献注册后没有任何读取方。安装后不生效且工具不提示时，
       * 用户只能推测是否自己写错。按 B5、B7，这一点必须明确说明，
       * 直到消费端接入为止（见 docs/plugins.md 同名小节）。
       */
      const inert: string[] = []
      if (p.manifest.contributes.previewers?.length) inert.push('预览器')
      if (p.manifest.contributes.roles?.length) inert.push('角色')
      if (p.manifest.contributes.providers?.length) inert.push('供应商')
      if (inert.length) {
        process.stderr.write(
          `    ${YELLOW}${inert.join(' / ')}贡献当前不生效${RESET}` +
            `${DIM}：宿主尚未接入消费端${RESET}
`,
        )
      }

      const rt = p.host?.runtime
      if (!p.host) {
        process.stderr.write(`    ${DIM}纯声明式插件，没有代码进程${RESET}\n`)
      } else if (!rt) {
        process.stderr.write(`    ${DIM}进程未启动，隔离状态未知${RESET}\n`)
      } else {
        const mark = (ok: boolean) => (ok ? `${GREEN}有${RESET}` : `${YELLOW}无${RESET}`)
        process.stderr.write(
          `    沙箱 ${mark(rt.sandboxed)} · 网络访问限制 ${mark(rt.netGuarded)} ` +
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
      // 路径改为相对工作区的形式。`f.reason` 中通常已含清单的绝对路径，
      // 若再输出 `f.dir` 的绝对路径，同一路径在一行中出现两次、各占七八十列，
      // 关键信息（如「缺少 version」）会被推出可见范围。
      const where = relative(workspaceRoot, f.dir) || f.dir
      const why = f.reason.split(`${f.dir}\\`).join('').split(`${f.dir}/`).join('')
      process.stderr.write(`${RED}✗${RESET} ${BOLD}${where}${RESET} ${why}\n`)
    }

    if (!verbose && reg.plugins.length) {
      process.stderr.write(`\n${DIM}加 --tools 查看每个插件提供的工具与启动日志${RESET}\n`)
    }

    // 有插件加载失败时返回非零：`qy plugins` 因此可在 CI 中用作一项检查，与 `qy mcp` 一致。
    return reg.failures.length > 0 ? 1 : 0
  } finally {
    // 探测完成后终止子进程，否则该命令会阻塞而不返回。
    await ext.stop()
  }
}
