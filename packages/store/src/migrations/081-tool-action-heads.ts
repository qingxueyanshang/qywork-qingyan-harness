import type { Database } from 'bun:sqlite'
import { type Migration, parsedObject } from './shared.ts'

/** 迁移 81 每批处理的工具行数。每行解析并改写一次 payload，单批耗时主要在 JSON 解析。 */
const BATCH_ROWS = 500

/**
 * 工具名对应的开头。按迁移时的类目冻结在此，之后修改类目表不改变本迁移的结果。
 * 按名称前缀归类的不在表中：`browser_` 与 `desktop_` 归入「网页控制」「电脑控制」；
 * 外部工具中 `mcp__` 开头的归入「MCP 调用」，其余带 `__` 的归入「插件调用」。
 */
const HEADS: Record<string, string> = {
  read_file: '文件读写',
  write_file: '文件读写',
  edit_file: '文件读写',
  list_dir: '文件读写',
  glob: '文件读写',
  grep: '文件读写',
  open_in_panel: '文件读写',
  run_command: '命令执行',
  background_command: '命令执行',
  web_fetch: '网络访问',
  web_search: '网络访问',
  read_office: '文档读写',
  read_office_guide: '文档读写',
  view_office: '文档读写',
  write_office: '文档读写',
  create_canvas: '画布读写',
  read_canvas: '画布读写',
  edit_canvas: '画布读写',
  run_canvas: '画布读写',
  retrieve_canvas: '画布读写',
  cancel_canvas: '画布读写',
  capture_canvas_frame: '画布读写',
  export_timeline: '画布读写',
  generate_image: '媒体生成',
  generate_video: '媒体生成',
  generate_audio: '媒体生成',
  retrieve_media: '媒体生成',
  read_memory: '记忆管理',
  write_memory: '记忆管理',
  delete_memory: '记忆管理',
  move_memory: '记忆管理',
  read_skill: '技能管理',
  write_skill: '技能管理',
  import_skill: '技能管理',
  move_skill: '技能管理',
  write_todos: '待办管理',
  read_goal: '目标管理',
  update_goal: '目标管理',
  subagent: '任务派发',
  wait_subagents: '任务派发',
  stop_subagent: '任务派发',
  workflow: '任务派发',
  new_conversation: '任务派发',
  define_role: '任务派发',
  personalize: '外观管理',
  pet: '外观管理',
  read_history: '会话读取',
  read_resource: '会话读取',
  load_tool: '会话读取',
  create_schedule: '定时管理',
  delete_schedule: '定时管理',
  list_schedules: '定时管理',
  write_mcp_server: 'MCP 管理',
  move_mcp_server: 'MCP 管理',
  enable_mcp_server: 'MCP 管理',
  install_plugin: '插件管理',
}

/** 动词所属的动作，按迁移时的动词表冻结。 */
const KINDS: Record<string, string> = {
  列出: 'query',
  查找: 'query',
  搜索: 'query',
  读取: 'read',
  查看: 'read',
  获取: 'read',
  取回: 'read',
  等待: 'read',
  创建: 'write',
  新建: 'write',
  生成: 'write',
  制作: 'write',
  导出: 'write',
  截取: 'write',
  保存: 'write',
  导入: 'write',
  安装: 'write',
  修改: 'edit',
  覆盖: 'edit',
  更新: 'edit',
  移动: 'edit',
  启用: 'edit',
  重置: 'edit',
  取消: 'edit',
  停止: 'edit',
  删除: 'delete',
  运行: 'run',
  派发: 'run',
}

/** 旧动作对应的动词，用于表中没有、又不是外部工具的旧工具名。 */
const OLD_KIND_VERBS: Record<string, string> = {
  query: '查找',
  read: '读取',
  write: '创建',
  edit: '修改',
  delete: '删除',
  run: '运行',
  call: '调用',
}

type Args = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

const BROWSER_ACT: Record<string, string> = {
  click: '点击',
  dblclick: '双击',
  rightclick: '右击',
  hover: '悬停',
  fill: '填写',
  type: '输入',
  select: '选择',
  scroll: '滚动',
  press: '按键',
  drag: '拖动',
  dialog: '操作',
}

const DESKTOP_ACT: Record<string, string> = {
  invoke: '点击',
  set_value: '填写',
  set_range_value: '填写',
  select: '选择',
  add_to_selection: '选择',
  remove_from_selection: '操作',
  set_toggle: '切换',
  expand: '展开',
  collapse: '折叠',
  scroll: '滚动',
  scroll_into_view: '滚动',
  realize_item: '操作',
  select_text: '选择',
  click: '点击',
  hover: '悬停',
  drag: '拖动',
  wheel: '滚动',
  type_text: '输入',
  press_key: '按键',
  activate: '激活',
  set_window_state: '缩放',
  move_window: '拖动',
  resize_window: '缩放',
  close_window: '关闭',
}

const DESKTOP_WINDOW_ACTIONS = new Set([
  'activate',
  'set_window_state',
  'move_window',
  'resize_window',
  'close_window',
])

/** 动词与对象。`target` 是旧记录中的目标，`oldKind` 是旧记录中的动作。 */
function verbAndObject(
  tool: string,
  a: Args,
  target: string | null,
  oldKind: string,
): [string, string | null] {
  switch (tool) {
    case 'read_file':
      return ['读取', target]
    case 'write_file':
      return [a.mode === 'overwrite' ? '覆盖' : '创建', target]
    case 'edit_file':
      return ['修改', target]
    case 'list_dir':
      return ['列出', target]
    case 'glob':
      return ['查找', target]
    case 'grep':
      return ['搜索', target]
    case 'open_in_panel':
      return ['打开', target]
    case 'run_command':
      return ['运行', target]
    case 'background_command': {
      const verb =
        a.stop === true
          ? '停止'
          : typeof a.input === 'string' || a.close_input === true
            ? '输入'
            : typeof a.wait_seconds === 'number'
              ? '等待'
              : '读取'
      return [verb, target ? `任务 ${target}` : null]
    }
    case 'web_fetch':
      return ['获取', target]
    case 'web_search':
      return ['搜索', target]
    case 'browser_tabs':
      return [
        a.action === 'list'
          ? '列出'
          : a.action === 'bind'
            ? '接管'
            : a.action === 'close'
              ? '关闭'
              : '打开',
        a.action === 'create' ? (str(a.url) ?? '标签页') : '标签页',
      ]
    case 'browser_navigate':
      return [
        a.action === 'back'
          ? '返回'
          : a.action === 'forward'
            ? '前进'
            : a.action === 'reload'
              ? '刷新'
              : '打开',
        a.action === 'goto'
          ? (str(a.url) ?? '网页')
          : a.action === 'back'
            ? '上一页'
            : a.action === 'forward'
              ? '下一页'
              : '网页',
      ]
    case 'browser_observe':
      return ['查看', '网页']
    case 'browser_act': {
      const action = String(a.action)
      const object =
        (action === 'type' || action === 'select') && str(a.text)
          ? `「${str(a.text)}」`
          : action === 'dialog'
            ? '对话框'
            : action === 'scroll' || action === 'press'
              ? '网页'
              : '元素'
      return [BROWSER_ACT[action] ?? '操作', object]
    }
    case 'browser_wait':
      return ['等待', str(a.selector) ?? '网页']
    case 'browser_upload':
      return ['上传', '文件']
    case 'browser_download':
      return ['下载', str(a.path) ?? '文件']
    case 'desktop_windows':
      return ['列出', '窗口']
    case 'desktop_observe':
      return ['查看', '窗口']
    case 'desktop_wait':
      return ['等待', '窗口']
    case 'desktop_act_sequence':
      return ['操作', '窗口']
    case 'desktop_act': {
      const action = String(a.action)
      const object =
        action === 'type_text' && str(a.text)
          ? `「${str(a.text)}」`
          : action === 'press_key' && str(a.key)
            ? str(a.key)
            : DESKTOP_WINDOW_ACTIONS.has(action)
              ? '窗口'
              : str(a.name)
                ? `「${str(a.name)}」`
                : '控件'
      return [DESKTOP_ACT[action] ?? '操作', object]
    }
    case 'read_office_guide':
      return ['读取', str(a.format) ? `${str(a.format)} 制作说明` : '制作说明']
    case 'read_office':
      return ['读取', target]
    case 'view_office':
      return ['查看', target]
    case 'write_office':
      return ['制作', target]
    case 'create_canvas':
      return ['创建', target]
    case 'read_canvas':
      return target ? ['读取', target] : ['列出', '画布']
    case 'edit_canvas':
      return ['修改', target]
    case 'run_canvas': {
      const names = Array.isArray(a.node) ? a.node.filter((n) => str(n) !== null) : []
      return ['运行', names.length ? names.join('、') : target]
    }
    case 'retrieve_canvas':
      return ['取回', str(a.node) ?? target]
    case 'cancel_canvas':
      return ['取消', str(a.node) ?? target]
    case 'capture_canvas_frame': {
      const node = str(a.node)
      return ['截取', node ? (typeof a.at === 'number' ? `${node} ${a.at} 秒` : node) : target]
    }
    case 'export_timeline':
      return ['导出', str(a.node) ?? target]
    case 'generate_image':
      return ['生成', str(a.output) ?? '图片']
    case 'generate_video':
      return ['生成', str(a.output) ?? '视频']
    case 'generate_audio':
      return ['生成', str(a.output) ?? '音频']
    case 'retrieve_media':
      return ['取回', target]
    case 'read_memory':
    case 'read_skill':
    case 'load_tool':
      return ['读取', target]
    case 'write_memory':
    case 'write_skill':
    case 'write_mcp_server':
      return ['保存', target]
    case 'delete_memory':
      return ['删除', target]
    case 'move_memory':
    case 'move_skill':
    case 'move_mcp_server':
      return ['移动', target]
    case 'import_skill':
      return ['导入', target]
    case 'enable_mcp_server':
      return ['启用', target]
    case 'install_plugin':
      return ['安装', target]
    case 'write_todos':
      return [oldKind === 'edit' ? '更新' : '创建', '待办清单']
    case 'read_goal':
      return ['读取', '目标']
    case 'update_goal':
      return ['更新', '目标']
    case 'subagent':
      return ['派发', target]
    case 'wait_subagents':
      return ['等待', '回执']
    case 'stop_subagent':
      return ['停止', target]
    case 'workflow':
      return ['运行', target]
    case 'new_conversation':
      return ['新建', target]
    case 'define_role':
      return ['创建', target]
    case 'personalize':
      return [a.action === 'read' ? '读取' : a.action === 'reset' ? '重置' : '保存', '个性化']
    case 'pet':
      return [
        a.action === 'save'
          ? '保存'
          : a.action === 'apply'
            ? '切换'
            : a.action === 'list'
              ? '列出'
              : '读取',
        str(a.id) ?? '宠物',
      ]
    case 'read_history':
      return ['读取', '历史原文']
    case 'read_resource':
      return ['读取', '完整结果']
    case 'create_schedule':
      return ['创建', target]
    case 'delete_schedule':
      return ['删除', '定时任务']
    case 'list_schedules':
      return ['列出', '定时任务']
    default:
      if (tool.includes('__')) return ['调用', externalObject(target, tool)]
      return [OLD_KIND_VERBS[oldKind] ?? '调用', target]
  }
}

/** 外部工具的旧目标是权限范围（`mcp:server/tool`、`plugin:id/tool`），显示为「server／tool」。 */
function externalObject(target: string | null, tool: string): string {
  const scope = target?.replace(/^(?:mcp|plugin):/, '') ?? tool.replace(/^mcp__/, '')
  return scope.replace('/', '／')
}

function headOf(tool: string): string {
  const known = HEADS[tool]
  if (known) return known
  if (tool.startsWith('browser_')) return '网页控制'
  if (tool.startsWith('desktop_')) return '电脑控制'
  if (tool.startsWith('mcp__')) return 'MCP 调用'
  if (tool.includes('__')) return '插件调用'
  return '会话读取'
}

/** 执行后确定的对象：写文件的实际路径、分段读取的行号范围、窗口标题。 */
function subjectOf(
  tool: string,
  a: Args,
  outcome: Record<string, unknown> | undefined,
): string | null {
  if (!outcome || outcome.status !== 'success') return null
  const data = outcome.data as Record<string, unknown> | undefined
  if (tool === 'write_file') {
    const changes = outcome.fileChanges as { path?: unknown }[] | undefined
    const actual = changes?.[0]?.path
    return typeof actual === 'string' && actual !== a.path ? actual : null
  }
  if (tool === 'read_file') {
    const { startLine, endLine, totalLines } = (data ?? {}) as Record<string, unknown>
    if (
      typeof a.path !== 'string' ||
      typeof startLine !== 'number' ||
      typeof endLine !== 'number' ||
      typeof totalLines !== 'number' ||
      endLine < startLine ||
      (startLine <= 1 && endLine >= totalLines)
    ) {
      return null
    }
    return `${a.path}:${startLine}-${endLine}`
  }
  if (tool.startsWith('desktop_') && tool !== 'desktop_windows') {
    if (tool === 'desktop_act' && !DESKTOP_WINDOW_ACTIONS.has(String(a.action))) return null
    const label = (v: unknown): string | null => {
      if (typeof v !== 'object' || v === null) return null
      const { title, app } = v as { title?: unknown; app?: unknown }
      return str(title) ?? str(app)
    }
    return label(data) ?? label(data?.observation)
  }
  return null
}

/** 一行的转换；已转换（带 `head`）或没有 `action` 的行返回 null。 */
function convertToolAction(
  tool: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const action = payload.action as Record<string, unknown> | undefined
  if (!action || typeof action.head === 'string') return null
  const args = (payload.args ?? {}) as Args
  const target = typeof action.target === 'string' ? action.target : null
  const [verb, object] = verbAndObject(tool, args, target, String(action.kind))
  const outcome = payload.outcome as Record<string, unknown> | undefined
  const subject = subjectOf(tool, args, outcome)
  const { objectLabel: _dropped, ...rest } = action
  return {
    ...payload,
    action: { ...rest, kind: KINDS[verb] ?? 'call', head: headOf(tool), verb, object, target },
    ...(outcome && subject ? { outcome: { ...outcome, subject } } : {}),
  }
}

function convertBatch(db: Database, after: number): number | null {
  const rows = db
    .query<
      { rid: number; id: string; tool: string | null; payload: string | null },
      [number, number]
    >(
      `SELECT rowid AS rid, id, tool_name AS tool, payload FROM steps
       WHERE rowid > ? AND kind = 'tool_action'
       ORDER BY rowid LIMIT ?`,
    )
    .all(after, BATCH_ROWS)
  if (!rows.length) return null
  const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    if (!payload) continue
    const next = convertToolAction(row.tool ?? '', payload)
    if (next) write.run(JSON.stringify(next), row.id)
  }
  return rows.at(-1)!.rid
}

export const migration081: Migration = {
  id: 81,
  name: 'tool_action_heads',
  /**
   * 工具行的标题改为「开头 · 动词 对象」：历史记录的 `action` 由动作加对象名（`objectLabel`）转换为开头、动词与对象，
   * 动作按动词重新得出；写文件的实际路径、分段读取的行号范围与窗口标题写入结果的 `subject`。
   *
   * 分批执行（`background`）：工具行随账本增长（本机 2026-11-26 约 9 万行），打开时同步改写会使启动时间随账本增长。
   * 转换完成之前的旧行没有 `head` 与 `verb`，界面显示为空标题，不报错；`kind` 与 `target` 两种格式相同，
   * 上下文压缩照常读取。一次性转换，不是兼容层：转换完成后，代码中没有分支识别旧格式。
   */
  background: (db, _content, after) => convertBatch(db, after),
}
