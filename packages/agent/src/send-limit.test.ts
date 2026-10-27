/**
 * 覆盖 `send-limit.ts`：按拒绝自适应的同时在途上限。经 `sendTurn` 的接入见 `loop/attempt.test.ts`。
 */
import { describe, expect, test } from 'bun:test'
import { classifyProviderError, ProviderError } from '@qywork/ai'
import { concurrencyRejected, SendLimiter, type SendOutcome } from './send-limit.ts'

const signal = () => new AbortController().signal

/** 下一个微任务轮次之后是否已取得名额。 */
async function granted(p: Promise<unknown>): Promise<boolean> {
  let done = false
  void p.then(() => {
    done = true
  })
  await new Promise((r) => setTimeout(r, 0))
  return done
}

async function fill(limiter: SendLimiter, key: string, n: number) {
  const slots: ((o: SendOutcome) => void)[] = []
  for (let i = 0; i < n; i++) slots.push(await limiter.acquire(key, signal()))
  return slots
}

describe('同时在途的请求数上限', () => {
  test('从未被拒过的端点不限制', async () => {
    const limiter = new SendLimiter()
    const slots = await fill(limiter, 'k', 50)
    expect(slots).toHaveLength(50)
  })

  /**
   * 原始失败形状：在途 20 个时中转报告并发超限，其余在途请求随后陆续被拒；
   * 不收紧时每次重发都在同样的在途数下发出，37% 再次被拒。
   */
  test('被拒时降到在途数的四分之三；同一批拒绝只收紧一次；之后发出的请求被拒再收紧', async () => {
    const limiter = new SendLimiter()
    const slots = await fill(limiter, 'k', 20)
    slots[0]!('concurrency_rejected')
    // 上限 15，在途 19：新请求排队。
    const waiting = limiter.acquire('k', signal())
    expect(await granted(waiting)).toBe(false)
    // 同一批中其余请求的拒绝不再收紧：在途降到 14 时排队者即取得名额（上限仍为 15）。
    for (const s of slots.slice(1, 6)) s('concurrency_rejected')
    expect(await granted(waiting)).toBe(true)
    // 收紧之后发出的请求被拒：按拒绝时刻的在途数（15）的四分之三再收紧为 11。
    ;(await waiting)('concurrency_rejected')
    const next = limiter.acquire('k', signal())
    expect(await granted(next)).toBe(false)
    for (const s of slots.slice(6, 9)) s('completed')
    // 在途 11：仍未低于 11。
    expect(await granted(next)).toBe(false)
    slots[9]!('completed')
    expect(await granted(next)).toBe(true)
  })

  test('完成后逐步放宽：每完成一次放宽 1/上限', async () => {
    const limiter = new SendLimiter()
    const slots = await fill(limiter, 'k', 4)
    slots[0]!('concurrency_rejected') // 上限 3，在途 3
    const waiting = limiter.acquire('k', signal())
    expect(await granted(waiting)).toBe(false)
    // 完成一次：在途 2，上限 3.33，排队者取得名额（在途 3）。
    slots[1]!('completed')
    expect(await granted(waiting)).toBe(true)
    // 再完成两次：上限 3.63、3.91，取整仍为 3；在途 1，可再取得 2 个名额，第 3 个排队。
    slots[2]!('completed')
    slots[3]!('completed')
    const more = [limiter.acquire('k', signal()), limiter.acquire('k', signal())]
    for (const p of more) expect(await granted(p)).toBe(true)
    const third = limiter.acquire('k', signal())
    expect(await granted(third)).toBe(false)
    // 再完成一次：上限 4.17，取整为 4，排队者取得名额。
    ;(await waiting)('completed')
    expect(await granted(third)).toBe(true)
  })

  test('排队者按到达顺序取得名额', async () => {
    const limiter = new SendLimiter()
    const [a, b] = await fill(limiter, 'k', 2)
    a!('concurrency_rejected') // 上限 1，在途 1
    const order: number[] = []
    const first = limiter.acquire('k', signal()).then((r) => {
      order.push(1)
      return r
    })
    const second = limiter.acquire('k', signal()).then((r) => {
      order.push(2)
      return r
    })
    b!('completed')
    ;(await first)('completed')
    await second
    expect(order).toEqual([1, 2])
  })

  test('排队时停止：退出队列并以中止原因拒绝，名额交给下一个排队者', async () => {
    const limiter = new SendLimiter()
    const [a, b] = await fill(limiter, 'k', 2)
    a!('concurrency_rejected') // 上限 1，在途 1
    const stop = new AbortController()
    const stopped = limiter.acquire('k', stop.signal)
    const after = limiter.acquire('k', signal())
    stop.abort(new DOMException('已中断', 'AbortError'))
    await expect(stopped).rejects.toThrow('已中断')
    b!('completed')
    expect(await granted(after)).toBe(true)
  })

  test('不同端点或模型分别计数', async () => {
    const limiter = new SendLimiter()
    const [a] = await fill(limiter, 'relay gpt', 2)
    a!('concurrency_rejected')
    expect(await granted(limiter.acquire('relay gpt', signal()))).toBe(false)
    expect(await granted(limiter.acquire('relay claude', signal()))).toBe(true)
  })

  test('释放只生效一次', async () => {
    const limiter = new SendLimiter()
    const [a, b] = await fill(limiter, 'k', 2)
    b!('concurrency_rejected') // 上限 1，在途 1
    const waiting = limiter.acquire('k', signal())
    a!('failed')
    a!('failed')
    expect(await granted(waiting)).toBe(true)
    // 重复释放未使在途数变为负值：上限 1、在途 1 时新请求仍须排队。
    expect(await granted(limiter.acquire('k', signal()))).toBe(false)
  })
})

describe('并发超限的识别', () => {
  test('只认中转在流内错误中给出的 code，不按报错文字推测', () => {
    // 流内错误事件：分类器把事件的 code 写入 detail.providerCode（账本诊断中的 provider.code 即取自此处，
    // 实测 1,353 次均为该值）。
    const inStream = new ProviderError({
      code: 'provider_unavailable',
      message: 'Concurrency limit exceeded for account, please retry later',
      provider: 'openai_responses',
      detail: { providerCode: 'gateway_concurrency_limit' },
    })
    expect(concurrencyRejected(inStream)).toBe(true)
    // HTTP 层拒绝经真实的分类器取得同一字段。
    const viaStatus = classifyProviderError(
      'openai_responses',
      Object.assign(new Error('Concurrency limit exceeded for account, please retry later'), {
        status: 429,
        error: { code: 'gateway_concurrency_limit', message: 'Concurrency limit exceeded' },
      }),
    )
    expect(concurrencyRejected(viaStatus)).toBe(true)
    expect(
      concurrencyRejected(
        new ProviderError({
          code: 'provider_unavailable',
          message: 'Concurrency limit exceeded for account, please retry later',
          provider: 'openai_responses',
        }),
      ),
    ).toBe(false)
    expect(concurrencyRejected(new Error('gateway_concurrency_limit'))).toBe(false)
  })
})
