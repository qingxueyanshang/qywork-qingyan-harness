/**
 * 建一个角色，写进工作区的 `.qy/team.json`。
 *
 * 角色是持久定义，不是运行中的子 agent。只在用户明确要求创建或修改角色时使用
 * （`/role` 命令或一句明确的话），模型没有自主建角色的权限。
 *
 * **为什么必须是一个专门的工具。** `.qy` 是受保护目录（`paths.ts` 的 `PROTECTED_DIRS`），
 * `write_file` 写不进去。那道墙挡的是**自我提权**——改 `.agents/` 就是给自己加工具。但「建一个角
 * 色」不属于那一类：角色的 `allowedTools` 只能从现有工具里**收窄**，它拿不到任何新能力。
 *
 * 实测形状：设置页的「添加」把话头递给模型，而模型写不了那个文件，因此它只能
 * 回一句「被系统拒绝，请手动创建」——一条设计成走对话的路径，走不通。
 *
 * **只动 `roles`，绝不碰 `rules`。** `rules.shared` 是用户对这台机器定的纪律，追加给所有角色。让模型
 * 整份改写这个文件，它就能一并改掉这一条。所以这里读出原文、只替换 `roles` 里的一条、其余键原样写回。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolContext, ToolSpec } from '@qywork/agent'

/** 角色配置落在这里。与 `runtime` 的 `TEAM_CONFIG` 同一个值——那边是加载方，这边是写入方。 */
const TEAM_CONFIG = '.qy/team.json'

/** id 只收这几类字符：它要出现在编排图里被引用，也要能当文件里的键。 */
const ID_OK = /^[a-zA-Z0-9_-]{1,40}$/

export const defineRoleTool: ToolSpec = {
  name: 'define_role',
  description:
    '用户明确要求创建或修改角色时（/role 命令或一句明确的话），把角色写进工作区的 .qy/team.json；' +
    '用户没有要求就不建。角色是持久定义：有自己的系统提示词、可选的模型与工具范围，' +
    '之后建子 agent 时按 role id 引用。同名 id 直接覆盖。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '角色 id，之后建子 agent 时按它引用。字母数字与 - _' },
      name: { type: 'string', description: '给人看的名字，如「代码审查员」' },
      description: {
        type: 'string',
        description: '一句话说明它擅长什么。',
      },
      systemPrompt: { type: 'string', description: '它的系统提示词：身份、纪律、产出要求' },
      provider: {
        type: 'string',
        description: '指定模型时，同时逐字填写运行上下文「已配置模型」清单中的 provider 参数',
      },
      model: {
        type: 'string',
        description:
          '指定模型：运行上下文「已配置模型」清单里的 model 参数，逐字，并同时填 provider。留空跟着当前会话',
      },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description: '只给它这几样工具。空数组 = 一个都不给（纯分析角色）；不填 = 全给',
      },
    },
    required: ['id', 'name', 'description', 'systemPrompt'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '角色',
  category: 'session',
  facet: '协作',
  summary: '建一个角色',
  targetExtractor: (a) => (typeof a.id === 'string' ? a.id : null),
  permissionEffect: 'write',
  parallelSafe: false,
  resourceKeys: (a) => [`role:${String(a.id ?? '*')}`],

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const id = String(args.id ?? '').trim()
    if (!ID_OK.test(id)) {
      return { status: 'failure' as const, message: 'id 只能用字母数字与 - _，且不超过 40 个字符' }
    }
    const name = String(args.name ?? '').trim()
    const description = String(args.description ?? '').trim()
    const systemPrompt = String(args.systemPrompt ?? '').trim()
    if (!name || !description || !systemPrompt) {
      return { status: 'failure' as const, message: 'name、description、systemPrompt 都不能为空' }
    }
    const provider = typeof args.provider === 'string' ? args.provider.trim() : ''
    const model = typeof args.model === 'string' ? args.model.trim() : ''
    if (provider && !model) {
      return { status: 'failure' as const, message: '指定 provider 时必须同时指定 model' }
    }
    let resolvedModel: { provider: string; model: string } | undefined
    if (model) {
      if (!ctx.delegate) {
        return { status: 'failure' as const, message: '本次执行拿不到模型配置，不能校验角色模型' }
      }
      const resolved = ctx.delegate.resolveModel(model, provider || undefined)
      if ('error' in resolved) {
        return { status: 'failure' as const, message: resolved.error }
      }
      resolvedModel = resolved
    }

    const file = join(ctx.workspaceRoot, ...TEAM_CONFIG.split('/'))
    const raw = await readFile(file, 'utf8').catch(() => null)
    let doc: Record<string, unknown> = {}
    if (raw?.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return {
            status: 'failure' as const,
            message: `${TEAM_CONFIG} 不是一个对象，先修好再建角色`,
          }
        }
        doc = parsed as Record<string, unknown>
      } catch (e) {
        // 坏 JSON 不覆盖：整份写回会把用户手写的规则一起冲掉。
        return {
          status: 'failure' as const,
          message: `${TEAM_CONFIG} 解析不了，不敢覆盖：${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }

    const roles = Array.isArray(doc.roles) ? (doc.roles as Record<string, unknown>[]) : []
    const next: Record<string, unknown> = {
      id,
      name,
      description,
      systemPrompt,
      // 校验得到的结构化真值直接落盘。尤其是撞名模型，不能把临时的
      // `接口/模型` 选择串塞进 model 字段，Role 本来就有独立的 provider。
      ...(resolvedModel ? { provider: resolvedModel.provider, model: resolvedModel.model } : {}),
      // 空数组与不填是两回事：前者是「一个工具都不给」，后者是「全给」。
      ...(Array.isArray(args.allowedTools) ? { allowedTools: args.allowedTools.map(String) } : {}),
    }
    const at = roles.findIndex((r) => String(r.id ?? '') === id)
    const replaced = at >= 0
    if (replaced) roles[at] = next
    else roles.push(next)
    doc.roles = roles

    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    return {
      status: 'success' as const,
      message: `${replaced ? '改好了' : '建好了'}角色 ${name}（${id}），建子 agent 时按 role 引用`,
      data: { id, replaced, path: TEAM_CONFIG },
    }
  },
}
