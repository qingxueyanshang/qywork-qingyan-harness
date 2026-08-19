#!/usr/bin/env bun

/**
 * `openai_responses` 适配器对着**真实端点**跑一遍。
 *
 *   DEEPSEEK_API_KEY=sk-... bun run scripts/smoke-responses.ts
 *
 * ## 为什么单测不够
 *
 * 单测（含 `openai-responses.stream.test.ts` 里的 fixture server）锁的是
 * **我们对报文的理解**。它锁不住「供应商实际发什么、实际要什么」——
 * 而这一版之前恰好两条都猜错了：
 *
 * - 只认 `response.reasoning_summary_text.delta`，DeepSeek 发的是
 *   `response.reasoning_text.delta`。后果**静默**：思考内容全丢，不报错。
 * - 不回传 `reasoning_text`。后果是**第二轮** 400，第一轮完全正常。
 *
 * 第二条尤其说明问题：它只在「调了工具 → 把结果喂回去」时发作，
 * 也就是 agent 主循环的每一轮。**任何单轮冒烟都测不出来**，
 * 所以下面第 2 项必须真的走完两轮，不能只发一次请求就算过。
 *
 * ## 它验的是什么、不验什么
 *
 * 验我们的客户端能不能跟一个真实的 Responses 端点对上。
 * **不验** DeepSeek 的服务端行为对不对，也不代表 OpenAI 自家端点同样通过——
 * 那条路仍然没有跑过，如实记在 ROADMAP。
 */

import type { ProviderEvent, ProviderUsage, WireMessage, WireToolCall } from '@qywork/ai'
import { buildAdapter, lookupModel } from '@qywork/ai'

/**
 * 一个待测端点。
 *
 * ## 为什么要能配两个
 *
 * 说 Responses 协议的不止一家，而它们在推理这块**不是一套东西**（ROADMAP §22.1）：
 * OpenAI 发 `reasoning_summary_text.delta`、不要求回传；
 * DeepSeek 发 `reasoning_text.delta`、不回传就 400。
 *
 * 适配器为此同时认两个事件名、并用「收到过 `reasoning_text` 才补回传」的
 * 证据判据分流。**这两条各自只在一种方言下被执行到**——只跑一个端点的话，
 * 另一条分支永远没有被验证过，而它坏掉的表现是静默丢失全部思考内容。
 *
 * 所以同一套断言对两种方言各跑一遍。这是目前唯一能自动防住
 * 「修了一边坏了另一边」的东西。
 */
interface Endpoint {
  label: string
  key: string
  baseUrl: string
  model: string
}

/*
 * 这里**没有** `dialect` 字段，是刻意的。
 *
 * 第一版写了一个 `dialect: 'reasoning_text' | 'summary'`，想用它决定
 * 反证那一项该期待 400 还是 200。但适配器把两种方言的推理增量都归一成了
 * `thinking_delta`，脚本这一侧**根本分辨不出**当前端点是哪种——
 * 那个字段只能靠手填，而手填的「预期」和实测不符时，人会去改字段而不是查代码。
 *
 * 真正跨方言的那条断言是第 1 项的「收到思考增量」：**两个端点都必须非空**。
 * 只认一个事件名的话，另一边会静默地一个增量都没有。
 * 反证那一项按端点如实记录实际行为，不预设结论。
 */

/** 端点清单。第二个可选——不配就只跑第一个，并且**明说只跑了一个**。 */
const ENDPOINTS: Endpoint[] = [
  {
    label: process.env.QY_RESPONSES_LABEL ?? 'DeepSeek',
    key: process.env.DEEPSEEK_API_KEY ?? process.env.QY_RESPONSES_KEY ?? '',
    baseUrl: process.env.QY_RESPONSES_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: process.env.QY_RESPONSES_MODEL ?? 'deepseek-v4-flash',
  },
  {
    label: process.env.QY_RESPONSES_LABEL_2 ?? '第二端点',
    key: process.env.QY_RESPONSES_KEY_2 ?? '',
    baseUrl: process.env.QY_RESPONSES_BASE_URL_2 ?? '',
    model: process.env.QY_RESPONSES_MODEL_2 ?? 'gpt-5.4-mini',
  },
].filter((e) => e.key && e.baseUrl)

/** 当前正在跑的端点。`once()` 从这里取连接参数。 */
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
 * 传输层抖动重试。
 *
 * 这台开发机对 `api.deepseek.com` 的连接会间歇性失败（超时 / 连接被关 /
 * 证书校验失败），实测同一个脚本 5 次里挂 2 次。那是**环境**的问题，
 * 不是客户端的问题——但如果不管，冒烟会在第一条请求上带着堆栈崩掉，
 * 看起来像我们的 bug，而后面十几项断言一条都没跑。
 *
 * 所以只对 `network_error` 重试，**并且把重试次数打出来**：
 * 悄悄重试成功等于把「这条链路不稳」这个事实藏起来。
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
    // `ThinkingRequest` 只有 adaptive / budget 两档，**没有关闭档**：
    // 不发这个字段就是不请求思考，`noThink` 因此只影响下面几条断言的期望值。
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
    // 没 key 就明确跳过，**不要静默通过**——一个永远绿的冒烟比没有冒烟更危险。
    process.stdout.write('跳过：没有 DEEPSEEK_API_KEY / QY_RESPONSES_KEY\n')
    return 0
  }

  if (ENDPOINTS.length === 1) {
    /*
     * 只跑了一个端点这件事**必须说出来**。
     *
     * 适配器里有两条按方言分流的分支，只跑一个端点就只走到其中一条。
     * 不说的话，一次「全部通过」看起来像两种方言都验过了——
     * 而实际上另一条分支这次一行都没被执行。这与「静默截断」是同一类错误：
     * 覆盖面缩小了，而结论的措辞没跟着缩小。
     */
    process.stdout.write(
      '注意：只配了一个端点，方言分流的另一条分支本次未被执行。\n' +
        '  配上第二个即可两种方言各跑一遍：\n' +
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
      // 一个端点炸了不该让后面的端点不跑——那正好会掩盖「另一种方言坏了」。
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
   * 先看这个模型在**我们这一侧**被解析成了什么。
   *
   * 不看的话会把「适配器压根没请求推理」误判成「适配器丢了推理增量」——
   * 这两件事的修法完全不同，而现象一模一样（`thinking` 是空的）。
   *
   * 第一次跑双端点就撞上了：`gpt-5.4-mini` 不在内置目录，
   * `lookupModel` 回落到 `unknownModel()`，其 `thinking: 'none'` 让
   * `buildReasoning` 整个省略 reasoning 字段。四条断言一起红，
   * 而适配器**完全按它掌握的信息正确行事**。
   */
  const spec = lookupModel(EP.model, 'openai_responses')
  const asksForReasoning = spec.thinking !== 'none'
  if (spec.catalogued === false) {
    process.stdout.write(
      `  · ${EP.model} 不在内置目录，能力按最保守假设：` +
        `${asksForReasoning ? '' : '**本次不会请求推理**、'}计价按 0。\n` +
        '    要让它真的思考，先 qy probe --save 实测一次能力。\n\n',
    )
  }

  // ── 1. 纯文本一轮：正文、思考、用量口径 ──
  process.stdout.write('1. 纯文本流式\n')
  const r1 = await once([{ role: 'user', content: '3812 乘以 79 等于多少？只给数字。' }])
  check('收到正文', r1.text.trim().length > 0, r1.text)
  if (asksForReasoning) {
    // 算错是**模型能力**不是协议问题。只在会思考时断言它，否则这条会变成
    // 「小模型心算不准」的噪声——而噪声一多，真的红就没人看了。
    check('正文含正确答案 301148', r1.text.includes('301148'), r1.text)
    // 这条抓的是「什么都没有」，不是「内容对不对」。
    // **这是唯一一条真正跨方言的断言**：只认一个事件名的话，另一边会静默地一个增量都没有。
    check('收到思考增量（两种方言的事件名都要认得出来）', r1.thinking.trim().length > 0)
  } else {
    process.stdout.write(
      `  · 本端点不请求推理，跳过「思考增量」与「答案正确」两项（正文：${r1.text.trim().slice(0, 20)}）\n`,
    )
  }
  // 兜底串写成转义 `\0` 而不是一个**裸的 NUL 字节**。
  // 真的 0x00 在源码里完全看不见，还让整个文件被 grep 当成二进制
  // （`Binary file matches`，于是搜不到任何东西）。
  // 语义上它必须是「正常文本里不会出现的字符」——换成空格的话
  // `text.includes(' ')` 几乎恒真，这条断言就永远失败了。
  check('思考内容没混进正文', !r1.text.includes(r1.thinking.slice(0, 30) || '\0'))
  check('用量来自供应商而非估算', r1.usage?.source === 'provider', r1.usage)
  check('终态是 end_turn', r1.stopReason === 'end_turn', r1.stopReason)

  // ── 2. 工具调用**两轮**：这一条才是关键 ──
  //    第一轮拿到调用；第二轮把 reasoningContent + 工具结果喂回去。
  //    不回传 reasoning_text 的话，第二轮直接 400。
  process.stdout.write('\n2. 工具调用来回两轮\n')
  const ask: WireMessage[] = [{ role: 'user', content: '北京现在天气怎么样？用工具查。' }]
  const r2 = await once(ask, { tools: true })
  check('第一轮拿到工具调用', r2.calls.length === 1, r2.calls)
  check('工具名对得上', r2.calls[0]?.name === 'get_weather', r2.calls[0]?.name)
  check('参数解析成对象', typeof r2.calls[0]?.arguments?.city === 'string', r2.calls[0]?.arguments)
  check('终态是 tool_use', r2.stopReason === 'tool_use', r2.stopReason)
  if (asksForReasoning) check('工具轮也拿到了思考内容', r2.thinking.trim().length > 0)

  if (r2.calls.length === 1) {
    const second: WireMessage[] = [
      ...ask,
      {
        role: 'assistant',
        content: r2.text,
        toolCalls: r2.calls,
        // 少了这一行，下面这次请求会 400。整个第 2 项就是为了跑到这里。
        ...(r2.thinking.trim() ? { reasoningContent: r2.thinking } : {}),
      },
      { role: 'tool', toolCallId: r2.calls[0]!.id, content: '晴，28 摄氏度，风力 2 级' },
    ]
    try {
      const r3 = await once(second, { tools: true })
      check('第二轮没有 400（reasoning_text 已回传）', true)
      check('第二轮读懂了工具结果', /28/.test(r3.text), r3.text)
      check('第二轮不再重复调用工具', r3.calls.length === 0, r3.calls)
    } catch (err) {
      check('第二轮没有 400（reasoning_text 已回传）', false, String(err))
    }

    // ── 反证：不回传就该被拒。没有这一条，上面那条通过了也可能只是「碰巧不需要」。
    //
    // **`call_id` 必须换成一个服务端没发过的**，这是实测出来的判别式：
    // 拿刚拿到的真 call_id 去问，服务端自己还记着那段思考，不回传也放行；
    // 换成合成 id 才会 400。
    //
    // 所以用真 id 写反证是**测不出来的**——它永远通过，然后「回传」这段代码
    // 会退化成一段没人知道还需不需要的死重量。
    //
    // 而合成 id 恰恰是**生产里的常态**：会话存在 SQLite 里，隔天接着聊，
    // 那时候的 call_id 对服务端来说和合成的没区别。也就是说这个 400
    // 不会在开发时出现，只会在用户恢复旧会话时出现。
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
       * 端点放行了。**不算失败**，但要说清有三种可能的成因，
       * 否则「规则可能已放宽」这句话会在另外两种情形下每次都出现，
       * 变成噪声——而噪声一多，真的放宽了时也就没人看了。
       */
      process.stdout.write(
        '  · 陈旧 call_id 且不回传思考内容，本端点放行。三种可能：\n' +
          '      它是 summary 方言（本就不要求回传）／本次根本没请求推理／服务端放宽了规则。\n',
      )
    } catch (err) {
      check(
        '反证：陈旧 call_id 且不回传思考内容 → 被拒',
        /reasoning_text|thinking/i.test(String(err)),
        String(err),
      )
    }

    // 正面：陈旧 call_id **加上**回传，应当照样通过——这才证明回传是那个解药。
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
  //    Responses 的 input_tokens **含**缓存命中，我们统一收敛到排他口径。
  //    只有连打两次同一个长前缀才看得出来减没减。
  process.stdout.write('\n3. 缓存命中口径\n')
  // 前缀要**每次跑都不一样**。用固定前缀的话，第一次就命中了上一次跑留下的缓存，
  // 于是「第二次比第一次少」这条断言恒不成立——第一版就是这么写的，
  // 报出来是 first=42 second=42 cached=768，看起来像口径错了，其实是测法错了。
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
    '第一次的 cachedTokens 是数字而非 null',
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
    // 缓存是服务端行为，没命中不代表我们错了。说出来而不是判失败。
    process.stdout.write(`  · 第二次没有命中缓存（cached=${c2.usage?.cachedTokens}），本项跳过\n`)
  }

  // ── 4. 「不思考」必须真的不思考 ──
  //
  // 这条抓的 bug **完全静默**：把「不思考」映射成 `effort:'minimal'` 时，
  // 实测 minimal 跟 high 一样把整个输出预算烧在推理上，正文被截断。
  // 用户要求不思考，拿到的是全额思考 + 一段截断的回答 + 账单，没有任何报错。
  // 只有对着真实端点看 `reasoning_tokens` 才拦得住它。
  process.stdout.write('\n4. 关掉思考\n')
  const ASK = '3812 乘以 79 等于多少？只给数字。'
  const think = await once([{ role: 'user', content: ASK }])
  const noThink = await once([{ role: 'user', content: ASK }], { noThink: true })
  if (asksForReasoning) {
    check('默认会思考（作为对照）', (think.usage?.reasoningTokens ?? 0) > 0, think.usage)
  } else {
    // 没有对照就没法证明「关掉」真的起了作用——说出来，不要让下面三条
    // 看起来像验过了。它们此刻验的只是「本来就没思考，关了还是没思考」。
    process.stdout.write('  · 本端点本来就不请求推理，下面三条没有对照，不构成「关得掉」的证据\n')
  }
  check('关掉之后 reasoningTokens 归零', noThink.usage?.reasoningTokens === 0, noThink.usage)
  check('关掉之后思考增量也没有了', noThink.thinking === '', noThink.thinking.slice(0, 80))
  if (asksForReasoning) {
    check('关掉之后正文照常给出', noThink.text.includes('301148'), noThink.text)
  } else {
    check('关掉之后正文照常给出（不断言算得对）', noThink.text.trim().length > 0, noThink.text)
  }
}

// 顶层兜底：任何漏网的异常都要变成一行「第 N 项炸了」+ 非零退出码，
// 而不是一堆堆栈。冒烟脚本自己崩掉时最需要说清楚的是「跑到哪一步崩的」。
process.exit(
  await main().catch((err) => {
    process.stdout.write(`\n冒烟中断：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }),
)
