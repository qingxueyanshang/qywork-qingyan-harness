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

import { applySpecOverride, lookupModel } from '@qywork/ai'
import type {
  ConversationId,
  Message,
  ProviderRequest,
  Run,
  RunContextSegment,
  Step,
} from '@qywork/core'
import {
  currentGoal,
  getConversation,
  getWorkspace,
  latestTodos,
  listDisabledExtras,
  listLoadedTools,
  listMessages,
  listProviderRequests,
  listResourcesForRun,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  SCHEMA_VERSION,
  type Store,
} from '@qywork/store'
import pkg from '../package.json' with { type: 'json' }
import type { QyConfig } from './config.ts'
import { isWorkspaceTrusted, resolveModel } from './config.ts'

export type ArchiveFormat = 'markdown' | 'json'

export interface ArchiveOptions {
  /** 工具参数与结果的截断长度。markdown 用，json 不截。 */
  maxToolChars?: number
  /** 含思考内容。默认不含——它通常很长，而且对读者价值最低。 */
  includeThinking?: boolean
}

const DEFAULT_TOOL_CHARS = 600

export interface ArchiveBundle {
  workspace: ReturnType<typeof getWorkspace>
  conversation: ReturnType<typeof getConversation>
  messages: Message[]
  sessionState: {
    goal: ReturnType<typeof currentGoal>
    todos: NonNullable<ReturnType<typeof latestTodos>>
    loadedTools: string[]
    disabledExtras: string[]
  }
  runs: (Run & {
    contextSnapshot: RunContextSegment[]
    steps: Step[]
    providerRequests: ProviderRequest[]
    resources: ReturnType<typeof listResourcesForRun>
  })[]
  collectionErrors: { section: string; message: string }[]
  exportedAt: number
}

export interface ChildConversationLink {
  parentConversationId: ConversationId
  parentRunId: Run['id']
  parentStepId: Step['id']
  childConversationId: ConversationId
  /** 新账本直接记在 step 上；旧账本从最终工具回执里回退读取。 */
  source: 'step_payload' | 'outcome_fallback'
}

export interface ConversationTree {
  rootConversationId: ConversationId
  /** 根会话仍在诊断包顶层；这里仅放全部后代，按首次出现顺序排列。 */
  childConversations: ArchiveBundle[]
  /** 扁平边表可还原父子层级，同一子会话被多处引用时正文只导出一份。 */
  links: ChildConversationLink[]
  unresolvedChildren: {
    link: ChildConversationLink
    error: string
  }[]
}

/** 把一个会话的全部账本读出来。两种格式共用这一份采集。 */
export function collect(store: Store, conversationId: ConversationId): ArchiveBundle {
  const conversation = getConversation(store, conversationId)
  if (!conversation) throw new Error(`会话不存在：${conversationId}`)
  const collectionErrors: ArchiveBundle['collectionErrors'] = []
  const bestEffort = <T>(section: string, fallback: T, read: () => T): T => {
    try {
      return read()
    } catch (error) {
      collectionErrors.push({
        section,
        message: error instanceof Error ? error.message : String(error),
      })
      return fallback
    }
  }
  const contextByRun = new Map(
    listRunContextSnapshots(store, conversationId).map((snapshot) => [
      snapshot.runId,
      snapshot.segments,
    ]),
  )
  return {
    workspace: getWorkspace(store, conversation.workspaceId),
    conversation,
    messages: listMessages(store, conversationId),
    sessionState: {
      goal: bestEffort('sessionState.goal', null, () => currentGoal(store, conversationId)),
      todos: bestEffort('sessionState.todos', [], () => latestTodos(store, conversationId) ?? []),
      loadedTools: bestEffort('sessionState.loadedTools', [], () =>
        [...listLoadedTools(store, conversationId)].sort(),
      ),
      disabledExtras: bestEffort('sessionState.disabledExtras', [], () =>
        [...listDisabledExtras(store, conversationId)].sort(),
      ),
    },
    runs: listRuns(store, conversationId).map((r) => ({
      ...r,
      contextSnapshot: contextByRun.get(r.id) ?? [],
      steps: listSteps(store, r.id),
      providerRequests: listProviderRequests(store, r.id),
      resources: listResourcesForRun(store, r.id),
    })),
    collectionErrors,
    exportedAt: Date.now(),
  }
}

/**
 * 沿父工具 step 递归收集子 Agent 会话。
 *
 * 会话 id 是去重键，也同时是循环保护：损坏账本即使出现 A → B → A，也只采集两份正文，
 * 但三条关联事实仍会留在 `links` 里供排查。
 */
function collectConversationTree(
  store: Store,
  rootConversationId: ConversationId,
  root: ArchiveBundle,
): ConversationTree {
  const childConversations: ArchiveBundle[] = []
  const links: ChildConversationLink[] = []
  const unresolvedChildren: ConversationTree['unresolvedChildren'] = []
  const visited = new Set<ConversationId>([rootConversationId])
  const pending: ArchiveBundle[] = [root]

  for (let cursor = 0; cursor < pending.length; cursor++) {
    const parent = pending[cursor]!
    const parentConversationId = parent.conversation!.id
    for (const run of parent.runs) {
      for (const step of run.steps) {
        const child = childConversationFrom(step)
        if (!child) continue
        const link: ChildConversationLink = {
          parentConversationId,
          parentRunId: run.id,
          parentStepId: step.id,
          childConversationId: child.id,
          source: child.source,
        }
        links.push(link)
        if (visited.has(child.id)) continue
        visited.add(child.id)

        try {
          const bundle = collect(store, child.id)
          childConversations.push(bundle)
          pending.push(bundle)
        } catch (error) {
          unresolvedChildren.push({
            link,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  return { rootConversationId, childConversations, links, unresolvedChildren }
}

function childConversationFrom(
  step: Step,
): { id: ConversationId; source: ChildConversationLink['source'] } | null {
  const payload = step.payload
  if (payload?.kind !== 'tool_call' && payload?.kind !== 'tool_result') return null
  if (payload.childConversationId) {
    return { id: payload.childConversationId, source: 'step_payload' }
  }
  if (payload.kind !== 'tool_result') return null
  const historical = payload.outcome.data?.conversationId
  return typeof historical === 'string' && historical.length > 0
    ? { id: historical as ConversationId, source: 'outcome_fallback' }
    : null
}

/**
 * 给排障人员的当前会话快照。
 *
 * 会话正文、思考、工具与逐请求账本全部来自 `collect`，没有一份前端临时投影。
 * 接口配置只带判断请求形状所需的字段：协议、地址、思考档位、请求头名字与模型库覆盖。
 * API key 和请求头值绝不进入导出物。
 */
export function exportConversationDiagnostics(
  store: Store,
  conversationId: ConversationId,
  config: QyConfig,
): string {
  const bundle = collect(store, conversationId)
  const conversationTree = collectConversationTree(store, conversationId, bundle)
  const allConversations = [bundle, ...conversationTree.childConversations]
  const conversationProfiles = allConversations.map((item) => ({
    conversationId: item.conversation!.id,
    provider: diagnosticProvider(config, item.conversation!),
  }))

  return `${JSON.stringify(
    {
      kind: 'qywork.session-diagnostic',
      schemaVersion: 3,
      exportedBy: {
        name: 'qywork',
        version: pkg.version,
        runtime: `Bun ${Bun.version}`,
        platform: process.platform,
        arch: process.arch,
        storeSchemaVersion: SCHEMA_VERSION,
      },
      coverage: {
        messages: 'full',
        steps: 'full',
        childConversations: 'recursive_full',
        runContextSnapshots: 'full',
        providerRequestLedger: 'full',
        intermediateResources: 'metadata_and_references',
        attachmentBytes: 'references_only',
        rawProviderBodies: 'not_persisted',
        configuredCredentials: 'redacted',
      },
      runSignals: allConversations.flatMap((item) =>
        item.runs.map((run) => {
          const textSteps = run.steps.filter(
            (step) => step.kind === 'text' && Boolean(step.content?.trim()),
          ).length
          const thinkingSteps = run.steps.filter(
            (step) => step.kind === 'thinking' && Boolean(step.content?.trim()),
          ).length
          const toolSteps = run.steps.filter((step) => step.kind === 'tool_action')
          return {
            conversationId: item.conversation!.id,
            runId: run.id,
            textSteps,
            thinkingSteps,
            toolSteps: toolSteps.length,
            failedToolSteps: toolSteps.filter((step) => step.status === 'failure').length,
            providerRequests: run.providerRequests.length,
            finishReasons: run.providerRequests.map((request) => request.finishReason),
            hasUnsettledProviderRequest: run.providerRequests.some(
              (request) => request.status === 'pending' || request.status === 'in_flight',
            ),
            toolOnly: toolSteps.length > 0 && textSteps === 0 && thinkingSteps === 0,
          }
        }),
      ),
      provider: conversationProfiles[0]?.provider ?? null,
      conversationProfiles,
      runtimeConfig: {
        permissionMode: config.mode ?? 'auto',
        sandboxNetwork: config.sandboxNetwork ?? 'allow',
        additionalDirectories: config.additionalDirectories ?? [],
        envAllowList: config.envAllowList ?? [],
        workspaceTrusted: bundle.workspace
          ? isWorkspaceTrusted(config, bundle.workspace.rootPath)
          : null,
      },
      conversationTree,
      ...bundle,
    },
    null,
    2,
  )}\n`
}

function diagnosticProvider(
  config: QyConfig,
  conversation: NonNullable<ArchiveBundle['conversation']>,
) {
  const resolved = resolveModel(config, {
    provider: conversation.provider,
    model: conversation.model,
  })
  if (!resolved) return null
  return {
    name: resolved.provider,
    kind: resolved.kind,
    model: resolved.model,
    baseUrl: safeBaseUrl(resolved.baseUrl),
    headerNames: Object.keys(resolved.headers ?? {}).sort(),
    effort: resolved.effort ?? null,
    catalogOverride: resolved.spec ?? null,
    effectiveModel: applySpecOverride(lookupModel(resolved.model, resolved.kind), resolved.spec),
  }
}

/**
 * 端点的主机与路径影响协议排查，但 URL 也能夹带 Basic Auth 或 `?key=`。
 * 这些值与 API key / header value 同属凭证，诊断包一律不带。
 */
function safeBaseUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return '[invalid URL omitted]'
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

function renderRun(run: ArchiveBundle['runs'][number], limit: number, thinking: boolean): string[] {
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
    /*
     * run 内注入的那句用户消息。**必须在下面那个兜底之前拦下来**——
     * 兜底把剩下的一切都当思考渲染，掉进去的结果是用户的话被标成模型的思考，
     * 而不导出思考时它整句消失。
     *
     * 用二级标题打断助手那一段：它确实是对话换了个人说话。
     */
    if (s.kind === 'user') {
      if (s.content?.trim()) out.push('## 用户（执行中插入）', '', s.content, '', '## 助手', '')
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
