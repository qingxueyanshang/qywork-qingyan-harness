import { afterEach, describe, expect, test } from 'bun:test'
import {
  collectSecrets,
  configNotices,
  diagnoseConfig,
  type QyConfig,
  resolveApiKey,
} from './config.ts'

function cfg(over: Partial<QyConfig> = {}): QyConfig {
  return {
    active: 'ds',
    profiles: {
      ds: {
        kind: 'openai_compatible',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'QYWORK_TEST_KEY',
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
    expect(
      resolveApiKey({ kind: 'anthropic', model: 'm', apiKeyEnv: 'QYWORK_TEST_KEY', apiKey: 'p' }),
    ).toBe('from-env')
  })

  test('环境变量为空时回落明文', () => {
    expect(
      resolveApiKey({ kind: 'anthropic', model: 'm', apiKeyEnv: 'QYWORK_TEST_KEY', apiKey: 'p' }),
    ).toBe('p')
  })

  test('都没有时是空串而不是 undefined', () => {
    expect(resolveApiKey({ kind: 'anthropic', model: 'm' })).toBe('')
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

  test('active 指向不存在的档案时列出实际有哪些', () => {
    const [p] = diagnoseConfig(cfg({ active: '打错了' }))
    expect(p).toContain('打错了')
    expect(p).toContain('ds')
  })

  test('一个档案都没有时也不崩', () => {
    expect(diagnoseConfig({ active: 'x', profiles: {} })).toHaveLength(1)
  })

  test('本机模型服务不要求 key', () => {
    const local = cfg({
      profiles: {
        ds: { kind: 'openai_compatible', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434/v1' },
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
  test('收全部档案的 key，不只是 active 那个', () => {
    const s = collectSecrets(
      cfg({
        profiles: {
          ds: { kind: 'openai_compatible', model: 'm', apiKey: 'sk-deepseek-plaintext' },
          cl: { kind: 'anthropic', model: 'm', apiKey: 'sk-anthropic-plaintext' },
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
        profiles: {
          ds: {
            kind: 'openai_compatible',
            model: 'm',
            apiKey: 'sk-from-config-file',
            apiKeyEnv: 'QYWORK_TEST_KEY',
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
        profiles: {
          a: { kind: 'anthropic', model: 'm', apiKeyEnv: 'QYWORK_TEST_KEY' },
          b: { kind: 'anthropic', model: 'm', apiKey: 'sk-same-key-everywhere' },
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
        active: 'x',
        profiles: { x: { kind: 'openai_responses', model: '某个没收录的模型', apiKey: 'sk-a' } },
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
        active: 'x',
        profiles: { x: { kind: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-a' } },
      }),
    ).join('\n')
    expect(n).not.toContain('不在内置目录')
  })

  test('已经有实测能力时不提醒——那说明用户跑过 qy probe 了', () => {
    const n = configNotices(
      cfg({
        active: 'x',
        profiles: {
          x: {
            kind: 'openai_responses',
            model: '某个没收录的模型',
            apiKey: 'sk-a',
            capabilities: { thinking: 'reasoning_effort', effortLevels: ['low', 'high'] },
          },
        },
      }),
    ).join('\n')
    expect(n).not.toContain('不在内置目录')
  })
})
