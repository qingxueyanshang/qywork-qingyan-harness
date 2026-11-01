/**
 * 覆盖 `panel.ts` 的 `open_in_panel`：路径核对与返回的相对路径，以及 `index.ts` 中按 `panel` 注册。
 * 界面收到成功结果后打开面板由 `apps/web/src/lib/store.test.ts` 覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from './index.ts'
import { openInPanelTool } from './panel.ts'

function ctx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

describe('open_in_panel', () => {
  test('工作区中的文件返回相对路径交给界面打开；缺少 path、文件不存在、指向工作区根时不打开', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-panel-'))
    await mkdir(join(root, '作品', '签收'), { recursive: true })
    await writeFile(join(root, '作品', '签收', '签收.canvas.json'), '{}')
    const ok = await openInPanelTool.fn({ path: '作品\\签收\\签收.canvas.json' }, ctx(root))
    expect(ok).toMatchObject({ status: 'success', data: { path: '作品/签收/签收.canvas.json' } })
    expect(await openInPanelTool.fn({ path: ' ' }, ctx(root))).toMatchObject({
      status: 'failure',
      executed: false,
    })
    await expect(openInPanelTool.fn({ path: '作品/不存在.png' }, ctx(root))).rejects.toThrow()
    expect(await openInPanelTool.fn({ path: '.' }, ctx(root))).toMatchObject({
      status: 'failure',
      executed: false,
    })
  })

  test('只在有界面的会话中注册', () => {
    const names = (opts: { panel?: boolean }) => {
      const registry = new ToolRegistry()
      registerBuiltinTools(registry, opts)
      return registry.list().map((s) => s.name)
    }
    expect(names({ panel: true })).toContain('open_in_panel')
    expect(names({})).not.toContain('open_in_panel')
  })

  test('workbench：已安装的工作台返回标识与名称交给界面打开；未安装、与 path 同时给出时失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-panel-'))
    const homeBefore = process.env.QYWORK_HOME
    const home = await mkdtemp(join(tmpdir(), 'qywork-home-'))
    process.env.QYWORK_HOME = home
    try {
      await mkdir(join(home, 'plugins', 'dev.demo'), { recursive: true })
      await writeFile(
        join(home, 'plugins', 'dev.demo', 'qywork.plugin.json'),
        JSON.stringify({
          contributes: { panels: [{ id: 'board', title: '看板', entry: 'ui.html' }] },
        }),
      )
      expect(await openInPanelTool.fn({ workbench: 'dev.demo/board' }, ctx(root))).toMatchObject({
        status: 'success',
        data: { workbench: 'dev.demo/board', title: '看板' },
      })
      expect(await openInPanelTool.fn({ workbench: 'dev.demo/none' }, ctx(root))).toMatchObject({
        status: 'failure',
      })
      expect(await openInPanelTool.fn({ workbench: '../x/board' }, ctx(root))).toMatchObject({
        status: 'failure',
      })
      expect(
        await openInPanelTool.fn({ workbench: 'dev.demo/board', path: 'a.png' }, ctx(root)),
      ).toMatchObject({ status: 'failure', message: 'path 与 workbench 只给一个' })
    } finally {
      if (homeBefore === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = homeBefore
    }
  })
})
