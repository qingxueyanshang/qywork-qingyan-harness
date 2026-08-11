/**
 * 插件清单。
 *
 * 设计取舍：**能力用声明，不用探测。** 插件必须在清单里列出它提供什么、
 * 需要什么权限；宿主据此在加载前就能决定是否允许，而不是让它先跑起来再看它干了什么。
 *
 * 「兼容所有格式」（需求 8）的落法是**预览器按渲染族注册**，不是按扩展名穷举——
 * 扩展名的长尾追不完，族是有限的。插件想支持一种新格式，只要说明它属于哪个族
 * （或自带渲染器）即可。
 */

export const MANIFEST_VERSION = 1

export interface PluginManifest {
  /** 全局唯一，反向域名风格。用作命名空间前缀，避免工具重名。 */
  id: string
  name: string
  version: string
  description: string
  manifestVersion: number
  author?: string
  homepage?: string

  /** 入口模块（相对插件目录）。默认 `index.js`。 */
  main?: string

  /**
   * 声明式权限。宿主在**加载前**据此提示用户；
   * 插件运行时越权调用会被拒绝，而不是靠自觉。
   */
  permissions: PluginPermission[]

  contributes: {
    tools?: ToolContribution[]
    previewers?: PreviewerContribution[]
    roles?: RoleContribution[]
    providers?: ProviderContribution[]
  }
}

export type PluginPermission =
  /** 读工作区文件 */
  | 'workspace:read'
  /** 写工作区文件 */
  | 'workspace:write'
  /** 执行命令 */
  | 'process:exec'
  /** 访问网络 */
  | 'network'
  /** 读写自己的私有存储 */
  | 'storage'

export interface ToolContribution {
  /** 实际注册名会加 `<pluginId>__` 前缀，防止与内置工具或其他插件撞名。 */
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 与内置工具同一套动作语义轴。 */
  actionKind: 'read' | 'write' | 'edit' | 'delete' | 'execute' | 'search' | 'fetch'
  objectLabel: string
  permissionEffect: 'read' | 'write' | 'delete' | 'execute' | 'network'
}

export interface PreviewerContribution {
  /** 接管哪些扩展名（小写、含点）。 */
  extensions: string[]
  /**
   * 渲染族。选 `custom` 时插件必须导出同名渲染函数，
   * 否则加载期直接拒绝——留一个渲染不出东西的预览器比没有更糟。
   */
  renders: 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'tabular' | 'custom'
  /** renders='custom' 时的导出名。 */
  render?: string
  /** 语法高亮语言标识，仅 renders='text' 有意义。 */
  language?: string
}

export interface RoleContribution {
  id: string
  name: string
  /** 该角色的系统提示词追加段。 */
  systemPrompt: string
  /** 允许该角色使用的工具名（不含插件前缀）。空=全部。 */
  allowedTools?: string[]
}

export interface ProviderContribution {
  id: string
  displayName: string
  /** 走哪套协议。自定义协议需要插件自己实现 adapter 导出。 */
  protocol: 'anthropic' | 'openai_compatible' | 'openai_responses' | 'custom'
  defaultBaseUrl?: string
  models?: { id: string; contextWindow: number; maxOutputTokens: number }[]
}

export class ManifestError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'ManifestError'
  }
}

/**
 * 校验清单。
 *
 * 严格拒绝而不是尽力兼容：一个字段写错的插件应该在加载期报出确切原因，
 * 而不是装载成功后在某次工具调用时以一个无法归因的形式炸掉。
 */
export function parseManifest(raw: unknown, path: string): PluginManifest {
  const fail = (msg: string): never => {
    throw new ManifestError(path, msg)
  }
  if (typeof raw !== 'object' || raw === null) return fail('清单不是对象')
  const m = raw as Record<string, unknown>

  if (m.manifestVersion !== MANIFEST_VERSION) {
    return fail(`清单版本不支持：${String(m.manifestVersion)}，本机支持 ${MANIFEST_VERSION}`)
  }
  const id = String(m.id ?? '')
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(id)) {
    return fail('id 必须是 3~64 位小写字母、数字、点、横线或下划线')
  }
  for (const field of ['name', 'version', 'description'] as const) {
    if (typeof m[field] !== 'string' || !(m[field] as string).trim()) {
      return fail(`缺少 ${field}`)
    }
  }

  const permissions = Array.isArray(m.permissions) ? m.permissions : []
  const known: PluginPermission[] = [
    'workspace:read',
    'workspace:write',
    'process:exec',
    'network',
    'storage',
  ]
  for (const p of permissions) {
    if (!known.includes(p as PluginPermission)) return fail(`未知权限：${String(p)}`)
  }

  const contributes = (m.contributes ?? {}) as PluginManifest['contributes']

  // 声明了工具却没声明相应权限，是清单写错了——放行等于把权限模型架空。
  for (const t of contributes.tools ?? []) {
    const need = requiredPermission(t.permissionEffect)
    if (need && !permissions.includes(need)) {
      return fail(`工具 ${t.name} 需要权限 ${need}，但清单未声明`)
    }
  }

  for (const p of contributes.previewers ?? []) {
    if (p.renders === 'custom' && !p.render) {
      return fail('自定义渲染器必须提供 render 导出名')
    }
    if (!Array.isArray(p.extensions) || p.extensions.length === 0) {
      return fail('预览器必须声明至少一个扩展名')
    }
  }

  return {
    id,
    name: String(m.name),
    version: String(m.version),
    description: String(m.description),
    manifestVersion: MANIFEST_VERSION,
    ...(typeof m.author === 'string' ? { author: m.author } : {}),
    ...(typeof m.homepage === 'string' ? { homepage: m.homepage } : {}),
    ...(typeof m.main === 'string' ? { main: m.main } : {}),
    permissions: permissions as PluginPermission[],
    contributes,
  }
}

function requiredPermission(effect: ToolContribution['permissionEffect']): PluginPermission | null {
  switch (effect) {
    case 'read':
      return 'workspace:read'
    case 'write':
    case 'delete':
      return 'workspace:write'
    case 'execute':
      return 'process:exec'
    case 'network':
      return 'network'
    default:
      return null
  }
}
