/**
 * `install_plugin` 工具的服务端实现。
 *
 * 与用户点「导入」走的是**同一段校验与复制**（`api/plugins.ts` 的 `readPluginDir`
 * / `copyPluginDir`）：两条入口在「清单合不合法」「同 id 怎么办」上必须给同一个答案。
 *
 * 这里额外做一件事：**把路径钉回工作区内**。工具收到的是模型给的相对路径，
 * 不解析的话 `../../../` 就成了「装任意目录」——而装进去的东西下一次加载就会跑。
 */

import type { ConversationId, RunId } from '@qywork/core'
import { resolveInWorkspace } from '@qywork/tools'
import { copyPluginDir, readPluginDir } from './api/plugins.ts'
import type { CommandDeps } from './deps.ts'

/** 授权卡上那几行之间的换行。 */
const NEWLINE = String.fromCharCode(10)

export function makePluginPort(ctx: {
  deps: Omit<CommandDeps, 'ws'>
  workspaceRoot: string
  /** 授权请求发给哪条会话——用户在那条会话里点头。 */
  conversationId: ConversationId
}) {
  const inside = async (dir: string) => resolveInWorkspace(ctx.workspaceRoot, dir)

  return {
    async inspect(dir: string) {
      const abs = await inside(dir).catch((e: unknown) => e as Error)
      if (abs instanceof Error) return { ok: false, error: `${dir} 不在这个项目里` }
      return await readPluginDir(abs)
    },

    async install(dir: string, opts: { replace: boolean; runId: string }) {
      const abs = await inside(dir).catch((e: unknown) => e as Error)
      if (abs instanceof Error) return { ok: false, error: `${dir} 不在这个项目里` }
      // 问之前**再读一次清单**：从模型看过到用户点头之间隔着思考时间，
      // 期间那个目录可能已经不是他看到的那一份了。用户点的必须是他看到的那一份。
      const found = await readPluginDir(abs)
      if (!found.ok || !found.id) return { ok: false, error: found.error ?? '清单读不出来' }

      const lines = [
        `插件 ${found.name ?? found.id}（${found.id}）版本 ${found.version ?? '未标'}`,
        found.tools?.length ? `注册工具：${found.tools.join('、')}` : '不注册任何工具',
        found.permissions?.length ? `申请权限：${found.permissions.join('、')}` : '不申请任何权限',
      ]
      if (found.replacing) lines.push('这一次会覆盖本机已装的同名插件')
      const granted = await ctx.deps.runs.requestPermission({
        runId: opts.runId as RunId,
        conversationId: ctx.conversationId,
        toolName: 'install_plugin',
        // **每个插件一个 scope，且带上版本**：授权范围放到「以后装什么都行」
        // 就等于把这道闸拆了，而它拦的是「一段代码要在这台机器上跑」。
        scope: `install_plugin:${found.id}@${found.version ?? '?'}`,
        preview: lines.join(NEWLINE),
        action: { kind: 'run', objectLabel: '插件', target: found.id } as never,
      })
      if (!granted) return { ok: false, error: '用户没同意装这个插件' }

      return await copyPluginDir(abs, found.id, { replace: opts.replace })
    },
  }
}
