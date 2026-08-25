/**
 * `install_plugin` 工具的服务端实现。
 *
 * 与用户点「导入」走的是**同一段校验与复制**（`api/plugins.ts` 的 `readPluginDir`
 * / `copyPluginDir`）：两条入口在「清单合不合法」「同 id 怎么办」上必须给同一个答案。
 *
 * 这里额外做一件事：**把路径钉回工作区内**。工具收到的是模型给的相对路径，
 * 不解析的话 `../../../` 就成了「装任意目录」——而装进去的代码下一次加载就会跑。
 */

import { resolveInWorkspace } from '@qywork/tools'
import { copyPluginDir, readPluginDir } from './api/plugins.ts'

export function makePluginPort(ctx: { workspaceRoot: string }) {
  const inside = async (dir: string) => resolveInWorkspace(ctx.workspaceRoot, dir)

  return {
    async inspect(dir: string) {
      const abs = await inside(dir).catch((e: unknown) => e as Error)
      if (abs instanceof Error) return { ok: false, error: `${dir} 不在这个项目里` }
      return await readPluginDir(abs)
    },

    async install(dir: string, opts: { replace: boolean }) {
      const abs = await inside(dir).catch((e: unknown) => e as Error)
      if (abs instanceof Error) return { ok: false, error: `${dir} 不在这个项目里` }
      // 装之前**再读一次清单**：inspect 与这里之间隔着模型的几步，
      // 那个目录可能已经不是它看过的那一份了。落盘按现在这一份的 id 走。
      const found = await readPluginDir(abs)
      if (!found.ok || !found.id) return { ok: false, error: found.error ?? '清单读不出来' }

      return await copyPluginDir(abs, found.id, { replace: opts.replace })
    },
  }
}
