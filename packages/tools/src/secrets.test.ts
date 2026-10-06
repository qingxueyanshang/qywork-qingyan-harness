import { describe, expect, test } from 'bun:test'
import {
  CREDENTIAL_NAME_PATTERN,
  createStreamRedactor,
  MIN_SECRET_VALUE_LENGTH,
  REDACTED,
  redactSecrets,
  type SecretSet,
  scrubEnv,
} from './secrets.ts'

const ANTHROPIC = 'sk-ant-api03-0123456789abcdef'
const DEEPSEEK = 'sk-deepseek-fedcba9876543210'

function secretsOf(over: Partial<SecretSet> = {}): SecretSet {
  return { values: [ANTHROPIC, DEEPSEEK], ...over }
}

describe('scrubEnv 的两条判据', () => {
  test('值命中时剥离，即使变量名不含凭证特征', () => {
    // 这是最可靠的判据：用户把 key 复制到名为 MY_STUFF 的变量中，
    // 名称模式无法识别，只有按值匹配才能检出。
    const out = scrubEnv({ MY_STUFF: ANTHROPIC, NOTES: 'hello' }, secretsOf())
    expect(out.MY_STUFF).toBeUndefined()
    expect(out.NOTES).toBe('hello')
  })

  test('值中仅包含 secret 时同样剥离', () => {
    // SDK 常把 key 拼接到 URL 或 header 模板中，整个变量都不能传给子进程。
    const out = scrubEnv({ CURL_ARGS: `-H "x-api-key: ${DEEPSEEK}"` }, secretsOf())
    expect(out.CURL_ARGS).toBeUndefined()
  })

  test('名称模式作为后备判据：识别明文未知的凭证', () => {
    const env = {
      GITHUB_TOKEN: 'ghp_x',
      AWS_SECRET_ACCESS_KEY: 'a',
      DB_PASSWORD: 'b',
      MY_APIKEY: 'c',
      SOME_CREDENTIAL: 'd',
      OPENAI_API_KEY: 'e',
    }
    expect(Object.keys(scrubEnv(env, { values: [] }))).toEqual([])
  })

  test('名称模式不能直接按子串匹配', () => {
    // KEY 命中 MONKEY_ISLAND、AUTH 命中 AUTHORS 时，用户的命令会缺少所需的变量，
    // 且没有任何线索指向脱敏模块。
    const env = { MONKEY_ISLAND: '1', KEYBOARD_LAYOUT: 'us', AUTHORS: 'a,b', TOKENIZER: 'bpe' }
    expect(scrubEnv(env, { values: [] })).toEqual(env)
    expect(CREDENTIAL_NAME_PATTERN.test('MONKEY_ISLAND')).toBe(false)
    expect(CREDENTIAL_NAME_PATTERN.test('ANTHROPIC_API_KEY')).toBe(true)
  })

  test('CREDENTIAL_NAME_PATTERN 连续 test 多个名字结果稳定', () => {
    // 带 g 标志的正则会保留 lastIndex，第二次 test 同一名称时返回 false。
    // 这类漏判具有随机性，必须由测试锁定。
    for (let i = 0; i < 3; i++) {
      expect(CREDENTIAL_NAME_PATTERN.test('GITHUB_TOKEN')).toBe(true)
      expect(CREDENTIAL_NAME_PATTERN.test('DB_PASSWORD')).toBe(true)
    }
  })
})

describe('短 secret 的下限保护', () => {
  test('长度不足的 secret 不参与按值匹配，否则全部环境变量都会被删除', () => {
    // 配置错误、apiKey 为占位符时 values 中可能是 "1"。按值匹配使用 includes()，
    // "1" 能命中大量环境变量，导致所有命令失败，且报错中没有指向脱敏的线索。
    const env = { PATH: '/usr/bin', PORT: '1234', LANG: 'en_US.UTF-8', NOTE: 'v1' }
    expect(scrubEnv(env, { values: ['1'] })).toEqual(env)
  })

  test('空串 secret 同样不参与：它能命中任何字符串', () => {
    const env = { PATH: '/usr/bin', FOO: 'bar' }
    expect(scrubEnv(env, { values: [''] })).toEqual(env)
  })

  test('恰好达到阈值的 secret 必须生效：下限保护不能放过真实 key', () => {
    const short = 'a'.repeat(MIN_SECRET_VALUE_LENGTH - 1)
    const atLimit = 'a'.repeat(MIN_SECRET_VALUE_LENGTH)
    expect(scrubEnv({ X: short }, { values: [short] })).toEqual({ X: short })
    expect(scrubEnv({ X: atLimit }, { values: [atLimit] })).toEqual({})
  })

  test('短 secret 仍按名称剥离：下限只关闭按值匹配的判据', () => {
    const out = scrubEnv({ MY_KEY_HOLDER: '1', DB_PASSWORD: '1' }, { values: ['1'] })
    expect(out).toEqual({})
  })
})

describe('allow 白名单的边界', () => {
  test('放行名称模式命中的变量', () => {
    const out = scrubEnv({ GITHUB_TOKEN: 'ghp_abc', NPM_TOKEN: 'npm_abc' }, secretsOf(), {
      allow: ['GITHUB_TOKEN'],
    })
    expect(out.GITHUB_TOKEN).toBe('ghp_abc')
    expect(out.NPM_TOKEN).toBeUndefined()
  })

  test('大小写不敏感', () => {
    const out = scrubEnv({ GITHUB_TOKEN: 'ghp_abc' }, secretsOf(), { allow: ['github_token'] })
    expect(out.GITHUB_TOKEN).toBe('ghp_abc')
  })

  test('白名单不能放行值命中的变量：值为用户的 key 时，变量名不影响判定', () => {
    // 优先级颠倒时白名单会成为绕过途径：用户放行 GITHUB_TOKEN，
    // 而该变量中存放的是 DeepSeek 的 key。
    const out = scrubEnv({ GITHUB_TOKEN: DEEPSEEK }, secretsOf(), { allow: ['GITHUB_TOKEN'] })
    expect(out.GITHUB_TOKEN).toBeUndefined()
  })
})

describe('必需变量', () => {
  test('PATH 等必需变量不会被误剥离', () => {
    // 没有 PATH 连 ls 都无法定位；PWD 恰好命中 password 的缩写模式。
    const env = {
      PATH: '/usr/bin:/bin',
      PWD: '/work',
      HOME: '/home/u',
      SYSTEMROOT: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
      LANG: 'C.UTF-8',
    }
    expect(scrubEnv(env, secretsOf())).toEqual(env)
  })

  test('识别 Windows 上 Path 的大小写变体', () => {
    expect(scrubEnv({ Path: 'C:\\bin' }, secretsOf()).Path).toBe('C:\\bin')
  })

  test('必需变量的值里混进了 secret 时，保留变量但屏蔽片段', () => {
    // 删除整个 PATH 会使命令无法执行；仅替换命中的片段，明文同样不会进入子进程。
    const out = scrubEnv({ PATH: `/usr/bin:/opt/${ANTHROPIC}/bin` }, secretsOf())
    expect(out.PATH).toBe(`/usr/bin:/opt/${REDACTED}/bin`)
    expect(out.PATH).not.toContain(ANTHROPIC)
  })
})

describe('scrubEnv 的健壮性', () => {
  test('不改入参，返回新对象', () => {
    // 调用方传入的通常是 process.env 的浅拷贝，甚至是 process.env 本身，
    // 就地删除会同时删除当前进程自身的 key。
    const env = { ANTHROPIC_API_KEY: ANTHROPIC, HOME: '/h' }
    const out = scrubEnv(env, secretsOf())
    expect(env.ANTHROPIC_API_KEY).toBe(ANTHROPIC)
    expect(out).not.toBe(env)
  })

  test('值为 undefined 的变量被丢弃，而不是转为 "undefined" 字符串', () => {
    // Record<string, string | undefined> 中的 undefined 表示未设置，
    // 原样传递会使子进程读到字面量 "undefined"。
    const out = scrubEnv({ FOO: undefined, BAR: 'ok' }, secretsOf())
    expect('FOO' in out).toBe(false)
    expect(out.BAR).toBe('ok')
  })

  test('空 secrets 不抛出异常，也不误剥离', () => {
    const env = { FOO: 'bar', PATH: '/bin' }
    expect(scrubEnv(env, { values: [] })).toEqual(env)
  })

  test('空字符串值原样保留', () => {
    expect(scrubEnv({ FOO: '' }, secretsOf())).toEqual({ FOO: '' })
  })
})

describe('redactSecrets', () => {
  test('替换全部出现位置', () => {
    const text = `key=${ANTHROPIC} again ${ANTHROPIC}`
    const out = redactSecrets(text, secretsOf())
    expect(out).toBe(`key=${REDACTED} again ${REDACTED}`)
    expect(out).not.toContain(ANTHROPIC)
  })

  test('一个 secret 是另一个的前缀时，长的必须先被替换', () => {
    // 先替换短的会把长 secret 变为 "[REDACTED]-and-more"，末尾部分仍会泄露。
    const short = 'sk-live-abcdef12'
    const long = `${short}-and-more`
    const out = redactSecrets(`token=${long} done`, { values: [short, long] })
    expect(out).toBe(`token=${REDACTED} done`)
    expect(out).not.toContain('and-more')
  })

  test('secret 里的正则特殊字符按字面量处理', () => {
    // 明文中出现 . * + $ ( ) 很常见。按正则处理会既遗漏明文又误改其他文本。
    const weird = 'a.b*c+d$e^f(g)'
    const out = redactSecrets(`raw ${weird} and aXb*c+d$e^f(g)`, { values: [weird] })
    expect(out).toBe(`raw ${REDACTED} and aXb*c+d$e^f(g)`)
    // 未转义的正则中 "." 会同时匹配 aXb...，此断言锁定这一点。
    expect(out).toContain('aXb*c+d$e^f(g)')
  })

  test('短 secret 不参与替换，否则输出中大量字符会被替换', () => {
    const text = 'exit code 1, 1 file changed'
    expect(redactSecrets(text, { values: ['1'] })).toBe(text)
  })

  test('空文本 / 空 secrets / 无命中时均不抛出异常', () => {
    expect(redactSecrets('', secretsOf())).toBe('')
    expect(redactSecrets('hello', { values: [] })).toBe('hello')
    expect(redactSecrets('hello', { values: [''] })).toBe('hello')
    expect(redactSecrets('hello', secretsOf())).toBe('hello')
  })

  test('1MB 输出时性能不退化：命令输出常达到该量级', () => {
    // 在循环中为每个 secret 重建全局正则会使长输出的处理耗时达到秒级，而该路径
    // 在每次 run_command 返回时都会执行。断言内容是执行完毕且结果正确，
    // 时间上限由下方的 test timeout 控制，不断言具体毫秒数。
    const line = 'x'.repeat(1024)
    const lines: string[] = []
    for (let i = 0; i < 1024; i++) lines.push(line)
    lines[500] = `leak: ${ANTHROPIC}`
    lines[900] = `also: ${DEEPSEEK}`
    const text = lines.join('\n')
    expect(text.length).toBeGreaterThan(1_000_000)

    const out = redactSecrets(text, secretsOf())
    expect(out).not.toContain(ANTHROPIC)
    expect(out).not.toContain(DEEPSEEK)
    expect(out).toContain(`leak: ${REDACTED}`)
    expect(out).toContain(`also: ${REDACTED}`)
    // 其余内容保持不变。
    expect(out.split('\n')[0]).toBe(line)
    expect(out.split('\n')).toHaveLength(1024)
  }, 5000)
})

/**
 * 流式脱敏。
 *
 * 本组测试跨片问题：一个 key 位于两片之间时，逐片脱敏在两片中都不命中，
 * 拼接后即为完整明文。该问题只在输出恰好在该位置分片时发生，
 * 本地几乎无法复现，因此只能由断言锁定。
 */
describe('流式脱敏', () => {
  const KEY = 'sk-test-stream-redaction-fixture-0123456789'
  const secrets = { values: [KEY] }

  /** 按给定切点把文本分片输入，返回拼接后的结果。 */
  function stream(text: string, cuts: number[]): string {
    const r = createStreamRedactor(secrets)
    let out = ''
    let prev = 0
    for (const c of [...cuts, text.length]) {
      out += r.push(text.slice(prev, c))
      prev = c
    }
    return out + r.flush()
  }

  test('key 跨片时同样被屏蔽：逐片脱敏遗漏的正是这种情况', () => {
    const text = `前面 ${KEY} 后面`
    // 在 key 中间分片
    const cut = text.indexOf(KEY) + 10
    expect(stream(text, [cut])).not.toContain(KEY)
    expect(stream(text, [cut])).toContain(REDACTED)
  })

  test('逐字符输入时也不遗漏：最细粒度的分片', () => {
    const text = `a${KEY}b`
    const cuts = Array.from({ length: text.length }, (_, i) => i)
    const got = stream(text, cuts)
    expect(got).not.toContain(KEY)
    expect(got).toBe(`a${REDACTED}b`)
  })

  test('不含 secret 的内容与顺序均保持不变', () => {
    const text = '第一行\n第二行\n第三行'
    expect(stream(text, [3, 7, 11])).toBe(text)
  })

  /** 遗漏 flush 会静默丢失末尾。此测试锁定 flush 确实输出末尾内容。 */
  test('flush 之后内容完整', () => {
    const text = '短'
    const r = createStreamRedactor(secrets)
    const pushed = r.push(text)
    expect(pushed + r.flush()).toBe(text)
  })

  /**
   * 没有已知 secret 时也不能直接透传。
   *
   * 没有已知明文时直接透传，只在仅按明文匹配时成立。引入按形状脱敏后该前提不再成立：
   * `cat ~/.ssh/id_rsa` 输出的私钥、`.env` 中的 token，其明文本地从未知晓，
   * 而这条链路是唯一能检出它们的位置。直接透传等于关闭这一层。
   *
   * 代价是普通输出的交付稍有延迟，因此此处同时锁定输出内容完整。
   */
  test('没有已知 secret 时也不直接透传，且内容完整', () => {
    const r = createStreamRedactor({ values: [] })
    const text = '立刻出来'
    expect(r.push(text) + r.flush()).toBe(text)
  })

  test('没有已知 secret 时同样剥离私钥', () => {
    const r = createStreamRedactor({ values: [] })
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nAAAABBBB\n-----END RSA PRIVATE KEY-----'
    expect(r.push(pem) + r.flush()).toBe(REDACTED)
  })

  /**
   * 已完整的行立即输出。
   *
   * 原始失败形式：`hold` 是 256 字节，而一条命令每秒输出一行七个字节，执行完毕之前
   * 没有任何输出，界面上的卡片持续为空直到结束（实测一条 12 行 87 字节的命令，
   * 全部输出合并为一条 `tool.delta`，在结束时才到达）。判据是 secret 不跨行，
   * 因此最后一个换行符之前的部分可以立即输出。
   */
  test('已完整的行无需等待累计 256 字节', () => {
    const r = createStreamRedactor({ values: [] })
    expect(r.push('line 1\n')).toBe('line 1\n')
    expect(r.push('line 2\n')).toBe('line 2\n')
    // 未完整的行仍被保留：它可能是某个 token 的开头。
    expect(r.push('line 3 还没写完')).toBe('')
    expect(r.flush()).toBe('line 3 还没写完')
  })

  /** 行末即可输出的前提是 secret 不跨行；明文本身含换行时回退为按字节保留。 */
  test('已知明文跨行时不按行边界提前输出', () => {
    const multi = 'sk-line-one\nline-two-secret'
    const r = createStreamRedactor({ values: [multi] })
    let out = ''
    const text = `头${multi}尾`
    for (let i = 0; i < text.length; i += 5) out += r.push(text.slice(i, i + 5))
    out += r.flush()
    expect(out).toBe(`头${REDACTED}尾`)
  })

  test('多个 secret 时按最长者保留末尾缓冲', () => {
    const long = 'sk-verylongsecretvalue0123456789'
    const short = 'sk-shortish1'
    const r = createStreamRedactor({ values: [short, long] })
    const text = `x${long}y${short}z`
    let out = ''
    for (let i = 0; i < text.length; i += 3) out += r.push(text.slice(i, i + 3))
    out += r.flush()
    expect(out).toBe(`x${REDACTED}y${REDACTED}z`)
  })
})

/**
 * 按形状脱敏。
 *
 * 与按明文匹配互补：按明文匹配只识别 `collectSecrets` 收到的值
 * （配置中的 apiKey），因此 `cat ~/.ssh/id_rsa`、
 * `cat .env` 的输出完全不会被脱敏：这些明文本地未知，结构上无法检出。
 *
 * 按形状匹配无需事先知道值，这是它的用途。
 */
describe('按形状脱敏', () => {
  const bare: SecretSet = { values: [] }

  test('私钥整块剥离，而不是只屏蔽头部', () => {
    const body = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF'
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const out = redactSecrets(`前${pem}后`, bare)
    // 正文不得保留任何字符：私钥本身没有固定特征，保留即等于未屏蔽。
    expect(out).not.toContain(body)
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(out).toBe(`前${REDACTED}后`)
  })

  test('各服务商 token 的形状', () => {
    for (const t of [
      'sk-abcdefghijklmnopqrstuvwxyz0123',
      'sk-ant-api03-abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz12',
      'github_pat_abcdefghijklmnopqrstuv',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-123456789012-abcdefghijkl',
      'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz012345',
    ]) {
      expect(redactSecrets(`token=${t}`, bare)).toBe(`token=${REDACTED}`)
    }
  })

  /**
   * 不做通用高熵检测，此测试锁定该边界。
   *
   * 把 commit sha、UUID、base64 资源全部替换为 [REDACTED] 会使输出无法阅读，
   * 模型无法理解输出时会反复重试，比遗漏一个无法识别的 token 更糟。
   */
  test('形似随机串但不是凭证的内容原样保留', () => {
    for (const s of [
      '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c', // commit sha
      '550e8400-e29b-41d4-a716-446655440000', // uuid
      'aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=', // base64
    ]) {
      expect(redactSecrets(s, bare)).toBe(s)
    }
  })

  /** 说明文字中提及的前缀不应被屏蔽：只匹配前缀会使文档内容残缺。 */
  test('只有前缀而后续长度不足时保持原样', () => {
    expect(redactSecrets('把 key 放进 sk- 开头的变量里', bare)).toContain('sk-')
    expect(redactSecrets('前缀是 ghp_ 那种', bare)).toContain('ghp_')
  })

  /** 私钥必然跨片，按「最长明文 -1」计算的滑动窗口无法覆盖它。 */
  test('私钥跨片到达时也能整块剥离', () => {
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAE\n-----END OPENSSH PRIVATE KEY-----'
    const r = createStreamRedactor(bare)
    let out = ''
    for (let i = 0; i < pem.length; i += 7) out += r.push(pem.slice(i, i + 7))
    out += r.flush()
    expect(out).toBe(REDACTED)
    expect(out).not.toContain('b3BlbnNz')
  })
})
