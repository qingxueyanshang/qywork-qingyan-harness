/**
 * 工具类目与开头。**没有「其他」。**
 *
 * 类目是与动作轴（`ActionKind`）、权限轴（`PermissionEffect`）正交的第三条轴：动作轴描述「做了什么」，
 * 权限轴描述「有什么副作用」，本轴描述「属于哪个领域」。工具注册时类目、功能方向（`facet`）与用途（`summary`）
 * 都必须填写，缺少任何一项即注册失败。
 *
 * 每个类目对应一个开头：会话中工具行的第一段与设置页「工具」列表的分组名都取这一个值，
 * 不要在界面中另写分组名，否则同一组工具在两处显示两个名称。
 * 开头为四个字的「名词 + 动词」；`MCP` 按原名保留。键的顺序即界面呈现顺序。
 *
 * MCP server 与插件提供的工具一律归入 `mcp_call` 与 `plugin_call`，因为它们的类目由第三方决定；
 * `mcp` 与 `plugins` 只含管理 MCP 配置、安装插件的内置工具。两者都不是后备类目：
 * 内置工具未标注类目时注册直接失败，不会归入其中。
 */
export const TOOL_CATEGORY_HEADS = {
  files: '文件读写',
  code: '命令执行',
  web: '联网搜索',
  browser: '网页控制',
  desktop: '电脑控制',
  office: '文档读写',
  canvas: '画布控制',
  generate: '媒体生成',
  memory: '记忆管理',
  skills: '技能管理',
  planning: '待办管理',
  goal: '目标管理',
  collab: '任务派发',
  appearance: '外观管理',
  context: '会话读取',
  schedule: '定时管理',
  mcp: 'MCP 管理',
  mcp_call: 'MCP 调用',
  plugins: '插件管理',
  plugin_call: '插件调用',
} as const

export type ToolCategory = keyof typeof TOOL_CATEGORY_HEADS

/**
 * 目标是工作区文件路径的类目。上下文压缩的「涉及的文件」只收录这些类目中读写动作的目标：
 * 其余类目的目标是标签页、窗口、任务编号或权限范围，不是文件。
 */
export const FILE_TARGET_CATEGORIES: ReadonlySet<ToolCategory> = new Set<ToolCategory>([
  'files',
  'office',
  'canvas',
  'generate',
])

/** 由开头查出类目；没有对应类目时为 null。账本中历史工具行的开头已由迁移改写为当前名称。 */
export function categoryOfHead(head: string | null | undefined): ToolCategory | null {
  const hit = Object.entries(TOOL_CATEGORY_HEADS).find(([, h]) => h === head)
  return hit ? (hit[0] as ToolCategory) : null
}

/** 全部类目，顺序即界面顺序。注册期校验需要运行时取值，由开头表的键得出。 */
export const TOOL_CATEGORIES = Object.keys(TOOL_CATEGORY_HEADS) as ToolCategory[]
