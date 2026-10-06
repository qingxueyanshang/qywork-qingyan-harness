#!/usr/bin/env bun

/**
 * 针对真实端点运行 `openai_responses` 适配器。
 *
 *   DEEPSEEK_API_KEY=sk-... bun run scripts/smoke-responses.ts
 *
 * **单元测试无法覆盖的部分。** 单元测试（含 `openai-responses.stream.test.ts` 中的 fixture server）锁定的是
 * 本仓库对报文的理解，无法锁定供应商实际发送的内容与实际要求，
 * 这两方面都出现过错误：
 *
 * - 只识别 `response.reasoning_summary_text.delta`，而 DeepSeek 发送的是
 *   `response.reasoning_text.delta`。后果是静默的：思考内容全部丢失，不报错。
 * - 不回传 `reasoning_text`。后果是第二轮返回 400，第一轮完全正常。
 *
 * 第二条尤其说明问题：它只在「调用工具 → 回传结果」时出现，
 * 即 agent 主循环的每一轮。任何单轮冒烟都无法测出，
 * 因此下方第 2 项必须真实完成两轮，不能只发一次请求就判定通过。
 *
 * **验证范围。** 验证本仓库的客户端能否与真实的 Responses 端点正确对接。
 * 不验证 DeepSeek 的服务端行为是否正确，也不代表 OpenAI 自身的端点同样通过：
 * 该路径尚未运行过。
 */

import type { ProviderEvent, ProviderUsage, WireMessage, WireToolCall } from '@qywork/ai'
import { buildAdapter, lookupModel, STREAM_IDLE_TIMEOUT_MS } from '@qywork/ai'

/**
 * 一个待测端点。
 *
 * **支持配置两个端点的原因。** 实现 Responses 协议的供应商不止一家，各家在推理部分的行为不同：
 * OpenAI 发送 `reasoning_summary_text.delta`、不要求回传；
 * DeepSeek 发送 `reasoning_text.delta`、不回传则返回 400。
 *
 * 适配器因此同时识别两个事件名，并依据「收到过 `reasoning_text` 才补充回传」的
 * 判据分流。两条分支各自只在一种实现下执行：只运行一个端点时，
 * 另一条分支始终未经验证，而它出错的表现是静默丢失全部思考内容。
 *
 * 因此同一套断言对两种实现各运行一遍。这是目前唯一能自动防止
 * 「修复一侧、破坏另一侧」的手段。
 */
interface Endpoint {
  label: string
  key: string
  baseUrl: string
  model: string
}

/*
 * 此处有意不设 `dialect` 字段。
 *
 * 不要添加 `dialect: 'reasoning_text' | 'summary'` 来决定反证项应期待 400
 * 还是 200：适配器把两种实现的推理增量都归一化为 `thinking_delta`，脚本一侧
 * 无法分辨当前端点属于哪种实现，该字段只能手动填写。手动填写的预期与实测不符时，
 * 开发者会修改字段而不是排查代码。
 *
 * 真正跨实现的断言是第 1 项的「收到思考增量」：两个端点都必须非空。
 * 只识别一个事件名时，另一种实现会静默地收不到任何增量。
 * 反证项按端点如实记录实际行为，不预设结论。
 */

/** 端点清单。第二个可选：未配置时只运行第一个，并明确提示只运行了一个。 */
const ENDPOINTS: Endpoint[] = [
  {
    label: process.env.QY_RESPONSES_LABEL ?? 'DeepSeek',
    key: process.env.DEEPSEEK_API_KEY ?? process.env.QY_RESPONSES_KEY ?? '',
    baseUrl: process.env.QY_RESPONSES_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: process.env.QY_RESPONSES_MODEL ?? 'deepseek-flash',
  },
  {
    label: process.env.QY_RESPONSES_LABEL_2 ?? '第二端点',
    key: process.env.QY_RESPONSES_KEY_2 ?? '',
    baseUrl: process.env.QY_RESPONSES_BASE_URL_2 ?? '',
    model: process.env.QY_RESPONSES_MODEL_2 ?? 'gpt-5.4-mini',
  },
].filter((e) => e.key && e.baseUrl)

/** 当前正在运行的端点。`once()` 从此处取得连接参数。 */
let EP: Endpoint = ENDPOINTS[0] ?? { label: '(none)', key: '', baseUrl: '', model: '' }

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined)
      process.stdout.write(`      ${JSON.stringify(detail).slice(0, 400)}\n`)
  }
}

const WEATHER = {
  name: 'get_weather',
  description: '查询某个城市当前的天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
}

interface Collected {
  text: string
  thinking: string
  calls: WireToolCall[]
  usage: ProviderUsage | null
  stopReason: string
}

/**
 * 传输层间歇失败时重试。
 *
 * 本开发机对 `api.deepseek.com` 的连接会间歇性失败（超时 / 连接被关闭 /
 * 证书校验失败），实测同一脚本 5 次中失败 2 次。这是环境问题，
 * 不是客户端问题；但若不处理，冒烟脚本会在第一条请求上崩溃并输出堆栈，
 * 被误判为客户端缺陷，而后续十几项断言均未执行。
 *
 * 因此只对 `network_error` 重试，并输出重试次数：
 * 静默重试成功等于隐藏「该链路不稳定」这一事实。
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'network_error' || i >= tries) throw err
      process.stdout.write(`  · ${label}：第 ${i} 次传输层失败（${code}），重试\n`)
      await new Promise((r) => setTimeout(r, 1000 * i))
    }
  }
}

async function once(
  messages: WireMessage[],
  opts: { tools?: boolean; cacheKey?: string; system?: string; noThink?: boolean } = {},
): Promise<Collected> {
  return withRetry('请求', () => streamOnce(messages, opts))
}

async function streamOnce(
  messages: WireMessage[],
  opts: { tools?: boolean; cacheKey?: string; system?: string; noThink?: boolean } = {},
): Promise<Collected> {
  const adapter = buildAdapter({
    kind: 'openai_responses',
    apiKey: EP.key,
    baseUrl: EP.baseUrl,
    model: EP.model,
  })
  const out: Collected = { text: '', thinking: '', calls: [], usage: null, stopReason: '' }
  for await (const ev of adapter.stream({
    model: EP.model,
    system: opts.system ? [{ text: opts.system }] : [],
    messages,
    tools: opts.tools ? [WEATHER] : [],
    maxOutputTokens: 2048,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    // `ThinkingRequest` 只有 adaptive / budget 两档，没有关闭档：
    // 不发送该字段即不请求思考，因此 `noThink` 只影响下方几条断言的期望值。
    ...(opts.cacheKey ? { cacheKey: opts.cacheKey } : {}),
  })) {
    apply(out, ev)
  }
  return out
}

function apply(out: Collected, ev: ProviderEvent): void {
  if (ev.type === 'text_delta') out.text += ev.delta
  else if (ev.type === 'thinking_delta') out.thinking += ev.delta
  else if (ev.type === 'tool_calls') out.calls = ev.calls
  else if (ev.type === 'usage') out.usage = ev.usage
  else if (ev.type === 'done') out.stopReason = ev.stopReason
}

async function main(): Promise<number> {
  if (ENDPOINTS.length === 0) {
    // 没有 key 时明确输出跳过，不静默通过：始终通过的冒烟比没有冒烟更危险。
    process.stdout.write('跳过：没有 DEEPSEEK_API_KEY / QY_RESPONSES_KEY\n')
    return 0
  }

  if (ENDPOINTS.length === 1) {
    /*
     * 只运行了一个端点时必须明确输出提示。
     *
     * 适配器中有两条分流分支，只运行一个端点时只会执行其中一条。
     * 不输出提示时，一次「全部通过」看起来像两种实现都已验证，
     * 而实际上另一条分支本次未执行任何一行。这与「静默截断」属于同一类错误：
     * 覆盖面缩小了，而结论的措辞没有相应缩小。
     */
    process.stdout.write(
      '注意：只配置了一个端点，分流的另一条分支本次未执行。\n' +
        '  配置第二个端点即可对两种实现各运行一遍：\n' +
        '  QY_RESPONSES_KEY_2=sk-... QY_RESPONSES_BASE_URL_2=https://.../v1 [QY_RESPONSES_MODEL_2=...]\n\n',
    )
  }

  for (const ep of ENDPOINTS) {
    EP = ep
    process.stdout.write(`━━ ${ep.label} · ${ep.baseUrl} · ${ep.model} ━━\n\n`)
    const before = failures
    try {
      await runEndpoint()
    } catch (err) {
      // 一个端点抛错不应阻止后续端点运行，否则会掩盖「另一种实现出错」。
      failures++
      process.stdout.write(`  ✗ ${ep.label} 中断：${err instanceof Error ? err.message : err}\n`)
    }
    process.stdout.write(
      failures === before
        ? `\n${ep.label}：全部通过\n\n`
        : `\n${ep.label}：${failures - before} 项失败\n\n`,
    )
  }

  process.stdout.write(failures === 0 ? '全部端点通过\n' : `合计 ${failures} 项失败\n`)
  return failures === 0 ? 0 : 1
}

async function runEndpoint(): Promise<void> {
  /*
   * 先检查该模型在客户端一侧的解析结果。
   *
   * 不检查时会把「适配器未请求推理」误判为「适配器丢失推理增量」：
   * 两者的修复方式完全不同，而现象相同（`thinking` 为空）。
   *
   * 实测形状：`gpt-5.4-mini` 不在内置目录，`lookupModel` 回退到 `unknownModel()`，
   * 其 `thinking: 'none'` 使 `buildReasoning` 省略整个 reasoning 字段，四条断言同时
   * 失败，而适配器按其掌握的信息正确执行。
   */
  const spec = lookupModel(EP.model, 'openai_responses')
  const asksForReasoning = spec.thinking !== 'none'
  if (spec.catalogued === false) {
    process.stdout.write(
      `  · ${EP.model} 不在内置目录，能力按最保守假设：` +
        `${asksForReasoning ? '' : '本次不会请求推理、'}计价按 0。\n` +
        '    如需启用思考，先运行 qy probe --save 实测一次能力。\n\n',
    )
  }

  // ── 1. 纯文本一轮：正文、思考、用量口径 ──
  process.stdout.write('1. 纯文本流式\n')
  const r1 = await once([{ role: 'user', content: '3812 乘以 79 等于多少？只给数字。' }])
  check('收到正文', r1.text.trim().length > 0, r1.text)
  if (asksForReasoning) {
    // 计算错误属于模型能力而不是协议问题。只在模型思考时断言，否则该断言会变成
    // 「小模型计算不准」的噪声；噪声一多，真正的失败便无人查看。
    check('正文含正确答案 301148', r1.text.includes('301148'), r1.text)
    // 该断言检测的是「完全没有增量」，不是「内容是否正确」。
    // 这是唯一真正跨实现的断言：只识别一个事件名时，另一种实现会静默地收不到任何增量。
    check('收到思考增量（两种实现的事件名都必须能识别）', r1.thinking.trim().length > 0)
  } else {
    process.stdout.write(
      `  · 本端点不请求推理，跳过「思考增量」与「答案正确」两项（正文：${r1.text.trim().slice(0, 20)}）\n`,
    )
  }
  // 后备字符串写成转义 `\0`，而不是原始的 NUL 字节。
  // 原始 0x00 在源码中不可见，且会使整个文件被 grep 视为二进制
  // （`Binary file matches`，grep 因此无法输出任何匹配内容）。
  // 语义上它必须是正常文本中不会出现的字符：换成空格时
  // `text.includes(' ')` 几乎恒为真，该断言将始终失败。
  check('思考内容未混入正文', !r1.text.includes(r1.thinking.slice(0, 30) || '\0'))
  check('用量来自供应商而非估算', r1.usage?.source === 'provider', r1.usage)
  check('终态为 end_turn', r1.stopReason === 'end_turn', r1.stopReason)

  // ── 2. 工具调用两轮：本项是关键 ──
  //    第一轮取得调用；第二轮回传 reasoningContent 与工具结果。
  //    不回传 reasoning_text 时，第二轮直接返回 400。
  process.stdout.write('\n2. 工具调用往返两轮\n')
  const ask: WireMessage[] = [{ role: 'user', content: '北京现在天气怎么样？用工具查。' }]
  const r2 = await once(ask, { tools: true })
  check('第一轮取得工具调用', r2.calls.length === 1, r2.calls)
  check('工具名一致', r2.calls[0]?.name === 'get_weather', r2.calls[0]?.name)
  check('参数解析为对象', typeof r2.calls[0]?.arguments?.city === 'string', r2.calls[0]?.arguments)
  check('终态为 tool_use', r2.stopReason === 'tool_use', r2.stopReason)
  if (asksForReasoning) check('工具轮也取得了思考内容', r2.thinking.trim().length > 0)

  if (r2.calls.length === 1) {
    const second: WireMessage[] = [
      ...ask,
      {
        role: 'assistant',
        content: r2.text,
        toolCalls: r2.calls,
        // 缺少该行时，下方请求会返回 400。第 2 项的目的是执行到此处。
        ...(r2.thinking.trim() ? { reasoningContent: r2.thinking } : {}),
      },
      { role: 'tool', toolCallId: r2.calls[0]!.id, content: '晴，28 摄氏度，风力 2 级' },
    ]
    try {
      const r3 = await once(second, { tools: true })
      check('第二轮未返回 400（reasoning_text 已回传）', true)
      check('第二轮正确使用了工具结果', /28/.test(r3.text), r3.text)
      check('第二轮不再重复调用工具', r3.calls.length === 0, r3.calls)
    } catch (err) {
      check('第二轮未返回 400（reasoning_text 已回传）', false, String(err))
    }

    // ── 反证：不回传时应被拒绝。缺少反证时，上方断言通过也可能只是因为端点恰好不需要回传。
    //
    // `call_id` 必须换成服务端未发出过的值，这是实测得出的判别方式：
    // 用刚取得的真实 call_id 请求时，服务端仍保留该段思考，不回传也放行；
    // 换成合成 id 才会返回 400。
    //
    // 因此用真实 id 编写反证无法测出问题：反证始终通过，回传逻辑
    // 会退化为无法确认是否仍需要的冗余代码。
    //
    // 而合成 id 是生产环境中的常态：会话存储在 SQLite 中，次日继续对话时，
    // 该 call_id 对服务端而言与合成 id 无异。该 400 不会在开发时出现，
    // 只会在用户恢复旧会话时出现。
    const staleId = 'call_00_qysmokestale000000000001'
    const withoutReasoning: WireMessage[] = [
      ...ask,
      {
        role: 'assistant',
        content: r2.text,
        toolCalls: [{ ...r2.calls[0]!, id: staleId }],
      },
      { role: 'tool', toolCallId: staleId, content: '晴，28 摄氏度' },
    ]
    try {
      await once(withoutReasoning, { tools: true })
      /*
       * 端点放行。不算失败，但必须说明三种可能的成因，
       * 否则「规则可能已放宽」的提示会在另外两种情形下每次都出现，
       * 变成噪声；噪声一多，规则真正放宽时也无人查看。
       */
      process.stdout.write(
        '  · 陈旧 call_id 且不回传思考内容，本端点放行。三种可能：\n' +
          '      端点为 summary 形式（不要求回传）／本次未请求推理／服务端放宽了规则。\n',
      )
    } catch (err) {
      check(
        '反证：陈旧 call_id 且不回传思考内容 → 被拒',
        /reasoning_text|thinking/i.test(String(err)),
        String(err),
      )
    }

    // 正向验证：陈旧 call_id 加上回传应当仍能通过，以此证明回传是有效的修复手段。
    try {
      const r4 = await once(
        [
          ...ask,
          {
            role: 'assistant',
            content: r2.text,
            toolCalls: [{ ...r2.calls[0]!, id: staleId }],
            reasoningContent: r2.thinking,
          },
          { role: 'tool', toolCallId: staleId, content: '晴，28 摄氏度' },
        ],
        { tools: true },
      )
      check('陈旧 call_id + 回传思考内容 → 通过', r4.stopReason !== '', r4.stopReason)
    } catch (err) {
      check('陈旧 call_id + 回传思考内容 → 通过', false, String(err))
    }
  }

  // ── 3. 缓存命中口径 ──
  //    Responses 的 input_tokens 包含缓存命中，本仓库统一转换为排他口径。
  //    只有连续两次发送同一个长前缀才能判断是否已扣减。
  process.stdout.write('\n3. 缓存命中口径\n')
  // 前缀必须每次运行都不同。使用固定前缀时，第一次请求就命中上一次运行留下的缓存，
  // 因此「第二次比第一次少」这条断言恒不成立。实测形状：first=42 second=42
  // cached=768，这不是口径错误，而是测试方法错误。
  const salt = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const longSystem = `参考资料（${salt}）：${'本项目是一个本地编程 agent。'.repeat(120)}`
  const cacheKey = `qy-smoke-${EP.model}-${salt}`
  const c1 = await once([{ role: 'user', content: '用一个字回答：好' }], {
    system: longSystem,
    cacheKey,
  })
  const c2 = await once([{ role: 'user', content: '用一个字回答：好' }], {
    system: longSystem,
    cacheKey,
  })
  check(
    '第一次的 cachedTokens 为数字而非 null',
    typeof c1.usage?.cachedTokens === 'number',
    c1.usage,
  )
  if (typeof c2.usage?.cachedTokens === 'number' && c2.usage.cachedTokens > 0) {
    check('第二次命中缓存', true)
    check(
      'inputTokens 已减去缓存命中（排他口径）',
      c2.usage.inputTokens < (c1.usage?.inputTokens ?? 0),
      { first: c1.usage?.inputTokens, second: c2.usage.inputTokens, cached: c2.usage.cachedTokens },
    )
  } else {
    // 缓存是服务端行为，未命中不代表客户端有误。输出说明而不判定失败。
    process.stdout.write(`  · 第二次未命中缓存（cached=${c2.usage?.cachedTokens}），跳过本项\n`)
  }

  // ── 4. 「不思考」必须确实不思考 ──
  //
  // 该项检测的缺陷完全静默：把「不思考」映射为 `effort:'minimal'` 时，
  // 实测 minimal 与 high 一样把全部输出预算消耗在推理上，正文被截断。
  // 用户要求不思考，得到的却是全额思考、一段截断的回答和相应账单，没有任何报错。
  // 只有针对真实端点检查 `reasoning_tokens` 才能拦截。
  process.stdout.write('\n4. 关闭思考\n')
  const ASK = '3812 乘以 79 等于多少？只给数字。'
  const think = await once([{ role: 'user', content: ASK }])
  const noThink = await once([{ role: 'user', content: ASK }], { noThink: true })
  if (asksForReasoning) {
    check('默认启用思考（作为对照）', (think.usage?.reasoningTokens ?? 0) > 0, think.usage)
  } else {
    // 没有对照就无法证明关闭思考确实生效：输出说明，避免下方三条
    // 看似已经验证。此时它们验证的只是「原本未思考，关闭后仍未思考」。
    process.stdout.write('  · 本端点原本不请求推理，下方三条没有对照，不能证明思考可以关闭\n')
  }
  check('关闭后 reasoningTokens 为零', noThink.usage?.reasoningTokens === 0, noThink.usage)
  check('关闭后没有思考增量', noThink.thinking === '', noThink.thinking.slice(0, 80))
  if (asksForReasoning) {
    check('关闭后正文正常输出', noThink.text.includes('301148'), noThink.text)
  } else {
    check('关闭后正文正常输出（不断言计算结果）', noThink.text.trim().length > 0, noThink.text)
  }
}

// 顶层异常处理：任何未捕获的异常都转为一行「冒烟中断」说明与非零退出码，
// 而不是整段堆栈。冒烟脚本自身崩溃时最需要说明的是崩溃发生在哪一步。
process.exit(
  await main().catch((err) => {
    process.stdout.write(`\n冒烟中断：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }),
)
