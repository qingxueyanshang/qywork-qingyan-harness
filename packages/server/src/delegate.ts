/**
 * `subagent` 工具的服务端实现：把一段任务交给一个角色或本机的外部 CLI。
 *
 * ## 为什么在 server
 *
 * 派一个角色出去 = 起一个成员会话，那要 `Session` 与账本；两样都在依赖图上高于
 * tools。所以工具那边只声明端口（`DelegatePort`），实现落在这里——与编排
 * （`team-run.ts`）**共用同一条成员会话路径**，不另开一套。
 *
 * ## 派一件与派一张图
 *
 * - `subagent`：一次一件，直接起一条成员会话。
 * - `workflow`：一整张图，交给编排器按依赖跑。
 *
 * 两者跑的是同一份角色定义、同一条成员会话路径，区别只在有没有图。
 */

import type { DelegatePort } from '@qywork/agent'
import type { AgentEvent, ConversationId, RunId } from '@qywork/core'
import { collectSecrets, loadTeamConfig, type ModelRef } from '@qywork/runtime'
import { getConversation } from '@qywork/store'
import { CLI_PREFIX, detectClis, findCli, type Role, runCli, TeamOrchestrator } from '@qywork/team'
import type { CommandDeps } from './deps.ts'
import { resolveModel, runBuiltinMember } from './team-run.ts'

/** 派活只用到装配三件套（账本、正文库、配置），不碰那条 WebSocket。 */
type DelegateDeps = Omit<CommandDeps, 'ws'>

/**
 * 不指定目标时用的那个临时子 agent。
 *
 * **没有系统提示词、不限工具、不限步数**：它要干的事由任务本身说清楚，
 * 而「铺开去查几件小事」正是它的用途——给它一套约束就成了又一个需要先定义的角色。
 * 会话仍然是独立的：上下文不与父会话共享，产出只有最终那段文本。
 */
const AD_HOC_ROLE: Role = {
  id: 'ad-hoc',
  name: '临时子 agent',
  description: '当前模型、全套工具，任务结束即销毁',
  systemPrompt: '',
}

export function makeDelegate(ctx: {
  deps: DelegateDeps
  workspaceRoot: string
  /** 进度事件发给哪条会话——图卡长在这条会话的那张卡上。 */
  conversationId: ConversationId
}): DelegatePort {
  const { deps, workspaceRoot, conversationId } = ctx

  /**
   * 角色与团队规则**每次直接读文件**，不走 `acquireExtensions`。
   *
   * 那份扩展是引用计数缓存的，服务全程持有一份——于是模型这一轮用 `define_subagent`
   * 刚建好的角色，在同一轮里派活时根本看不见。实测撞到过：文件写成了、`subagent`
   * 的清单里却只有外部 CLI，模型反复重试后判定「派活引擎读的是另一份文件」。
   * 设置页那条接口（`api/team.ts`）出于同样的理由也是直接读。
   */
  const team = async () => {
    const cfg = await loadTeamConfig(workspaceRoot)
    return { roles: cfg.roles, rules: cfg.rules }
  }
  const roles = async () => (await team()).roles

  /**
   * 父会话当前的「接口 × 模型」。成员没点名接口时跟着它跑，而不是跟着 `config.active`。
   *
   * **每次现读**：模型是会话级属性，用户在界面上随时能切；这一轮开始时读到的那一对
   * 才是他要的那一对。迁移 24 之前建的会话 `provider` 是空串，这种回 undefined，
   * 由下游落回配置默认。
   */
  const inherited = () => {
    const c = getConversation(deps.store, conversationId)
    return c?.provider && c.model ? { provider: c.provider, model: c.model } : undefined
  }

  /** 这一次用哪一对：点名了就解析它，没点名就继承父会话。 */
  const pick = (
    named?: string,
  ): { explicit: ModelRef } | { inherit: ModelRef } | Record<string, never> | { error: string } => {
    if (named) {
      const r = resolveModel(named, deps.config)
      return 'error' in r ? r : { explicit: r }
    }
    const pair = inherited()
    return pair ? { inherit: pair } : {}
  }

  return {
    async targets() {
      const [rs, clis] = await Promise.all([roles(), detectClis()])
      return [
        ...rs.map((r) => ({
          id: r.id,
          kind: 'role' as const,
          description: r.description || r.name,
        })),
        ...clis.map((c) => ({
          id: `${CLI_PREFIX}${c.id}`,
          kind: 'cli' as const,
          // 接没接入要说出来：派给一个没登录的 CLI，回来的是它的登录提示，
          // 而模型会把那段当成任务产出。
          description: `${c.vendor} · ${c.connected ? '已接入' : '未见凭证'}`,
        })),
      ]
    },

    async run(input: { target: string; task: string; model?: string; signal: AbortSignal }) {
      if (input.target.startsWith(CLI_PREFIX)) {
        const id = input.target.slice(CLI_PREFIX.length)
        // 外部 CLI 用它自己的模型，接不了这个参数。当场说出来，
        // 不是照跑一遍再让用户以为换过了。
        if (input.model) {
          return { ok: false, output: '', error: `${id} 用它自己的模型，指定不了 ${input.model}` }
        }
        const cli = await findCli(id)
        if (!cli) return { ok: false, output: '', error: `本机没有识别到 ${id}` }
        const r = await runCli(cli, {
          prompt: input.task,
          workspaceRoot,
          signal: input.signal,
          // 外部 CLI 要它自己的 key 才能干活，但 qywork 配置里那几把它一把用不上。
          secrets: collectSecrets(deps.config),
        })
        return {
          ok: r.ok,
          output: r.output,
          ...(r.ok
            ? {}
            : {
                error: r.timedOut
                  ? '超时'
                  : `退出码 ${r.exitCode}${r.stderr ? `：${r.stderr.slice(-500)}` : ''}`,
              }),
        }
      }

      const role = input.target ? (await roles()).find((r) => r.id === input.target) : AD_HOC_ROLE
      if (!role) return { ok: false, output: '', error: `这个项目里没有角色 ${input.target}` }
      const picked = pick(input.model)
      if ('error' in picked) return { ok: false, output: '', error: picked.error }
      const res = await runBuiltinMember(
        { role, prompt: input.task, signal: input.signal },
        { deps, workspaceRoot, ...picked },
      )
      return {
        ok: res.ok,
        output: res.output,
        ...(res.error ? { error: res.error } : {}),
        // 子会话不进会话列表，这个 id 是点开它的唯一入口。
        ...(res.conversationId ? { conversationId: res.conversationId } : {}),
      }
    },

    /**
     * 跑一整张图。依赖就绪才启动、并发闸都在编排器那边，
     * 这里只负责把图递进去、把进度广播出来、把终态收回来。
     */
    async runGraph(input) {
      const { roles: rs, rules } = await team()
      const clis = await detectClis()
      const orchestrator = new TeamOrchestrator(
        // 临时子 agent 排在用户的角色**后面**：同 id 时先找到的是用户那条，
        // 他定义的东西盖过内置的默认。
        { name: 'workflow', roles: [...rs, AD_HOC_ROLE], rules, plan: input.nodes },
        {
          workspaceRoot,
          signal: input.signal,
          secrets: collectSecrets(deps.config),
          runId: input.runId as RunId,
          resolveCli: (id) => clis.find((c) => c.id === id),
          // 进度带上 stepId：前端按它认领是哪一张图卡。不带的话事件到了也无处可落。
          emit: (ev: AgentEvent) =>
            deps.bus.publish(
              ev.type === 'team.member' || ev.type === 'team.output'
                ? { ...ev, stepId: input.stepId }
                : ev,
              conversationId,
            ),
          runBuiltin: async (member) => {
            const picked = pick(member.model)
            if ('error' in picked) return { ok: false, output: '', error: picked.error }
            return runBuiltinMember(member, { deps, workspaceRoot, ...picked })
          },
        },
      )
      try {
        const results = await orchestrator.run(input.goal)
        return {
          ok: results.every((r) => r.status === 'done'),
          nodes: results,
        }
      } catch (err) {
        // 图本身不合法（成环、悬空依赖、门禁引用不到角色）在这里落地：
        // 它是模型写错了参数，要原样告诉它，不能压成一句「工具执行出错」。
        return { ok: false, error: err instanceof Error ? err.message : String(err), nodes: [] }
      }
    },
  }
}
