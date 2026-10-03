/**
 * 书面语检查：把 CLAUDE.md B11 与 B10 中可按词判定的条目落成词表，扫描注释与字符串字面量。
 *
 * 覆盖可按词判定的类别：口语与语气词、第一人称自述与变更史、拟人与比喻、场景铺陈、外部出处。
 * 「复述代码」「过期断言」需结合上下文判断，仍由人工审查。
 *
 * 注释：全部源文件。字符串字面量：非测试源文件中含汉字的字面量，包括界面文案、模型提示与工具说明、
 * 错误与日志信息。测试文件不扫字符串：其中的用户消息样例按用户原话书写。
 *
 * 不设豁免名单。豁免名单构成第二份规则：命中即改写；无法改写说明该句不应出现在此处。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/**
 * 扫描根，相对仓库根。目录不存在时跳过，不报错。
 *
 * 取的是包根而不是 `src`：配置文件（`vite.config.ts`、`build.rs`）里的注释同样算注释，
 * 按 `src` 划范围会把它们漏在外面。
 */
const ROOTS = ['packages', 'apps/web', 'apps/desktop/src-tauri', 'apps/desktop/native', 'scripts']

/** 按正文扫描的规则与记忆文件，相对仓库根。 */
const DOC_FILES = ['CLAUDE.md']
const DOC_DIRS = ['.claude/memory']

const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'gen', '.git', '__pycache__'])
/** `.ps1` / `.toml` / `.py` 走 `#` 行注释（`.py` 另加文档字符串），其余走 C 系。 */
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.rs', '.css', '.ps1', '.toml', '.py'])
const HASH_EXTS = new Set(['.ps1', '.toml', '.py'])
/** 不扫字符串的文件：`scripts/`（开发脚本，含模拟的用户消息）、测试与测试辅助、类型声明。注释照扫。 */
const NO_STRING_SCAN =
  /^scripts[\\/]|\.test\.(ts|tsx|mjs|js)$|test-helper\.ts$|[\\/]tests?[\\/]|(^|[\\/])test_\w+\.py$|\.d\.ts$/
/** 测试文件（TS / JS）。其中只检查测试名。 */
const TEST_FILE = /\.test\.(ts|tsx|mjs|js)$/
/** 汉字与中文标点。只检查含汉字的字面量。 */
const CJK = /[\u4e00-\u9fff]/
const CJK_PUNCT = /[，。；：！？、「」（）]/

/**
 * Python 的文档字符串：三引号块逐行取出。模块、函数与类的说明写在这里，
 * 只扫 `#` 行会把它们漏在外面。
 */
export function pythonDocstrings(src: string): Comment[] {
  const out: Comment[] = []
  for (const m of src.matchAll(/("""|''')([\s\S]*?)\1/g)) {
    const start = src.slice(0, m.index).split('\n').length
    for (const [k, text] of (m[2] ?? '').split('\n').entries()) out.push({ line: start + k, text })
  }
  return out
}

export interface Violation {
  file: string
  line: number
  /** 命中在注释、字符串字面量还是规则与记忆文档的正文里。 */
  kind: '注释' | '字符串' | '文档'
  word: string
  /** 该写成什么。失败信息里直接给出改写方向，不让读的人再回去查规则。 */
  hint: string
  text: string
}

interface Rule {
  re: RegExp
  hint: string
}

/**
 * 词表。每条的 `hint` 是改写方向，不是解释。
 *
 * 正则一律不带 `g`：带 `g` 的正则有 `lastIndex` 状态，跨行复用会漏报。
 */
const RULES: Rule[] = [
  // 口语与语气词
  { re: /其实(?!际|现|施|质)|说白了|换句话说|也就是说|简单来说|总之/, hint: '删掉，直接说结论' },
  { re: /反正|干脆|索性|老老实实/, hint: '删掉语气词' },
  { re: /压根|明明|偏偏|死活|根本[不没就无]/, hint: '删掉强调，只留事实' },
  // 该词组也用于表达方位（滚动至末端、单行不换行），那时不算命中：只在它后面
  // 跟着动词时才判为语气词。
  { re: /到底(?![的下点部层了就。，、；：）])|究竟/, hint: '删掉；要指认对象就写出对象名' },
  { re: /一路(?!径)/, hint: '写传播范围：逐层向上 / 贯穿整条链路' },
  { re: /顺手|随手/, hint: '写动作本身' },
  { re: /白白|硬生生|活生生|眼睁睁/, hint: '删掉' },
  { re: /莫名其妙|神奇|离谱|坑爹/, hint: '写具体现象' },
  { re: /东西/, hint: '写具体名词：状态 / 对象 / 条目 / 内容' },
  { re: /一堆|一大堆/, hint: '写数量或类别' },
  { re: /顺带|捎带/, hint: '写「一并」' },
  { re: /多半/, hint: '写「通常」「很可能」' },
  { re: /干活/, hint: '写「执行」「处理」' },
  // 「挂了监听」「挂了三个模型」是挂载，不是故障：只认后面直接收句的那一种。
  { re: /挂掉|挂了(?=[，。！？」）])/, hint: '写「已退出」「不可用」' },
  { re: /搞|弄/, hint: '写具体动词' },
  { re: /跑飞/, hint: '写「不受控继续执行」' },
  { re: /省事|偷懒|将就|凑合|硬着头皮/, hint: '写取舍本身' },
  { re: /半天|干等|死等/, hint: '写时长，或「阻塞等待」' },
  { re: /好好的|老是/, hint: '写状态本身' },
  { re: /要命(?!中)|完蛋|没救/, hint: '写后果' },
  { re: /瞎|笨|蠢|(?<!麻)烦/, hint: '删掉' },
  { re: /碰运气|撞大运|胡诌|胡乱/, hint: '写机制' },
  { re: /于是/, hint: '写「因此」，或拆成两句陈述' },
  { re: /跑/, hint: '写「运行」「执行」' },
  { re: /抓(?!取)/, hint: '写「获取」' },
  { re: /猜/, hint: '写「推测」' },
  { re: /(?<![一统])一下(?!子)|看看/, hint: '删掉，或写具体动作：查看 / 检查' },
  { re: /就行|就好(?=[，。；、）」]|$)/, hint: '删掉' },
  { re: /拿(?=[到不回得它着来去出])/, hint: '写「取得」「获得」「使用」' },
  { re: /卡在|卡住|卡死/, hint: '写「阻塞」「停滞」' },
  { re: /(?<!碰)撞(?!击)/, hint: '写「遇到」「触发」「冲突」「超出」' },
  { re: /(?<!坑)坑(?!位)/, hint: '写「易错点」「问题」' },
  {
    re: /做不了|做完|做不完|删不掉|读不到|读不了|看不了|找不到|放得下|放不下|装不下|对不上/,
    hint: '写「无法…」「完成」「未找到」「不一致」',
  },
  { re: /别(?=[再用改动做让碰])/, hint: '写「不要」' },
  { re: /啥|咋/, hint: '写「什么」「怎么」' },
  { re: /挂上|一趟|大块|派出去|玩意/, hint: '写「创建」「一次」「较长」「派发」或具体名词' },
  { re: /取不了|丢不动|调不通|起不来|测不出|写不了|派不出去|活不过/, hint: '写「无法…」' },
  { re: /派活/, hint: '写「派发任务」' },
  { re: /掐掉|掐断|砍掉/, hint: '写「中止」「截断」「删除」' },
  { re: /活得|活多久/, hint: '写「生命周期」「存活时间」' },
  { re: /火发/, hint: '写「发起」' },
  { re: /干完|干了/, hint: '写「完成」「执行」' },
  { re: /看一眼|冒出|实打实|照样/, hint: '写「查看」「出现」，或删掉' },
  { re: /(?<!修)改口(?!径)|说实话/, hint: '写具体行为' },
  { re: /读回/, hint: '写「读取」「重新读取」' },
  { re: /续起|续行/, hint: '写「自动继续」「开始下一轮」' },
  { re: /到手|对得上/, hint: '写「取得」「加载完成」「一致」' },
  {
    re: /撑不住|撑爆|摆在一起|掉到|(?<!暴)露面/,
    hint: '写「不成立」「超出」「并列」「移到」「出现」',
  },
  { re: /一波/, hint: '写「一批」' },
  { re: /(?<!阻)拦(?!截)|挡回|挡掉/, hint: '写「拦截」「拒绝」' },
  { re: /碰(?!撞)/, hint: '写「访问」「涉及」「触及」' },
  { re: /甩|扔|捞|(?<![阻堵闭])塞/, hint: '写「交给」「丢弃」「取回」「放入」' },
  { re: /吃(?!力)/, hint: '写「接受」「消耗」「支持」' },
  { re: /剥(?![离夺])/, hint: '写「剥离」「移除」' },

  // 第一人称、变更史、自述
  // 「自我提权」是术语，不是人称。
  { re: /我们|咱们|(?<![a-zA-Z自])我(?!们)/, hint: '写模块名或「本地」「调用方」' },
  // 时间副词那一条要跳过跨词边界的偶然拼接（「之后」接「来自」）。
  {
    re: /上一版|旧版(?!本)|原来[是的写叫]|之前是|曾经|一开始|(?<![之以])后来(?!者)|当时/,
    hint: '删掉变更史，只留结论',
  },
  { re: /教训|订正|踩过|踩坑/, hint: '删掉；经过写进计划文档' },
  { re: /早先|早期版本|原本(?=[写是在用])/, hint: '删掉变更史，只留结论' },

  // 外部出处
  {
    re: /抄自|照搬|移植自|参照实现|参照物|原版|上游那边|借鉴/,
    hint: '删掉出处；来源写进计划文档',
  },

  // 拟人与比喻
  { re: /赖着|撒谎|说谎|偷偷|悄悄|乖乖|抢走|吃掉|吞掉|吞了|糊住|烂在|装死|忽悠/, hint: '写机制' },
  { re: /溜过去|溜走|拽回|拽出|硬拽|甩到|咬住/, hint: '写机制' },
  { re: /喂给|喂回|吐出|吐字|吐完|吐一|吐了|吐 /, hint: '写「传入」「返回」「输出」' },
  { re: /活着|死掉|醒着|睡着/, hint: '写「存活」「已退出」' },
  { re: /炸掉|就炸|会炸|炸了/, hint: '写「抛错」「失败」' },
  { re: /骗过|骗了|被骗/, hint: '写「误判」' },
  { re: /心里|脑子/, hint: '写状态所在的位置' },
  { re: /打死|栽在|收尸|掀掉|攥着|躺着|互相踩|那坨/, hint: '写机制：失败/中止/占用/阻塞/冲突' },
  { re: /咽下去|无声吞掉|白花一|白跑|白做/, hint: '写机制：丢弃/无效' },
  { re: /死因|不让它炸|好使(?!用)|雷区/, hint: '写「失败原因」「避免崩溃」「可用」「问题密集」' },
  { re: /闸/, hint: '写「权限检查」「防护」「限制」' },
  { re: /空转拦截/, hint: '写「连续无进展时终止」' },

  // 场景铺陈与后果剧本
  { re: /以为/, hint: '写可观察的现象：界面显示什么、返回什么' },
  { re: /表现就是|你会看到|结果就是|一脸|直接懵/, hint: '写现象本身' },
  { re: /设想|试想|想象一下|假设你/, hint: '写可观察的现象，不做假设铺陈' },

  // 口语虚指与含糊。负向前瞻避开「干」「为」打头的疑问，那是正当用法不是虚指。
  { re: /(?<![干为])什么的|啥的|诸如此类/, hint: '写具体条目' },
  { re: /说来|按理说|照理说|讲道理|说到底/, hint: '删掉，直接说结论' },

  // 反问与强调堆叠
  { re: /恰恰|难道|不正是/, hint: '删掉' },
  { re: /[吗呢]？/, hint: '改成陈述句' },
]

interface Comment {
  line: number
  text: string
}

/**
 * 取出注释正文。
 *
 * 必须跳过字符串字面量：`'https://x'` 里的 `//` 不是注释，当成注释会把界面文案
 * 一起拖进这份检查。模板串跨行，单双引号不跨行——遇到换行就当它没闭合，收手。
 */
/** 在这些字符之后出现的 `/` 起始正则字面量，其余位置是除号。 */
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^'])
const REGEX_KEYWORDS =
  /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|yield|await|else|do)$/

/**
 * `i` 处是正则字面量时返回其后的位置，否则返回 null。
 *
 * 必须识别正则字面量：其中的引号与反引号（如 `/"(?:`[\s\S])*"/`）会被当成字符串起点，
 * 之后的注释与字符串整体错位。按前一个有效字符判断：运算符、左括号、逗号等之后是正则，
 * 标识符、右括号之后是除号。
 */
function skipRegex(src: string, i: number): number | null {
  let k = i - 1
  while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--
  const prev = src[k]
  if (
    prev !== undefined &&
    prev !== '\n' &&
    !BEFORE_REGEX.has(prev) &&
    !REGEX_KEYWORDS.test(src.slice(Math.max(0, k - 8), k + 1))
  )
    return null
  let inClass = false
  let j = i + 1
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '\n') return null
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) break
    j++
  }
  if (j >= src.length) return null
  j++
  while (j < src.length && /[a-z]/.test(src[j]!)) j++
  return j
}

export function extractComments(src: string, lineComments: boolean, hash = false): Comment[] {
  if (hash) {
    return src
      .split('\n')
      .map((text, i) => ({ line: i + 1, text }))
      .filter((c) => c.text.trimStart().startsWith('#'))
      .map((c) => ({ line: c.line, text: c.text.slice(c.text.indexOf('#') + 1) }))
  }
  const out: Comment[] = []
  let line = 1
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (lineComments && c === '/' && src[i + 1] === '/') {
      let j = i + 2
      while (j < n && src[j] !== '\n') j++
      out.push({ line, text: src.slice(i + 2, j) })
      i = j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      const body = src.slice(i + 2, j)
      const rows = body.split('\n')
      for (const [k, text] of rows.entries()) out.push({ line: line + k, text })
      line += rows.length - 1
      i = j + 2
      continue
    }
    if (lineComments && c === '/') {
      const end = skipRegex(src, i)
      if (end !== null) {
        i = end
        continue
      }
    }
    if (lineComments && (c === '"' || c === "'" || c === '`')) {
      i++
      while (i < n) {
        const d = src[i]
        if (d === '\\') {
          if (src[i + 1] === '\n') line++
          i += 2
          continue
        }
        if (d === '\n') {
          line++
          i++
          if (c !== '`') break
          continue
        }
        i++
        if (d === c) break
      }
      continue
    }
    i++
  }
  return out
}

/**
 * 取出字符串字面量正文，只留含汉字的。
 *
 * 必须跳过注释：注释里的引号不是字符串。单双引号不跨行；模板串跨行；Rust 的双引号串可跨行，
 * 单引号是字符或生命周期，不当字符串。Python 只取单行的单双引号串，三引号块归文档字符串。
 * 长于 50 字且不含中文标点的字面量是字表一类的数据，不是文案，不检查。
 */
export function extractStrings(src: string, ext: string): Comment[] {
  const out: Comment[] = []
  const keep = (line: number, text: string) => {
    if (!CJK.test(text)) return
    if (text.length > 50 && !CJK_PUNCT.test(text)) return
    out.push({ line, text })
  }
  if (ext === '.css' || ext === '.toml' || ext === '.ps1') return out
  if (ext === '.py') {
    const body = src.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, ' '))
    for (const [i, row] of body.split('\n').entries()) {
      const code = row.replace(/#.*$/, '')
      for (const m of code.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)) keep(i + 1, m[2] ?? '')
    }
    return out
  }
  let line = 1
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      line += src.slice(i, j).split('\n').length - 1
      i = j + 2
      continue
    }
    if (c === '/') {
      const end = skipRegex(src, i)
      if (end !== null) {
        i = end
        continue
      }
    }
    // JSX 标签之间的文本（按钮名、提示文字）不是字符串字面量，同样是界面文案。
    // 只取不含引号、等号、分号与半角括号的片段：比较运算 `a > b` 之后跟的是代码，不是文本。
    if (ext === '.tsx' && c === '>' && src[i - 1] !== '=' && src[i - 1] !== '-') {
      let j = i + 1
      while (j < n && src[j] !== '<' && src[j] !== '{' && src[j] !== '}') j++
      const segment = src.slice(i + 1, j)
      if (!/['"`;=()]/.test(segment)) keep(line, segment.trim())
    }
    if (c === '"' || c === '`' || (c === "'" && ext !== '.rs')) {
      const start = line
      const multiline = c === '`' || (ext === '.rs' && c === '"')
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          if (src[j + 1] === '\n') line++
          j += 2
          continue
        }
        if (src[j] === '\n') {
          if (!multiline) break
          line++
        }
        j++
      }
      keep(start, src.slice(i + 1, j))
      i = j + 1
      continue
    }
    i++
  }
  return out
}

/**
 * 规则与记忆文档的正文行。去掉围栏代码块、反引号片段、「」引文与标「✗」的反例行：
 * 引用的原话、示例词与反例不是本文的表述。
 */
export function docLines(src: string): Comment[] {
  const out: Comment[] = []
  let fenced = false
  for (const [i, row] of src.split('\n').entries()) {
    if (row.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced || row.includes('✗')) continue
    let text = row.replace(/`[^`]*`/g, '')
    for (let k = 0; k < 3 && /「[^「」]*」/.test(text); k++)
      text = text.replace(/「[^「」]*」/g, '')
    out.push({ line: i + 1, text })
  }
  return out
}

/**
 * 测试名：`test` / `it` / `describe` 的第一个参数，含 `.each(...)`、`.skip` 等修饰。
 * 测试名是开发者写的说明文字，适用书面语要求；测试体里的其他字符串可能是按用户原话书写的样例，不取。
 */
export function testTitles(src: string): Comment[] {
  const out: Comment[] = []
  const re =
    /\b(?:test|it|describe)(?:\.\w+)*(?:\.each\([\s\S]*?\))?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
  for (const m of src.matchAll(re)) {
    const text = m[2] ?? ''
    if (!CJK.test(text)) continue
    out.push({ line: src.slice(0, m.index).split('\n').length, text })
  }
  return out
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (EXTS.has(extname(entry))) out.push(full)
  }
}

export function sourceFiles(): string[] {
  const out: string[] = []
  for (const root of ROOTS) walk(join(ROOT, root), out)
  return out.sort()
}

export function scanFile(file: string): Violation[] {
  const src = readFileSync(file, 'utf8')
  const ext = extname(file)
  const comments = [
    ...extractComments(src, ext !== '.css', HASH_EXTS.has(ext)),
    ...(ext === '.py' ? pythonDocstrings(src) : []),
  ]
  const rel = relative(ROOT, file)
  const strings = !NO_STRING_SCAN.test(rel)
    ? extractStrings(src, ext)
    : TEST_FILE.test(rel)
      ? testTitles(src)
      : []
  const out: Violation[] = []
  const check = (kind: Violation['kind'], items: Comment[]) => {
    for (const { line, text } of items) {
      for (const rule of RULES) {
        const m = rule.re.exec(text)
        if (m) out.push({ file: rel, line, kind, word: m[0], hint: rule.hint, text: text.trim() })
      }
    }
  }
  check('注释', comments)
  check('字符串', strings)
  return out
}

export function docFiles(): string[] {
  const out = DOC_FILES.map((f) => join(ROOT, f))
  for (const dir of DOC_DIRS) {
    try {
      for (const f of readdirSync(join(ROOT, dir)))
        if (f.endsWith('.md')) out.push(join(ROOT, dir, f))
    } catch {
      // 目录不存在时跳过。
    }
  }
  return out.sort()
}

export function scanDoc(file: string): Violation[] {
  const rel = relative(ROOT, file)
  const out: Violation[] = []
  for (const { line, text } of docLines(readFileSync(file, 'utf8'))) {
    for (const rule of RULES) {
      const m = rule.re.exec(text)
      if (m)
        out.push({ file: rel, line, kind: '文档', word: m[0], hint: rule.hint, text: text.trim() })
    }
  }
  return out
}

export function scanAll(): Violation[] {
  return [...sourceFiles().flatMap(scanFile), ...docFiles().flatMap(scanDoc)]
}

if (import.meta.main) {
  const violations = scanAll()
  for (const v of violations) {
    console.log(`${v.file}:${v.line}\t${v.kind}\t${v.word}\t${v.hint}\n\t${v.text}`)
  }
  console.log(`\n${violations.length} 处`)
}
