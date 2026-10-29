/**
 * `open_in_panel`：在界面右侧面板打开工作区中的文件，与用户点击正文中的文件链接相同。
 *
 * 工具只核对路径并返回工作区相对路径；打开由界面在收到本工具的成功结果后执行（`openFileInPanel`），
 * 画布打开为画布页签，网页进入内置浏览器，其他文件进入文件预览。只注册给有服务端的顶层会话：
 * 成员会话的工具卡不显示在当前会话中，界面不会为它打开面板。
 */

import type { ToolSpec } from '@qywork/agent'
import { displayPath, resolveInWorkspace, rootsOf } from './paths.ts'

export const openInPanelTool: ToolSpec = {
  name: 'open_in_panel',
  description:
    '在界面右侧面板打开工作区中的一个文件，与用户点击回复中的文件链接相同：*.canvas.json 打开为画布页签，' +
    '.html 在内置浏览器中打开，图片、视频、文档等进入文件预览。用户要求打开、查看工作区中的画布或文件时使用。' +
    '只打开，不读取内容；读取画布用 read_canvas，读取文件用 read_file。界面未打开时没有效果。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区中的文件路径，相对工作区' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '文件',
  category: 'files',
  facet: '查看',
  summary: '在右侧面板打开文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'read',
  parallelSafe: true,
  async fn(args, ctx) {
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return {
        status: 'failure',
        executed: false,
        message: '缺少 path',
        errorKind: 'invalid_tool_arguments',
      }
    }
    const abs = await resolveInWorkspace(rootsOf(ctx), args.path.trim(), { mustExist: true })
    const shown = displayPath(ctx.workspaceRoot, abs)
    // 面板按工作区相对路径读取文件，工作区外的文件无法在面板中打开。
    if (shown === abs || shown === '.') {
      return {
        status: 'failure',
        executed: false,
        message: `不是工作区中的文件，无法在面板中打开：${args.path}`,
        errorKind: 'invalid_tool_arguments',
      }
    }
    return {
      status: 'success',
      message: `已请求界面在右侧面板打开 ${shown}`,
      data: { path: shown },
    }
  },
}
