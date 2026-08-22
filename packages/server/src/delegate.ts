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

import { acquireExtensions, collectSecrets, releaseExtensions } from '@qywork/runtime'
import { CLI_PREFIX, findCli, runCli } from '@qywork/team'
import type { CommandDeps } from './deps.ts'
import { runBuiltinMember } from './team-run.ts'

/** 派活只用到装配三件套（账本、正文库、配置），不碰那条 WebSocket。 */
type DelegateDeps = Omit<CommandDeps, 'ws'>

export function makeDelegate(ctx: { deps: DelegateDeps; workspaceRoot: string }) {
  const { deps, workspaceRoot } = ctx

  const roles = async () => {
    // 每次现读：用户可能刚在设置页改完角色，让他为此重开一条会话不合理。
    const ext = await acquireExtensions(workspaceRoot)
    try {
      return ext.team.roles
    } finally {
      releaseExtensions(workspaceRoot)
    }
  }

  return {
    async targets() {
      const [rs, clis] = await Promise.all([roles(), (await import('@qywork/team')).detectClis()])
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
  }
}
