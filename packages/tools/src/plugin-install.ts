/**
 * 把工作区中已编写好的插件目录安装到本机的插件目录。
 *
 * **编写与安装是两个步骤。** 编写代码使用普通文件工具：本机插件目录是全局目录，不在工作区内，
 * 模型在工作区中编写多少次都不会运行任何代码。**安装**才是分界：安装之后，
 * 这段代码会在下一次加载时执行。
 *
 * **安全检查依靠清单校验，不依靠确认弹窗。** 本产品只有 `auto` / `full` 两种权限模式，
 * 没有「逐次询问」模式；执行到本工具即视为同意。因此格式不正确时必须立即拒绝，且不写入磁盘：
 * 清单中无法识别的 `permissionEffect`、声明了工具却未声明相应权限，都在安装前拦截。
 *
 * **安装的是快照。** 安装即整目录复制。之后修改工作区中的源码不影响已安装的副本，修改后需重新安装，
 * 新版本同样先经过清单校验。
 *
 * **安装后不立即生效。** 扩展按工作区缓存，下一条消息新建会话时才重新加载。返回信息中必须说明这一点，
 * 否则模型会在同一轮中反复查找新工具，然后判定安装失败。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'

export const installPluginTool: ToolSpec = {
  name: 'install_plugin',
  description:
    '把工作区中已编写好的插件目录安装到本机的插件目录。' +
    '目录中必须有合法的 qywork.plugin.json。安装后从下一条消息起生效，不立即生效。' +
    '修改插件代码后需重新安装：安装的是快照。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '插件目录，相对于工作区，如 my-plugin' },
      replace: {
        type: 'boolean',
        description: '本机已安装同 id 的插件时是否覆盖。默认否，不覆盖时拒绝安装。',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '插件',
  category: 'plugins',
  facet: '扩展',
  summary: '安装一个插件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  // 安装使一段代码在下次加载时运行，权限级别与 `run_command` 相同。
  permissionEffect: 'execute',
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const port = ctx.plugins
    if (!port) {
      // 正常情况下不会执行到此处：没有插件通道时不注册本工具。
      return { status: 'failure' as const, message: '本次执行无法安装插件' }
    }

    const dir = typeof args.path === 'string' ? args.path.trim() : ''
    if (!dir) return { status: 'failure' as const, message: '需指定要安装的目录' }
    const replace = args.replace === true

    const found = await port.inspect(dir)
    if (!found.ok) {
      return {
        status: 'failure' as const,
        message: found.error ?? `${dir} 不是一个插件目录`,
        errorKind: 'invalid_manifest',
      }
    }
    if (found.replacing && !replace) {
      return {
        status: 'failure' as const,
        message: `本机已安装 ${found.id}。确认用当前目录替换时，带上 replace: true 重新调用`,
        errorKind: 'conflict',
      }
    }

    // 复制由端口执行：端口在安装前会再次读取清单，因为 inspect 与安装之间隔着模型的若干步，
    // 目录内容可能已与 inspect 时不同。
    const done = await port.install(dir, { replace })
    if (!done.ok) {
      return { status: 'failure' as const, message: done.error ?? '安装失败' }
    }
    return {
      status: 'success' as const,
      message: `已安装 ${found.name ?? found.id}。**从下一条消息起生效**：扩展在新建会话时加载，本轮中尚无该插件的工具`,
      data: { id: found.id, tools: found.tools ?? [] },
    }
  },
}
