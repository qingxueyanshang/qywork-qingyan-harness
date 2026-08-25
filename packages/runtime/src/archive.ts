/**
 * 会话导出。
 *
 * 「把会话搬到另一台机器」不做（那要账号体系、要冲突合并、要正文迁移）；
 * 「把这次会话导出成一份能读、能存档、能贴进 issue 的文档」是真实需求。
 * 两者的界限就在这里——本模块**只读**，产出物是死的，不承诺能被导回来。
 *
 * 两种格式，各有明确用途：
 *
 * - **markdown**：给人读。工具调用折叠成一行摘要，失败的展开；正文不含 base64。
 * - **json**：给脚本读。**完整**导出消息、run、step、payload，不做任何裁剪——
 *   两种格式的取舍相反，混成一种就两边都不好用。
 */

import type { ConversationId, Message, Run, Step } from '@qywork/core'
import { getConversation, listMessages, listRuns, listSteps, type Store } from '@qywork/store'

export type ArchiveFormat = 'markdown' | 'json'

export interface ArchiveOptions {
  /** 工具参数与结果的截断长度。markdown 用，json 不截。 */
  maxToolChars?: number
  /** 含思考内容。默认不含——它通常很长，而且对读者价值最低。 */
  includeThinking?: boolean
}

const DEFAULT_TOOL_CHARS = 600

export interface ArchiveBundle {
  conversation: ReturnType<typeof getConversation>
  messages: Message[]
  runs: (Run & { steps: Step[] })[]
  exportedAt: number
}

/** 把一个会话的全部账本读出来。两种格式共用这一份采集。 */
export function collect(store: Store, conversationId: ConversationId): ArchiveBundle {
  const conversation = getConversation(store, conversationId)
  if (!conversation) throw new Error(`会话不存在：${conversationId}`)
  return {
    conversation,
    messages: listMessages(store, conversationId),
    runs: listRuns(store, conversationId).map((r) => ({ ...r, steps: listSteps(store, r.id) })),
    exportedAt: Date.now(),
  }
}

export function exportConversation(
  store: Store,
  conversationId: ConversationId,
  format: ArchiveFormat,
  opts: ArchiveOptions = {},
): string {
  const bundle = collect(store, conversationId)
  return format === 'json' ? toJson(bundle) : toMarkdown(bundle, opts)
}

/**
 * JSON：**不裁剪**。
 *
 * 这份是给脚本用的，裁剪等于把「导出的内容不全」这件事藏起来——
 * 而脚本没法像人一样看出「这里少了点什么」。
 */
function toJson(bundle: ArchiveBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

function toMarkdown(bundle: ArchiveBundle, opts: ArchiveOptions): string {
  const limit = opts.maxToolChars ?? DEFAULT_TOOL_CHARS
  const c = bundle.conversation!
  const out: string[] = []

  out.push(`# ${c.title || '未命名会话'}`, '')
  out.push(
    `- 会话 ${c.id}`,
    `- 模型 ${c.model}`,
    `- 创建于 ${iso(c.createdAt)}`,
    `- 导出于 ${iso(bundle.exportedAt)}`,
  )

  const totals = bundle.runs.reduce(
    (a, r) => ({
      cost: a.cost + r.usage.cost,
      input: a.input + r.usage.inputTokens,
      output: a.output + r.usage.outputTokens,
    }),
    { cost: 0, input: 0, output: 0 },
  )
  out.push(
    `- ${bundle.runs.length} 轮 · 入 ${totals.input} 出 ${totals.output} · $${totals.cost.toFixed(4)}`,
  )

  // 压缩过的会话要**在最上面**说清楚：读者看到的历史与模型看到的不是同一份，
  // 不说的话「模型为什么忘了前面」会变成一个查不出原因的问题。
  if (c.compactionManifest) {
    out.push(
      `- ⚠ 本会话被压缩过（修订 ${c.compactionManifest.revision}）：` +
        '模型看到的是摘要，下面的原文是完整的',
    )
  }
  out.push('')

  const stepsByRun = new Map(bundle.runs.map((r) => [r.userMessageId ?? '', r]))

  for (const m of bundle.messages) {
    if (m.role === 'user') {
      out.push('---', '', `## 用户`, '', m.content, '')
      const run = stepsByRun.get(m.id)
      if (run) out.push(...renderRun(run, limit, opts.includeThinking === true))
    } else if (m.role === 'assistant' && !hasRunFor(bundle, m)) {
      // 没有对应 run 的 assistant 消息（历史导入之类）也要出现，不能因为
      // 「渲染路径主要走 run」就把它漏掉。
      out.push('## 助手', '', m.content, '')
    }
  }

  return `${out.join('\n')}\n`
}

function hasRunFor(bundle: ArchiveBundle, m: Message): boolean {
  return bundle.runs.some((r) => r.assistantMessageId === m.id)
}

function renderRun(run: Run & { steps: Step[] }, limit: number, thinking: boolean): string[] {
  const out: string[] = ['## 助手', '']

  for (const s of run.steps) {
    if (s.kind === 'text') {
      if (s.content?.trim()) out.push(s.content, '')
      continue
    }
    if (s.kind === 'compaction') {
      out.push('> （此处发生了一次上下文压缩）', '')
      continue
    }
    if (s.kind === 'tool_action') {
      out.push(...renderTool(s, limit))
      continue
    }
    if (thinking && s.content?.trim()) {
      out.push('<details><summary>思考</summary>', '', s.content, '', '</details>', '')
    }
  }

  if (run.status !== 'done') {
    out.push(`> 本轮以 \`${run.stopReason ?? run.status}\` 结束`, '')
  }
  return out
}

/**
 * 工具调用一行摘要，**失败的展开**。
 *
 * 成功的调用读者基本不看；失败的是最需要看到细节的地方。
 * 一视同仁地折叠或一视同仁地展开，都会让这份文档在最有用的地方最没用。
 */
function renderTool(s: Step, limit: number): string[] {
  const p = s.payload
  const ok = s.status === 'success'
  const target =
    (p?.kind === 'tool_result' || p?.kind === 'tool_call' ? p.action?.target : null) ?? ''
  const head = `${ok ? '✓' : '✗'} \`${s.toolName ?? '?'}\`${target ? ` ${target}` : ''}`

  if (ok) return [`- ${head}`]

  const message = p?.kind === 'tool_result' ? p.outcome.message : ''
  const lines = [`- ${head}`]
  if (message)
    lines.push(
      '',
      '  ```',
      ...clip(message, limit)
        .split('\n')
        .map((l) => `  ${l}`),
      '  ```',
    )
  return [...lines, '']
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（截断，完整内容见 json 导出）`
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}
