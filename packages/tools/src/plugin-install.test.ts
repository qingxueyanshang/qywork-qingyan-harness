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

function port(found: Found, result: { ok: boolean; error?: string } = { ok: true }) {
  const installs: { dir: string; replace: boolean; runId: string }[] = []
  return {
    installs,
    port: {
      inspect: async () => found,
      install: async (dir: string, opts: { replace: boolean; runId: string }) => {
        installs.push({ dir, replace: opts.replace, runId: opts.runId })
        return result
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
  test('装成功时把这一轮的 runId 带给端口 —— 授权请求要挂在这一轮上', async () => {
    const p = port(good)
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(res.status).toBe('success')
    expect(p.installs).toEqual([{ dir: 'demo', replace: false, runId: 'rn_test' }])
  })

  /**
   * 复现的失败形状：第一版在工具里调 `ctx.requestPermission` 问用户，而那条通道
   * 在这个仓库里由会话按权限模式就地裁决，除 `run_command` 外一律放行——
   * 真机跑通一次，全程没有任何弹窗。问用户这一步必须落在端口那边。
   */
  test('工具自己不问用户 —— 那条通道弹不到人', async () => {
    const p = port(good)
    const c = ctx(p.port)
    await installPluginTool.fn({ path: 'demo' }, c)
    expect(c.asked).toHaveLength(0)
  })

  test('用户不点头时端口回拒，工具如实报失败', async () => {
    const p = port(good, { ok: false, error: '用户没同意装这个插件' })
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('没同意')
  })

  test('清单不合法当场拒，也不往下走', async () => {
    const p = port({ ok: false, error: '目录里没有 qywork.plugin.json' })
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(res.status).toBe('failure')
    expect(p.installs).toHaveLength(0)
  })

  /** 覆盖已装的那一份要模型显式说。授权卡上写明是覆盖由端口那边负责。 */
  test('同 id 已存在：不带 replace 直接拒，带了才往下走', async () => {
    const p = port({ ...good, replacing: true })
    const first = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(first.status).toBe('failure')
    expect(p.installs).toHaveLength(0)

    const second = await installPluginTool.fn({ path: 'demo', replace: true }, ctx(p.port))
    expect(second.status).toBe('success')
    expect(p.installs).toEqual([{ dir: 'demo', replace: true, runId: 'rn_test' }])
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
