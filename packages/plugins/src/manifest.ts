/**
 * 插件清单。
 *
 * 设计取舍：能力采用声明而不是探测。插件必须在清单中列出提供的能力与所需的权限；
 * 宿主据此在加载前决定是否允许，而不是先运行插件再观察其行为。
 *
 * 支持任意格式的方式是预览器按渲染族注册，而不是按扩展名穷举：扩展名无法穷举，
 * 渲染族数量有限。插件要支持一种新格式，只需说明它属于哪个渲染族
 * （或自带渲染器）。
 */

import type { ProviderKind } from '@qywork/core'

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
   * 声明式权限。宿主在加载前据此提示用户；
   * 插件运行时的越权调用会被拒绝，不依赖插件自觉遵守。
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

/**
 * 工具贡献。
 *
 * 动作语义与对象名不在此处声明。插件工具一律记为 `call`（外置调用），对象名
 * 一律为「插件」，由宿主判定；清单中填写的 `actionKind` / `objectLabel`
 * 不会被读取，也不会报错。
 */
export interface ToolContribution {
  /** 实际注册名会加 `<pluginId>__` 前缀，防止与内置工具或其他插件重名。 */
  name: string
  description: string
  parameters: Record<string, unknown>
  permissionEffect: 'read' | 'write' | 'delete' | 'execute' | 'network'
}

export interface PreviewerContribution {
  /** 负责的扩展名（小写、含点）。 */
  extensions: string[]
  /**
   * 渲染族。选择 `custom` 时插件必须导出同名渲染函数，
   * 否则在加载期拒绝：无法渲染内容的预览器比没有预览器更糟。
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
  /** 允许该角色使用的工具名（不含插件前缀）。空表示全部。 */
  allowedTools?: string[]
}

export interface ProviderContribution {
  id: string
  displayName: string
  /** 使用的协议。自定义协议需要插件自行实现并导出 adapter。 */
  protocol: ProviderKind | 'custom'
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
 * 严格拒绝，不尽力兼容：字段有误的插件应在加载期报告确切原因，
 * 而不是加载成功后在某次工具调用时抛出无法归因的错误。
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
  // 注册名是 `<规范化的 id>__<工具名>`（`qywork.browser` → `qywork_browser__`），
  // id 的末段已包含在前缀中。工具名再以末段开头会形成 `qywork_browser__browser_tabs` 这样的重复。
  const idTheme = id.split('.').pop() ?? id
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

  // 声明了工具却未声明相应权限，说明清单有误；放行会使权限模型失效。
  //
  // 先校验 permissionEffect 本身。它是权限检查的输入，无法识别时必须拒绝而不是
  // 跳过：`requiredPermission` 对未知值返回 null，把 `execute` 误写为 `exec`
  // 会使下方的权限检查完全失效，拼写错误反而免除了检查。
  for (const t of contributes.tools ?? []) {
    if (!t.name || typeof t.name !== 'string') return fail('工具贡献缺少 name')
    // 工具名不得以 id 的末段开头：注册名前缀已包含末段，再次出现是冗余。
    if (t.name === idTheme || t.name.startsWith(`${idTheme}_`)) {
      const suggestion = t.name.slice(idTheme.length).replace(/^_+/, '')
      const prefix = `${id.replace(/[^a-z0-9_]/g, '_')}__`
      return fail(
        `工具 ${t.name} 不能以插件 id 末段「${idTheme}」开头` +
          `（注册名将为 ${prefix}${t.name}，末段重复出现）` +
          (suggestion ? `，应改为「${suggestion}」` : '，应去掉该前缀'),
      )
    }
    if (!KNOWN_EFFECTS.includes(t.permissionEffect)) {
      return fail(
        `工具 ${t.name} 的 permissionEffect 无法识别：${String(t.permissionEffect)}` +
          `（可用值：${KNOWN_EFFECTS.join('、')}）`,
      )
    }
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

const KNOWN_EFFECTS: ToolContribution['permissionEffect'][] = [
  'read',
  'write',
  'delete',
  'execute',
  'network',
]

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
