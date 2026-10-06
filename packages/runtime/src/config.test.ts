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
import type { MediaKind } from '@qywork/core'
import {
  catalogKey,
  collectSecrets,
  configNotices,
  diagnoseConfig,
  diagnoseRunnable,
  listMediaModels,
  loadConfig,
  type QyConfig,
  resolveMediaModel,
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

test('已落盘的旧参数模式不能覆盖模型库的协议策略', async () => {
  const model = 'mimo-v2.6-pro'
  const config = cfg({
    active: { provider: 'mimo', model },
    providers: {
      mimo: { kind: 'openai_chat_completions', apiKey: 'test', models: { [model]: {} } },
    },
  })
  const home = await mkdtemp(join(tmpdir(), 'qy-tool-schema-'))
  const previousHome = process.env.QYWORK_HOME
  try {
    process.env.QYWORK_HOME = home
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        ...config,
        catalog: {
          [catalogKey(model, 'openai_chat_completions')]: { chatToolSchema: 'openai_strict' },
        },
      }),
    )
    const loaded = await loadConfig()
    const target = resolveModel(loaded)!
    expect(buildAdapter({ ...target, apiKey: target.apiKey! }).spec.chatToolSchema).toBe('native')
    expect(diagnoseConfig(loaded)).toEqual([])
  } finally {
    if (previousHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

/**
 * 「接口 → 模型」两层结构下的解析。
 *
 * 本组测试覆盖单层结构无法实现的三项行为：
 * 能力按模型分别存储、同名模型时当前接口优先、凭证只保存一份。
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

  test('同接口下切换模型，凭证与端点随接口确定', () => {
    const r = resolveModel(two, 'deepseek-v4-pro')
    expect(r?.provider).toBe('ds')
    expect(r?.apiKey).toBe('sk-ds')
    expect(r?.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  /*
   * 思考档位是偏好，按「接口 × 模型」分别存储。未在该项选择过的模型不会沿用
   * 同接口另一个模型选择的档位：沿用会把模型 A 的选择应用到模型 B，且不产生任何提示。
   */
  test('未在该项选择过的思考档位不会应用到其他模型', () => {
    expect(resolveModel(two, 'deepseek-v4-flash')?.effort).toBe('high')
    expect(resolveModel(two, 'deepseek-v4-pro')?.effort).toBeUndefined()
    expect(resolveModel(two, '完全没配过的模型')?.effort).toBeUndefined()
  })

  /*
   * 同一个模型 id 配置在两个接口下（官方接口与中转站）是常见配置。使用
   * `Object.values().find()` 时结果取决于对象键的枚举顺序：用户选择 A 时请求可能发往 B，
   * 且重新保存一次后顺序改变，结果随之改变。
   */
  test('两个接口都有该模型时，当前接口优先', () => {
    expect(resolveModel(two, 'deepseek-v4-flash')?.provider).toBe('ds')
    const onMirror = { ...two, active: { provider: 'mirror', model: 'deepseek-v4-flash' } }
    expect(resolveModel(onMirror, 'deepseek-v4-flash')?.provider).toBe('mirror')
  })

  test('当前接口没有该模型时归入声明了该模型的接口', () => {
    const elsewhere = { ...two, active: { provider: 'mirror', model: 'deepseek-v4-flash' } }
    expect(resolveModel(elsewhere, 'deepseek-v4-pro')?.provider).toBe('ds')
  })

  test('裸模型名属于多个接口且均不是当前接口时返回 undefined，不按枚举顺序选择', () => {
    // flash 同时属于 ds 与 mirror，active 指向不含 flash 的第三个接口。
    const third = cfg({
      providers: {
        ds: two.providers.ds!,
        mirror: two.providers.mirror!,
        other: { kind: 'openai_chat_completions', models: { x: {} } },
      },
      active: { provider: 'other', model: 'x' },
    })
    expect(resolveModel(third, 'deepseek-v4-flash')).toBeUndefined()
    // 已明确指定接口的 ModelRef 不受影响，正常解析。
    expect(resolveModel(third, { provider: 'mirror', model: 'deepseek-v4-flash' })?.provider).toBe(
      'mirror',
    )
  })

  /** 传入 ref 表示用户已指定接口，不再推测：classifier 即按此方式配置。 */
  test('传入 ModelRef 时接口已明确指定，不参与推测', () => {
    const r = resolveModel(two, { provider: 'mirror', model: 'deepseek-v4-pro' })
    expect(r?.provider).toBe('mirror')
    expect(r?.apiKey).toBe('sk-mirror')
  })

  test('接口不存在时返回 undefined，而不是回退到其他接口', () => {
    expect(resolveModel(two, { provider: '不存在', model: 'x' })).toBeUndefined()
  })
})

describe('配置诊断', () => {
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

  test('未配置 key 是运行前置条件，不阻止保存', () => {
    // 阻止运行的是 diagnoseRunnable，并附带配置文件路径与最小示例。
    const [p] = diagnoseRunnable(noKey())
    expect(p).toBeDefined()
    expect(p).toContain('config.json')
    expect(p).toContain('qy init')
    // 只说明未配置不够：用户需要知道应写入何种形状的配置。
    expect(p).toContain('"apiKey"')
    // diagnoseConfig 放行：缺少 key 是配置中间态，阻止保存将使「新增接口 → 新增模型 → 再填写 key」这一流程无法完成。
    expect(diagnoseConfig(noKey())).toEqual([])
  })

  test('已配置 key 时没有问题', () => {
    expect(diagnoseConfig(cfg())).toEqual([])
    expect(diagnoseRunnable(cfg())).toEqual([])
  })

  test('active 指向不存在的接口时列出现有接口', () => {
    const [p] = diagnoseConfig(cfg({ active: { provider: '打错了', model: 'm' } }))
    expect(p).toContain('打错了')
    expect(p).toContain('ds')
  })

  /** 非布尔值落盘后按真值判定，关闭状态会被读取为开启。 */
  test('两个电脑控制开关只接受布尔值，缺省时放行', () => {
    expect(diagnoseConfig(cfg({ desktopEnabled: true, desktopForeground: false }))).toEqual([])
    expect(diagnoseConfig(cfg())).toEqual([])
    expect(diagnoseConfig(cfg({ desktopForeground: 'yes' as unknown as boolean }))).toEqual([
      'desktopForeground 必须是 true 或 false',
    ])
    expect(diagnoseConfig(cfg({ desktopEnabled: 1 as unknown as boolean }))).toEqual([
      'desktopEnabled 必须是 true 或 false',
    ])
  })

  test('浏览器控制开关只接受布尔值，缺省时放行', () => {
    expect(diagnoseConfig(cfg({ browserEnabled: false }))).toEqual([])
    expect(diagnoseConfig(cfg({ browserEnabled: 'off' as unknown as boolean }))).toEqual([
      'browserEnabled 必须是 true 或 false',
    ])
  })

  test('Office 与画布生成开关只接受布尔值，解释器只接受绝对路径', () => {
    const abs = process.platform === 'win32' ? 'C:\\Python312\\python.exe' : '/usr/bin/python3'
    expect(diagnoseConfig(cfg({ officeEnabled: false, officePython: abs }))).toEqual([])
    expect(diagnoseConfig(cfg({ officeEnabled: 'no' as unknown as boolean }))).toEqual([
      'officeEnabled 必须是 true 或 false',
    ])
    expect(diagnoseConfig(cfg({ officePython: 'python.exe' }))).toEqual([
      'officePython 必须是 Python 解释器的绝对路径',
    ])
    expect(diagnoseConfig(cfg({ mediaEnabled: false }))).toEqual([])
    expect(diagnoseConfig(cfg({ mediaEnabled: 'off' as unknown as boolean }))).toEqual([
      'mediaEnabled 必须是 true 或 false',
    ])
  })

  test('没有任何接口时不崩溃', () => {
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
    expect(diagnoseRunnable(local)).toEqual([])
  })

  test('不验证 key 是否有效：只有 provider 能判定', () => {
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
 * 这是「凭证不进子进程」这项防护的输入端：遗漏任何一个 key，
 * 脱敏层即使正确也无法拦截它。因此本组测试全部针对收集是否完整。
 */
describe('收集凭证', () => {
  /**
   * 只收集 active 接口的 key 不够：用户配置了三个服务商就有三个 key 存在于环境中，
   * 模型能读取哪一个与当前使用的模型无关。
   */
  test('收集全部接口的 key，不只是 active 接口', () => {
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

  test('未配置 key 的接口不收集空串：空串会使按值匹配命中所有内容', () => {
    const s = collectSecrets(
      cfg({ providers: { ds: { kind: 'anthropic_messages', models: { m: {} } } } }),
    )
    expect(s.values).not.toContain('')
  })

  test('同一个 key 配置在多个接口下只出现一次', () => {
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
  test('额外根目录：相对路径被拒绝并说明原因', () => {
    const n = configNotices(cfg({ additionalDirectories: ['notes'] }))
    expect(n.join('\n')).toContain('绝对路径')
  })

  test('额外根目录：合法时每次都提醒已开放工作区之外的目录', () => {
    // 模型可以读写工作区之外的这些目录，这一事实必须每次说明，
    // 而不是配置一次后即被遗忘的开关。
    // 使用正斜杠：`isAbsolute` 接受两种写法，而反斜杠在 TS 字符串中是转义序列
    // （`\d` → `d`、`\n` → 换行），在源码中无法察觉。
    const abs = process.platform === 'win32' ? 'C:/data/notes' : '/data/notes'
    const n = configNotices(cfg({ additionalDirectories: [abs] })).join('\n')
    expect(n).toContain('工作区之外')
    // `resolve()` 会把分隔符规范化为本平台的形式，因此比对时同样规范化。
    expect(n.replace(/\\/g, '/')).toContain(abs)
  })

  test('未配置额外根目录时不产生提醒', () => {
    // 提醒过多会被忽略。未配置时不输出任何内容。
    expect(configNotices(cfg()).some((s) => s.includes('工作区之外'))).toBe(false)
  })

  test('模型不在内置目录时说明两项后果', () => {
    /*
     * `lookupModel` 对未收录的模型回退到
     * `unknownModel()`，其 `thinking: 'none'` 使适配器从不请求推理，
     * 计价全零使 `qy usage` 报告 $0。两项后果都没有任何提示。
     *
     * 保守默认值正确，错误在于不提示，见 ARCHITECTURE §27（不能把「未测试」写成「不支持」）。
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
    expect(n).toContain('无法取得窗口与价格')
  })

  test('内置目录中的模型不提醒', () => {
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

  test('模型库中已明确补录该条目时不提醒', () => {
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
  test('另一协议下的条目不计入', () => {
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
   * 旧格式不迁移（CLAUDE.md B3：开发期不保留兼容层），但不能静默丢弃：
   * 否则界面上已配置的接口与 key 全部消失，而配置文件中仍原样保存。
   * autoApprove 采用相同处理：一律忽略，但必须提示。
   */
  test('检测到旧的扁平 profiles 时明确提示，并指出 key 需要重新填写', () => {
    const legacy = {
      ...cfg(),
      profiles: { ds: { kind: 'anthropic_messages', model: 'm' } },
    } as QyConfig
    const n = configNotices(legacy).join('\n')
    expect(n).toContain('profiles')
    expect(n).toContain('API Key')
  })

  test('没有旧字段时不输出提示', () => {
    expect(configNotices(cfg()).some((s) => s.includes('profiles'))).toBe(false)
  })
})

/**
 * 档位存储在「接口 × 模型」项上。
 *
 * 不能使用全局值：只接入一家厂商的模型时档位集合一致，一个全局字段即可满足；本产品同时
 * 接入多家厂商（Claude 五档、DeepSeek 三档，也有模型没有档位，同一个模型换用另一种协议时
 * 档位集合也会变化），且 Agent Team 的每个角色各使用一个模型（`team-run.ts` 的
 * `backend.model`），应用全局值必然错配。
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

  test('各模型分别取自己的档位', () => {
    expect(resolveModel(two, 'deepseek-v4-flash')?.effort).toBe('max')
    // xhigh 在 DeepSeek 上不存在，却是 Claude 的合法值：
    // 全局单一取值无法容纳这一差异。
    expect(resolveModel(two, 'claude-opus-5')?.effort).toBe('xhigh')
  })

  /** 同接口的另一个模型不随之改变：按接口存储会把模型 A 的选择应用到模型 B。 */
  test('同接口的另一个模型不受影响', () => {
    expect(resolveModel(two, 'deepseek-v4-pro')?.effort).toBeUndefined()
  })

  /** 未选择时为 undefined，不代为选择档位：「第一档」在两个模型上含义不同。 */
  test('未选择时为 undefined，不构造默认档位', () => {
    expect(resolveModel(cfg(), 'deepseek-v4-flash')?.effort).toBeUndefined()
  })
})

/**
 * 词表校验必须位于配置写入的校验环节。
 *
 * 不拦截时，任何客户端 PUT 一个词表外的值都会直接落盘，下一轮原样发给 provider，
 * 返回 400，而错误信息中只有 provider 的原文。
 */
describe('思考档位校验', () => {
  // 只检查档位：夹具没有 key，其他问题与本组无关。
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
   * 校验必须位于配置写入的校验环节，否则任何客户端 PUT 一个词表外的值都会直接落盘，
   * 下一轮原样发给 provider 并返回 400。
   */
  test('词表外的值属于致命问题（422 且不落盘）', () => {
    expect(effortProblems(withEffort('ultra'))).toHaveLength(1)
  })

  test('词表中的值放行', () => {
    expect(effortProblems(withEffort('max'))).toEqual([])
  })

  test('旧的关闭命令 none 不再是可选档位', () => {
    expect(effortProblems(withEffort('none'))).toHaveLength(1)
  })

  /** 未选择表示不发送思考字段，使用模型自身的默认值，不属于问题。 */
  test('未选择不属于问题', () => {
    expect(effortProblems(cfg())).toEqual([])
  })

  /** 报错必须指明是哪个接口下的哪个模型：多家模型并存时，不指明则无法定位。 */
  test('报错指明接口与模型', () => {
    expect(effortProblems(withEffort('ultra'))[0]).toContain('ds / deepseek-v4-flash')
  })
})

/**
 * 模型库枚举字段的校验。
 *
 * 与思考档位使用同一校验环节、同一理由，但后果更隐蔽：档位写错时下一轮返回
 * provider 的 400，而这三个字段写错时通常没有任何可见现象：`thinking` 写错会使
 * `effortIsTransmittable` 恒为 false（该模型的 effort 从此不再发送），
 * `cacheRouting` 写错会使缓存路由字段不再发送，两者都不报错。
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

  test('三个枚举各自的词表外值都属于致命问题', () => {
    expect(diagnoseConfig(withEntry({ thinking: 'anthropic_effort' }))).toHaveLength(1)
    expect(diagnoseConfig(withEntry({ reasoningEcho: '要' }))).toHaveLength(1)
    expect(diagnoseConfig(withEntry({ cacheRouting: '发' }))).toHaveLength(1)
    expect(diagnoseConfig(withEntry({ chatReasoningProtocol: 'unknown' }))).toHaveLength(1)
  })

  test('词表中的值放行', () => {
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
    expect(diagnoseConfig(withEntry({ chatReasoningProtocol: 'deepseek_preserved' }))).toEqual([])
    expect(diagnoseConfig(withEntry({ chatReasoningProtocol: 'preserved' }))).toEqual([])
    expect(diagnoseConfig(withEntry({ reasoningEcho: 'reasoning_text_object' }))).toEqual([])
    expect(diagnoseConfig(withEntry({ reasoningEcho: 'encrypted_content' }))).toEqual([])
  })

  /** 未填写表示沿用内置值，不属于问题。 */
  test('未填写的字段不属于问题', () => {
    expect(diagnoseConfig(withEntry({ contextWindow: 1024 }))).toEqual([])
  })

  /**
   * 键的第二维写错时，该覆盖永远不会匹配任何请求（`resolveModel` 按
   * `catalogKey(model, provider.kind)` 取值），是另一种静默失效。
   */
  test('键中的协议不在词表中同样属于问题', () => {
    const [p] = diagnoseConfig(withEntry({ contextWindow: 1024 }, 'deepseek-v4-flash|openai_v2'))
    expect(p).toContain('openai_v2')
  })

  /** 拦截时必须说明修改位置：该校验会使 `qy exec` 直接退出。 */
  test('报错包含修改位置', () => {
    const [p] = diagnoseConfig(withEntry({ thinking: 'anthropic_effort' }))
    expect(p).toContain('模型库')
    expect(p).toContain('config.json')
  })
})

/**
 * 模型库的覆盖值必须能被 `resolveModel` 取得。
 *
 * 若只有可编辑的界面而修改无法到达 `resolveModel`，该链路有生产者而无消费者：
 * 修改后的价格不会出现在任何请求或账本中。
 */
describe('模型库覆盖', () => {
  const withCatalog = () =>
    cfg({
      catalog: {
        [catalogKey('deepseek-v4-flash', 'openai_chat_completions')]: { input: 9, output: 19 },
      },
    })

  test('按「模型 id × 接口的协议」取值', () => {
    expect(resolveModel(withCatalog())?.spec).toEqual({ input: 9, output: 19 })
  })

  /** 模型未在该接口下声明时同样可以取得：参数是模型在该协议上的属性。 */
  test('接口下未声明该模型时同样可以取得', () => {
    const r = resolveModel(withCatalog(), 'deepseek-v4-flash')
    expect(r?.spec?.input).toBe(9)
  })

  test('模型库中没有该条目时不带 spec，不放入空对象', () => {
    expect(resolveModel(cfg())?.spec).toBeUndefined()
  })

  /**
   * 同一个模型 id 在两种协议下分别取各自的条目。
   *
   * 一维键会把一份参数应用到两条 seed 上，而目录中 deepseek 的同一 id 恰有两条：
   * 使用 chat/completions 时无法控制思考，使用 Responses 时 `effort:'none'` 可以关闭思考。
   */
  test('同一个模型 id 在两种协议下分别取各自的条目', () => {
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
 * 一次性迁移：模型库的旧结构 → `catalogKey(id, kind)` 两维键。
 *
 * 判据不是迁移函数的返回值，而是迁移前后 `buildAdapter` 解析出的
 * `ModelSpec` 逐字段相等：旧配置不得因形状改变而静默失效。
 * 迁移只在配置含三种旧键之一时执行；除本组测试外，
 * 没有其他验证覆盖这条路径。
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
   * 迁移前的四层解析，逐字重现：
   * 目录 seed → 模型库（一维键） → 探测得到的 capabilities → 与接口下固定的上限取较小值。
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

  /** 迁移后的两层解析：`resolveModel` 取得模型库中的条目，`buildAdapter` 将其叠加。 */
  function currentSpec(cfg: QyConfig, providerName: string, model: string): ModelSpec {
    const r = resolveModel(cfg, { provider: providerName, model })!
    return buildAdapter({
      kind: r.kind,
      apiKey: r.apiKey ?? 'sk-x',
      model: r.model,
      // 参数迁移验收使用测试端点，不依赖旧模型仍在官方目录中。
      baseUrl: 'https://relay.example/v1',
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

  test('无 catalog 段：空操作，也不新建 catalog', async () => {
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

  test('切换到正式 Flash 后旧探测记录不再成为自定义模型，且清理幂等', async () => {
    const raw: LegacyConfig = {
      active: { provider: 'ds', model: 'deepseek-flash' },
      providers: { ds: { kind: 'openai_chat_completions', models: { 'deepseek-flash': {} } } },
      catalog: {
        'deepseek-v4-flash|openai_chat_completions': {
          effortLevels: ['high', 'max'],
          thinksByDefault: true,
        },
        'deepseek-v4-flash-vision-exp|openai_chat_completions': {
          effortLevels: ['high', 'max'],
          thinksByDefault: true,
        },
      },
    }
    const once = await load(raw)
    expect(once.catalog).toEqual({})
    await writeFile(join(home, 'config.json'), JSON.stringify(once), 'utf8')
    expect(await loadConfig()).toEqual(once)
  })

  test('旧名称仍在使用、人工补录规格和真正的自定义模型不被清理', async () => {
    const catalog = {
      'deepseek-v4-flash|openai_chat_completions': { effortLevels: ['high'] },
      'deepseek-v4-flash-vision-exp|openai_chat_completions': { input: 3 },
      'my-model|openai_chat_completions': { effortLevels: ['max'] },
    } satisfies NonNullable<QyConfig['catalog']>
    const migrated = await load({
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: { ds: { kind: 'openai_chat_completions', models: { 'deepseek-v4-flash': {} } } },
      catalog,
    })
    expect(migrated.catalog).toEqual(catalog)
  })

  test('旧配置中的 none 迁移为未选择，不再向 provider 发送关闭命令', async () => {
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

  test('一维键 + 单 kind：改写为两维键，解析结果逐字段不变', async () => {
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

  /** 一维键的旧语义是一份参数应用到所有协议，因此每个 kind 各写一份。 */
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

  test('接口下的旧字段合并到同一个键，并在原处完全删除', async () => {
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
    // 旧字段就地删除，不保留第二条读取路径。
    expect(migrated.providers.gw?.models.中转站上的某个模型).toEqual({})
    expect(currentSpec(migrated, 'gw', '中转站上的某个模型')).toEqual(
      legacySpec(raw, 'gw', '中转站上的某个模型'),
    )
  })

  /**
   * 同协议的两个接口写入同一个键：不推测，保留接口名字典序靠前的一份。
   * 保留后一个会使结果随对象键的枚举顺序变化，重新保存一次即改变。
   */
  test('两接口冲突：保留字典序靠前的一份', async () => {
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

  /** 接口下的两个字段排在模型库之后，优先级不变。 */
  test('一维键与接口下的字段键名冲突时，以接口下的字段为准', async () => {
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

  /** 幂等判据是键的形状：执行一次后旧形状即不存在，再执行一次原样返回。 */
  test('执行两次结果相同', async () => {
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

  /** 一维键指向不属于任何接口的模型：无法判断协议，不推测，丢弃并指明。 */
  test('一维键指向不属于任何接口的模型时丢弃', async () => {
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

/**
 * 出厂默认：不预设任何模型。首次启动没有配置文件时，返回空接口表且没有 active，
 * 由界面引导用户配置，发送在启动 run 之前被拒绝，而不是回退到一个用户未配置过的模型。
 */
describe('出厂默认不预设模型', () => {
  let home: string
  const prevHome = process.env.QYWORK_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qy-default-'))
    process.env.QYWORK_HOME = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  test('没有配置文件时没有 active，接口表为空', async () => {
    const fresh = await loadConfig()
    expect(fresh.active).toBeUndefined()
    expect(fresh.providers).toEqual({})
    expect(fresh.mode).toBe('auto')
  })

  test('没有 active 不是致命问题：诊断不报 problem，也不阻断保存', async () => {
    const fresh = await loadConfig()
    // 空 active 是合法的中间态（删除最后一个模型后也会进入此状态）。报成 problem 会使
    // `/api/config` PUT 返回 422，用户将无法删除最后一个模型。
    expect(diagnoseConfig(fresh)).toEqual([])
  })

  test('没有 active 时 resolveModel 返回 undefined，不推测接口', async () => {
    const fresh = await loadConfig()
    expect(resolveModel(fresh)).toBeUndefined()
  })
})

describe('生成模型', () => {
  const withMedia = (over: Partial<QyConfig> = {}): QyConfig => {
    const base = cfg()
    return {
      ...base,
      providers: {
        ...base.providers,
        qwen: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-qwen',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          models: {},
          media: { 'qwen-image-3.0': { kind: 'dashscope_images' } },
        },
      },
      mediaDefaults: { image: { provider: 'qwen', model: 'qwen-image-3.0' } },
      ...over,
    }
  }

  test('未指定模型时取该类别的默认模型，并带上接口的凭证与地址', () => {
    const r = resolveMediaModel(withMedia(), 'image')
    expect(r).toMatchObject({
      provider: 'qwen',
      model: 'qwen-image-3.0',
      kind: 'dashscope_images',
      output: 'image',
      apiKey: 'sk-qwen',
    })
  })

  /** 已指定模型时不替换：生成按次计费，替换等于代替调用方修改选择。 */
  test('指定的模型不存在时解析失败，不回退到默认模型', () => {
    expect(resolveMediaModel(withMedia(), 'image', { provider: 'qwen', model: '没有' })).toBe(
      undefined,
    )
    expect(resolveMediaModel(withMedia({ mediaDefaults: {} }), 'image')).toBeUndefined()
  })

  /** 对话解析只读取 `models`：生成表中的 id 不会使其解析到该接口。 */
  test('对话模型不在生成清单中，对话解析也不读取生成表', () => {
    expect(listMediaModels(withMedia()).map((m) => m.model)).toEqual(['qwen-image-3.0'])
    expect(resolveModel(withMedia(), 'qwen-image-3.0')?.provider).toBe('ds')
  })

  test('协议不在词表中、默认模型指向不存在的模型均被拦截', () => {
    const bad = withMedia()
    bad.providers.qwen!.media = { x: { kind: 'dalle' as never } }
    const problems = diagnoseConfig(bad)
    expect(problems.some((p) => p.includes('生成协议 "dalle"'))).toBe(true)
    expect(problems.some((p) => p.includes('默认生成模型 "qwen / qwen-image-3.0"'))).toBe(true)
    expect(diagnoseConfig(withMedia())).toEqual([])
  })
})

describe('生成协议校正', () => {
  let home: string
  const prevHome = process.env.QYWORK_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qy-media-kind-'))
    process.env.QYWORK_HOME = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  const relay = (media: Record<string, { kind: MediaKind }>): QyConfig =>
    cfg({
      providers: {
        ...cfg().providers,
        relay: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-relay',
          baseUrl: 'https://relay.example/v1',
          models: {},
          media,
        },
      },
    })

  async function load(raw: QyConfig): Promise<QyConfig> {
    await writeFile(join(home, 'config.json'), JSON.stringify(raw), 'utf8')
    return loadConfig()
  }

  test('经中转站保存为 OpenAI 兼容协议的 Grok 视频改为 xAI 协议，且幂等', async () => {
    const loaded = await load(relay({ 'grok-imagine-video-1.5': { kind: 'openai_videos' } }))
    expect(
      resolveMediaModel(loaded, 'video', { provider: 'relay', model: 'grok-imagine-video-1.5' }),
    ).toMatchObject({ kind: 'xai_videos', baseUrl: 'https://relay.example/v1' })
    expect(await load(loaded)).toEqual(loaded)
  })

  test('已核实的兼容协议与未收录模型的协议不改写', async () => {
    const raw = relay({
      'veo-3.1-generate-preview': { kind: 'openai_videos' },
      'relay-video-x': { kind: 'openai_videos' },
    })
    expect((await load(raw)).providers.relay?.media).toEqual(raw.providers.relay?.media)
  })
})
