/**
 * 覆盖范围：`sink.ts` 的可重放性分类、裁剪与落盘、调用方自带摘录的那条入口，
 * 子 agent 产出的投递闸，以及只读工具的续读交付（`deliverReadable`）。
 */
import { describe, expect, test } from 'bun:test'
import { batchRemaining, deliveredTokens, openBatchBudget } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  clampBody,
  deliver,
  deliverAgentOutput,
  deliverReadable,
  INLINE_BUDGET_BYTES,
  isContentAuthority,
  observationBudget,
  type SinkPort,
} from './sink.ts'

const enc = new TextEncoder()

function fakeSink(): SinkPort & { landed: Uint8Array[] } {
  const landed: Uint8Array[] = []
  return {
    landed,
    land(input) {
      landed.push(input.body)
      return { resourceId: `rs_${landed.length}`, contentHash: 'sha256:x' }
    },
    read: () => null,
    stat: () => null,
  }
}

describe('可重放性分类', () => {
  test('外部抓取与命令执行属于内容权威', () => {
    expect(isContentAuthority('web_fetch')).toBe(true)
    expect(isContentAuthority('run_command')).toBe(true)
  })

  test('工作区读取不属于内容权威 —— 再读一次就有了', () => {
    expect(isContentAuthority('read_file')).toBe(false)
    expect(isContentAuthority('grep')).toBe(false)
    expect(isContentAuthority('list_dir')).toBe(false)
  })

  test('第三方 MCP 工具保守当作不可重放', () => {
    expect(isContentAuthority('mcp__github__get_issue')).toBe(true)
  })

  /** 漏一个的后果是那个出口静默不落盘：`deliver` 直接走不截断分支，不报错。 */
  test('会带回观察的四个 desktop 工具都在表里', () => {
    for (const name of ['desktop_observe', 'desktop_act', 'desktop_act_sequence', 'desktop_wait']) {
      expect(isContentAuthority(name)).toBe(true)
    }
  })

  test('会带回观察或选项页的四个 browser 工具都在表里，只回短回执的三个不在', () => {
    for (const name of ['browser_observe', 'browser_act', 'browser_navigate', 'browser_wait']) {
      expect(isContentAuthority(name)).toBe(true)
    }
    for (const name of ['browser_tabs', 'browser_upload', 'browser_download']) {
      expect(isContentAuthority(name)).toBe(false)
    }
  })
})

/**
 * 结构化正文按字节头尾裁出来的不是可用的结果，这类调用方自己选好投递哪一部分，
 * `deliver` 只管落盘、地址、覆盖事实与失败降级。
 */
describe('调用方自带摘录', () => {
  const body = enc.encode('a'.repeat(INLINE_BUDGET_BYTES * 3))
  const excerpt = { text: '[{"ref":"w#0"}]', truncated: true, deliveredBytes: 15 }

  test('正文照旧整份落盘，摘录原样回，不追加保存说明', () => {
    const sink = fakeSink()
    const r = deliver(sink, {
      toolName: 'desktop_observe',
      sourceType: 'desktop:observation',
      body,
      excerpt,
    })

    expect(sink.landed[0]!.byteLength).toBe(body.byteLength)
    expect(r.resourceId).toBe('rs_1')
    expect(r.text).toBe(excerpt.text)
    expect(r.coverage.deliveredBytes).toBe(15)
    expect(r.coverage.totalBytes).toBe(body.byteLength)
    expect(r.coverage.truncated).toBe(true)
  })

  test('落盘失败时给出原因，摘录仍然原样回', () => {
    const failing: SinkPort = {
      land() {
        throw new Error('磁盘满了')
      },
      read: () => null,
      stat: () => null,
    }
    const r = deliver(failing, {
      toolName: 'desktop_act',
      sourceType: 'desktop:observation',
      body,
      excerpt,
    })

    expect(r.resourceId).toBeNull()
    expect(r.status).toBe('partial')
    expect(r.landError).toBe('磁盘满了')
    expect(r.text).toBe(excerpt.text)
    expect(r.coverage.landFailed).toBe(true)
  })

  test('没有 sink 时不落盘，摘录原样回', () => {
    const r = deliver(null, {
      toolName: 'desktop_act',
      sourceType: 'desktop:observation',
      body,
      excerpt,
    })
    expect(r.resourceId).toBeNull()
    expect(r.landError).toBeUndefined()
    expect(r.text).toBe(excerpt.text)
  })

  test('现有调用方不受影响：仍按字节裁剪并追加保存说明', () => {
    const sink = fakeSink()
    const r = deliver(sink, { toolName: 'run_command', sourceType: 'shell', body })
    expect(r.text).toContain('完整输出已保存')
    expect(r.text).toContain('read_resource')
    expect(r.landError).toBeUndefined()
  })
})

describe('裁剪', () => {
  test('未超预算原样返回', () => {
    const r = clampBody(enc.encode('短输出'))
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('短输出')
  })

  test('超预算保留头和尾 —— 错误信息通常在尾部', () => {
    const body = enc.encode(`开头标记${'x'.repeat(20000)}结尾标记`)
    const r = clampBody(body)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('开头标记')
    expect(r.text).toContain('结尾标记')
    expect(r.text).toContain('中间省略')
  })

  test('切点落在 UTF-8 字符边界，不产生替换符', () => {
    // 全中文，每字 3 字节；预算取非 3 的倍数，强制切在字符中间。
    const body = enc.encode('中'.repeat(5000))
    const r = clampBody(body, 1000)
    expect(r.truncated).toBe(true)
    expect(r.text).not.toContain('�')
  })

  test('四字节字符（emoji）同样不被切坏', () => {
    const body = enc.encode('🙂'.repeat(5000))
    const r = clampBody(body, 1001)
    expect(r.text).not.toContain('�')
  })

  test('二进制内容不炸，替换符如实出现（那是真实信息）', () => {
    const body = new Uint8Array(20000)
    body.fill(0xff)
    const r = clampBody(body)
    expect(r.truncated).toBe(true)
    expect(typeof r.text).toBe('string')
  })
})

describe('投递分支', () => {
  test('本地权威工具即使超预算也不落盘', () => {
    const sink = fakeSink()
    const body = enc.encode('y'.repeat(INLINE_BUDGET_BYTES * 3))
    const r = deliver(sink, { toolName: 'read_file', sourceType: 'workspace', body })

    expect(sink.landed).toHaveLength(0)
    expect(r.resourceId).toBeNull()
    // 仍然要截断——上下文预算是硬的，跟可重放性无关。
    expect(r.coverage.truncated).toBe(true)
  })

  test('内容权威但没超预算也不落盘', () => {
    const sink = fakeSink()
    const r = deliver(sink, {
      toolName: 'run_command',
      sourceType: 'shell',
      body: enc.encode('ok'),
    })
    expect(sink.landed).toHaveLength(0)
    expect(r.resourceId).toBeNull()
    expect(r.coverage.truncated).toBe(false)
  })

  test('内容权威 + 超预算才落盘，并把 resource id 告诉模型', () => {
    const sink = fakeSink()
    const body = enc.encode('z'.repeat(INLINE_BUDGET_BYTES * 3))
    const r = deliver(sink, { toolName: 'run_command', sourceType: 'shell', body })

    expect(sink.landed).toHaveLength(1)
    expect(sink.landed[0]!.byteLength).toBe(body.byteLength)
    expect(r.resourceId).toBe('rs_1')
    expect(r.text).toContain('rs_1')
    expect(r.text).toContain('read_resource')
  })

  test('覆盖事实必须完整 —— 模型要知道自己看到的是几分之几', () => {
    const sink = fakeSink()
    const body = enc.encode('w'.repeat(100_000))
    const r = deliver(sink, {
      toolName: 'web_fetch',
      sourceType: 'http',
      body,
      query: 'https://example.com',
    })
    expect(r.coverage.totalBytes).toBe(100_000)
    expect(r.coverage.deliveredBytes).toBeLessThan(100_000)
    expect(r.coverage.truncated).toBe(true)
    expect(r.coverage.query).toBe('https://example.com')
  })

  test('落盘失败时明确告知，不让模型去读一个不存在的 id', () => {
    const failing: SinkPort = {
      land() {
        throw new Error('磁盘满了')
      },
      read: () => null,
      stat: () => null,
    }
    const body = enc.encode('q'.repeat(INLINE_BUDGET_BYTES * 3))
    const r = deliver(failing, { toolName: 'run_command', sourceType: 'shell', body })

    expect(r.resourceId).toBeNull()
    expect(r.status).toBe('partial')
    expect(r.text).toContain('保存失败')
    expect(r.text).not.toContain('read_resource')
  })

  test('没有 sink 时降级为纯截断，不抛', () => {
    const body = enc.encode('v'.repeat(INLINE_BUDGET_BYTES * 3))
    const r = deliver(null, { toolName: 'run_command', sourceType: 'shell', body })
    expect(r.resourceId).toBeNull()
    expect(r.coverage.truncated).toBe(true)
  })
})

/**
 * 子 agent 与 workflow 的产出走这一道：摘录取单份视图尺寸，不是 8 KB 默认值。
 * 调用方是 server 的派活通道（组装回执时），在任何一次 provider 决策之外，不走投递额度。
 */
describe('子 agent 产出的投递闸', () => {
  const window = 200_000
  const budget = observationBudget(window)
  const middle = '被摘录切掉的那一句'
  const huge = '审查结论。'.repeat(30_000) + middle + '审查结论。'.repeat(30_000)
  const context = () => ({
    sink: fakeSink(),
    contextWindow: window,
    density: DEFAULT_DENSITY,
  })

  test('超长产出落盘，交出去的是有界摘要加定位符', () => {
    const ctx = context()
    const landed = deliverAgentOutput(ctx, {
      toolName: 'subagent',
      sourceType: 'subagent',
      body: huge,
    })
    expect(deliveredTokens(landed.text, DEFAULT_DENSITY)).toBeLessThanOrEqual(budget)
    expect(landed.text).not.toContain(middle)
    expect(landed.text).toContain('read_resource')
    expect(landed.coverage?.truncated).toBe(true)
    expect(landed.resource?.resourceId).toBeTruthy()
  })

  test('没超预算的原样交出，不落盘', () => {
    const ctx = context()
    const landed = deliverAgentOutput(ctx, {
      toolName: 'subagent',
      sourceType: 'subagent',
      body: '三行结论',
    })
    expect(landed.text).toBe('三行结论')
    expect(landed.coverage).toBeNull()
    expect(landed.resource).toBeNull()
    expect(ctx.sink.landed).toHaveLength(0)
  })

  /** 一条回执里几格平分同一份视图尺寸。每格各拿一份的话内联总量随格数线性增长。 */
  test('share 是分母：几格平分同一份预算', () => {
    const alone = deliverAgentOutput(context(), {
      toolName: 'workflow',
      sourceType: 'workflow:a',
      body: huge,
    }).text
    const shared = deliverAgentOutput(context(), {
      toolName: 'workflow',
      sourceType: 'workflow:a',
      body: huge,
      share: 2,
    }).text
    expect(shared.length).toBeLessThan(alone.length * 0.6)
    expect(shared.length).toBeGreaterThan(alone.length * 0.4)
  })

  /** 回执在决策之外产生：不要求开账，也不动任何一份决策账。 */
  test('不走投递额度', () => {
    const ctx = context()
    expect(() =>
      deliverAgentOutput(ctx, { toolName: 'subagent', sourceType: 'subagent', body: huge }),
    ).not.toThrow()
    expect('state' in ctx).toBe(false)
  })
})

/**
 * 只读工具交付一段不能按范围续读的正文。三档：整份装得下、装不下（头部 + 落盘续读）、余额为 0。
 */
describe('续读交付', () => {
  const body = `${'前段正文。'.repeat(2000)}尾部标记`
  // 窗口取 0：尾部保留量为 0，单次上限等于余额。
  const context = (room: number) => ({
    sink: fakeSink(),
    density: DEFAULT_DENSITY,
    contextWindow: 0,
    state: openBatchBudget(new Map<string, unknown>(), room),
  })
  const input = {
    toolName: 'read_history',
    sourceType: 'history:message',
    whole: { message: '读回消息', data: { content: body } },
    body,
    partial: (head: string, note: string) => ({
      message: `读回消息${note}`,
      data: { content: head, truncated: true },
    }),
  }

  test('装得下：整份投递，不落盘', () => {
    const ctx = context(1_000_000)
    const r = deliverReadable(ctx, input)
    expect((r.data as { content: string }).content).toBe(body)
    expect(ctx.sink.landed).toHaveLength(0)
    expect(r.resources).toBeUndefined()
  })

  test('装不下：投递头部，完整正文存一次，说明里给出续读位置', () => {
    const ctx = context(2000)
    const r = deliverReadable(ctx, input)
    const head = (r.data as { content: string }).content
    expect(r.status).toBe('success')
    expect(body.startsWith(head)).toBe(true)
    expect(head.length).toBeLessThan(body.length)
    expect(ctx.sink.landed).toHaveLength(1)
    expect(new TextDecoder().decode(ctx.sink.landed[0])).toBe(body)
    expect(r.message).toContain(`offset=${new TextEncoder().encode(head).byteLength}`)
    expect(r.resources?.[0]?.resourceId).toBeTruthy()
    // 头部按余额定：只超出续读说明那几十 token。
    expect(2000 - batchRemaining(ctx)).toBeGreaterThan(1500)
  })

  test('余额为 0：失败，不落盘', () => {
    const ctx = context(0)
    const r = deliverReadable(ctx, input)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('result_too_large')
    expect(ctx.sink.landed).toHaveLength(0)
  })
})
