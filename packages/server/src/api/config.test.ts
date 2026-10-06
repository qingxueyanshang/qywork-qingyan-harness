/**
 * 配置脱敏与回填。
 *
 * 覆盖范围：`config.ts` 的 `redactConfig` / `mergeConfig`，以及
 * `GET /api/config` 读取磁盘的时机、`PUT /api/config` 的落盘门禁与以磁盘内容为基准的版本校验。
 *
 * 这两个函数是「明文 key 不出进程」这一边界的全部实现，因此此处的测试比其他位置更细。
 * 最严重的情形不是 key 泄漏（泄漏可立即发现），而是「打开设置页、不做修改直接保存」
 * 时静默清除 key：保存时没有任何反馈，直到下一次调用模型才失败，
 * 此时已难以将失败与刚才修改的 baseUrl 关联起来。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

  test('有 key 的接口返回 hasApiKey: true，没有 key 的返回 false', () => {
    const r = redactConfig(cfg())
    expect(r.providers.main?.hasApiKey).toBe(true)
    expect(r.providers.local?.hasApiKey).toBe(false)
  })

  test('空串 key 视为没有 key：否则界面显示已配置而实际调用返回 401', () => {
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
  test('修改接口地址保留所有已保存的生成协议，包括与旧默认值相同的选择', () => {
    const current = cfg()
    current.providers.main!.media = {
      'wan3.0-video-prime': { kind: 'openai_videos' },
      'qwen-image-3.0': { kind: 'openai_images' },
      'qwen3-tts-flash': { kind: 'openai_speech' },
      'custom-video': { kind: 'ark_videos' },
    }
    const wire = redactConfig(current)
    wire.providers.main!.baseUrl =
      'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    const next = mergeConfig(current, wire)
    expect(next.providers.main!.media).toEqual(current.providers.main!.media)
    expect(current.providers.main!.media!['wan3.0-video-prime']!.kind).toBe('openai_videos')
    const back = redactConfig(next)
    back.providers.main!.baseUrl = 'https://relay.example/v1'
    expect(mergeConfig(next, back).providers.main!.media!['wan3.0-video-prime']!.kind).toBe(
      'openai_videos',
    )
  })

  test('原生转发更换域名时保持协议，显式切换接入方式仍能保存', () => {
    const current = cfg()
    current.providers.main!.media = {
      'veo-3.1-fast-generate-preview': { kind: 'veo_videos' },
      'gemini-omni-1.1-flash': { kind: 'gemini_videos' },
      'grok-imagine-video-1.5': { kind: 'xai_videos' },
    }
    expect(mergeConfig(current, redactConfig(current)).providers.main!.media).toEqual(
      current.providers.main!.media,
    )
    const wire = redactConfig(current)
    wire.providers.main!.baseUrl = 'https://relay.example/v1'
    expect(mergeConfig(current, wire).providers.main!.media).toEqual(current.providers.main!.media)
    wire.providers.main!.media = {
      ...wire.providers.main!.media,
      'veo-3.1-fast-generate-preview': { kind: 'openai_videos' },
    }
    const next = mergeConfig(current, wire)
    expect(next.providers.main!.media!['veo-3.1-fast-generate-preview']!.kind).toBe('openai_videos')
    expect(next.providers.main!.media!['grok-imagine-video-1.5']!.kind).toBe('xai_videos')
  })
  const roundTrip = (mutate: (r: RedactedConfig) => void): QyConfig => {
    const current = cfg()
    const wire = redactConfig(current)
    mutate(wire)
    return mergeConfig(current, wire)
  }

  test('原样保存不改变 key：这是最常见的保存方式', () => {
    expect(roundTrip(() => {}).providers.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('修改其他字段不改变 key', () => {
    const out = roundTrip((r) => {
      r.providers.main = { ...r.providers.main!, baseUrl: 'https://relay.example/v1' }
    })
    expect(out.providers.main?.apiKey).toBe('sk-real-secret-value')
    expect(out.providers.main?.baseUrl).toBe('https://relay.example/v1')
  })

  test('显式传入新 key 时替换', () => {
    const out = roundTrip((r) => {
      ;(r.providers.main as { apiKey?: string }).apiKey = 'sk-new'
    })
    expect(out.providers.main?.apiKey).toBe('sk-new')
  })

  test('显式传入空串表示清除，与未携带区分', () => {
    const out = roundTrip((r) => {
      ;(r.providers.main as { apiKey?: string }).apiKey = ''
    })
    expect(out.providers.main?.apiKey).toBeUndefined()
  })

  test('hasApiKey 误报 true 时不会产生 key：已保存的配置中没有 key 时结果仍为没有', () => {
    const out = roundTrip((r) => {
      r.providers.local = { ...r.providers.local!, hasApiKey: true }
    })
    expect(out.providers.local?.apiKey).toBeUndefined()
  })

  test('hasApiKey 为 false 表示该接口未配置 key，不影响其他接口', () => {
    const out = roundTrip(() => {})
    expect(out.providers.local?.apiKey).toBeUndefined()
    expect(out.providers.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('新增接口携带明文 key 时照常接受', () => {
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

  test('hasApiKey 字段本身不会写入磁盘上的配置', () => {
    const out = roundTrip(() => {})
    for (const p of Object.values(out.providers)) {
      expect('hasApiKey' in p).toBe(false)
    }
  })

  test('顶层字段以传入值为准', () => {
    const out = roundTrip((r) => {
      r.mode = 'full'
      r.active = { provider: 'local', model: 'qwen' }
    })
    expect(out.mode).toBe('full')
    expect(out.active).toEqual({ provider: 'local', model: 'qwen' })
  })

  /**
   * 默认生成模型与 active 规则相同。原始失败形状：界面删除最后一个图像模型、不再携带 `mediaDefaults`，
   * 服务端按展开合并保留了旧默认值，校验判定它指向已删除的模型，保存被 422 拒绝，模型无法删除。
   */
  test('默认生成模型以客户端为准，未携带时删除', () => {
    const base = cfg()
    const current: QyConfig = {
      ...base,
      providers: {
        ...base.providers,
        local: {
          ...base.providers.local!,
          media: { 'qwen-image-3.0': { kind: 'dashscope_images' } },
        },
      },
      mediaDefaults: { image: { provider: 'local', model: 'qwen-image-3.0' } },
    }
    const wire = redactConfig(current)
    wire.providers.local = { ...wire.providers.local!, media: {} }
    delete wire.mediaDefaults
    const out = mergeConfig(current, JSON.parse(JSON.stringify(wire)) as RedactedConfig)
    expect(out.mediaDefaults).toBeUndefined()
    expect(out.providers.local?.media).toEqual({})
  })

  /**
   * 界面已知的字段少于配置中实际存在的字段。
   *
   * `apps/web` 无法引用 `@qywork/runtime`（层级不允许），因此界面手工复制了一份
   * `RedactedConfig`，其中缺少 `sandboxNetwork`：该字段只在配置文件中设置。
   *
   * 因此失败形状是：用户在配置文件中设置 `sandboxNetwork: 'deny'`，
   * 然后在设置页修改模型并保存，该项被清除。保存时没有任何反馈，
   * 而它是一项安全设置，被发现时已有若干条命令在不受限的情况下执行。
   *
   * 该项不被清除，依靠的是 `mergeConfig` 中 `{ ...current, ...incoming }` 的展开：
   * incoming 没有该键时不会覆盖。但这只是一行代码的副作用，
   * 改为逐字段赋值即会失效。本测试锁定的正是这一行为。
   */
  test('客户端未知的顶层字段不会被清除', () => {
    const current: QyConfig = { ...cfg(), sandboxNetwork: 'deny', envAllowList: ['GITHUB_TOKEN'] }
    // 模拟界面：将服务端返回的配置按界面已知的字段重建，丢弃其余的键。
    const wire = redactConfig(current)
    const asClientSeesIt = {
      active: wire.active,
      profiles: wire.providers,
      mode: 'full',
      additionalDirectories: wire.additionalDirectories,
      envAllowList: wire.envAllowList,
    }
    // 经过一次 JSON 序列化：实际传输中值为 `undefined` 的键不会发送，不要在内存中保留这些键。
    const incoming = JSON.parse(JSON.stringify(asClientSeesIt)) as RedactedConfig

    const out = mergeConfig(current, incoming)
    expect(out.mode).toBe('full')
    expect(out.sandboxNetwork).toBe('deny')
    expect(out.envAllowList).toEqual(['GITHUB_TOKEN'])
  })

  test('多轮往返不丢失 key：用户会反复打开设置页', () => {
    let c = cfg()
    for (let i = 0; i < 5; i++) c = mergeConfig(c, redactConfig(c))
    expect(c.providers.main?.apiKey).toBe('sk-real-secret-value')
  })
})

describe('读取磁盘的时机', () => {
  const get = async (d: ApiDeps) => {
    const url = new URL('http://127.0.0.1/api/config')
    const res = await handleConfigApi(url, new Request(url.href, { method: 'GET' }), d as never)
    return (await res!.json()) as { config: RedactedConfig }
  }

  /**
   * 进程外修改的配置不得被下一次保存整份覆盖。
   *
   * 保存流程是「读取整份 → 修改一项 → 整份写回」，因此 GET 返回的内容
   * 即下一次 PUT 写入文件的内容。GET 返回启动时的配置时，`qy probe` 写入的校准
   * 结果、手工编辑的 JSON、另一个实例写入的改动，都会在用户修改一项设置时丢失。
   */
  test('每次 GET 都按文件内容返回，进程内的配置随之更新', async () => {
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

      // 初始内容与 `cfg()` 不同，第一条断言才能证明读取的是磁盘内容。
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

describe('落盘门禁', () => {
  const put = async (d: ApiDeps, config: unknown, baseVersion?: string) => {
    const url = new URL('http://127.0.0.1/api/config')
    return handleConfigApi(
      url,
      new Request(url.href, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config, ...(baseVersion ? { baseVersion } : {}) }),
      }),
      d as never,
    )
  }
  const get = async (d: ApiDeps) => {
    const url = new URL('http://127.0.0.1/api/config')
    const res = await handleConfigApi(url, new Request(url.href, { method: 'GET' }), d as never)
    return (await res!.json()) as { config: RedactedConfig; problems: string[]; version: string }
  }

  /**
   * 未配置 key 不阻止保存。原始失败形状：添加一个新接口并为其添加第一个模型（active 随之切换到
   * 该尚未填写 key 的接口），保存被 422 拒绝，模型无法添加；填写 key 与 url 的先后顺序也因此
   * 受到限制。此处锁定的是「active 接口没有 key 也能保存」，key 可稍后填写。
   */
  test('active 接口没有 key 也能保存，只在 problems 中提示', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qy-cfg-'))
    const prev = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = home
    try {
      // 进程内的配置始终从磁盘读取：夹具先将同一份配置写入磁盘。
      await writeFile(join(home, 'config.json'), JSON.stringify(cfg()))
      const d = { config: cfg() } as unknown as ApiDeps
      const res = await put(d, {
        active: { provider: 'newp', model: 'm1' },
        providers: {
          main: { kind: 'anthropic_messages', hasApiKey: true, models: { 'claude-opus-5': {} } },
          newp: { kind: 'openai_chat_completions', hasApiKey: false, models: { m1: {} } },
        },
        mode: 'auto',
      })
      expect(res!.status).toBe(200)
      // 已写入磁盘：新接口存在，main 的 key 也未因 hasApiKey:true 被清除。
      expect(d.config.providers.newp?.models.m1).toBeDefined()
      expect(d.config.providers.main?.apiKey).toBe('sk-real-secret-value')
      // 但须提示：GET 的 problems 包含缺少 key 的提示，用户可以看到尚未完成的步骤。
      expect((await get(d)).problems.some((p) => p.includes('未配置 API Key'))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
    }
  })

  /** 结构不合法时仍拒绝：active 指向不存在的接口时返回 422 且不写入磁盘。 */
  test('active 指向不存在的接口时仍返回 422，不写入磁盘', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qy-cfg-'))
    const prev = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = home
    try {
      await writeFile(join(home, 'config.json'), JSON.stringify(cfg()))
      const d = { config: cfg() } as unknown as ApiDeps
      const res = await put(d, {
        active: { provider: '不存在', model: 'm1' },
        providers: {
          main: { kind: 'anthropic_messages', hasApiKey: true, models: { 'claude-opus-5': {} } },
        },
        mode: 'auto',
      })
      expect(res!.status).toBe(422)
      // 未写入：进程内配置的 active 未被改动。
      expect(d.config.active?.provider).toBe('main')
    } finally {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
    }
  })

  /**
   * 电脑控制的两个字段只接受布尔值。设置页写入的是 `true` / `false`，其他客户端写入
   * 字符串时必须在写入磁盘前拒绝：`desktopEnabled` 的判据是「不为 false 即视为开启」，
   * 写入 `'off'` 后读取的结果是开启。
   */
  test('电脑控制的开关不是布尔值时返回 422，不写入磁盘', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qy-cfg-'))
    const prev = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = home
    try {
      const d = { config: cfg() } as unknown as ApiDeps
      const res = await put(d, {
        providers: {
          main: { kind: 'anthropic_messages', hasApiKey: true, models: { 'claude-opus-5': {} } },
        },
        mode: 'auto',
        desktopEnabled: 'off',
      } as unknown as Parameters<typeof put>[1])
      expect(res!.status).toBe(422)
      expect(d.config.desktopEnabled).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
    }
  })

  /**
   * 原始失败形状：删除某一类别的最后一个生成模型（默认值随之删除）后，在另一个接口下添加同一个模型，保存被 422 拒绝，
   * 原因是默认生成模型不在配置中。进程内的配置保留了已删除的默认值，GET 将其返回给设置页；设置页发现该类别已有默认值便不再修改，
   * 因此提交了指向已删除模型的默认值。此处按设置页的修改方式执行一次。
   */
  test('已删除的默认生成模型不保留在进程内，更换接口重新添加后可以保存', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qy-cfg-'))
    const prev = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = home
    const image = { 'gpt-image-2.5-sunburst': { kind: 'openai_images' as const } }
    try {
      const d = { config: cfg() } as unknown as ApiDeps
      const start = redactConfig(cfg())
      start.providers.main!.media = image
      start.mediaDefaults = { image: { provider: 'main', model: 'gpt-image-2.5-sunburst' } }
      expect((await put(d, start))!.status).toBe(200)

      // 设置页删除 main 下的模型：该类别没有其他模型，默认值一并删除。
      const removed = (await get(d)).config
      removed.providers.main!.media = {}
      delete removed.mediaDefaults
      expect((await put(d, removed))!.status).toBe(200)

      const fresh = (await get(d)).config
      expect(fresh.mediaDefaults).toBeUndefined()
      // 设置页的添加操作：添加到 local 下，该类别尚无默认值时才将其设为默认。
      fresh.providers.local!.media = image
      fresh.mediaDefaults ??= { image: { provider: 'local', model: 'gpt-image-2.5-sunburst' } }
      expect((await put(d, fresh))!.status).toBe(200)
      expect(d.config.mediaDefaults?.image?.provider).toBe('local')
    } finally {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
    }
  })

  /**
   * 乐观并发：携带过期的 baseVersion（模拟另一个窗口已修改过）保存时返回 409 且不写入磁盘。
   * 携带当前 version 的正常保存放行。不携带 baseVersion 的客户端或脚本同样放行。
   */
  test('baseVersion 不一致时返回 409 且不落盘，一致时放行', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qy-cfg-'))
    const prev = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = home
    try {
      const d = { config: cfg() } as unknown as ApiDeps
      // GET 会按磁盘内容（空的临时 home 目录）将 d.config 重置为默认值；current 是该版本的指纹。
      const current = (await get(d)).version
      const body = {
        active: { provider: 'main', model: 'claude-opus-5' },
        providers: {
          main: { kind: 'anthropic_messages', hasApiKey: true, models: { 'claude-opus-5': {} } },
        },
        mode: 'auto' as const,
      }

      const stale = await put(d, body, 'deadbeefdeadbeef')
      expect(stale!.status).toBe(409)
      // 未写入磁盘：本次 PUT 的接口 main 未进入 d.config。
      expect(d.config.providers.main).toBeUndefined()

      const ok = await put(d, body, current)
      expect(ok!.status).toBe(200)
      expect(d.config.providers.main).toBeDefined()

      // 不携带 baseVersion：此类客户端同样放行。
      const legacy = await put(d, body)
      expect(legacy!.status).toBe(200)
    } finally {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
    }
  })

  /**
   * 原始失败形状：设置页 GET 之后、PUT 之前，另一个进程（`qy probe`、另一个 qywork 实例）向配置中
   * 添加了一个接口；设置页携带 GET 时的版本号保存。此时返回 200 即表示该接口连同 key 被整份覆盖清除。
   */
  test('GET 之后其他进程写入了配置：以旧版本号保存时返回 409，文件中其他进程的改动保留', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qy-cfg-'))
    const prev = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = home
    try {
      const file = join(home, 'config.json')
      await writeFile(file, JSON.stringify(cfg()))
      const d = { config: cfg() } as unknown as ApiDeps
      const seen = await get(d)

      const other = JSON.parse(await readFile(file, 'utf8')) as QyConfig
      other.providers.other = {
        kind: 'openai_chat_completions',
        apiKey: 'sk-from-another-process',
        models: { m: {} },
      }
      await writeFile(file, JSON.stringify(other))

      const res = await put(d, { ...seen.config, mode: 'full' }, seen.version)
      expect(res!.status).toBe(409)
      const onDisk = JSON.parse(await readFile(file, 'utf8')) as QyConfig
      expect(onDisk.providers.other?.apiKey).toBe('sk-from-another-process')
      expect(onDisk.mode).not.toBe('full')
    } finally {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
    }
  })
})
