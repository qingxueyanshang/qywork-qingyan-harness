/**
 * 把工作区里写好的一个插件目录装进本机的插件目录。
 *
 * ## 定义与装是两件事
 *
 * 写代码用普通文件工具就行——插件目录在全局，本来就不在工作区里，
 * 模型写多少遍都不会有任何东西跑起来。**装**才是那条分界线：装完之后，
 * 那段代码在下一次加载时会真的执行。
 *
 * 所以**每次装都要真的问到人**，问之前把清单摘要摆出来：要注册哪些工具、
 * 声明了哪些权限、是不是覆盖已有的那一份——那三样是他判断「让不让它跑」的全部依据。
 *
 * **问这一步在端口那边做，不在这里。** 这个仓库里 `ctx.requestPermission` 由会话按
 * 权限模式就地裁决（`runtime/session.ts` 的 `decide`），除了 `run_command` 之外一律
 * 直接放行——在这里调它，装插件就成了「自动审批模式下无声安装」。
 * 实测撞到过：第一版就是这么写的，真机跑通一次，全程没有任何弹窗。
 *
 * ## 装进去的是快照
 *
 * 装 = 整目录复制。工作区里的源码之后再改不会影响已装的那份，改完要再装一次
 * ——也就再问一次。这不是限制，是「换一版要重新点头」。
 *
 * ## 装完不立刻生效
 *
 * 扩展按工作区缓存，下一条消息新建会话时才重新加载。返回值里必须说清这句话，
 * 否则模型会在同一轮里反复找那个新工具，然后判定「装失败了」。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'

export const installPluginTool: ToolSpec = {
  name: 'install_plugin',
  description:
    '把工作区里已经写好的一个插件目录装进本机的插件目录（需要用户当场点头）。' +
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
      // 正常不会走到：没有这条通道时这个工具压根不注册。
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

    // 问用户与复制都在端口那边：那边才够得着授权通道，也才会在问之前把清单重读一次。
    const done = await port.install(dir, { replace, runId: ctx.runId })
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
