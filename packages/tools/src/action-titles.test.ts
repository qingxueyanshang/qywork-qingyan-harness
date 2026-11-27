/**
 * 工具行的标题：覆盖 `registerToolCatalog` 注册的全部内置工具的 `verb` / `object` 声明，
 * 以及 `files.ts` 中读文件、写文件写入的 `subject`。
 *
 * 原始失败形状：标题由七个动作的动词与类别词拼接，截取画面、导出成片、取回结果都显示为「创建画布」，
 * 浏览器观察显示为「读取浏览器控制」，在面板中打开文件显示为「读取文件」。
 */
import { expect, test } from 'bun:test'
import { resolveAction, ToolRegistry } from '@qywork/agent'
import { MEDIA_OUTPUTS, TOOL_CATEGORY_HEADS, VERB_KINDS } from '@qywork/core'
import { registerToolCatalog } from './index.ts'

const catalog = () => {
  const registry = new ToolRegistry()
  registerToolCatalog(registry, MEDIA_OUTPUTS)
  return registry.list()
}

test('每个内置工具的开头取自类目表，动词在动词表中，动作由动词得出', () => {
  for (const spec of catalog()) {
    const a = resolveAction(spec, {})
    expect(a.head).toBe(TOOL_CATEGORY_HEADS[spec.category])
    expect(VERB_KINDS[a.verb as keyof typeof VERB_KINDS]).toBe(a.kind)
  }
})

/** 这几类工具的目标是标签页编号、窗口编号或权限范围，必须另行声明显示的对象。 */
test('目标是不透明编号的工具声明了显示的对象', () => {
  for (const spec of catalog()) {
    if (spec.category !== 'browser' && spec.category !== 'desktop') continue
    expect(spec.object).toBeDefined()
    const a = resolveAction(spec, { tabId: 'tab_7', windowId: 'dw_3' })
    expect(a.object).not.toBe(a.target)
  }
})

test('原先显示错误的工具得到描述实际动作的标题', () => {
  const byName = new Map(catalog().map((s) => [s.name, s]))
  const title = (name: string, args: Record<string, unknown>) => {
    const a = resolveAction(byName.get(name)!, args)
    return `${a.head} · ${a.verb} ${a.object ?? ''}`.trim()
  }
  expect(title('open_in_panel', { path: 'page.html' })).toBe('文件读写 · 打开 page.html')
  expect(title('capture_canvas_frame', { path: 'a.canvas.json', node: '封面', at: 12.5 })).toBe(
    '画布控制 · 截取 封面 12.5 秒',
  )
  expect(title('export_timeline', { path: 'a.canvas.json', node: '成片' })).toBe(
    '画布控制 · 导出 成片',
  )
  expect(title('cancel_canvas', { path: 'a.canvas.json', node: '封面' })).toBe(
    '画布控制 · 取消 封面',
  )
  expect(title('browser_observe', { tabId: 'tab_7' })).toBe('网页控制 · 查看 网页')
  expect(title('browser_act', { tabId: 'tab_7', action: 'type', text: '会议纪要' })).toBe(
    '网页控制 · 输入 「会议纪要」',
  )
  expect(title('desktop_windows', {})).toBe('电脑控制 · 列出 窗口')
  expect(title('load_tool', { names: ['read_office', 'write_office'] })).toBe(
    '工具加载 · 加载 read_office、write_office',
  )
  expect(title('install_plugin', { path: 'C:/plugins/shot' })).toBe(
    '插件管理 · 安装 C:/plugins/shot',
  )
  expect(title('enable_mcp_server', { name: 'github' })).toBe('MCP 管理 · 启用 github')
  expect(title('write_file', { path: 'a.ts', mode: 'overwrite' })).toBe('文件读写 · 覆盖 a.ts')
  expect(title('wait_subagents', {})).toBe('任务派发 · 等待 回执')
})

test('在面板中打开的文件不计入上下文压缩的「涉及的文件」：动作不是读取或写入', () => {
  const spec = catalog().find((s) => s.name === 'open_in_panel')!
  expect(resolveAction(spec, { path: 'page.html' }).kind).toBe('call')
})
