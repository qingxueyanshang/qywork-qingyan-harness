import { afterEach, describe, expect, test } from 'bun:test'
import {
  collectSecrets,
  configNotices,
  diagnoseConfig,
  type QyConfig,
  resolveApiKey,
  resolveModel,
} from './config.ts'

function cfg(over: Partial<QyConfig> = {}): QyConfig {
  return {
    active: { provider: 'ds', model: 'deepseek-v4-flash' },
    providers: {
      ds: {
        kind: 'openai_compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'QYWORK_TEST_KEY',
        models: { 'deepseek-v4-flash': {} },
      },
    },
    ...over,
  }
}

afterEach(() => {
  delete process.env.QYWORK_TEST_KEY
})

describe('key 解析', () => {
  test('环境变量优先于配置文件明文', () => {
    process.env.QYWORK_TEST_KEY = 'from-env'
    expect(resolveApiKey({ apiKeyEnv: 'QYWORK_TEST_KEY', apiKey: 'p' })).toBe('from-env')
  })

  test('环境变量为空时回落明文', () => {
    expect(resolveApiKey({ apiKeyEnv: 'QYWORK_TEST_KEY', apiKey: 'p' })).toBe('p')
  })

  test('都没有时是空串而不是 undefined', () => {
    expect(resolveApiKey({})).toBe('')
  })
})

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
        kind: 'openai_compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds',
        models: {
          'deepseek-v4-flash': { capabilities: { thinking: 'none' } },
          'deepseek-v4-pro': {},
        },
      },
      mirror: {
        kind: 'openai_compatible',
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
   * 旧结构把 capabilities 挂在档案上，于是「档案里没声明的模型」会**套上**
   * 同档案另一个模型的实测结果——探过 flash 支持思考，换到 pro 就当 pro 也支持。
   * 那是拿 A 的实测事实去描述 B，而且完全静默。
   */
  test('没在这个接口下声明过的能力不会被套到别的模型上', () => {
    expect(resolveModel(two, 'deepseek-v4-flash')?.capabilities).toEqual({ thinking: 'none' })
    expect(resolveModel(two, 'deepseek-v4-pro')?.capabilities).toBeUndefined()
    expect(resolveModel(two, '完全没配过的模型')?.capabilities).toBeUndefined()
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
  test('没配 key 时给出配置文件路径与最小示例', () => {
    const [p] = diagnoseConfig(cfg())
    expect(p).toBeDefined()
    expect(p).toContain('config.json')
    expect(p).toContain('qy init')
    // 光说「没配」不够——用户得知道往里写什么形状的东西。
    expect(p).toContain('"apiKey"')
    expect(p).toContain('QYWORK_TEST_KEY')
  })

  test('环境变量配上了就没问题', () => {
    process.env.QYWORK_TEST_KEY = 'sk-x'
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
          kind: 'openai_compatible',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: { qwen3: {} },
        },
      },
    })
    expect(diagnoseConfig(local)).toEqual([])
  })

  test('不验证 key 是否有效 —— 那只有 provider 能回答', () => {
    process.env.QYWORK_TEST_KEY = '显然不是一个真 key'
    expect(diagnoseConfig(cfg())).toEqual([])
  })
})

/**
 * 收集凭证。
 *
 * 这是「凭证不进子进程」那条防线的**输入端**——收漏了一把 key，
 * 脱敏层再对也拦不住它。所以这一组测的全是「有没有收全」。
 */
describe('收集凭证', () => {
  afterEach(() => {
    delete process.env.QYWORK_TEST_KEY
    delete process.env.OTHER_KEY
  })

  /**
   * 只收 active 那个档案是不够的：用户配了三家就有三把 key 躺在环境里，
   * 而模型能读到哪一把跟当前用哪个模型毫无关系。
   */
  test('收全部接口的 key，不只是 active 那个', () => {
    const s = collectSecrets(
      cfg({
        providers: {
          ds: { kind: 'openai_compatible', apiKey: 'sk-deepseek-plaintext', models: { m: {} } },
          cl: { kind: 'anthropic', apiKey: 'sk-anthropic-plaintext', models: { m: {} } },
        },
      }),
    )
    expect(s.values).toContain('sk-deepseek-plaintext')
    expect(s.values).toContain('sk-anthropic-plaintext')
  })

  /**
   * `resolveApiKey` 在两者都有时只返回一个，另一个照样躺在环境里
   * 等着被 `env` 打印出来。所以这里必须两处都取。
   */
  test('明文与环境变量两处都取，不是二选一', () => {
    process.env.QYWORK_TEST_KEY = 'sk-from-environment'
    const s = collectSecrets(
      cfg({
        providers: {
          ds: {
            kind: 'openai_compatible',
            apiKey: 'sk-from-config-file',
            apiKeyEnv: 'QYWORK_TEST_KEY',
            models: { m: {} },
          },
        },
      }),
    )
    expect(s.values).toContain('sk-from-config-file')
    expect(s.values).toContain('sk-from-environment')
  })

  /** 变量名这条判据抓的是「明文我们不知道」的情况：key 只在环境里，配置里没写。 */
  test('变量名单独收，用来抓明文未知的那些', () => {
    const s = collectSecrets(cfg())
    expect(s.envNames).toContain('QYWORK_TEST_KEY')
  })

  test('环境变量没设时不收一个空串 —— 空串会让按值匹配命中一切', () => {
    const s = collectSecrets(cfg())
    expect(s.values).not.toContain('')
  })

  test('同一把 key 配在多处只出现一次', () => {
    process.env.QYWORK_TEST_KEY = 'sk-same-key-everywhere'
    const s = collectSecrets(
      cfg({
        providers: {
          a: { kind: 'anthropic', apiKeyEnv: 'QYWORK_TEST_KEY', models: { m: {} } },
          b: { kind: 'anthropic', apiKey: 'sk-same-key-everywhere', models: { m: {} } },
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
    expect(n).toContain('qy probe')
  })

  test('内置目录里的模型不提醒', () => {
    const n = configNotices(
      cfg({
        active: { provider: 'x', model: 'claude-opus-5' },
        providers: {
          x: { kind: 'anthropic', apiKey: 'sk-a', models: { 'claude-opus-5': {} } },
        },
      }),
    ).join('\n')
    expect(n).not.toContain('不在内置目录')
  })

  test('已经有实测能力时不提醒——那说明用户跑过 qy probe 了', () => {
    const n = configNotices(
      cfg({
        active: { provider: 'x', model: '某个没收录的模型' },
        providers: {
          x: {
            kind: 'openai_responses',
            apiKey: 'sk-a',
            models: {
              某个没收录的模型: {
                capabilities: { thinking: 'reasoning_effort', effortLevels: ['low', 'high'] },
              },
            },
          },
        },
      }),
    ).join('\n')
    expect(n).not.toContain('不在内置目录')
  })

  /*
   * 旧格式**不迁移**（B3：开发期不留兼容层），但静默丢弃是另一回事：
   * 用户看到的是「我配好的接口和 key 全没了」，而配置文件里还原样躺着。
   * 先例是 autoApprove——一律忽略，但必须说出来。
   */
  test('检出旧的扁平 profiles 时点名说清楚，并指出 key 要重填', () => {
    const legacy = { ...cfg(), profiles: { ds: { kind: 'anthropic', model: 'm' } } } as QyConfig
    const n = configNotices(legacy).join('\n')
    expect(n).toContain('profiles')
    expect(n).toContain('API Key')
  })

  test('没有旧字段时一个字都不说', () => {
    expect(configNotices(cfg()).some((s) => s.includes('profiles'))).toBe(false)
  })
})
