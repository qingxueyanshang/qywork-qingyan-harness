/**
 * `subagent` 工具的服务端实现：把一段任务交给一个角色或本机的外部 CLI。
 *
 * ## 为什么在 server
 *
 * 派一个角色出去 = 起一个成员会话，那要 `Session` 与账本；两样都在依赖图上高于
 * tools。所以工具那边只声明端口（`DelegatePort`），实现落在这里——与编排
 * （`team-run.ts`）**共用同一条成员会话路径**，不另开一套。
 *
 * ## 与编排的分工
 *
 * - 编排（`team.run`）：用户点开始，按 `.qy/team.json` 里画好的图跑，确定性的。
 * - 派活（`subagent`）：模型自己决定把哪一件事交出去，一次一个。
 *
 * 两者跑的是同一份角色定义、同一条执行路径，区别只在「谁决定派谁」。
 */

import type { DelegatePort } from '@qywork/agent'
import type { AgentEvent, ConversationId, RunId } from '@qywork/core'
import { acquireExtensions, collectSecrets, releaseExtensions } from '@qywork/runtime'
import { CLI_PREFIX, detectClis, findCli, runCli, TeamOrchestrator } from '@qywork/team'
import type { CommandDeps } from './deps.ts'
import { runBuiltinMember } from './team-run.ts'

/** 派活只用到装配三件套（账本、正文库、配置），不碰那条 WebSocket。 */
type DelegateDeps = Omit<CommandDeps, 'ws'>

export function makeDelegate(ctx: {
  deps: DelegateDeps
  workspaceRoot: string
  /** 进度事件发给哪条会话——图卡长在这条会话的那张卡上。 */
  conversationId: ConversationId
}): DelegatePort {
  const { deps, workspaceRoot, conversationId } = ctx

  /** 角色与团队规则每次现读：用户可能刚在设置页改完，让他为此重开一条会话不合理。 */
  const team = async () => {
    const ext = await acquireExtensions(workspaceRoot)
    try {
      return { roles: ext.team.roles, rules: ext.team.rules }
    } finally {
      releaseExtensions(workspaceRoot)
    }
  }
  const roles = async () => (await team()).roles

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

    async run(input: { target: string; task: string; signal: AbortSignal }) {
      if (input.target.startsWith(CLI_PREFIX)) {
        const id = input.target.slice(CLI_PREFIX.length)
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

      const role = (await roles()).find((r) => r.id === input.target)
      if (!role) return { ok: false, output: '', error: `这个项目里没有角色 ${input.target}` }
      const res = await runBuiltinMember(
        { role, prompt: input.task, signal: input.signal },
        { deps, workspaceRoot },
      )
      return {
        ok: res.ok,
        output: res.output,
        ...(res.error ? { error: res.error } : {}),
      }
    },

    /**
     * 跑一整张图。执行与 `team.run` 走**同一个编排器**：依赖就绪才启动、并发闸、
     * 人工门禁都在那边，这里只负责把图递进去、把进度广播出来、把终态收回来。
     */
    async runGraph(input) {
      const { roles: rs, rules } = await team()
      const clis = await detectClis()
      const orchestrator = new TeamOrchestrator(
        { name: 'workflow', roles: rs, rules, plan: input.nodes },
        {
          workspaceRoot,
          signal: input.signal,
          secrets: collectSecrets(deps.config),
          runId: input.runId as RunId,
          resolveCli: (id) => clis.find((c) => c.id === id),
          // 进度带上 stepId：前端按它认领是哪一张图卡。不带的话事件到了也无处可落。
          emit: (ev: AgentEvent) =>
            deps.bus.publish(
              ev.type === 'team.member' ? { ...ev, stepId: input.stepId } : ev,
              conversationId,
            ),
          runBuiltin: (member) => runBuiltinMember(member, { deps, workspaceRoot }),
          // 人工门禁与 `team.run` 同一条通道：授权请求发给用户，等他点。
          awaitHumanGate: async (nodeId, summary) =>
            deps.runs.requestPermission({
              runId: input.runId as RunId,
              conversationId,
              toolName: 'workflow',
              scope: `team:gate:${nodeId}`,
              preview: summary,
              action: { kind: 'run', objectLabel: '编排节点', target: nodeId } as never,
            }),
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
