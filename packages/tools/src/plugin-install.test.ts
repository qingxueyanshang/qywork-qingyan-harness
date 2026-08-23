/**
 * 覆盖范围：`plugin-install.ts`（装插件工具）。
 *
 * 这条路径通向「一段代码在下次加载时会跑」，所以拒绝分支必须逐条锁住：
 * 清单不合法不装、同 id 不带 replace 不装、用户不点头不装。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@qywork/agent'
import { installPluginTool } from './plugin-install.ts'

type Found = Awaited<ReturnType<NonNullable<ToolContext['plugins']>['inspect']>>

function port(found: Found) {
  const installs: { dir: string; replace: boolean }[] = []
  return {
    installs,
    port: {
      inspect: async () => found,
      install: async (dir: string, opts: { replace: boolean }) => {
        installs.push({ dir, replace: opts.replace })
        return { ok: true }
      },
    },
  }
}

const good: Found = {
  ok: true,
  id: 'demo.hello',
  name: '打招呼',
  version: '1.0.0',
  tools: ['hello'],
  permissions: ['workspace:read'],
}

function ctx(plugins: ToolContext['plugins'], approve = true): ToolContext & { asked: string[] } {
  const asked: string[] = []
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    stepId: 'st_test',
    requestPermission: async (_scope: string, preview: string) => {
      asked.push(preview)
      return approve
    },
    ...(plugins ? { plugins } : {}),
    asked,
  } as ToolContext & { asked: string[] }
}

describe('装插件', () => {
  test('点头之前先把清单摘要摆出来：工具与权限', async () => {
    const p = port(good)
    const c = ctx(p.port)
    const res = await installPluginTool.fn({ path: 'demo' }, c)
    expect(res.status).toBe('success')
    expect(c.asked[0]).toContain('hello')
    expect(c.asked[0]).toContain('workspace:read')
    expect(p.installs).toEqual([{ dir: 'demo', replace: false }])
  })

  test('用户不点头就不装', async () => {
    const p = port(good)
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port, false))
    expect(res.status).toBe('failure')
    expect(p.installs).toHaveLength(0)
  })

  test('清单不合法当场拒，也不问用户', async () => {
    const p = port({ ok: false, error: '目录里没有 qywork.plugin.json' })
    const c = ctx(p.port)
    const res = await installPluginTool.fn({ path: 'demo' }, c)
    expect(res.status).toBe('failure')
    expect(c.asked).toHaveLength(0)
    expect(p.installs).toHaveLength(0)
  })

  /** 覆盖已装的那一份要模型显式说，且授权卡上必须写明这是覆盖。 */
  test('同 id 已存在：不带 replace 直接拒，带了要在卡上说明是覆盖', async () => {
    const p = port({ ...good, replacing: true })
    const first = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(first.status).toBe('failure')
    expect(p.installs).toHaveLength(0)

    const c = ctx(p.port)
    const second = await installPluginTool.fn({ path: 'demo', replace: true }, c)
    expect(second.status).toBe('success')
    expect(c.asked[0]).toContain('覆盖')
    expect(p.installs).toEqual([{ dir: 'demo', replace: true }])
  })

  /** 装完不是当场生效——不说清楚的话，模型会在同一轮里反复找那个新工具。 */
  test('装完的提示里说清下一条消息才生效', async () => {
    const p = port(good)
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(res.message).toContain('下一条消息')
  })

  test('没有通道时不装也不假装', async () => {
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(undefined))
    expect(res.status).toBe('failure')
  })
})
