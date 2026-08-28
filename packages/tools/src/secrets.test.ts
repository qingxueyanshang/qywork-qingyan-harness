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
  test('值命中就剥，哪怕变量名毫无嫌疑', () => {
    // 这是最可靠的一条：用户把 key 复制进了一个叫 MY_STUFF 的变量，
    // 名字模式指望不上，只有按值才抓得到。
    const out = scrubEnv({ MY_STUFF: ANTHROPIC, NOTES: 'hello' }, secretsOf())
    expect(out.MY_STUFF).toBeUndefined()
    expect(out.NOTES).toBe('hello')
  })

  test('值里只是「包含」secret 也要剥', () => {
    // SDK 常把 key 拼进 URL 或 header 模板，整个变量都不能带过去。
    const out = scrubEnv({ CURL_ARGS: `-H "x-api-key: ${DEEPSEEK}"` }, secretsOf())
    expect(out.CURL_ARGS).toBeUndefined()
  })

  test('名字模式兜底：抓那些明文未知的凭证', () => {
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

  test('名字模式不能裸做子串匹配', () => {
    // KEY 命中 MONKEY_ISLAND、AUTH 命中 AUTHORS 的话，用户的命令会丢掉它要的变量，
    // 而且现场没有任何线索指向脱敏模块。
    const env = { MONKEY_ISLAND: '1', KEYBOARD_LAYOUT: 'us', AUTHORS: 'a,b', TOKENIZER: 'bpe' }
    expect(scrubEnv(env, { values: [] })).toEqual(env)
    expect(CREDENTIAL_NAME_PATTERN.test('MONKEY_ISLAND')).toBe(false)
    expect(CREDENTIAL_NAME_PATTERN.test('ANTHROPIC_API_KEY')).toBe(true)
  })

  test('CREDENTIAL_NAME_PATTERN 连续 test 多个名字结果稳定', () => {
    // 带 g 标志的正则会记住 lastIndex，第二次 test 同一个名字就会返回 false。
    // 这类漏判是随机的，必须钉死。
    for (let i = 0; i < 3; i++) {
      expect(CREDENTIAL_NAME_PATTERN.test('GITHUB_TOKEN')).toBe(true)
      expect(CREDENTIAL_NAME_PATTERN.test('DB_PASSWORD')).toBe(true)
    }
  })
})

describe('短 secret 的下限保护', () => {
  test('长度不足的 secret 不参与按值匹配，否则整份环境会被删光', () => {
    // 配置写错、apiKey 是占位符时 values 里可能就是 "1"。按值匹配是 includes()，
    // "1" 能命中半个环境——症状是所有命令都失败，且报错里没有指向脱敏的线索。
    const env = { PATH: '/usr/bin', PORT: '1234', LANG: 'en_US.UTF-8', NOTE: 'v1' }
    expect(scrubEnv(env, { values: ['1'] })).toEqual(env)
  })

  test('空串 secret 同样不参与 —— 它能命中任何字符串', () => {
    const env = { PATH: '/usr/bin', FOO: 'bar' }
    expect(scrubEnv(env, { values: [''] })).toEqual(env)
  })

  test('恰好达到阈值的 secret 要生效 —— 保护不能宽到把真 key 放过去', () => {
    const short = 'a'.repeat(MIN_SECRET_VALUE_LENGTH - 1)
    const atLimit = 'a'.repeat(MIN_SECRET_VALUE_LENGTH)
    expect(scrubEnv({ X: short }, { values: [short] })).toEqual({ X: short })
    expect(scrubEnv({ X: atLimit }, { values: [atLimit] })).toEqual({})
  })

  test('短 secret 仍然按名字剥 —— 下限只关掉按值那条判据', () => {
    const out = scrubEnv({ MY_KEY_HOLDER: '1', DB_PASSWORD: '1' }, { values: ['1'] })
    expect(out).toEqual({})
  })
})

describe('allow 白名单的边界', () => {
  test('放行名字模式命中的变量', () => {
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

  test('放行不了「值命中」—— 值就是用户的 key 时叫什么名字都不算数', () => {
    // 优先级取反的后果就是白名单变成了绕过通道：用户放行 GITHUB_TOKEN，
    // 而那个变量里躺着的是 DeepSeek 的 key。
    const out = scrubEnv({ GITHUB_TOKEN: DEEPSEEK }, secretsOf(), { allow: ['GITHUB_TOKEN'] })
    expect(out.GITHUB_TOKEN).toBeUndefined()
  })
})

describe('必需变量', () => {
  test('PATH 一类永远不会被误剥', () => {
    // 没有 PATH 连 ls 都找不到；PWD 更是正好撞上 password 的缩写模式。
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

  test('Windows 上的 Path 大小写变体也认', () => {
    expect(scrubEnv({ Path: 'C:\\bin' }, secretsOf()).Path).toBe('C:\\bin')
  })

  test('必需变量的值里混进了 secret 时，保留变量但屏蔽片段', () => {
    // 整个删掉 PATH 会让命令根本跑不起来；只换掉命中的那段，明文一样进不了子进程。
    const out = scrubEnv({ PATH: `/usr/bin:/opt/${ANTHROPIC}/bin` }, secretsOf())
    expect(out.PATH).toBe(`/usr/bin:/opt/${REDACTED}/bin`)
    expect(out.PATH).not.toContain(ANTHROPIC)
  })
})

describe('scrubEnv 的健壮性', () => {
  test('不改入参，返回新对象', () => {
    // 调用方大概率传的是 process.env 的浅拷贝甚至 process.env 本身，
    // 就地删除会把当前进程自己的 key 一起删掉。
    const env = { ANTHROPIC_API_KEY: ANTHROPIC, HOME: '/h' }
    const out = scrubEnv(env, secretsOf())
    expect(env.ANTHROPIC_API_KEY).toBe(ANTHROPIC)
    expect(out).not.toBe(env)
  })

  test('undefined 的值被丢掉而不是变成 "undefined" 字符串', () => {
    // Record<string, string | undefined> 里的 undefined 就是「没设置」，
    // 透传过去会让子进程看到字面量 "undefined"。
    const out = scrubEnv({ FOO: undefined, BAR: 'ok' }, secretsOf())
    expect('FOO' in out).toBe(false)
    expect(out.BAR).toBe('ok')
  })

  test('空 secrets 不抛，也不误剥', () => {
    const env = { FOO: 'bar', PATH: '/bin' }
    expect(scrubEnv(env, { values: [] })).toEqual(env)
  })

  test('空字符串值原样保留', () => {
    expect(scrubEnv({ FOO: '' }, secretsOf())).toEqual({ FOO: '' })
  })
})

describe('redactSecrets', () => {
  test('替换掉全部出现位置', () => {
    const text = `key=${ANTHROPIC} again ${ANTHROPIC}`
    const out = redactSecrets(text, secretsOf())
    expect(out).toBe(`key=${REDACTED} again ${REDACTED}`)
    expect(out).not.toContain(ANTHROPIC)
  })

  test('一个 secret 是另一个的前缀时，长的必须先被替换', () => {
    // 短的先替换会把长 secret 切成 "[REDACTED]-and-more"，尾巴照样泄露。
    const short = 'sk-live-abcdef12'
    const long = `${short}-and-more`
    const out = redactSecrets(`token=${long} done`, { values: [short, long] })
    expect(out).toBe(`token=${REDACTED} done`)
    expect(out).not.toContain('and-more')
  })

  test('secret 里的正则特殊字符按字面量处理', () => {
    // 明文里出现 . * + $ ( ) 很正常。当成正则会既漏网又误伤别的文本。
    const weird = 'a.b*c+d$e^f(g)'
    const out = redactSecrets(`raw ${weird} and aXb*c+d$e^f(g)`, { values: [weird] })
    expect(out).toBe(`raw ${REDACTED} and aXb*c+d$e^f(g)`)
    // 未转义的正则里 "." 会连 aXb... 一起匹配掉，这条断言就是用来钉死这一点的。
    expect(out).toContain('aXb*c+d$e^f(g)')
  })

  test('短 secret 不参与替换，否则输出会被打成筛子', () => {
    const text = 'exit code 1, 1 file changed'
    expect(redactSecrets(text, { values: ['1'] })).toBe(text)
  })

  test('空文本 / 空 secrets / 无命中都不抛', () => {
    expect(redactSecrets('', secretsOf())).toBe('')
    expect(redactSecrets('hello', { values: [] })).toBe('hello')
    expect(redactSecrets('hello', { values: [''] })).toBe('hello')
    expect(redactSecrets('hello', secretsOf())).toBe('hello')
  })

  test('1MB 输出上不退化 —— 命令输出经常是这个量级', () => {
    // 在循环里对每个 secret 重建全局正则会让长输出变成秒级卡顿，而这条路径
    // 在每次 run_command 返回时都要走一遍。断言的是「跑完了且结果正确」，
    // 时间上限交给下面的 test timeout，不去钉具体毫秒数。
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
    // 其余内容一字未动。
    expect(out.split('\n')[0]).toBe(line)
    expect(out.split('\n')).toHaveLength(1024)
  }, 5000)
})

/**
 * 流式脱敏。
 *
 * 这一组测的是**跨片**那个坑：一个 key 落在两片之间时，逐片脱敏两边都不命中，
 * 拼起来就是完整明文。而它只在输出恰好断在那个位置时才发生——
 * 本地几乎复现不出来，所以只能靠断言钉死。
 */
describe('流式脱敏', () => {
  const KEY = 'sk-test-stream-redaction-fixture-0123456789'
  const secrets = { values: [KEY] }

  /** 把一段文本按给定切点切开喂进去，返回拼接后的结果。 */
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

  test('key 跨片时照样挡住 —— 逐片脱敏会漏的正是这种', () => {
    const text = `前面 ${KEY} 后面`
    // 在 key 正中间切一刀
    const cut = text.indexOf(KEY) + 10
    expect(stream(text, [cut])).not.toContain(KEY)
    expect(stream(text, [cut])).toContain(REDACTED)
  })

  test('逐字符喂进去也不漏 —— 最极端的分片', () => {
    const text = `a${KEY}b`
    const cuts = Array.from({ length: text.length }, (_, i) => i)
    const got = stream(text, cuts)
    expect(got).not.toContain(KEY)
    expect(got).toBe(`a${REDACTED}b`)
  })

  test('不含 secret 的内容一字不改，顺序也不变', () => {
    const text = '第一行\n第二行\n第三行'
    expect(stream(text, [3, 7, 11])).toBe(text)
  })

  /** 忘了 flush 会静默丢掉末尾。这条钉的是「flush 确实把尾段交了出来」。 */
  test('flush 之后一个字节都不少', () => {
    const text = '短'
    const r = createStreamRedactor(secrets)
    const pushed = r.push(text)
    expect(pushed + r.flush()).toBe(text)
  })

  /**
   * **没有已知 secret 也不能直通。**
   *
   * 「没有已知明文就直通」只在**只按明文匹配**时成立。有形状脱敏之后前提没了——
   * `cat ~/.ssh/id_rsa` 的私钥、`.env` 里的 token，它们的明文本地从来不知道，
   * 而这条链路是唯一能抓到它们的地方。直通等于把这一层关掉。
   *
   * 代价是普通输出会晚一点交出，所以这里同时钉住「一个字节都不少」。
   */
  test('没有已知 secret 也不直通，但内容一个字节不少', () => {
    const r = createStreamRedactor({ values: [] })
    const text = '立刻出来'
    expect(r.push(text) + r.flush()).toBe(text)
  })

  test('没有已知 secret 时照样剥掉私钥', () => {
    const r = createStreamRedactor({ values: [] })
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nAAAABBBB\n-----END RSA PRIVATE KEY-----'
    expect(r.push(pem) + r.flush()).toBe(REDACTED)
  })

  /**
   * 写完的行现在就交出去。
   *
   * 原始失败形状：`hold` 是 256 字节，而一条命令一秒输出一行七个字节——跑完之前
   * 一个字都交不出去，界面上就是一张空卡片跑满全程（实测一条 12 行 87 字节的命令，
   * 全部输出攒成一条 `tool.delta` 在结束时才到）。判据是**一个 secret 不跨行**，
   * 所以最后一个换行之前的部分现在就安全。
   */
  test('已经写完的行不必等够 256 字节', () => {
    const r = createStreamRedactor({ values: [] })
    expect(r.push('line 1\n')).toBe('line 1\n')
    expect(r.push('line 2\n')).toBe('line 2\n')
    // 还没写完的那半行照旧扣着——它可能是某个 token 的开头。
    expect(r.push('line 3 还没写完')).toBe('')
    expect(r.flush()).toBe('line 3 还没写完')
  })

  /** 行末即安全的前提是 secret 不跨行；明文自己带换行时退回按字节扣。 */
  test('已知明文跨行时不用行边界这条捷径', () => {
    const multi = 'sk-line-one\nline-two-secret'
    const r = createStreamRedactor({ values: [multi] })
    let out = ''
    const text = `头${multi}尾`
    for (let i = 0; i < text.length; i += 5) out += r.push(text.slice(i, i + 5))
    out += r.flush()
    expect(out).toBe(`头${REDACTED}尾`)
  })

  test('多个 secret 时按最长的那个留尾巴', () => {
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
 * 与按明文匹配是两件互补的事：按明文只认得 `collectSecrets` 收到的那几个值
 * （配置里的那几把 apiKey），所以 `cat ~/.ssh/id_rsa`、
 * `cat .env` 的输出一个字都不会被脱敏——那些明文本地未知，结构上就抓不到。
 *
 * 形状不需要事先知道值，这正是它存在的理由。
 */
describe('按形状脱敏', () => {
  const bare: SecretSet = { values: [] }

  test('私钥整块剥掉，不是只打包头', () => {
    const body = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF'
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const out = redactSecrets(`前${pem}后`, bare)
    // 正文一个字符都不许留：私钥本身没有固定特征，留着等于没屏蔽。
    expect(out).not.toContain(body)
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(out).toBe(`前${REDACTED}后`)
  })

  test('各家 token 的形状', () => {
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
   * **不做通用高熵检测**，这条钉的就是那个边界。
   *
   * 把 commit sha、UUID、base64 资源全打成 [REDACTED] 会让输出没法读，
   * 而模型看不懂输出就会反复重试——比漏掉一个不认识的 token 更糟。
   */
  test('长得像随机串但不是凭证的原样保留', () => {
    for (const s of [
      '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c', // commit sha
      '550e8400-e29b-41d4-a716-446655440000', // uuid
      'aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=', // base64
    ]) {
      expect(redactSecrets(s, bare)).toBe(s)
    }
  })

  /** 说明文字里提到前缀不该被打码——只匹配前缀会让文档读起来像坏了。 */
  test('只有前缀没有足够长的尾巴时不动它', () => {
    expect(redactSecrets('把 key 放进 sk- 开头的变量里', bare)).toContain('sk-')
    expect(redactSecrets('前缀是 ghp_ 那种', bare)).toContain('ghp_')
  })

  /** 私钥必然跨片，滑窗按「最长明文 -1」算兜不住它。 */
  test('私钥跨片到达也能整块剥掉', () => {
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
