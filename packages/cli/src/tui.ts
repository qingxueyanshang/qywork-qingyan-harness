/**
 * 交互式模式：`qy` 不带参数时进这里。
 *
 * ## 为什么是行式 REPL 而不是全屏 TUI
 *
 * 全屏方案（备用缓冲区、自绘光标、鼠标）在 Windows 的 conhost 上是雷区：
 * resize 事件、宽字符光标定位、Ctrl-C 的传递各有各的坑，而它换来的东西
 * ——固定的输入框、滚动区——对一个「说一句、看它干活」的循环并不是必需的。
 * 行式 REPL 把渲染交给终端本身，代价是没有花哨的界面，收益是它在哪都能跑。
 *
 * ## 与 `qy exec` 的关键差别
 *
 * 不是「exec 加个循环」。**会话是连续的**：同一个 conversationId 跨轮复用，
 * 所以模型看得到上一轮说了什么，提示缓存也能命中。exec 每次都是新会话——
 * 那正是它作为「一次性执行」应该有的语义，两者不能合并。
 *
 * ## Ctrl-C
 *
 * 跑的时候按 = 中断这一轮，**不退出**。空闲时按 = 退出。
 * 一个改到一半的任务被整个进程带走，比中断本身糟得多。
 */

import type { AgentEvent, ConversationId } from '@qywork/core'
import { formatCosts, formatMoney } from '@qywork/core'
import {
  configNotices,
  dataPath,
  diagnoseConfig,
  exportConversation,
  loadConfig,
  type QyConfig,
  Session,
} from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, usageTotals } from '@qywork/store'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

const HELP = `${BOLD}命令${RESET}
  /new            开一个新会话（清空上下文）
  /model [名字]   查看或切换模型
  /usage          最近 30 天的用量
  /export [文件]  导出当前会话为 markdown
  /cost           本会话花了多少
  /help           这个
  /quit           退出

${DIM}直接输入内容就是提问。跑的时候 Ctrl-C 中断这一轮，空闲时 Ctrl-C 退出。${RESET}`

export async function runTui(workspaceRoot: string): Promise<number> {
  const config = await loadConfig()
  for (const p of [...diagnoseConfig(config), ...configNotices(config)]) {
    process.stderr.write(`\n${YELLOW}⚠${RESET} ${p}\n`)
  }

  const store = new Store({ path: dataPath() })
  const content = new ContentStore(contentPathFor(dataPath()))

  let conversationId: ConversationId | undefined
  let model = config.active.model
  /** 当前这一轮的中断句柄。null = 空闲。 */
  let running: AbortController | null = null
  let quitting = false

  const onSigint = () => {
    if (running) {
      // 中断这一轮，不退出。改到一半的任务被整个进程带走比中断本身糟得多。
      running.abort()
      process.stderr.write(`\n${DIM}已中断${RESET}\n`)
      return
    }
    quitting = true
    process.stderr.write('\n')
    process.exit(0)
  }
  process.on('SIGINT', onSigint)

  process.stdout.write(
    `${BOLD}qywork${RESET} ${DIM}${workspaceRoot}${RESET}\n` +
      `${DIM}模型 ${model} · /help 看命令${RESET}\n\n`,
  )

  try {
    while (!quitting) {
      process.stdout.write(`${CYAN}›${RESET} `)
      const line = await readLine()
      if (line === null) break // stdin 关了（管道结束、Ctrl-D）
      const input = line.trim()
      if (!input) continue

      if (input.startsWith('/')) {
        const done = await handleCommand(input, {
          store,
          config,
          get conversationId() {
            return conversationId
          },
          setConversation: (id) => {
            conversationId = id
          },
          get model() {
            return model
          },
          setModel: (m) => {
            model = m
          },
        })
        if (done === 'quit') break
        continue
      }

      running = new AbortController()
      const session = new Session({
        store,
        config,
        content,
        workspaceRoot,
        signal: running.signal,
      })

      try {
        for await (const ev of session.ask(input, conversationId, { model })) {
          if (ev.type === 'run.started') conversationId = ev.conversationId
          render(ev)
        }
      } catch (err) {
        process.stderr.write(
          `\n${RED}✗${RESET} ${err instanceof Error ? err.message : String(err)}\n`,
        )
      } finally {
        session.dispose()
        running = null
      }
      process.stdout.write('\n')
    }
  } finally {
    process.off('SIGINT', onSigint)
    content.close()
    store.close()
  }
  return 0
}

// ───────────────────────── 斜杠命令 ─────────────────────────

export interface CommandContext {
  store: Store
  config: QyConfig
  readonly conversationId: ConversationId | undefined
  setConversation(id: ConversationId | undefined): void
  readonly model: string
  setModel(m: string): void
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<'quit' | 'ok'> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()

  switch (cmd) {
    case 'quit':
    case 'exit':
      return 'quit'

    case 'help':
      process.stdout.write(`${HELP}\n`)
      return 'ok'

    case 'new':
      ctx.setConversation(undefined)
      process.stdout.write(`${DIM}已开新会话${RESET}\n`)
      return 'ok'

    case 'model': {
      if (!arg) {
        const names = Object.values(ctx.config.providers).flatMap((p) => Object.keys(p.models))
        process.stdout.write(
          `当前 ${BOLD}${ctx.model}${RESET}\n${DIM}配置里有：${names.join('、')}${RESET}\n`,
        )
        return 'ok'
      }
      ctx.setModel(arg)
      // 换模型**不清会话**：用户多半是想「换个模型接着聊」。
      // 真要重来有 /new，而把两件事绑在一起会让人不敢换模型。
      process.stdout.write(`${DIM}下一轮起用 ${arg}${RESET}\n`)
      return 'ok'
    }

    case 'usage': {
      const t = usageTotals(ctx.store, { since: Date.now() - 30 * 86_400_000 })
      process.stdout.write(
        t.entries === 0
          ? `${DIM}最近 30 天没有记录${RESET}\n`
          : `最近 30 天：${t.entries} 笔 · 入 ${t.inputTokens} 出 ${t.outputTokens} · ${formatCosts(t.cost)}\n`,
      )
      return 'ok'
    }

    case 'cost': {
      if (!ctx.conversationId) {
        process.stdout.write(`${DIM}还没开始${RESET}\n`)
        return 'ok'
      }
      const t = usageTotals(ctx.store, {})
      process.stdout.write(`${DIM}账本总计 ${formatCosts(t.cost)}（本机全部会话）${RESET}\n`)
      return 'ok'
    }

    case 'export': {
      if (!ctx.conversationId) {
        process.stdout.write(`${DIM}还没有可导出的会话${RESET}\n`)
        return 'ok'
      }
      const text = exportConversation(ctx.store, ctx.conversationId, 'markdown')
      if (arg) {
        await Bun.write(arg, text)
        process.stdout.write(`${DIM}已写入 ${arg}${RESET}\n`)
      } else {
        process.stdout.write(`${text}\n`)
      }
      return 'ok'
    }

    default:
      // 未知命令**明确拒绝**，不要当成提问发给模型——
      // 用户打错一个斜杠命令却收到一段模型回答，是最让人困惑的那种反馈。
      process.stdout.write(`${RED}未知命令 /${cmd}${RESET}${DIM}，/help 看可用的${RESET}\n`)
      return 'ok'
  }
}

// ───────────────────────── 渲染 ─────────────────────────

/**
 * 与 `qy exec` 同一套渲染。
 *
 * 刻意共用而不是各写一份：两套渲染就是两套会漂移的行为，
 * 而「exec 里显示了但交互模式没显示」这种差异极难发现。
 */
function render(ev: AgentEvent): void {
  switch (ev.type) {
    case 'text.delta':
      process.stdout.write(ev.delta)
      break
    case 'tool.started':
      process.stdout.write(
        `\n${DIM}▸ ${ev.toolName}${ev.action.target ? ` ${ev.action.target}` : ''}${RESET}\n`,
      )
      break
    case 'tool.finished': {
      const ok = ev.status === 'success'
      process.stdout.write(
        `${ok ? GREEN : RED}${ok ? '✓' : '✗'}${RESET} ${DIM}${ev.outcome.message}${RESET}\n`,
      )
      break
    }
    case 'compaction':
      if (ev.phase === 'started') process.stdout.write(`${DIM}（正在压缩上下文…）${RESET}\n`)
      break
    case 'run.error':
      process.stderr.write(`\n${RED}错误 [${ev.code}]${RESET} ${ev.message}\n`)
      break
    case 'run.finished': {
      const u = ev.usage
      const cached = u.cachedTokens === null ? '未回报' : String(u.cachedTokens)
      process.stdout.write(
        `\n${DIM}—— ${ev.stopReason} · 入 ${u.inputTokens} 出 ${u.outputTokens} 缓存 ${cached} · ${formatMoney(u.cost, u.currency)}${RESET}\n`,
      )
      break
    }
    default:
      break
  }
}

/** 读一行。返回 null 表示 stdin 已关闭——那时候必须退出，不能空转。 */
async function readLine(): Promise<string | null> {
  for await (const line of console) return line
  return null
}
