import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySpecOverride,
  buildAdapter,
  lookupModel,
  type ModelSpec,
  type ProviderKind,
} from '@qywork/ai'
import {
  catalogKey,
  collectSecrets,
  configNotices,
  diagnoseConfig,
  loadConfig,
  type QyConfig,
  resolveModel,
} from './config.ts'

function cfg(over: Partial<QyConfig> = {}): QyConfig {
  return {
    active: { provider: 'ds', model: 'deepseek-v4-flash' },
    providers: {
      ds: {
        kind: 'openai_chat_completions',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek-configured',
        models: { 'deepseek-v4-flash': {} },
      },
    },
    ...over,
  }
}

/**
 * 「接口 → 模型」两层之后的解析。
 *
 * 这一组测的是**旧结构做不到的三件事**，不是把老断言换个写法：
 * 能力按模型分格、同名模型时当前接口优先、凭证只写一份。
 */
describe('模型解析', () => {
  const two = cfg({
    providers: {
      ds: {
        kind: 'openai_chat_completions',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds',
        models: {
          'deepseek-v4-flash': { effort: 'high' },
          'deepseek-v4-pro': {},
        },
      },
      mirror: {
        kind: 'openai_chat_completions',
        baseUrl: 'https://mirror.example/v1',
        apiKey: 'sk-mirror',
        models: { 'deepseek-v4-flash': {} },
      },
    },
  })

  test('同接口下换模型，凭证与端点跟着接口走', () => {
    const r = resolveModel(two, 'deepseek-v4-pro')
    expect(r?.provider).toBe('ds')
    expect(r?.apiKey).toBe('sk-ds')
    expect(r?.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  /*
   * 思考档是**偏好**，逐「接口 × 模型」存。没在这一格选过的模型不会套上
   * 同接口另一个模型选的那一档——那是拿 A 的选择去描述 B，而且完全静默。
   */
  test('没在这一格选过的思考档不会被套到别的模型上', () => {
    expect(resolveModel(two, 'deepseek-v4-flash')?.effort).toBe('high')
    expect(resolveModel(two, 'deepseek-v4-pro')?.effort).toBeUndefined()
    expect(resolveModel(two, '完全没配过的模型')?.effort).toBeUndefined()
  })

  /*
   * 同一个模型 id 挂在两个接口下（官方 + 中转）是常见配置。旧实现取的是
   * `Object.values().find()`——对象键的枚举顺序，用户选了 A 可能发去 B，
   * 而且重新保存一次顺序变了结果就变。
   */
  test('两个接口都有这个模型时，当前接口优先', () => {
    expect(resolveModel(two, 'deepseek-v4-flash')?.provider).toBe('ds')
    const onMirror = { ...two, active: { provider: 'mirror', model: 'deepseek-v4-flash' } }
    expect(resolveModel(onMirror, 'deepseek-v4-flash')?.provider).toBe('mirror')
  })

  test('当前接口没有这个模型时挂到声明了它的那个接口上', () => {
    const elsewhere = { ...two, active: { provider: 'mirror', model: 'deepseek-v4-flash' } }
    expect(resolveModel(elsewhere, 'deepseek-v4-pro')?.provider).toBe('ds')
  })

  /** 传 ref 是「用户写死了哪个接口」，不能再去猜——classifier 就是这么配的。 */
  test('传 ModelRef 时接口是指定死的，不参与猜测', () => {
    const r = resolveModel(two, { provider: 'mirror', model: 'deepseek-v4-pro' })
    expect(r?.provider).toBe('mirror')
    expect(r?.apiKey).toBe('sk-mirror')
  })

  test('接口不存在时返回 undefined，而不是回落到别的接口', () => {
    expect(resolveModel(two, { provider: '不存在', model: 'x' })).toBeUndefined()
  })
})

describe('配置体检', () => {
  const noKey = () =>
    cfg({
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          baseUrl: 'https://api.deepseek.com/v1',
          models: { 'deepseek-v4-flash': {} },
        },
      },
    })

  test('没配 key 时给出配置文件路径与最小示例', () => {
    const [p] = diagnoseConfig(noKey())
    expect(p).toBeDefined()
    expect(p).toContain('config.json')
    expect(p).toContain('qy init')
    // 光说「没配」不够——用户得知道往里写什么形状的配置。
    expect(p).toContain('"apiKey"')
  })

  test('配了 key 就没问题', () => {
    expect(diagnoseConfig(cfg())).toEqual([])
  })

  test('active 指向不存在的接口时列出实际有哪些', () => {
    const [p] = diagnoseConfig(cfg({ active: { provider: '打错了', model: 'm' } }))
    expect(p).toContain('打错了')
    expect(p).toContain('ds')
  })

  test('一个接口都没有时也不崩', () => {
    expect(diagnoseConfig({ active: { provider: 'x', model: 'm' }, providers: {} })).toHaveLength(1)
  })

  test('本机模型服务不要求 key', () => {
    const local = cfg({
      active: { provider: 'ds', model: 'qwen3' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: { qwen3: {} },
        },
      },
    })
    expect(diagnoseConfig(local)).toEqual([])
  })

  test('不验证 key 是否有效 —— 那只有 provider 能回答', () => {
    expect(
      diagnoseConfig(
        cfg({
          providers: {
            ds: {
              kind: 'openai_chat_completions',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKey: '显然不是一个真 key',
              models: { 'deepseek-v4-flash': {} },
            },
          },
        }),
      ),
    ).toEqual([])
  })
})

/**
 * 收集凭证。
 *
 * 这是「凭证不进子进程」那条防线的**输入端**——收漏了一把 key，
 * 脱敏层再对也拦不住它。所以这一组测的全是「有没有收全」。
 */
describe('收集凭证', () => {
  /**
   * 只收 active 那个档案是不够的：用户配了三家就有三把 key 躺在环境里，
   * 而模型能读到哪一把跟当前用哪个模型毫无关系。
   */
  test('收全部接口的 key，不只是 active 那个', () => {
    const s = collectSecrets(
      cfg({
        providers: {
          ds: {
            kind: 'openai_chat_completions',
            apiKey: 'sk-deepseek-plaintext',
            models: { m: {} },
          },
          cl: { kind: 'anthropic_messages', apiKey: 'sk-anthropic-plaintext', models: { m: {} } },
        },
      }),
    )
    expect(s.values).toContain('sk-deepseek-plaintext')
    expect(s.values).toContain('sk-anthropic-plaintext')
  })

  test('没配 key 的接口不收一个空串 —— 空串会让按值匹配命中一切', () => {
    const s = collectSecrets(
      cfg({ providers: { ds: { kind: 'anthropic_messages', models: { m: {} } } } }),
    )
    expect(s.values).not.toContain('')
  })

  test('同一把 key 配在多个接口下只出现一次', () => {
    const s = collectSecrets(
      cfg({
        providers: {
          a: { kind: 'anthropic_messages', apiKey: 'sk-same-key-everywhere', models: { m: {} } },
          b: { kind: 'anthropic_messages', apiKey: 'sk-same-key-everywhere', models: { m: {} } },
        },
      }),
    )
    expect(s.values.filter((v) => v === 'sk-same-key-everywhere')).toHaveLength(1)
  })
})

describe('配置提醒', () => {
  test('额外根目录：相对路径被拒且说得出为什么', () => {
    const n = configNotices(cfg({ additionalDirectories: ['notes'] }))
    expect(n.join('\n')).toContain('绝对路径')
  })

  test('额外根目录：合法时每次都提醒它放开了工作区之外', () => {
    // 「模型可以读写工作区之外的这几个目录」是一件必须反复说清的事实，
    // 而不是配一次就忘的开关。
    // 正斜杠：`isAbsolute` 两种写法都认，而反斜杠在 TS 字符串里是转义序列
    // （`\d` → `d`、`\n` → 换行），源码上完全看不出来。
    const abs = process.platform === 'win32' ? 'C:/data/notes' : '/data/notes'
    const n = configNotices(cfg({ additionalDirectories: [abs] })).join('\n')
    expect(n).toContain('工作区之外')
    // `resolve()` 会把分隔符归一成本平台的形式，所以比对时也归一。
    expect(n.replace(/\\/g, '/')).toContain(abs)
  })

  test('不配额外根目录时不产生噪声', () => {
    // 提醒一多就没人看了。没配就一个字都不该说。
    expect(configNotices(cfg()).some((s) => s.includes('工作区之外'))).toBe(false)
  })

  test('模型不在内置目录时要说清两条后果', () => {
    /*
     * 这条是跑双端点冒烟照出来的：`lookupModel` 对未收录的模型回落到
     * `unknownModel()`，其 `thinking: 'none'` 让适配器**从不请求推理**，
     * 而计价全零让 `qy usage` 报 $0。两件事都完全静默。
     *
     * 保守默认是对的，错的是不说——ARCHITECTURE §27「不能把『没测』写成『不支持』」。
     */
    const n = configNotices(
      cfg({
        active: { provider: 'x', model: '某个没收录的模型' },
        providers: {
          x: { kind: 'openai_responses', apiKey: 'sk-a', models: { 某个没收录的模型: {} } },
        },
      }),
    ).join('\n')
    expect(n).toContain('不在内置目录')
    expect(n).toContain('思考')
    expect(n).toContain('计价')
    expect(n).toContain('端点探测')
    expect(n).toContain('不能补出')
  })

  test('内置目录里的模型不提醒', () => {
    const n = configNotices(
      cfg({
        active: { provider: 'x', model: 'claude-opus-5' },
        providers: {
          x: { kind: 'anthropic_messages', apiKey: 'sk-a', models: { 'claude-opus-5': {} } },
        },
      }),
    ).join('\n')
    expect(n).not.toContain('不在内置目录')
  })

  test('模型库里已经明确补录这一条时不提醒', () => {
    const n = configNotices(
      cfg({
        active: { provider: 'x', model: '某个没收录的模型' },
        providers: {
          x: { kind: 'openai_responses', apiKey: 'sk-a', models: { 某个没收录的模型: {} } },
        },
        catalog: {
          [catalogKey('某个没收录的模型', 'openai_responses')]: {
            thinking: 'reasoning_effort',
            effortLevels: ['low', 'high'],
          },
        },
      }),
    ).join('\n')
    expect(n).not.toContain('不在内置目录')
  })

  /** 键的第二维是协议：补录 responses 的规格，不等于补录兼容协议的规格。 */
  test('另一条协议下的那一条不算数', () => {
    const n = configNotices(
      cfg({
        active: { provider: 'x', model: '某个没收录的模型' },
        providers: {
          x: { kind: 'openai_responses', apiKey: 'sk-a', models: { 某个没收录的模型: {} } },
        },
        catalog: {
          [catalogKey('某个没收录的模型', 'openai_chat_completions')]: { thinking: 'none' },
        },
      }),
    ).join('\n')
    expect(n).toContain('不在内置目录')
  })

  /*
   * 旧格式**不迁移**（B3：开发期不留兼容层），但静默丢弃是另一回事：
   * 界面上是「配好的接口和 key 全没了」，而配置文件里还原样存着。
   * 先例是 autoApprove——一律忽略，但必须说出来。
   */
  test('检出旧的扁平 profiles 时点名说清楚，并指出 key 要重填', () => {
    const legacy = {
      ...cfg(),
      profiles: { ds: { kind: 'anthropic_messages', model: 'm' } },
    } as QyConfig
    const n = configNotices(legacy).join('\n')
    expect(n).toContain('profiles')
    expect(n).toContain('API Key')
  })

  test('没有旧字段时一个字都不说', () => {
    expect(configNotices(cfg()).some((s) => s.includes('profiles'))).toBe(false)
  })
})

/**
 * 档位挂在「接口 × 模型」那一格。
 *
 * **不能用一个全局值**：只调一家模型时档位面一致，一个全局字段够用；这里同时
 * 接多家（Claude 五档、DeepSeek 三档、也有模型一档没有，同一个模型换条协议档位面
 * 还会变），而且 Agent Team 的每个角色各带一个模型（`team-run.ts` 的
 * `backend.model`）——一个全局值套上去必然错配。
 */
describe('按「接口 × 模型」取档位', () => {
  const two = cfg({
    active: { provider: 'ds', model: 'deepseek-v4-flash' },
    providers: {
      ds: {
        kind: 'openai_chat_completions',
        apiKey: 'sk-ds',
        models: { 'deepseek-v4-flash': { effort: 'max' }, 'deepseek-v4-pro': {} },
      },
      claude: {
        kind: 'anthropic_messages',
        apiKey: 'sk-c',
        models: { 'claude-opus-5': { effort: 'xhigh' } },
      },
    },
  })

  test('各取各的那一格', () => {
    expect(resolveModel(two, 'deepseek-v4-flash')?.effort).toBe('max')
    // xhigh 在 DeepSeek 上不存在，而它是 Claude 那一格的合法值——
    // 这正是全局一个值装不下的差异。
    expect(resolveModel(two, 'claude-opus-5')?.effort).toBe('xhigh')
  })

  /** 同接口的另一个模型不跟着变：挂在接口上就是拿 A 的选择去描述 B。 */
  test('同接口的另一个模型不受影响', () => {
    expect(resolveModel(two, 'deepseek-v4-pro')?.effort).toBeUndefined()
  })

  /** 没选过就是 undefined，**不替它挑一档**——挑「第一档」在两个模型上是两个意思。 */
  test('没选过是 undefined，不编一个默认档', () => {
    expect(resolveModel(cfg(), 'deepseek-v4-flash')?.effort).toBeUndefined()
  })
})

/**
 * 词表校验必须落在**配置这道闸门**上。
 *
 * 不拦的话，任何客户端 PUT 一个词表外的值就直接落盘，下一轮原样发给 provider，
 * 换来一个 400，而错误信息里只有 provider 的原话。
 */
describe('思考档位校验', () => {
  // 只看档位这一条：夹具没有 key，别的问题与这里无关。
  const effortProblems = (c: QyConfig) => diagnoseConfig(c).filter((p) => p.includes('思考强度'))

  const withEffort = (effort: unknown): QyConfig =>
    cfg({
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          models: { 'deepseek-v4-flash': { effort: effort as never } },
        },
      },
    })

  /**
   * 校验必须落在配置这道闸门上——否则任何客户端 PUT 一个词表外的值就直接落盘，
   * 下一轮原样发给 provider 换一个 400。
   */
  test('词表外的值算致命问题（422 且不落盘）', () => {
    expect(effortProblems(withEffort('ultra'))).toHaveLength(1)
  })

  test('词表里的值放行', () => {
    expect(effortProblems(withEffort('max'))).toEqual([])
  })

  test('旧的关闭命令 none 不再是可选档位', () => {
    expect(effortProblems(withEffort('none'))).toHaveLength(1)
  })

  /** 没选过 = 不发思考字段，让模型走自己的默认，不是问题。 */
  test('没选过不算问题', () => {
    expect(effortProblems(cfg())).toEqual([])
  })

  /** 报错要点名是哪个接口下的哪个模型——多家模型并存时，不点名等于没说。 */
  test('报错点名接口与模型', () => {
    expect(effortProblems(withEffort('ultra'))[0]).toContain('ds / deepseek-v4-flash')
  })
})

/**
 * 模型库那几个枚举的校验。
 *
 * 与思考档位同一道闸门、同一个理由，但**后果更隐蔽**：档位打错下一轮换来一个
 * provider 的 400，而这三个打错通常什么都不发生——`thinking` 打错会让
 * `effortIsTransmittable` 恒 false（这个模型的 effort 从此不再发送），
 * `cacheRouting` 打错会让亲和键不再发送，两条都不报错。
 */
describe('模型库枚举校验', () => {
  const withEntry = (entry: Record<string, unknown>, key = 'deepseek-v4-flash|openai_responses') =>
    cfg({
      providers: {
        ds: {
          kind: 'openai_responses',
          apiKey: 'sk-x',
          models: { 'deepseek-v4-flash': {} },
        },
      },
      catalog: { [key]: entry as never },
    })

  test('三个枚举各自的词表外值都算致命问题', () => {
    expect(diagnoseConfig(withEntry({ thinking: 'anthropic_effort' }))).toHaveLength(1)
    expect(diagnoseConfig(withEntry({ reasoningEcho: '要' }))).toHaveLength(1)
    expect(diagnoseConfig(withEntry({ cacheRouting: '发' }))).toHaveLength(1)
  })

  test('词表里的值放行', () => {
    expect(
      diagnoseConfig(
        withEntry({
          thinking: 'reasoning_effort',
          reasoningEcho: 'reasoning_text',
          cacheRouting: 'prompt_cache_key',
        }),
      ),
    ).toEqual([])
    expect(diagnoseConfig(withEntry({ cacheRouting: 'x_grok_conv_id' }))).toEqual([])
  })

  /** 没填 = 照内置值，不是问题。 */
  test('没填的字段不算问题', () => {
    expect(diagnoseConfig(withEntry({ contextWindow: 1024 }))).toEqual([])
  })

  /**
   * 键的第二维写错时，这条覆盖**永远匹配不上任何请求**（`resolveModel` 按
   * `catalogKey(model, provider.kind)` 取），是另一种静默失效。
   */
  test('键里的协议不在词表里也算问题', () => {
    const [p] = diagnoseConfig(withEntry({ contextWindow: 1024 }, 'deepseek-v4-flash|openai_v2'))
    expect(p).toContain('openai_v2')
  })

  /** 挡下来还得说清去哪改——这道闸门会让 `qy exec` 直接退出。 */
  test('报错带着改哪', () => {
    const [p] = diagnoseConfig(withEntry({ thinking: 'anthropic_effort' }))
    expect(p).toContain('模型库')
    expect(p).toContain('config.json')
  })
})

/**
 * 模型库的覆盖要**取得到**。
 *
 * 只有一个能编辑的界面、改完到不了 `resolveModel`，那就是一条有产出没有消费者的
 * 链路——改完的价格永远不会出现在任何一次请求或账本里。
 */
describe('模型库覆盖', () => {
  const withCatalog = () =>
    cfg({
      catalog: {
        [catalogKey('deepseek-v4-flash', 'openai_chat_completions')]: { input: 9, output: 19 },
      },
    })

  test('按「模型 id × 接口的协议」取', () => {
    expect(resolveModel(withCatalog())?.spec).toEqual({ input: 9, output: 19 })
  })

  /** 模型没在这个接口下声明过也要取得到：参数是模型在这条协议上的属性。 */
  test('接口下没声明过这个模型也取得到', () => {
    const r = resolveModel(withCatalog(), 'deepseek-v4-flash')
    expect(r?.spec?.input).toBe(9)
  })

  test('库里没这一条就不带 spec，不塞一个空对象', () => {
    expect(resolveModel(cfg())?.spec).toBeUndefined()
  })

  /**
   * 同一个模型 id 在两种协议下各取自己那份。
   *
   * 一维键会把一份参数套到两条 seed 上——而目录里 deepseek 同 id 就是两条，
   * 走 chat/completions 时思考无从控制，走 Responses 时 `effort:'none'` 关得掉。
   */
  test('同一个模型 id 在两种协议下各取自己那份', () => {
    const both = cfg({
      active: { provider: 'compat', model: 'deepseek-v4-flash' },
      providers: {
        compat: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-a',
          models: { 'deepseek-v4-flash': {} },
        },
        resp: {
          kind: 'openai_responses',
          apiKey: 'sk-b',
          models: { 'deepseek-v4-flash': {} },
        },
      },
      catalog: {
        [catalogKey('deepseek-v4-flash', 'openai_chat_completions')]: { maxOutputTokens: 111 },
        [catalogKey('deepseek-v4-flash', 'openai_responses')]: { maxOutputTokens: 222 },
      },
    })
    expect(resolveModel(both)?.spec?.maxOutputTokens).toBe(111)
    expect(
      resolveModel(both, { provider: 'resp', model: 'deepseek-v4-flash' })?.spec?.maxOutputTokens,
    ).toBe(222)
  })
})

/**
 * 一次性迁移：模型库的旧形状 → `catalogKey(id, kind)` 两维键。
 *
 * 判据不是「迁移函数返回了什么」，而是**迁移前后 `buildAdapter` 解析出的
 * `ModelSpec` 逐字段相等**：旧配置不许因为换了形状就静默变哑。
 * 本机的 `config.json` 三种旧键一个都没有，迁移对它是空操作——正因如此，
 * 这条路径除了这里没有任何人走过。
 */
describe('模型库一次性迁移', () => {
  interface LegacyModel {
    maxOutputTokens?: number
    capabilities?: { thinking?: string; effortLevels?: string[]; thinksByDefault?: boolean }
    effort?: string
  }
  interface LegacyConfig {
    active: { provider: string; model: string }
    providers: Record<
      string,
      { kind: ProviderKind; apiKey?: string; models: Record<string, LegacyModel> }
    >
    catalog?: Record<string, Record<string, unknown>>
  }

  /**
   * 迁移前那条四层解析，逐字复刻：
   * 目录 seed → 模型库（一维键） → 探测出来的 capabilities → 接口下写死的上限取小。
   */
  function legacySpec(raw: LegacyConfig, providerName: string, model: string): ModelSpec {
    const p = raw.providers[providerName]!
    const declared = p.models[model]
    const base = applySpecOverride(lookupModel(model, p.kind), raw.catalog?.[model])
    const caps = declared?.capabilities
    const probed = caps
      ? {
          ...base,
          ...(caps.thinking ? { thinking: caps.thinking as ModelSpec['thinking'] } : {}),
          ...(caps.effortLevels
            ? { effortLevels: caps.effortLevels as ModelSpec['effortLevels'] }
            : {}),
          ...(caps.thinksByDefault !== undefined ? { thinksByDefault: caps.thinksByDefault } : {}),
        }
      : base
    return declared?.maxOutputTokens
      ? {
          ...probed,
          maxOutputTokens: Math.min(
            declared.maxOutputTokens,
            probed.maxOutputTokens ?? declared.maxOutputTokens,
          ),
        }
      : probed
  }

  /** 迁移后那条两层解析：`resolveModel` 取到库里那一条，`buildAdapter` 叠上去。 */
  function currentSpec(cfg: QyConfig, providerName: string, model: string): ModelSpec {
    const r = resolveModel(cfg, { provider: providerName, model })!
    return buildAdapter({
      kind: r.kind,
      apiKey: r.apiKey ?? 'sk-x',
      model: r.model,
      ...(r.spec ? { spec: r.spec } : {}),
    }).spec
  }

  let home: string
  const prevHome = process.env.QYWORK_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qy-catalog-migrate-'))
    process.env.QYWORK_HOME = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  async function load(raw: LegacyConfig): Promise<QyConfig> {
    await writeFile(join(home, 'config.json'), JSON.stringify(raw), 'utf8')
    return loadConfig()
  }

  test('无 catalog 段：空操作，也不凭空造一个 catalog', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-ds',
          models: { 'deepseek-v4-flash': { effort: 'high' } },
        },
      },
    }
    const migrated = await load(raw)
    expect(migrated.catalog).toBeUndefined()
    expect(migrated.providers.ds?.models['deepseek-v4-flash']?.effort).toBe('high')
    expect(currentSpec(migrated, 'ds', 'deepseek-v4-flash')).toEqual(
      legacySpec(raw, 'ds', 'deepseek-v4-flash'),
    )
  })

  test('旧配置里的 none 迁成未选择，不再向 provider 发送关闭命令', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-ds',
          models: { 'deepseek-v4-flash': { effort: 'none' } },
        },
      },
    }
    const migrated = await load(raw)
    expect(migrated.providers.ds?.models['deepseek-v4-flash']?.effort).toBeUndefined()
    expect(resolveModel(migrated, 'deepseek-v4-flash')?.effort).toBeUndefined()
  })

  test('一维键 + 单 kind：改写成两维键，解析结果逐字段不变', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-ds',
          models: { 'deepseek-v4-flash': {} },
        },
      },
      catalog: { 'deepseek-v4-flash': { input: 9, output: 19, contextWindow: 123_000 } },
    }
    const migrated = await load(raw)
    expect(Object.keys(migrated.catalog ?? {})).toEqual([
      catalogKey('deepseek-v4-flash', 'openai_chat_completions'),
    ])
    expect(currentSpec(migrated, 'ds', 'deepseek-v4-flash')).toEqual(
      legacySpec(raw, 'ds', 'deepseek-v4-flash'),
    )
  })

  /** 一维键的旧语义就是「一份套到所有协议」，所以每个 kind 各写一份。 */
  test('一维键 + 多 kind：每个协议各写一份，两侧解析结果都不变', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'compat', model: 'deepseek-v4-flash' },
      providers: {
        compat: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-a',
          models: { 'deepseek-v4-flash': {} },
        },
        resp: { kind: 'openai_responses', apiKey: 'sk-b', models: { 'deepseek-v4-flash': {} } },
      },
      catalog: { 'deepseek-v4-flash': { input: 9, output: 19 } },
    }
    const migrated = await load(raw)
    expect(Object.keys(migrated.catalog ?? {}).sort()).toEqual(
      [
        catalogKey('deepseek-v4-flash', 'openai_chat_completions'),
        catalogKey('deepseek-v4-flash', 'openai_responses'),
      ].sort(),
    )
    expect(currentSpec(migrated, 'compat', 'deepseek-v4-flash')).toEqual(
      legacySpec(raw, 'compat', 'deepseek-v4-flash'),
    )
    expect(currentSpec(migrated, 'resp', 'deepseek-v4-flash')).toEqual(
      legacySpec(raw, 'resp', 'deepseek-v4-flash'),
    )
  })

  test('接口下的旧字段并进同一个键，且原地删干净', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'gw', model: '中转站上的某个模型' },
      providers: {
        gw: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-gw',
          models: {
            中转站上的某个模型: {
              maxOutputTokens: 512,
              capabilities: {
                thinking: 'reasoning_effort',
                effortLevels: ['low', 'high'],
                thinksByDefault: true,
              },
            },
          },
        },
      },
    }
    const migrated = await load(raw)
    const key = catalogKey('中转站上的某个模型', 'openai_chat_completions')
    expect(migrated.catalog?.[key]).toEqual({
      maxOutputTokens: 512,
      thinking: 'reasoning_effort',
      effortLevels: ['low', 'high'],
      thinksByDefault: true,
    })
    // 旧字段就地删掉，不留第二条读取路径。
    expect(migrated.providers.gw?.models.中转站上的某个模型).toEqual({})
    expect(currentSpec(migrated, 'gw', '中转站上的某个模型')).toEqual(
      legacySpec(raw, 'gw', '中转站上的某个模型'),
    )
  })

  /**
   * 同协议的两个接口撞同一个键：不猜，留接口名字典序靠前的那份。
   * 「留后一个」会让结果跟着对象键的枚举顺序走，重新保存一次就变。
   */
  test('两接口冲突：保留字典序靠前的那份', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'aaa', model: 'deepseek-v4-flash' },
      providers: {
        zzz: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-z',
          models: { 'deepseek-v4-flash': { maxOutputTokens: 999 } },
        },
        aaa: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-a',
          models: { 'deepseek-v4-flash': { maxOutputTokens: 111 } },
        },
      },
    }
    const migrated = await load(raw)
    const key = catalogKey('deepseek-v4-flash', 'openai_chat_completions')
    expect(migrated.catalog?.[key]?.maxOutputTokens).toBe(111)
    expect(currentSpec(migrated, 'aaa', 'deepseek-v4-flash')).toEqual(
      legacySpec(raw, 'aaa', 'deepseek-v4-flash'),
    )
  })

  /** 接口下那两个字段排在模型库之后，优先级不变。 */
  test('一维键与接口下的字段撞键时，接口下的赢', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-ds',
          models: { 'deepseek-v4-flash': { maxOutputTokens: 512 } },
        },
      },
      catalog: { 'deepseek-v4-flash': { maxOutputTokens: 4096, input: 9 } },
    }
    const migrated = await load(raw)
    const entry = migrated.catalog?.[catalogKey('deepseek-v4-flash', 'openai_chat_completions')]
    expect(entry?.maxOutputTokens).toBe(512)
    expect(entry?.input).toBe(9)
    expect(currentSpec(migrated, 'ds', 'deepseek-v4-flash')).toEqual(
      legacySpec(raw, 'ds', 'deepseek-v4-flash'),
    )
  })

  /** 幂等判据是键的形状：跑完一次旧形状就不存在，再跑一次原样返回。 */
  test('跑两次同果', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-ds',
          models: { 'deepseek-v4-flash': { maxOutputTokens: 512 } },
        },
      },
      catalog: { 'deepseek-v4-flash': { input: 9 } },
    }
    const once = await load(raw)
    await writeFile(join(home, 'config.json'), JSON.stringify(once), 'utf8')
    expect(await loadConfig()).toEqual(once)
  })

  /** 一维键指向一个哪个接口都没挂的模型：判不出协议，不猜——丢弃并点名。 */
  test('一维键指向没挂在任何接口下的模型时丢弃', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-ds',
          models: { 'deepseek-v4-flash': {} },
        },
      },
      catalog: { 谁都没挂过的模型: { input: 9 } },
    }
    const migrated = await load(raw)
    expect(migrated.catalog).toBeUndefined()
  })
})
