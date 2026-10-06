/**
 * 会话导出。
 *
 * 不支持把会话迁移到另一台机器（需要账号体系、冲突合并与正文迁移）；
 * 支持把会话导出为可阅读、可存档、可附在 issue 中的文档。
 * 本模块只读，导出物是静态快照，不承诺可以导回。
 *
 * 两种格式，各有明确用途：
 *
 * - markdown：供人阅读。工具调用折叠为一行摘要，失败的调用展开；正文不含 base64。
 * - json：供脚本读取。完整导出消息、run、step、payload，不做任何裁剪。
 *   两种格式的取舍相反，合并为一种会使两种用途都无法满足。
 */

import { applySpecOverride, diagnosticEndpoint, lookupModel } from '@qywork/ai'
import type {
  ConversationId,
  Message,
  ProviderRequest,
  Run,
  RunContextSegment,
  Step,
} from '@qywork/core'
import { isNoticeStep } from '@qywork/core'
import {
  currentGoal,
  getConversation,
  getWorkspace,
  latestTodos,
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
import { resolveModel } from './config.ts'
import { contextPanel } from './context-panel.ts'

export type ArchiveFormat = 'markdown' | 'json'

export interface ArchiveOptions {
  /** 工具参数与结果的截断长度。仅用于 markdown，json 不截断。 */
  maxToolChars?: number
  /** 是否包含思考内容。默认不包含：思考内容通常很长，且对读者价值最低。 */
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
  source: 'step_payload'
}

export interface ConversationTree {
  rootConversationId: ConversationId
  /** 根会话位于诊断包顶层；此处只包含全部后代，按首次出现顺序排列。 */
  childConversations: ArchiveBundle[]
  /** 扁平边表可还原父子层级，同一子会话被多处引用时正文只导出一份。 */
  links: ChildConversationLink[]
  unresolvedChildren: {
    link: ChildConversationLink
    error: string
  }[]
}

/** 读取一个会话的全部账本。两种格式共用同一份采集结果。 */
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
    bestEffort('runContextSnapshots', [], () => listRunContextSnapshots(store, conversationId)).map(
      (snapshot) => [snapshot.runId, snapshot.segments],
    ),
  )
  return {
    workspace: bestEffort('workspace', null, () => getWorkspace(store, conversation.workspaceId)),
    conversation,
    messages: bestEffort('messages', [], () => listMessages(store, conversationId)),
    sessionState: {
      goal: bestEffort('sessionState.goal', null, () => currentGoal(store, conversationId)),
      todos: bestEffort('sessionState.todos', [], () => latestTodos(store, conversationId) ?? []),
      loadedTools: bestEffort('sessionState.loadedTools', [], () =>
        [...listLoadedTools(store, conversationId)].sort(),
      ),
    },
    runs: bestEffort('runs', [], () => listRuns(store, conversationId)).map((r) => ({
      ...r,
      contextSnapshot: contextByRun.get(r.id) ?? [],
      steps: bestEffort(`runs.${r.id}.steps`, [], () => listSteps(store, r.id)),
      providerRequests: bestEffort(`runs.${r.id}.providerRequests`, [], () =>
        listProviderRequests(store, r.id),
      ),
      resources: bestEffort(`runs.${r.id}.resources`, [], () => listResourcesForRun(store, r.id)),
    })),
    collectionErrors,
    exportedAt: Date.now(),
  }
}

/**
 * 沿父工具 step 递归收集子 Agent 会话。
 *
 * 会话 id 既是去重键，也用于防止循环：损坏的账本即使出现 A → B → A，也只采集两份正文，
 * 三条关联事实仍保留在 `links` 中供排查。
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
        for (const child of childConversationsFrom(step)) {
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
  }

  return { rootConversationId, childConversations, links, unresolvedChildren }
}

/** 任务派发 step 创建的子会话：派发卡片上每一项创建的子 agent。 */
function childConversationsFrom(
  step: Step,
): { id: ConversationId; source: ChildConversationLink['source'] }[] {
  const payload = step.payload
  if (payload?.kind !== 'tool_call' && payload?.kind !== 'tool_result') return []
  return Object.values(payload.nodes ?? {}).flatMap((node) =>
    node.subagentId ? [{ id: node.subagentId, source: 'step_payload' as const }] : [],
  )
}

/**
 * 诊断包用于转发给他人，工具图片的原始字节不属于排障信息。
 * 运行账本与普通 JSON 存档保持完整；只在分享这一边界把字节替换为明确的长度元数据。
 */
function diagnosticBundle(bundle: ArchiveBundle): ArchiveBundle {
  return {
    ...bundle,
    runs: bundle.runs.map((run) => ({
      ...run,
      steps: run.steps.map((step) => {
        const payload = step.payload
        if (payload?.kind !== 'tool_result') return step
        const data = payload.outcome.data
        if (!Array.isArray(data?.images)) return step

        const images = data.images.map((image) => {
          if (typeof image !== 'object' || image === null) return image
          const record = image as Record<string, unknown>
          if (typeof record.data !== 'string') return image
          const { data: base64, ...metadata } = record
          return { ...metadata, base64Chars: base64.length, bytesOmitted: true }
        })
        return {
          ...step,
          payload: {
            ...payload,
            outcome: { ...payload.outcome, data: { ...data, images } },
          },
        }
      }),
    })),
  }
}

/**
 * 供排障人员使用的当前会话快照。
 *
 * 会话正文、思考、工具与逐请求账本全部来自 `collect`，不含任何前端临时投影；
 * 工具结果中的媒体字节只在导出边界替换为长度元数据。
 * 接口配置只包含判断请求形状所需的字段：协议、地址、思考档位、请求头名称与模型库覆盖。
 * API key 与请求头的值不进入导出物。
 */
export function exportConversationDiagnostics(
  store: Store,
  conversationId: ConversationId,
  config: QyConfig,
): string {
  const bundle = collect(store, conversationId)
  const conversationTree = collectConversationTree(store, conversationId, bundle)
  const allConversations = [bundle, ...conversationTree.childConversations]
  const exportedBundle = diagnosticBundle(bundle)
  const exportedTree = {
    ...conversationTree,
    childConversations: conversationTree.childConversations.map(diagnosticBundle),
  }
  const conversationProfiles = allConversations.map((item) => {
    let provider: ReturnType<typeof diagnosticProvider> = null
    let context: ReturnType<typeof contextPanel> | null = null
    try {
      provider = diagnosticProvider(config, item.conversation!)
      if (provider)
        context = contextPanel(store, item.conversation!.id, {
          id: provider.model,
          contextWindow: provider.effectiveModel.contextWindow,
          providerName: provider.name,
          providerKind: provider.kind,
        })
    } catch (error) {
      item.collectionErrors.push({
        section: 'currentProfile',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return {
      conversationId: item.conversation!.id,
      source: 'export_time' as const,
      provider,
      context,
    }
  })

  return `${JSON.stringify(
    {
      kind: 'qywork.session-diagnostic',
      schemaVersion: 8,
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
        steps: 'full_except_tool_result_media',
        childConversations: 'recursive_full_except_tool_result_media',
        runContextSnapshots: 'full',
        providerRequestLedger: 'full',
        requestConfiguration: 'persisted_at_assembly_when_available',
        conversationProfiles: 'export_time_not_historical',
        providerFailureAndRetryDecisions: 'persisted_when_observed',
        runInterruptionSources: 'persisted_when_observed',
        sidecarExitCodeSignalAndStderrTail: 'persisted_on_supervised_restart',
        intermediateResources: 'metadata_and_references',
        attachmentBytes: 'references_only',
        toolResultMedia: 'metadata_only',
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
            summaryRequests: run.providerRequests.filter((r) => r.purpose === 'summary').length,
            failedSummaryRequests: run.providerRequests.filter(
              (r) =>
                r.purpose === 'summary' && (r.status === 'rejected' || r.status === 'uncertain'),
            ).length,
            requestsWithoutConfiguration: run.providerRequests.filter(
              (r) => r.configuration === null,
            ).length,
            failedRequestsWithoutDiagnostics: run.providerRequests
              .filter(
                (r) =>
                  (r.status === 'rejected' || r.status === 'uncertain') && r.diagnostic === null,
              )
              .map((r) => r.id),
            compactions: run.steps
              .filter((s) => s.kind === 'compaction')
              .map((s) => ({ stepId: s.id, ...s.payload })),
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
      },
      conversationTree: exportedTree,
      ...exportedBundle,
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
    baseUrl: diagnosticEndpoint(resolved.baseUrl),
    headerNames: Object.keys(resolved.headers ?? {}).sort(),
    effort: resolved.effort ?? null,
    catalogOverride: resolved.spec ?? null,
    effectiveModel: applySpecOverride(lookupModel(resolved.model, resolved.kind), resolved.spec),
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
 * JSON：不裁剪。
 *
 * 该格式供脚本使用，裁剪会隐藏导出内容不完整这一事实，
 * 而脚本无法像人一样察觉内容缺失。
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

  // 压缩过的会话必须在开头注明：读者看到的历史与模型看到的不同，
  // 不注明时，模型遗忘前文的原因将无从查明。
  if (c.compactionManifest) {
    out.push(
      `- ⚠ 本会话已压缩（修订 ${c.compactionManifest.revision}）：` +
        '模型收到的是摘要，以下为完整原文',
    )
  }
  out.push('')

  const stepsByRun = new Map(bundle.runs.map((r) => [r.userMessageId ?? '', r]))

  for (const m of bundle.messages) {
    out.push('---', '', `## 用户`, '', m.content, '')
    const run = stepsByRun.get(m.id)
    if (run) out.push(...renderRun(run, limit, opts.includeThinking === true))
  }

  return `${out.join('\n')}\n`
}

function renderRun(run: ArchiveBundle['runs'][number], limit: number, thinking: boolean): string[] {
  const out: string[] = ['## 助手', '']

  for (const s of run.steps) {
    if (s.kind === 'text') {
      if (s.content?.trim()) out.push(s.content, '')
      continue
    }
    if (s.kind === 'compaction') {
      out.push('> （此处进行了一次上下文压缩）', '')
      continue
    }
    if (s.kind === 'tool_action') {
      out.push(...renderTool(s, limit))
      continue
    }
    /*
     * run 内注入的用户消息。必须在下方的默认分支之前处理：
     * 默认分支把其余内容全部按思考渲染，进入该分支会使用户消息被标为模型的思考，
     * 不导出思考时整句消失。
     *
     * 用二级标题分隔助手段落：此处对话的发言者发生了变化。
     */
    if (s.kind === 'user') {
      if (s.content?.trim() && !isNoticeStep(s)) {
        out.push('## 用户（执行中插入）', '', s.content, '', '## 助手', '')
      }
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
 * 工具调用渲染为一行摘要，失败的调用展开。
 *
 * 读者通常不查看成功的调用；失败的调用最需要细节。
 * 全部折叠或全部展开，都会使文档在最需要信息的位置缺少有效信息。
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
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断，完整内容见 json 导出）`
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}
