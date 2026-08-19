/**
 * 配置脱敏与回填。
 *
 * **覆盖范围**：`config.ts` 的 `redactConfig` / `mergeConfig`，以及
 * `GET /api/config` 的读盘时机。
 *
 * 这两个函数是**明文 key 不出进程**这条边界的全部实现，所以这里测得比别处细。
 * 最要命的一条不是「key 泄漏了」——那种一眼能看出来；是**「打开设置页看一眼再保存」
 * 把 key 静默清掉**：保存那一刻没有任何反馈，要到下一次调用模型才炸，
 * 那时候人已经不会把它和「我刚才改了 baseUrl」联系起来。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'
import { handleConfigApi, mergeConfig, type RedactedConfig, redactConfig } from './config.ts'
import type { ApiDeps } from './types.ts'

const cfg = (): QyConfig => ({
  active: { provider: 'main', model: 'claude-opus-5' },
  providers: {
    main: {
      kind: 'anthropic_messages',
      apiKey: 'sk-real-secret-value',
      models: { 'claude-opus-5': {} },
    },
    local: {
      kind: 'openai_chat_completions',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: { qwen: {} },
    },
  },
  mode: 'auto',
})

describe('脱敏', () => {
  test('明文 apiKey 不出现在结果的任何一处', () => {
    const wire = JSON.stringify(redactConfig(cfg()))
    expect(wire).not.toContain('sk-real-secret-value')
  })

  test('有 key 的接口报 hasApiKey: true，没有的报 false', () => {
    const r = redactConfig(cfg())
    expect(r.providers.main?.hasApiKey).toBe(true)
    expect(r.providers.local?.hasApiKey).toBe(false)
  })

  test('空串 key 算「没有」 —— 否则界面会显示已配置而实际调用会 401', () => {
    const c = cfg()
    c.providers.main = { ...c.providers.main!, apiKey: '' }
    expect(redactConfig(c).providers.main?.hasApiKey).toBe(false)
  })

  test('非密钥字段原样保留', () => {
    const r = redactConfig(cfg())
    expect(r.mode).toBe('auto')
    expect(r.active).toEqual({ provider: 'main', model: 'claude-opus-5' })
    expect(r.providers.local?.baseUrl).toBe('http://127.0.0.1:11434/v1')
  })
})

describe('回填', () => {
  const roundTrip = (mutate: (r: RedactedConfig) => void): QyConfig => {
    const current = cfg()
    const wire = redactConfig(current)
    mutate(wire)
    return mergeConfig(current, wire)
  }

  test('原样存回不会动 key —— 这是最常见的一次保存', () => {
    expect(roundTrip(() => {}).providers.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('改别的字段也不会动 key', () => {
    const out = roundTrip((r) => {
      r.providers.main = { ...r.providers.main!, baseUrl: 'https://relay.example/v1' }
    })
    expect(out.providers.main?.apiKey).toBe('sk-real-secret-value')
    expect(out.providers.main?.baseUrl).toBe('https://relay.example/v1')
  })

  test('显式传新 key 就换掉', () => {
    const out = roundTrip((r) => {
      ;(r.providers.main as { apiKey?: string }).apiKey = 'sk-new'
    })
    expect(out.providers.main?.apiKey).toBe('sk-new')
  })

  test('显式传空串是「清掉」，与「没带」区分开', () => {
    const out = roundTrip((r) => {
      ;(r.providers.main as { apiKey?: string }).apiKey = ''
    })
    expect(out.providers.main?.apiKey).toBeUndefined()
  })

  test('hasApiKey 谎报 true 也变不出 key —— 库里没有就是没有', () => {
    const out = roundTrip((r) => {
      r.providers.local = { ...r.providers.local!, hasApiKey: true }
    })
    expect(out.providers.local?.apiKey).toBeUndefined()
  })

  test('hasApiKey 报 false 表示这个接口本来就没配，不影响别人', () => {
    const out = roundTrip(() => {})
    expect(out.providers.local?.apiKey).toBeUndefined()
    expect(out.providers.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('新增接口带明文 key 的话照收', () => {
    const out = roundTrip((r) => {
      r.providers.added = {
        kind: 'anthropic_messages',
        models: { m: {} },
        hasApiKey: false,
        apiKey: 'sk-added',
      } as never
    })
    expect(out.providers.added?.apiKey).toBe('sk-added')
  })

  test('hasApiKey 这个字段本身不会漏进落盘的配置里', () => {
    const out = roundTrip(() => {})
    for (const p of Object.values(out.providers)) {
      expect('hasApiKey' in p).toBe(false)
    }
  })

  test('顶层字段以传入的为准', () => {
    const out = roundTrip((r) => {
      r.mode = 'full'
      r.active = { provider: 'local', model: 'qwen' }
    })
    expect(out.mode).toBe('full')
    expect(out.active).toEqual({ provider: 'local', model: 'qwen' })
  })

  /**
   * **界面认识的字段，比配置里真实存在的字段少。**
   *
   * `apps/web` 够不着 `@qywork/runtime`（层级不允许），所以那边手抄了一份
   * `RedactedConfig`。抄的那份现在就少一个 `sandboxNetwork`——它只在 CLI 里配。
   *
   * 于是失败形状是：用户 `qy config` 设了 `sandboxNetwork: 'deny'`，
   * 然后打开设置页改个模型保存，那一项被抹掉。**保存那一刻毫无反馈**，
   * 而它是条安全设置，等发现时早就跑了一堆没受限的命令了。
   *
   * 现在不会抹，靠的是 `mergeConfig` 里 `{ ...current, ...incoming }` 这个展开
   * ——incoming 没有这个键就不会覆盖。但那是一行代码的副作用，没人钉住它，
   * 改成逐字段赋值就当场坏。这条测试钉的就是它。
   */
  test('客户端不认识的顶层字段不会被抹掉', () => {
    const current: QyConfig = { ...cfg(), sandboxNetwork: 'deny', envAllowList: ['GITHUB_TOKEN'] }
    // 模拟界面：把服务端回的那份按自己认识的字段重建一遍，多余的键丢掉。
    const wire = redactConfig(current)
    const asClientSeesIt = {
      active: wire.active,
      profiles: wire.providers,
      mode: 'full',
      additionalDirectories: wire.additionalDirectories,
      envAllowList: wire.envAllowList,
    }
    // 过一遍 JSON：真实路径上 `undefined` 的键根本不会上线，别在内存里假装它在。
    const incoming = JSON.parse(JSON.stringify(asClientSeesIt)) as RedactedConfig

    const out = mergeConfig(current, incoming)
    expect(out.mode).toBe('full')
    expect(out.sandboxNetwork).toBe('deny')
    expect(out.envAllowList).toEqual(['GITHUB_TOKEN'])
  })

  test('多轮往返不掉 key —— 用户会反复打开设置页', () => {
    let c = cfg()
    for (let i = 0; i < 5; i++) c = mergeConfig(c, redactConfig(c))
    expect(c.providers.main?.apiKey).toBe('sk-real-secret-value')
  })
})

describe('读盘时机', () => {
  const get = async (d: ApiDeps) => {
    const url = new URL('http://127.0.0.1/api/config')
    const res = await handleConfigApi(url, new Request(url.href, { method: 'GET' }), d as never)
    return (await res!.json()) as { config: RedactedConfig }
  }

  /**
   * 进程外改过的配置，不能被下一次保存整份盖掉。
   *
   * 形状是这样的：保存走「读回整份 → 改一格 → 整份写回」，所以 GET 回什么，
   * 下一次 PUT 就把什么写进文件。GET 回启动时那份的话，`qy probe` 落下的校准
   * 结果、手编的 JSON、另一个实例写的改动，都会在用户随手改一格设置时消失。
   */
  test('每次 GET 都按文件回答，进程里那份跟着换', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qy-cfg-'))
    const prev = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = home
    const write = (kind: string) =>
      writeFile(
        join(home, 'config.json'),
        JSON.stringify({
          active: { provider: 'main', model: 'claude-opus-5' },
          providers: { main: { kind, models: { 'claude-opus-5': {} } } },
        }),
        'utf8',
      )
    try {
      const d = { config: cfg() } as unknown as ApiDeps

      // 起手就和 `cfg()` 里那份不同，第一条断言才证明得了「读的是盘」。
      await write('openai_chat_completions')
      expect((await get(d)).config.providers.main?.kind).toBe('openai_chat_completions')

      await write('openai_responses')
      expect((await get(d)).config.providers.main?.kind).toBe('openai_responses')
      expect(d.config.providers.main?.kind).toBe('openai_responses')
    } finally {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
    }
  })
})
