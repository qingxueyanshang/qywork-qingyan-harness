/**
 * 把工作区里写好的一个插件目录装进本机的插件目录。
 *
 * **定义与装是两件事。** 写代码用普通文件工具就行——插件目录在全局，本来就不在工作区里，
 * 模型写多少遍都不会有任何代码跑起来。**装**才是那条分界线：装完之后，
 * 那段代码在下一次加载时会真的执行。
 *
 * **把关在清单校验上，不在弹窗上。** 这个产品只有 `auto` / `full` 两种权限模式，
 * 没有「逐次询问」那一档；跑到这个工具就是同意。所以形状不对必须当场拒、不落盘：
 * 清单里认不出的 `permissionEffect`、声明了工具却没声明相应权限，都在装之前挡掉。
 *
 * **装进去的是快照。** 装 = 整目录复制。工作区里的源码之后再改不会影响已装的那份，改完要再装一次
 * ——也就再问一次。这不是限制，是「换一版要重新点头」。
 *
 * **装完不立刻生效。** 扩展按工作区缓存，下一条消息新建会话时才重新加载。返回值里必须说清这句话，
 * 否则模型会在同一轮里反复找那个新工具，然后判定「装失败了」。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'

export const installPluginTool: ToolSpec = {
  name: 'install_plugin',
  description:
    '把工作区里已经写好的一个插件目录装进本机的插件目录。' +
    '目录里要有合法的 qywork.plugin.json。装完在下一条消息生效，不是当场。' +
    '改了插件代码要再装一次——装进去的是快照。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '插件目录，相对工作区，如 my-plugin' },
      replace: {
        type: 'boolean',
        description: '本机已经装过同 id 时是否覆盖。默认否——不覆盖就直接拒绝。',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '插件',
  category: 'external',
  facet: '扩展',
  summary: '装一个插件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  // 它让一段代码在下次加载时跑起来，与 `run_command` 同一档。
  permissionEffect: 'execute',
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const port = ctx.plugins
    if (!port) {
      // 正常不会走到：没有这条通道时这个工具不注册。
      return { status: 'failure' as const, message: '本次执行装不了插件' }
    }

    const dir = typeof args.path === 'string' ? args.path.trim() : ''
    if (!dir) return { status: 'failure' as const, message: '要装哪个目录' }
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
        message: `本机已经装了 ${found.id}。确认要换成这一份就带上 replace: true 再来一次`,
        errorKind: 'conflict',
      }
    }

    // 复制在端口那边：它装之前会把清单再读一次——中间隔着模型的几步，
    // 那个目录可能已经不是 inspect 时的那一份了。
    const done = await port.install(dir, { replace })
    if (!done.ok) {
      return { status: 'failure' as const, message: done.error ?? '装失败了' }
    }
    return {
      status: 'success' as const,
      message: `装好了 ${found.name ?? found.id}。**下一条消息才生效**——扩展是新建会话时加载的，这一轮里还看不到它的工具`,
      data: { id: found.id, tools: found.tools ?? [] },
    }
  },
}
