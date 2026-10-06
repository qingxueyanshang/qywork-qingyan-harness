/**
 * 交互模式：`qy` 不带参数时进入此处。
 *
 * **采用行式 REPL 而不是全屏 TUI 的原因。** 全屏方案（备用缓冲区、自绘光标、鼠标）在 Windows 的
 * conhost 上问题集中：resize 事件、宽字符光标定位、Ctrl-C 的传递各有易错点，而它带来的收益（固定
 * 的输入框、滚动区）对「输入一句、观察执行」的循环并非必需。行式 REPL 把渲染交给终端本身，
 * 代价是界面较为简单，收益是在任何终端中都能运行。
 *
 * **与 `qy exec` 的关键区别。** 它不是「exec 加一个循环」。**会话是连续的**：同一个 conversationId 跨轮
 * 复用，因此模型能看到上一轮的内容，提示缓存也能命中。exec 每次都是新会话，这正是单次执行
 * 应有的语义，两者不能合并。
 *
 * **Ctrl-C。** 运行中按下 = 中断本轮，**不退出**。空闲时按下 = 退出。
 * 进程退出会连带终止执行到一半的任务，后果比中断本身严重得多。
 */

import type { AgentEvent, ConversationId } from '@qywork/core'
import { formatCosts, formatMoney } from '@qywork/core'
import {
  collectResourceGarbage,
  configNotices,
  createOfficeHost,
  dataPath,
  diagnoseConfig,
  diagnoseRunnable,
  exportConversation,
  importLegacySchedules,
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
  /new            开始新会话（清空上下文）
  /model [名称]   查看或切换模型
  /usage          最近 30 天的用量
  /export [文件]  导出当前会话为 markdown
  /cost           本会话的花费
  /help           显示本帮助
  /quit           退出

${DIM}直接输入内容即为提问。执行时按 Ctrl-C 中断本轮，空闲时按 Ctrl-C 退出。${RESET}`

export async function runTui(workspaceRoot: string): Promise<number> {
  const config = await loadConfig()
  for (const p of [
    ...diagnoseConfig(config),
    ...diagnoseRunnable(config),
    ...configNotices(config),
  ]) {
    process.stderr.write(`\n${YELLOW}⚠${RESET} ${p}\n`)
  }

  const store = new Store({ path: dataPath(), owner: 'cli' })
  // 此处同样需要导入定时任务的旧文件：本次会话注入了定时任务端口，若不导入，在 `qy serve`
  // 运行之前 `list_schedules` 无法读取已排定的任务。文件不合法时抛出，与 serve 的行为相同。
  importLegacySchedules(store)
  const content = new ContentStore(contentPathFor(dataPath()))
  /*
   * 正文回收。两个库都打开之后、执行本轮之前回收一次：清理上一个进程在登记引用之前
   * 退出所遗留的孤儿正文，与 `qy serve` 使用同一个协调器。
   *
   * 失败时只向 stderr 写一行，不阻止本轮执行：回收影响的是磁盘空间，不影响正确性。
   */
  try {
    collectResourceGarbage(store, content)
  } catch (err) {
    process.stderr.write(`[qy] 正文回收失败：${err instanceof Error ? err.message : String(err)}\n`)
  }

  // Office 执行程序：启动时探测一次，此后每轮按缓存结果提供端口，与 `qy serve` 使用同一个宿主实现。
  const office = createOfficeHost(() => config)
  await office.refresh()

  let conversationId: ConversationId | undefined
  // 默认不预设模型：未配置时为 undefined，可用 `/model` 切换，发送时由 session.ask 拒绝。
  let model = config.active?.model
  /** 本轮的中断句柄。null = 空闲。 */
  let running: AbortController | null = null
  let quitting = false

  const onSigint = () => {
    if (running) {
      // 中断本轮，不退出。进程退出会连带终止执行到一半的任务，后果比中断本身严重得多。
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
      `${DIM}模型 ${model ?? '未配置（使用 /model 选择，或在设置中配置）'} · /help 查看命令${RESET}\n\n`,
  )

  try {
    while (!quitting) {
      process.stdout.write(`${CYAN}›${RESET} `)
      const line = await readLine()
      if (line === null) break // stdin 已关闭（管道结束、Ctrl-D）
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
      const officePort = office.port()
      const session = new Session({
        store,
        config,
        content,
        workspaceRoot,
        signal: running.signal,
        ...(officePort ? { office: officePort } : {}),
      })

      try {
        for await (const ev of session.ask(input, conversationId, {
          ...(model ? { model } : {}),
        })) {
          if (ev.type === 'run.started') conversationId = ev.conversationId
          render(ev)
        }
      } catch (err) {
        process.stderr.write(
          `\n${RED}✗${RESET} ${err instanceof Error ? err.message : String(err)}\n`,
        )
      } finally {
        await session.dispose()
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
  readonly model: string | undefined
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
      process.stdout.write(`${DIM}已开始新会话${RESET}\n`)
      return 'ok'

    case 'model': {
      if (!arg) {
        const names = Object.values(ctx.config.providers).flatMap((p) => Object.keys(p.models))
        process.stdout.write(
          `当前 ${BOLD}${ctx.model ?? '未配置'}${RESET}\n${DIM}配置中的模型：${names.join('、') || '（空）'}${RESET}\n`,
        )
        return 'ok'
      }
      ctx.setModel(arg)
      // 切换模型**不清除会话**：用户通常是要更换模型后继续对话。
      // 需要重新开始时可使用 /new；两者绑定会使用户不敢切换模型。
      process.stdout.write(`${DIM}下一轮起使用 ${arg}${RESET}\n`)
      return 'ok'
    }

    case 'usage': {
      const t = usageTotals(ctx.store, { since: Date.now() - 30 * 86_400_000 })
      process.stdout.write(
        t.entries === 0
          ? `${DIM}最近 30 天没有记录${RESET}\n`
          : `最近 30 天：${t.entries} 笔 · 输入 ${t.inputTokens} 输出 ${t.outputTokens} · ${formatCosts(t.cost)}\n`,
      )
      return 'ok'
    }

    case 'cost': {
      if (!ctx.conversationId) {
        process.stdout.write(`${DIM}尚未开始会话${RESET}\n`)
        return 'ok'
      }
      const t = usageTotals(ctx.store, {})
      process.stdout.write(`${DIM}账本总计 ${formatCosts(t.cost)}（本机全部会话）${RESET}\n`)
      return 'ok'
    }

    case 'export': {
      if (!ctx.conversationId) {
        process.stdout.write(`${DIM}尚无可导出的会话${RESET}\n`)
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
      // 未知命令**明确拒绝**，不要作为提问发给模型：
      // 用户输错斜杠命令却收到一段模型回答，是最令人困惑的反馈。
      process.stdout.write(
        `${RED}未知命令 /${cmd}${RESET}${DIM}，输入 /help 查看可用命令${RESET}\n`,
      )
      return 'ok'
  }
}

// ───────────────────────── 渲染 ─────────────────────────

/**
 * 输出格式与 `qy exec` 的 `renderHuman`（`index.ts`）保持一致。
 *
 * 两处分别实现：修改其中一处时须同步修改另一处，
 * 否则「exec 中显示而交互模式未显示」这类差异极难发现。
 */
function render(ev: AgentEvent): void {
  switch (ev.type) {
    case 'text.delta':
      process.stdout.write(ev.delta)
      break
    case 'tool.started':
      process.stdout.write(
        `\n${DIM}▸ ${ev.toolName}${ev.action?.target ? ` ${ev.action.target}` : ''}${RESET}\n`,
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
        `\n${DIM}—— ${ev.stopReason} · 输入 ${u.inputTokens} 输出 ${u.outputTokens} 缓存命中 ${cached} · ${formatMoney(u.cost, u.currency)}${RESET}\n`,
      )
      break
    }
    default:
      break
  }
}

/** 读取一行。返回 null 表示 stdin 已关闭，此时必须退出，不能继续循环等待。 */
async function readLine(): Promise<string | null> {
  for await (const line of console) return line
  return null
}
