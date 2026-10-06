/**
 * 覆盖范围：`plugin-install.ts`（安装插件工具）。
 *
 * 安装使一段代码在下次加载时执行，而本产品没有「逐次询问」权限模式，
 * 因此**安全检查全部依赖清单校验**：清单不合法时不安装，同 id 且未带 replace 时不安装。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { installPluginTool } from './plugin-install.ts'

type Found = Awaited<ReturnType<NonNullable<ToolContext['plugins']>['inspect']>>

function port(found: Found, result: { ok: boolean; error?: string } = { ok: true }) {
  const installs: { dir: string; replace: boolean }[] = []
  return {
    installs,
    port: {
      inspect: async () => found,
      install: async (dir: string, opts: { replace: boolean }) => {
        installs.push({ dir, replace: opts.replace })
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
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    stepId: 'st_test',
    requestPermission: async (call: { toolName: string }) => {
      asked.push(call.toolName)
      return approve ? { allowed: true } : { allowed: false, reason: '夹具拒绝' }
    },
    ...(plugins ? { plugins } : {}),
    asked,
  } as ToolContext & { asked: string[] }
}

describe('安装插件', () => {
  test('校验通过即安装，不请求用户确认', async () => {
    const p = port(good)
    const c = ctx(p.port)
    const res = await installPluginTool.fn({ path: 'demo' }, c)
    expect(res.status).toBe('success')
    expect(p.installs).toEqual([{ dir: 'demo', replace: false }])
    // 本产品只有 auto / full 两种权限模式，没有「逐次询问」。
    expect(c.asked).toHaveLength(0)
  })

  test('端口拒绝时如实报告失败', async () => {
    const p = port(good, { ok: false, error: '目标目录写不进去' })
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('写不进去')
  })

  test('清单不合法时立即拒绝，不继续安装', async () => {
    const p = port({ ok: false, error: '目录里没有 qywork.plugin.json' })
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(res.status).toBe('failure')
    expect(p.installs).toHaveLength(0)
  })

  /** 覆盖已安装的插件需要模型显式声明：未传 `replace` 即拒绝，不默认覆盖。 */
  test('同 id 已存在：未带 replace 时直接拒绝，带上后才继续安装', async () => {
    const p = port({ ...good, replacing: true })
    const first = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(first.status).toBe('failure')
    expect(p.installs).toHaveLength(0)

    const second = await installPluginTool.fn({ path: 'demo', replace: true }, ctx(p.port))
    expect(second.status).toBe('success')
    expect(p.installs).toEqual([{ dir: 'demo', replace: true }])
  })

  /** 安装后不会立即生效；若不说明，模型会在同一轮内反复查找该新工具。 */
  test('安装完成的提示中写明下一条消息起生效', async () => {
    const p = port(good)
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(p.port))
    expect(res.message).toContain('下一条消息')
  })

  test('没有插件通道时不安装，也不报告成功', async () => {
    const res = await installPluginTool.fn({ path: 'demo' }, ctx(undefined))
    expect(res.status).toBe('failure')
  })
})
