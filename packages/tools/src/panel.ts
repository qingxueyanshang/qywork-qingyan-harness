/**
 * `open_in_panel`：在界面右侧面板打开工作区中的文件或已安装的工作台，与用户在界面上点击相同。
 *
 * 工具只核对目标并返回结果；打开由界面在收到本工具的成功结果后执行（`openFileInPanel` /
 * `openWorkbenchTab`）：画布打开为画布页签，网页进入内置浏览器，其他文件进入文件预览，工作台打开为工作台页签。
 * 只注册给有服务端的顶层会话：成员会话的工具卡不显示在当前会话中，界面不会为它打开面板。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { displayPath, resolveInWorkspace, rootsOf } from './paths.ts'
import { globalScopeRoot } from './scopes.ts'

type Outcome = Awaited<ReturnType<ToolSpec['fn']>>

function invalid(message: string): Outcome {
  return { status: 'failure', executed: false, message, errorKind: 'invalid_tool_arguments' }
}

/**
 * 核对工作台已安装：读取已安装插件的清单，按 id 查找工作台并取得名称。
 * 插件安装目录即清单 id（`~/.qywork/plugins/<插件 id>/`），与服务端提供页面文件的位置相同。
 */
async function workbenchTitle(key: string): Promise<string | null> {
  const [plugin, panel, ...rest] = key.split('/')
  if (!plugin || !panel || rest.length > 0 || plugin.includes('..') || plugin.includes('\\'))
    return null
  const file = join(globalScopeRoot(), 'plugins', plugin, 'qywork.plugin.json')
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      contributes?: { panels?: { id?: unknown; title?: unknown }[] }
    }
    const hit = manifest.contributes?.panels?.find((p) => p.id === panel)
    return typeof hit?.title === 'string' ? hit.title : null
  } catch {
    return null
  }
}

export const openInPanelTool: ToolSpec = {
  name: 'open_in_panel',
  description:
    '在界面右侧面板打开工作区中的一个文件或一个已安装的工作台，与用户在界面上点击相同。' +
    'path：*.canvas.json 打开为画布页签，.html 在内置浏览器中打开，图片、视频、文档等进入文件预览。' +
    'workbench：插件清单 contributes.panels 中声明的工作台，写作「插件 id/工作台 id」，安装后即可打开。' +
    '用户要求打开、查看工作区中的画布、文件或工作台时使用。只打开，不读取内容；读取画布用 read_canvas，' +
    '读取文件用 read_file。界面未打开时没有效果。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区中的文件路径，相对工作区；与 workbench 二选一' },
      workbench: {
        type: 'string',
        description: '已安装的工作台，「插件 id/工作台 id」；与 path 二选一',
      },
    },
    additionalProperties: false,
  },
  requireOneOf: [['path', 'workbench']],
  actionKind: 'read',
  objectLabel: '文件',
  category: 'files',
  facet: '查看',
  summary: '在右侧面板打开文件或工作台',
  targetExtractor: (a) =>
    typeof a.path === 'string' ? a.path : typeof a.workbench === 'string' ? a.workbench : null,
  permissionEffect: 'read',
  parallelSafe: true,
  async fn(args, ctx) {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const workbench = typeof args.workbench === 'string' ? args.workbench.trim() : ''
    if (path && workbench) return invalid('path 与 workbench 只给一个')
    if (workbench) {
      const title = await workbenchTitle(workbench)
      if (!title) return invalid(`没有已安装的工作台：${workbench}`)
      return {
        status: 'success',
        message: `已请求界面在右侧面板打开工作台「${title}」`,
        data: { workbench, title },
      }
    }
    if (!path) return invalid('缺少 path 或 workbench')
    const abs = await resolveInWorkspace(rootsOf(ctx), path, { mustExist: true })
    const shown = displayPath(ctx.workspaceRoot, abs)
    // 面板按工作区相对路径读取文件，工作区外的文件无法在面板中打开。
    if (shown === abs || shown === '.') {
      return invalid(`不是工作区中的文件，无法在面板中打开：${path}`)
    }
    return {
      status: 'success',
      message: `已请求界面在右侧面板打开 ${shown}`,
      data: { path: shown },
    }
  },
}
