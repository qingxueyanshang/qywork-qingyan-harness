/**
 * 工具结果的附带文本块（`outcome.data.texts`）：标记独立成块，估算按声明的特征计数计。
 *
 * 覆盖范围：`loop/request.ts` 的 `textsOf` / `toolResultContent` / `envelopeResult` / `omitImages`，
 * `delivery.ts` 的 `outcomeTokens`，`compaction.ts` 的 `condenseMessage`，以及经 `AgentLoop.run` 的
 * 占用读数、锚点准入（`turn-end.ts` 的 `inputLimit`）与投递额度。压缩回收量与选界由
 * `runtime/compaction.test.ts`、取回由 `runtime/session.test.ts` 与 `tools/history.test.ts` 覆盖。
 *
 * 声明的计数取被替换正文的 `textFeatures`：本地估算因此等于把标记替换为正文之后的估算，
 * 各处取同一个值。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, ContentBlock, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import { estimateMessage, estimateRequest, estimateText, textFeatures } from '@qywork/ai'
import { condenseMessage } from '../compaction.ts'
import { batchRemaining, chargeBatchBudget, outcomeTokens } from '../delivery.ts'
import { AgentLoop } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { envelopeResult, omitImages, textsOf, toolResultContent } from './request.ts'

const BODY =
  '技能主文档的正文，按步骤执行。Run check_all.py before export; step 12 of 40.\n'.repeat(2500)
const MARKER = '[[cloud:pkg/SKILL.md#sha256:0f3a]]'
const FEATURES = textFeatures(BODY)
const ENVELOPE = '{"call_id":"c_1","tool":"read_skill","status":"success","summary":"读取"}'

describe('附带文本块的形状', () => {
  test('每项成为信封之后的独立文本块并带特征计数，信封的 result 中不含该键', () => {
    const data = { path: 'SKILL.md', texts: [{ text: MARKER, features: FEATURES }] }
    expect(toolResultContent(ENVELOPE, data)).toEqual([
      { type: 'text', text: ENVELOPE },
      { type: 'text', text: MARKER, features: FEATURES },
    ])
    expect(envelopeResult(data)).toEqual({ path: 'SKILL.md' })
    expect(envelopeResult({ texts: [{ text: MARKER, features: FEATURES }] })).toBeUndefined()
  })

  test('缺少的计数项按 0 计，不合法的项不予采用', () => {
    expect(
      textsOf({
        texts: [
          { text: MARKER, features: { cjk: 3, word: -1, letter: 'x' } },
          { text: 1, features: FEATURES },
          { text: MARKER },
          null,
        ],
      }),
    ).toEqual([
      {
        type: 'text',
        text: MARKER,
        features: {
          cjk: 3,
          rareCjk: 0,
          word: 0,
          letter: 0,
          caseBreak: 0,
          digit: 0,
          punctRun: 0,
          punct: 0,
          space: 0,
          other: 0,
        },
      },
    ])
  })

  test('图片换出为说明时附带文本块保留在信封之后', () => {
    const m: WireMessage = {
      role: 'tool',
      toolCallId: 'c_1',
      content: [
        { type: 'text', text: ENVELOPE },
        { type: 'text', text: MARKER, features: FEATURES },
        { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'QUJD' } },
      ],
    }
    const omitted = omitImages(m, 'omitted').content as ContentBlock[]
    expect(omitted.map((b) => b.type)).toEqual(['text', 'text'])
    expect(JSON.parse(omitted[0]!.type === 'text' ? omitted[0]!.text : '')).toHaveProperty(
      'images_omitted',
    )
    expect(omitted[1]).toEqual({ type: 'text', text: MARKER, features: FEATURES })
  })
})

describe('各处取同一个值', () => {
  const d = fakeAdapter([]).spec.density

  test('投递额度等于请求侧对该块的估算，即被替换正文的估算', () => {
    const plain = { message: '读取 SKILL.md', data: { path: 'SKILL.md' } }
    const declared = {
      message: '读取 SKILL.md',
      data: { path: 'SKILL.md', texts: [{ text: MARKER, features: FEATURES }] },
    }
    expect(outcomeTokens(declared, d) - outcomeTokens(plain, d)).toBe(estimateText(BODY, d))
    const message: WireMessage = {
      role: 'tool',
      toolCallId: 'c_1',
      content: toolResultContent(ENVELOPE, declared.data),
    }
    expect(
      estimateMessage(message, d) - estimateMessage({ ...message, content: ENVELOPE }, d),
    ).toBe(estimateText(BODY, d))
  })

  /** 收纳后标记不再出现在请求中，信封注明正文已移除；再次收纳逐字相同。 */
  test('收纳移除附带文本块并标记 result_omitted，回收量包含声明的大小', () => {
    const message: WireMessage = {
      role: 'tool',
      toolCallId: 'c_1',
      content: toolResultContent(ENVELOPE, { texts: [{ text: MARKER, features: FEATURES }] }),
    }
    const condensed = condenseMessage(message)
    expect(typeof condensed.content).toBe('string')
    expect(String(condensed.content)).not.toContain(MARKER)
    expect(JSON.parse(String(condensed.content))).toMatchObject({ result_omitted: true })
    expect(condenseMessage(condensed)).toEqual(condensed)
    expect(estimateMessage(message, d) - estimateMessage(condensed, d)).toBe(
      estimateText(BODY, d) +
        estimateText(ENVELOPE, d) -
        estimateText(String(condensed.content), d),
    )
  })
})

describe('经 AgentLoop 的占用读数、锚点准入与投递额度', () => {
  /** 把声明了计数的文本块替换为正文：上游实际收到的请求。 */
  function replaced(req: ChatRequest): ChatRequest {
    return {
      ...req,
      messages: req.messages.map((m) =>
        typeof m.content === 'string'
          ? m
          : {
              ...m,
              content: m.content.map((b) =>
                b.type === 'text' && b.features ? { type: 'text' as const, text: BODY } : b,
              ),
            },
      ),
    }
  }

  test('读取附带文本块之后，下一次请求的读数与锚点按声明的大小计，同一决策的额度扣除同一个值', async () => {
    const base = fakeAdapter([[call('cloud'), call('probe')], null])
    const d = base.spec.density
    const sent: ChatRequest[] = []
    const adapter: LlmAdapter = {
      ...base,
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        sent.push(req)
        const real = estimateRequest(replaced(req), d)
        for await (const ev of base.stream(req)) {
          yield ev.type === 'usage'
            ? { ...ev, usage: { ...ev.usage, inputTokens: real, outputTokens: 0 } }
            : ev
        }
      },
    }
    const remaining: number[] = []
    let delivered = 0
    const registry = new ToolRegistry()
    const spec = {
      description: '测试夹具。',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      actionKind: 'read' as const,
      objectLabel: '测试',
      category: 'session' as const,
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control' as const,
    }
    registry.register({
      ...spec,
      name: 'cloud',
      async fn(_args, ctx) {
        const outcome = {
          status: 'success' as const,
          message: '读取 SKILL.md',
          data: { path: 'SKILL.md', texts: [{ text: MARKER, features: FEATURES }] },
        }
        remaining.push(batchRemaining(ctx))
        delivered = outcomeTokens(outcome, ctx.density)
        expect(chargeBatchBudget(ctx, delivered).ok).toBe(true)
        return outcome
      },
    })
    registry.register({
      ...spec,
      name: 'probe',
      async fn(_args, ctx) {
        remaining.push(batchRemaining(ctx))
        return { status: 'success', message: 'ok' }
      },
    })
    const persist = noopPersistence()
    const opened: { measured: number; occupancy: number | undefined }[] = []
    const anchored: boolean[] = []
    let requests = 0
    const loop = new AgentLoop({
      adapter,
      registry,
      systemPrompt: 'sys',
      persist: {
        ...persist,
        openRequest: (input) => {
          opened.push({ measured: input.measuredInputTokens, occupancy: input.occupancyTokens })
          return `pr_${++requests}`
        },
        settleRequest: (...a) => {
          anchored.push(a[6] === true)
        },
      },
      makeToolContext: (runId) => baseCtx(runId),
    })
    for await (const _ of loop.run({
      compactPercent: 80,
      runId: 'rn_declared' as never,
      history: [{ role: 'user', content: '读取技能' }],
      signal: new AbortController().signal,
    })) {
      // 只检查请求账与工具一侧的额度
    }

    // 第二次请求带着附带文本块发出，标记本身只有几十个字符。
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(sent[1]!.messages)).toContain(MARKER)
    const body = estimateText(BODY, d)
    // 本地估算等于上游收到的、标记替换为正文之后的请求的估算。
    expect(opened[1]!.measured).toBe(estimateRequest(replaced(sent[1]!), d))
    expect(opened[1]!.occupancy!).toBeGreaterThan(body)
    // 上游回报在准入上限之内，作为锚点。
    expect(anchored).toEqual([true, true])
    // 投递额度扣除的正是 `outcomeTokens` 的值，其中包含声明的大小。
    expect(delivered).toBeGreaterThan(body)
    expect(remaining[0]! - remaining[1]!).toBe(delivered)
  })
})
