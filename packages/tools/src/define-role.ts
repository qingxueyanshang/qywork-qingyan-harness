/**
 * 创建角色，写入工作区的 `.qy/team.json`。
 *
 * 角色是持久定义，不是运行中的子 agent。仅在用户明确要求创建或修改角色时使用
 * （`/role` 命令或明确的文字要求），模型无权自主创建角色。
 *
 * 必须是专用工具：`.qy` 是受保护目录（`paths.ts` 的 `PROTECTED_DIRS`），`write_file` 无法写入。
 * 该限制防止的是自我提权：修改 `.agents/` 等于为自身添加工具。创建角色不属于此类：
 * 角色的 `allowedTools` 只能在现有工具中收窄，无法获得新能力。
 * 没有专用工具时，设置页的「添加」把请求转交给模型，模型无法写入该文件，只能回复「被系统拒绝，请手动创建」。
 *
 * 只修改 `roles`，不修改 `rules`。`rules.shared` 是用户为本机设定的约束，追加给所有角色；
 * 允许模型整份改写该文件，就等于允许它修改这条约束。因此读取原文，只替换 `roles` 中的一项，其余键原样写回。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolContext, ToolSpec } from '@qywork/agent'

/** 角色配置文件的路径。与 `runtime` 的 `TEAM_CONFIG` 取值相同：`runtime` 负责加载，本文件负责写入。 */
const TEAM_CONFIG = '.qy/team.json'

/** id 只接受以下字符：它在编排图中被引用，也用作配置文件中的键。 */
const ID_OK = /^[a-zA-Z0-9_-]{1,40}$/

export const defineRoleTool: ToolSpec = {
  name: 'define_role',
  description:
    '用户明确要求创建或修改角色时（/role 命令或明确的文字要求），把角色写入工作区的 .qy/team.json；' +
    '用户未要求时不创建。角色是持久定义：有自己的系统提示词、可选的模型与工具范围，' +
    '之后新建子 agent 时按 role id 引用。同名 id 直接覆盖。',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: '角色 id，之后新建子 agent 时按此 id 引用。只能包含字母、数字与 - _',
      },
      name: { type: 'string', description: '显示名称，如「代码审查员」' },
      description: {
        type: 'string',
        description: '一句话说明该角色的专长。',
      },
      systemPrompt: { type: 'string', description: '角色的系统提示词：身份、纪律、产出要求' },
      provider: {
        type: 'string',
        description: '指定模型时，同时逐字填写运行上下文「已配置模型」清单中的 provider 参数',
      },
      model: {
        type: 'string',
        description:
          '指定模型：逐字填写运行上下文「已配置模型」清单中的 model 参数，并同时填写 provider。留空时使用当前会话的模型',
      },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description:
          '仅向该角色提供这些工具。空数组 = 不提供任何工具（纯分析角色）；不填 = 提供全部工具',
      },
    },
    required: ['id', 'name', 'description', 'systemPrompt'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '角色',
  category: 'session',
  facet: '协作',
  summary: '创建角色',
  targetExtractor: (a) => (typeof a.id === 'string' ? a.id : null),
  permissionEffect: 'write',
  parallelSafe: false,
  resourceKeys: (a) => [`role:${String(a.id ?? '*')}`],

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const id = String(args.id ?? '').trim()
    if (!ID_OK.test(id)) {
      return {
        status: 'failure' as const,
        message: 'id 只能包含字母、数字与 - _，且不超过 40 个字符',
      }
    }
    const name = String(args.name ?? '').trim()
    const description = String(args.description ?? '').trim()
    const systemPrompt = String(args.systemPrompt ?? '').trim()
    if (!name || !description || !systemPrompt) {
      return { status: 'failure' as const, message: 'name、description、systemPrompt 均不能为空' }
    }
    const provider = typeof args.provider === 'string' ? args.provider.trim() : ''
    const model = typeof args.model === 'string' ? args.model.trim() : ''
    if (provider && !model) {
      return { status: 'failure' as const, message: '指定 provider 时必须同时指定 model' }
    }
    let resolvedModel: { provider: string; model: string } | undefined
    if (model) {
      if (!ctx.delegate) {
        return { status: 'failure' as const, message: '本次执行无法获取模型配置，无法校验角色模型' }
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
            message: `${TEAM_CONFIG} 不是 JSON 对象，需先修复再创建角色`,
          }
        }
        doc = parsed as Record<string, unknown>
      } catch (e) {
        // JSON 无法解析时不覆盖：整份写回会丢失用户手写的规则。
        return {
          status: 'failure' as const,
          message: `${TEAM_CONFIG} 无法解析，不予覆盖：${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }

    const roles = Array.isArray(doc.roles) ? (doc.roles as Record<string, unknown>[]) : []
    const next: Record<string, unknown> = {
      id,
      name,
      description,
      systemPrompt,
      // 直接写入校验得到的结构化结果。模型重名时不要把临时的 `接口/模型` 选择串写入 model 字段：
      // Role 有独立的 provider 字段。
      ...(resolvedModel ? { provider: resolvedModel.provider, model: resolvedModel.model } : {}),
      // 空数组与未填写含义不同：前者表示不提供任何工具，后者表示提供全部工具。
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
      message: `${replaced ? '已修改' : '已创建'}角色 ${name}（${id}），新建子 agent 时按 role 引用`,
      data: { id, replaced, path: TEAM_CONFIG },
    }
  },
}
