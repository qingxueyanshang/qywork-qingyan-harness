/**
 * `install_plugin` 工具的服务端实现。
 *
 * 与用户点击「导入」经由**同一段校验与复制**（`api/plugins.ts` 的 `readPluginDir`
 * / `copyPluginDir`）：两个入口在「清单是否合法」「同 id 如何处理」上必须给出相同结果。
 *
 * 这里另外执行一项处理：**把路径限制在工作区内**。工具收到的是模型提供的相对路径，
 * 不解析时 `../../../` 即成为「安装任意目录」，而安装的代码会在下一次加载时运行。
 */

import { resolveInWorkspace } from '@qywork/tools'
import { copyPluginDir, readPluginDir } from './api/plugins.ts'

export function makePluginPort(ctx: { workspaceRoot: string }) {
  const inside = async (dir: string) => resolveInWorkspace(ctx.workspaceRoot, dir)

  return {
    async inspect(dir: string) {
      const abs = await inside(dir).catch((e: unknown) => e as Error)
      if (abs instanceof Error) return { ok: false, error: `${dir} 不在当前项目中` }
      return await readPluginDir(abs)
    },

    async install(dir: string, opts: { replace: boolean }) {
      const abs = await inside(dir).catch((e: unknown) => e as Error)
      if (abs instanceof Error) return { ok: false, error: `${dir} 不在当前项目中` }
      // 安装之前**再读取一次清单**：inspect 与此处之间相隔模型的若干步骤，
      // 该目录可能已不是模型检查过的内容。写入时按当前清单的 id 处理。
      const found = await readPluginDir(abs)
      if (!found.ok || !found.id) return { ok: false, error: found.error ?? '无法读取清单' }

      return await copyPluginDir(abs, found.id, { replace: opts.replace })
    },
  }
}
