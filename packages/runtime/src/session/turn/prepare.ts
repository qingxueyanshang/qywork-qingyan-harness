/**
 * 准备阶段：解析本轮的模型与规格，冻结非对话上下文（扩展工具、技能、记忆、项目说明文件、待办、运行环境）。
 * 在写入 run 行之前完成，抛出时不留下任何记录。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DelegatePort, softLimit } from '@qywork/agent'
import { buildAdapter, type ProviderProfile } from '@qywork/ai'
import type { ConversationId, WorkflowProjection } from '@qywork/core'
import { foldWorkflow } from '@qywork/core'
import {
  createConversation,
  getConversation,
  latestTodos,
  listWorkflowRecords,
  permissionModeOf,
  type Store,
  workflowIdsOf,
} from '@qywork/store'
import {
  conversationTempDir,
  displayPath,
  listScopedEntries,
  scanSkills,
  scopeRoots,
} from '@qywork/tools'
import {
  compactPercentFor,
  type ModelRef,
  modelLabel,
  NO_MODEL_MESSAGE,
  resolveModel,
} from '../../config.ts'
import { contextPanel } from '../../context-panel.ts'
import { describeEnvironment, ensureWorkspacePython } from '../../environment.ts'
import { findPython } from '../../office.ts'
import { buildTailNotes, mediaModelsNote } from '../../prompt.ts'
import { loadExtensionTools } from '../extension-tools.ts'
import type { AskOptions, SessionState } from '../types.ts'
import { type KnownContext, MEDIA_CHANGED_HEADING, registeredMediaModels } from './known-context.ts'
import type { TurnPlan } from './state.ts'

export async function prepareTurn(
  session: SessionState,
  existing: ConversationId | undefined,
  options: AskOptions | undefined,
): Promise<TurnPlan> {
  const { store, config } = session.opts
  // 必须在下方的准备步骤之前取值：写入 run 之前的扩展装配与目录扫描同样是用户的等待时间。
  const startedAt = options?.startedAt ?? Date.now()

  // 模型优先级：本轮显式指定 > 会话当前模型 > 配置默认。
  // 会话是权威：config 只在会话尚无模型时作为回退，否则用户在界面上切换模型后，
  // 下一轮又会被配置文件中的默认值静默覆盖。使用 `||` 而不是 `??`：未配置模型的会话
  // provider/model 存储为空串，空串须视为未设置并继续回退。
  const prior = existing ? getConversation(store, existing) : undefined
  const model = options?.model || prior?.model || config.active?.model
  // 三处均无法取得模型表示用户尚未配置模型：在启动 run 之前于此处拒绝，不创建会话、不发送请求。
  // 服务端已在 `run-control` 中预先拦截并返回结构化的 `no_model`；此处是 CLI 与直接调用的后备处理。
  if (!model) throw new Error(NO_MODEL_MESSAGE)

  const conversationId =
    existing ??
    createConversation(store, {
      workspaceId: session.workspaceId as never,
      // 新会话记录默认的接口与模型；没有默认接口时按哪个接口配置了该模型反查。
      provider: config.active?.provider || resolveModel(config, model)?.provider || '',
      model,
      ...(options?.source ? { source: options.source } : {}),
      ...(options?.sourceRef ? { sourceRef: options.sourceRef } : {}),
      ...(options?.parentConversationId
        ? { parentConversationId: options.parentConversationId }
        : { mode: config.mode ?? 'auto' }),
    }).id

  const conversation = getConversation(store, conversationId)
  /*
   * 会话记录了接口名时按记录的接口与模型发送，不再按模型 id 反查：两个接口配置同一
   * 模型 id 时反查结果取决于枚举顺序，出错时端点、key 与价目表都会改变，且不会报错。
   * 单轮显式 `--model` 是用户主动要求的裸模型选择，按 `resolveModel` 的裸模型名规则解析。
   */
  const target: string | ModelRef =
    !options?.model && conversation?.provider ? { provider: conversation.provider, model } : model
  // 思考强度：派发子 agent 时传入的档位优先，否则取配置中「接口 × 模型」对应的条目。
  // 不保存会话级的第二份，也不共用一个全局值：档位集合因模型而异（见 `StoredModel.effort`），
  // 套用全局值必然不匹配。
  const resolvedTarget = resolveModel(config, target)
  const effort = options?.effort ?? resolvedTarget?.effort

  /*
   * 冻结本 run 的非对话上下文。
   *
   * 这一步必须在写入 run 之前完成：扩展工具、技能、记忆与待办只读取一次，随后与 run
   * 同行写入数据库。loop 内任何一次 provider 请求都不再临时重新计算，重启也从同一份快照
   * 重建，因此上下文字节不会随执行波次变化。
   */
  // 本轮的规格只在此处解析一次：工具上下文、摘要与记账都使用这一份。各自重新解析时，
  // 轮次进行中保存配置会使它们取得不同的规格，接口被删除时记账步骤抛出异常。
  const profile = resolveProfile(session, target)
  const adapter = buildAdapter(profile)
  /*
   * 自动压缩比例在此解析一次，一轮之内不变：触发判定、压缩、请求行的触发线与写给模型的百分比都取这一个值。
   * 配置不合法时在写入轮次之前抛出配置错误，不改用缺省值。
   */
  const compactPercent = compactPercentFor(config, adapter.spec)
  if (!session.extensions) {
    await loadExtensionTools(session, adapter.spec.density)
  }
  const roots = scopeRoots(session.opts.workspaceRoot)
  const skills = await scanSkills(roots).catch(() => [])
  session.skillDirs = skills.map((s) => s.dir)
  const memories = await listScopedEntries(roots).catch(() => [])
  const projectInstructions = await projectInstructionFiles(session.opts.workspaceRoot)
  const canAssignModels = ['define_role', 'subagent', 'workflow'].some((name) =>
    session.registry.has(name),
  )
  // 只列出本会话实际拥有工具的类别：角色只指定了视频工具时，不提供图像模型的参数表。
  const mediaModels = registeredMediaModels(session)
  // 跟进消息注入时的比较基准：本轮快照中的生成模型与面板文件（`changedContext`）。
  const known: KnownContext = {
    media: mediaModelsNote(mediaModels, MEDIA_CHANGED_HEADING),
    ...(options?.viewing ? { viewing: options.viewing } : {}),
  }
  // 角色、外部 CLI、本会话已有的子 agent：模型据此按 id 引用，不推测名称。
  // 所用模型按名称写出（`modelLabel`）：云端型号的 id 是编号，只写 id 时无法判断是哪一个模型。
  const delegate = canAssignModels ? session.ports.get(DelegatePort) : undefined
  const team = await delegate?.targets()
  const subagents = await delegate?.subagents()
  const delegateFacts =
    team && subagents
      ? {
          team: {
            ...team,
            roles: team.roles.map((role) =>
              role.provider && role.model
                ? {
                    ...role,
                    label: modelLabel(config, { provider: role.provider, model: role.model }),
                  }
                : role,
            ),
          },
          subagents: subagents.map((item) => ({ ...item, label: modelLabel(config, item) })),
        }
      : {}
  // 运行环境随快照冻结。auto 模式下工作区 Python 环境在此确保存在，命令中的 python 与 pip 指向它
  // （tools `commandEnv`）；完全访问模式不创建，装入全局还是工作区由模型选择。
  const mode = permissionModeOf(store, conversationId)
  const python = findPython(config)
  const venvError =
    python && mode === 'auto'
      ? await ensureWorkspacePython(session.opts.workspaceRoot, python)
      : null
  const environment = await describeEnvironment(session.opts.workspaceRoot, python, venvError, mode)
  // 本轮开始时的上下文占用：与面板、运行中读数和压缩触发同一口径，不另行估算。
  const context = contextPanel(
    store,
    conversationId,
    {
      id: adapter.spec.id,
      contextWindow: adapter.spec.contextWindow,
      providerName: resolvedTarget?.provider ?? '',
      providerKind: adapter.kind,
    },
    compactPercent,
  )
  const contextSnapshot = buildTailNotes({
    workspaceRoot: session.opts.workspaceRoot,
    environment,
    // 触发线按本轮的比例计算，不取面板的值：面板显示的是上一轮请求行的触发线，设置修改后两者不同。
    context: {
      used: context.total,
      window: context.limit,
      compactAt: softLimit({ contextWindow: adapter.spec.contextWindow, compactPercent }),
    },
    tempDir: displayPath(
      session.opts.workspaceRoot,
      conversationTempDir(session.opts.workspaceRoot, conversationId),
    ),
    platform: process.platform,
    mode,
    ...(projectInstructions.length ? { projectInstructions } : {}),
    skills,
    memories,
    // 派发工具存在时才提供；成员会话没有 delegate，既无法取得清单，也无法递归派发任务。
    // 已下架的型号不列出，与界面的模型选择一致：请求必然被拒绝，且云端型号换用新编号后旧编号保留同一名称，列出时出现两行同名。
    ...(canAssignModels
      ? {
          models: Object.entries(config.providers).flatMap(([provider, stored]) =>
            Object.entries(stored.models)
              .filter(([, declared]) => !declared.delisted)
              .map(([model]) => ({
                provider,
                model,
                label: modelLabel(config, { provider, model }),
                current: resolvedTarget?.provider === provider && resolvedTarget.model === model,
              })),
          ),
        }
      : {}),
    ...delegateFacts,
    // 参数表随生成工具提供：工具未注册（未配置模型、角色未指定）时不提供。
    ...(mediaModels.length ? { mediaModels } : {}),
    ...(options?.viewing ? { viewing: options.viewing } : {}),
    pendingMcp: session.extensions?.mcpConfig.pending ?? [],
    todos: latestTodos(store, conversationId),
    // 未执行完毕的任务图随快照一并冻结。没有派发通道时不存在任务图，无需查询。
    ...(canAssignModels ? { workflows: unfinishedWorkflows(store, conversationId) } : {}),
  })
  return {
    startedAt,
    model,
    conversationId,
    conversation,
    target,
    resolvedTarget,
    effort,
    profile,
    adapter,
    compactPercent,
    known,
    contextSnapshot,
  }
}

/**
 * 解析本轮使用的接口与凭证。
 *
 * 入参是 `ModelRef` 时接口已确定（会话自身记录了归属），是裸模型名时
 * 按模型 id 反查接口：后者用于 `qy ask --model x` 这类用户只指定模型、不指定接口
 * 的入口。规则只有 `resolveModel` 一处：界面上列出的协议与本轮实际
 * 发出的协议必须一致。
 *
 * 每次使用时实时解析：在构造函数中解析一次并固定时，会话级模型切换无法生效。
 */
export function resolveProfile(
  session: Pick<SessionState, 'opts'>,
  target?: string | ModelRef,
): ProviderProfile {
  const { providers, active } = session.opts.config
  const stored = resolveModel(session.opts.config, target)
  if (!stored) {
    const who = typeof target === 'object' ? target.provider : (active?.provider ?? '（未配置）')
    throw new Error(
      `配置中没有名为 "${who}" 的接口。可用：${Object.keys(providers).join(', ') || '（空）'}`,
    )
  }
  return {
    kind: stored.kind,
    apiKey: stored.apiKey ?? '',
    model: stored.model,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.headers ? { headers: stored.headers } : {}),
    ...(stored.spec ? { spec: stored.spec } : {}),
    ...(stored.transport ? { transport: stored.transport } : {}),
  }
}

/**
 * 本会话中尚未完成的任务图。
 *
 * 折叠失败的任务图（首次派发的参数已不合法）整条跳过：该任务图无法继续执行，
 * 将错误信息写入运行上下文只会使模型尝试修复一份它无法读取的记录。
 */
function unfinishedWorkflows(store: Store, conversationId: ConversationId): WorkflowProjection[] {
  const records = listWorkflowRecords(store, conversationId)
  const out: WorkflowProjection[] = []
  for (const workflowId of workflowIdsOf(records)) {
    const folded = foldWorkflow(records, workflowId)
    if (folded.ok && folded.projection.phase !== 'completed') out.push(folded.projection)
  }
  return out
}

/** 仓库写给编码 agent 的说明文件，按此顺序列出。 */
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

/** 工作区根目录中存在的项目说明文件与行数。只读取根目录：子目录中的同名文件属于各自的模块，由模型按需查找。 */
export async function projectInstructionFiles(
  workspaceRoot: string,
): Promise<{ file: string; lines: number }[]> {
  const found: { file: string; lines: number }[] = []
  for (const file of PROJECT_INSTRUCTION_FILES) {
    const text = await readFile(join(workspaceRoot, file), 'utf8').catch(() => null)
    if (text === null) continue
    // 末尾的换行不另计一行。
    const lines = text === '' ? 0 : text.replace(/\r?\n$/, '').split('\n').length
    found.push({ file, lines })
  }
  return found
}
