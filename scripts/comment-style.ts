/**
 * 注释文体检查：把 CLAUDE.md B10 里能机械判定的那几条变成词表。
 *
 * 覆盖的是词表命中即成立的五类——口语与语气词、第一人称自述与变更史、拟人与比喻、
 * 场景铺陈、外部出处。「复述代码」「过期断言」判不了，要读懂上下文才成立，仍归人审。
 *
 * 不设豁免名单。豁免名单是第二本账：命中就改写，改不动说明这句话本身不该在注释里。
 *
 * 只读注释，字符串字面量不读——界面文案归 B7，判据与这里不同。
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
const ROOTS = ['packages', 'apps/web', 'apps/desktop/src-tauri', 'scripts']

const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'gen', '.git'])
/** `.ps1` / `.toml` 走 `#` 行注释，其余走 C 系。 */
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.rs', '.css', '.ps1', '.toml'])
const HASH_EXTS = new Set(['.ps1', '.toml'])

export interface Violation {
  file: string
  line: number
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
  { re: /其实|说白了|换句话说|也就是说|简单来说|总之/, hint: '删掉，直接说结论' },
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

  // 第一人称、变更史、自述
  // 「自我提权」是术语，不是人称。
  { re: /我们|咱们|(?<![a-zA-Z自])我(?!们)/, hint: '写模块名或「本地」「调用方」' },
  // 时间副词那一条要跳过跨词边界的偶然拼接（「之后」接「来自」）。
  {
    re: /上一版|旧版(?!本)|原来[是的写叫]|之前是|曾经|一开始|(?<![之以])后来(?!者)|当时/,
    hint: '删掉变更史，只留结论',
  },
  { re: /教训|订正|踩过|踩坑/, hint: '删掉；经过写进 docs/plans' },

  // 外部出处
  {
    re: /抄自|照搬|移植自|参照实现|参照物|原版|上游那边|借鉴/,
    hint: '删掉出处；来源写进 docs/plans',
  },

  // 拟人与比喻
  { re: /赖着|撒谎|说谎|偷偷|悄悄|乖乖|抢走|吃掉|糊住|烂在|装死|忽悠/, hint: '写机制' },
  { re: /溜过去|溜走|拽回|拽出|硬拽|甩到|咬住/, hint: '写机制' },
  { re: /喂给|喂回|吐出|吐字|吐完|吐一|吐了|吐 /, hint: '写「传入」「返回」「输出」' },
  { re: /活着|死掉|醒着|睡着/, hint: '写「存活」「已退出」' },
  { re: /炸掉|就炸|会炸|炸了/, hint: '写「抛错」「失败」' },
  { re: /骗过|骗了|被骗/, hint: '写「误判」' },
  { re: /心里|脑子/, hint: '写状态所在的位置' },

  // 场景铺陈与后果剧本
  { re: /以为/, hint: '写可观察的现象：界面显示什么、返回什么' },
  { re: /表现就是|你会看到|结果就是|一脸|直接懵/, hint: '写现象本身' },

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
  const comments = extractComments(src, ext !== '.css', HASH_EXTS.has(ext))
  const out: Violation[] = []
  for (const { line, text } of comments) {
    for (const rule of RULES) {
      const m = rule.re.exec(text)
      if (m)
        out.push({
          file: relative(ROOT, file),
          line,
          word: m[0],
          hint: rule.hint,
          text: text.trim(),
        })
    }
  }
  return out
}

export function scanAll(): Violation[] {
  return sourceFiles().flatMap(scanFile)
}

if (import.meta.main) {
  const violations = scanAll()
  for (const v of violations) {
    console.log(`${v.file}:${v.line}\t${v.word}\t${v.hint}\n\t${v.text}`)
  }
  console.log(`\n${violations.length} 处`)
}
