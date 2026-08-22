/**
 * 文件工具：read / write / edit / list。
 *
 * 两条贯穿全部写操作的规则：
 *
 * 1. **写前必须读过。** edit/write 对已存在文件要求调用方先读过且内容未变。
 *    这挡住的是「模型基于陈旧内容覆盖掉用户刚做的修改」——最贵的一类事故，
 *    而且用户往往到很久以后才发现。
 * 2. **edit 的 old_string 必须唯一命中。** 命中 0 次或多次都是失败，不猜第一个。
 *    猜错的那次会静默改错地方。
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { chargeBatchBudget, type ToolContext, type ToolSpec } from '@qywork/agent'
import { estimateText, MEDIA_TOKENS } from '@qywork/ai'
import type { FileChange } from '@qywork/core'
import { isInlineImage, mimeOf } from '@qywork/core'
import { badIntMessage, intArg } from './args.ts'
import { dominantEol, eolInsensitivePattern, fromLf, toLf } from './eol.ts'
import { shrinkImage } from './image.ts'
import {
  displayPath,
  IGNORED_DIRS,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
} from './paths.ts'
import { redactSecrets } from './secrets.ts'

/** 没有会话级 port 时的退路：把读记录暂存在 run 内的便签上。 */
const READ_STATE_KEY = 'files.readHashes'

/**
 * 默认读多少行。
 *
 * 与 `RESULT_BUDGET_RATIO` 是一对：2000 行普通代码约 20~25k token，
 * 而 200k 窗口的 1/8 正好是 25k。改这个数就要回去看那个比例还容不容得下，
 * 否则工具描述里写的默认值就是假的。
 */
const DEFAULT_READ_LINES = 2000

/**
 * 读记录的取用口。
 *
 * **寿命由装配方决定，不由这里决定。** 接上 `ctx.reads`（runtime 按会话落账本）
 * 就是会话级；没接上退回 run 内的便签——那是更严的一侧（每轮头一次写要先读），
 * 所以漏接不会放宽边界。这里只管「读的时候记、写之前比」。
 */
interface ReadHashes {
  get(path: string): string | null
  set(path: string, hash: string): void
}

function readHashes(ctx: ToolContext): ReadHashes {
  if (ctx.reads) {
    const port = ctx.reads
    return { get: (p) => port.seen(p), set: (p, h) => port.mark(p, h) }
  }
  let m = ctx.state.get(READ_STATE_KEY) as Map<string, string> | undefined
  if (!m) {
    m = new Map()
    ctx.state.set(READ_STATE_KEY, m)
  }
  const fallback = m
  return { get: (p) => fallback.get(p) ?? null, set: (p, h) => void fallback.set(p, h) }
}

function hash(text: string): string {
  return Bun.hash(text).toString(16)
}

const MAX_READ_BYTES = 1024 * 1024

/**
 * 图片与 PDF 各有自己的上限，**不与 `MAX_READ_BYTES` 合并**。
 *
 * 三个数管三件不同的事：文本按 token 成本封顶（1 MB 已经装不进任何窗口），
 * 图片按 provider 的单请求上限封顶（10 MB base64 约 13 MB），
 * PDF 按解析时的内存占用封顶（`unpdf` 整份读进内存）。
 * 合并成一个数之后，调任一边都会误伤另外两边。
 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024

/** PDF 抽取结果的 run 内缓存。键带指纹，文件改了自然失效。 */
const PDF_STATE_KEY = 'files.pdfText'

/**
 * 抽 PDF 正文，**同一份文件一个 run 内只抽一次**。
 *
 * 不缓存的话 offset/limit 分页读是 O(n²)：抽一页要先把整本解析一遍，
 * 而模型翻页正是它拿到「已截断」之后必然会做的事（实测一页约 550 ms，
 * 两百页的文档每翻一页都要先付整本）。
 *
 * 键里带 `mtimeMs:size`：文件被改过就是另一份内容，缓存自然不命中。
 * 判据与图像块的指纹（`ai` 的 `ImageSource.stamp`）是同一组，不另发明一套。
 */
async function pdfText(ctx: ToolContext, abs: string, stamp: string): Promise<string> {
  let cache = ctx.state.get(PDF_STATE_KEY) as Map<string, string> | undefined
  if (!cache) {
    cache = new Map()
    ctx.state.set(PDF_STATE_KEY, cache)
  }
  const key = `${abs}|${stamp}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  // 动态 import：`unpdf` 是 2.4 MB，绝大多数会话一个 PDF 都不读，
  // 顶层引入等于每次起进程都为它付一次解析。
  const { extractText, getDocumentProxy } = await import('unpdf')
  const bytes = new Uint8Array(await readFile(abs))
  const doc = await getDocumentProxy(bytes)
  // `mergePages: true` 时返回的就是一整段；类型上仍是联合，取窄一次。
  const { text } = await extractText(doc, { mergePages: true })
  const out = String(text)
  cache.set(key, out)
  return out
}

/**
 * 二进制嗅探：NUL 字节。
 *
 * 用转义写而不是把控制字符直接嵌进正则字面量——后者在编辑器和 diff 里是不可见的，
 * 改动它的人看不出这一行到底在匹配什么。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 NUL 正是本意——这是判断文件是不是二进制的标准做法
const BINARY_SNIFF = /\x00/

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    '读取工作区内一个文件。文本返回带行号的正文；PNG/JPG/GIF/WebP 直接作为图片交给你看；' +
    'PDF 抽取正文后当文本返回（丢版式，中文可能出现同形异码，别拿它做逐字匹配）。' +
    '修改任何已存在的文件前必须先用它读一次——' +
    'write_file 和 edit_file 会校验你读到的内容是否仍是磁盘上的最新版本。' +
    '支持用 offset/limit 分段读取大文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      offset: { type: 'integer', description: '起始行号（1 起），默认 1' },
      limit: { type: 'integer', description: '最多读取行数，默认 2000' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '文件',
  category: 'files',
  facet: '读写',
  summary: '读一个文件（可分页，大文件自动落盘）',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'read',
  // 读操作互不干扰，可并行；资源键让同一文件的读写不会混进同一波。
  parallelSafe: true,
  resourceKeys: (a) => (typeof a.path === 'string' ? [`file:${a.path}`] : []),
  async fn(args, ctx) {
    const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path), { mustExist: true })
    const info = await stat(abs)
    if (info.isDirectory()) {
      return { status: 'failure', message: `${args.path} 是目录，请用 list_dir` }
    }

    /*
     * 图片与 PDF 在**大小守卫之前**分派。
     *
     * 不能放到下面二进制嗅探那一行：`MAX_READ_BYTES` 是 1 MB，而手机照片和多数
     * PDF 都比它大，放晚一行它们会先被拒，拿到的话术还是「请用 offset/limit
     * 分段读取」——对一张图不可执行。这两条各有自己的上限。
     */
    // PDF 抽取缓存的键：文件改了就是另一份内容，缓存自然不命中。
    const fingerprint = `${Math.trunc(info.mtimeMs)}:${info.size}`
    if (isInlineImage(abs)) {
      if (info.size > MAX_IMAGE_BYTES) {
        return {
          status: 'failure',
          message: `图片过大（${Math.round(info.size / 1024 / 1024)} MB），上限 10 MB`,
        }
      }
      /*
       * **记一次读记录。** 图片走不到下面那句 `readHashes(...).set`，不补这一笔的话
       * 模型读过一张图再 `write_file` 同一个路径，会拿到「已存在但没读取过。
       * 先 read_file 再覆盖」——而它照做也永远过不去，那句话就成了假的。
       *
       * **按 utf8 解码后再哈希，不按原始字节。** 判据是「和校验方算的是不是同一个数」
       * ——`write_file` 那侧读的就是 utf8（`readFile(abs, 'utf8')`）。
       * 对二进制来说这个解码是有损的，但它是确定性的，两侧算出来一样就够。
       */
      readHashes(ctx).set(abs, hash(await readFile(abs, 'utf8')))
      const charged = chargeBatchBudget(ctx, MEDIA_TOKENS)
      if (!charged.ok) {
        return {
          status: 'failure',
          message: `本批投递预算只剩 ${charged.batchRemaining} token，装不下一张图，下一轮再读。`,
          errorKind: 'result_too_large',
        }
      }
      /*
       * 超标才缩，在上限内原样通过——**不能读到图就重编码**：
       * 一张 1440×900 的网页截图重编码之后会变大 2.4 倍（实测，见 `image.ts`）。
       */
      const raw = new Uint8Array(await readFile(abs))
      const fit = await shrinkImage(raw, mimeOf(abs))
      const shrunk = { data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime }
      const note = fit.bytes.length < raw.length ? '，已缩放' : ''
      return {
        status: 'success',
        message: `读取 ${displayPath(ctx.workspaceRoot, abs)}（图片${note}）`,
        /*
         * **字节就地定格，不给路径。**
         *
         * 一次读取是一次**观察**，观察的结果该留在执行记录里——和这个工具读一份
         * 文本、`run_command` 留一段 stdout 是同一件事。
         *
         * 给路径的话记录里存的是「去哪看」而不是「看到了什么」，而那个地方的内容
         * 会变：模型改完页面重新截图覆盖同名文件（那正是「对比改前改后」这个工作流
         * 的自然动作），历史里那一张就再也取不回来了。**捕获必须发生在观察的那一刻**，
         * 之后再想补是物理上做不到的。
         *
         * 附件那条**不走这里**，它仍然是路径引用（`runtime` 的 `withAttachments`）：
         * 那是用户自己的文件，我们没有理由复制它。判据是「这是一次观察，还是一个引用」。
         */
        data: { images: [shrunk] },
      }
    }

    let pdf: string | null = null
    if (abs.toLowerCase().endsWith('.pdf')) {
      if (info.size > MAX_PDF_BYTES) {
        return {
          status: 'failure',
          message: `PDF 过大（${Math.round(info.size / 1024 / 1024)} MB），上限 20 MB`,
        }
      }
      pdf = await pdfText(ctx, abs, fingerprint).catch(() => null)
      if (pdf === null) {
        return { status: 'failure', message: `${args.path} 解析失败，可能不是有效的 PDF` }
      }
    }

    if (pdf === null && info.size > MAX_READ_BYTES) {
      return {
        status: 'failure',
        message: `文件过大（${info.size} 字节），请用 offset/limit 分段读取`,
      }
    }
    const text = pdf ?? (await readFile(abs, 'utf8'))
    if (BINARY_SNIFF.test(text.slice(0, 4096))) {
      return { status: 'failure', message: '二进制文件，无法作为文本读取' }
    }

    // 哈希按**磁盘原文**算：它回答的是「磁盘现在是什么」，换成归一后的那份，
    // 文件行尾被别人改过就查不出来了。交给模型的正文才归一。
    readHashes(ctx).set(abs, hash(text))

    const lines = toLf(text).split('\n')
    // 读不出整数就在这里终止。`Math.max` 是下界钳位（`offset: 0` 取 1），它挡不住 NaN：
    // `Math.max(1, NaN)` 还是 NaN，一路走下去就是一次「成功读取 0 行」。
    const rawOffset = intArg(args.offset, 1)
    const rawLimit = intArg(args.limit, DEFAULT_READ_LINES)
    if (rawOffset === null || rawLimit === null) {
      const bad = rawOffset === null ? 'offset' : 'limit'
      return {
        status: 'failure',
        message: badIntMessage(bad, args[bad]),
        errorKind: 'invalid_args',
      }
    }
    const offset = Math.max(1, rawOffset)
    const limit = Math.max(1, rawLimit)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    const truncated = offset - 1 + slice.length < lines.length

    /*
     * 投递预算：这一次调用最多往上下文里放多少。
     *
     * **超了就拒绝，不截断。** 截断看着更友好，实际更贵：拒绝只产生约 100 字节的
     * 错误回执，截断产生的是满额正文，而那份正文往往并不是模型要的那一段——
     * 工具错误率是降了，平均 token 反而上升。
     *
     * 预算取「窗口比例」与绝对封顶的较小者（`deliveryBudget`），不是硬编码；
     * 判据与建议范围一起给回去，否则模型只知道「太大了」，只能靠二分去猜。
     */
    const tokens = estimateText(numbered)
    const charged = chargeBatchBudget(ctx, tokens)
    if (!charged.ok) {
      const perLine = Math.max(1, Math.ceil(tokens / Math.max(1, slice.length)))
      const room = Math.min(charged.perCall, charged.batchRemaining)
      return {
        status: 'failure',
        message:
          `这一段约 ${tokens} token，超出单次投递预算 ${charged.perCall}` +
          `（本批还剩 ${charged.batchRemaining}）。` +
          `改成 offset=${offset}、limit=${Math.max(1, Math.floor(room / perLine))} 分段读。`,
        errorKind: 'result_too_large',
      }
    }

    return {
      status: 'success',
      message: `读取 ${displayPath(ctx.workspaceRoot, abs)}（${slice.length} 行${truncated ? '，已截断' : ''}）`,
      /*
       * **正文过一遍脱敏。**
       *
       * 这条路不接凭证保护的话，`read_file` 就是直接把磁盘上的字节交给模型：
       * 工作区里的 `.env`、误提交的私钥、`config/*.local.json` 里的 token，
       * 读一次就进上下文、随下一次请求发给 provider——**而那是不可撤回的**。
       *
       * 一头拦一头不拦等于没拦：模型拿不到 `cat .env` 的输出，换 `read_file`
       * 就拿到了，而它并不是在绕过什么，只是选了个更顺手的工具。
       *
       * 脱敏的是**交给模型的那一份**，磁盘上的文件一个字节没动；`edit_file`
       * 的读回校验走的是另一条路（`readHashes` 存的是原文哈希），不受影响。
       */
      data: {
        content: redactSecrets(numbered, ctx.secrets ?? EMPTY_SECRETS),
        totalLines: lines.length,
        truncated,
      },
    }
  },
}

/** 没有配置任何 secret 时的空集合。形状脱敏与它无关，照常生效。 */
const EMPTY_SECRETS = { values: [] }

export const writeFileTool: ToolSpec = {
  name: 'write_file',
  description:
    '把完整内容写入一个文件，覆盖原有内容。用于新建文件，或改动幅度大到不适合 edit_file 的重写。' +
    '覆盖已存在的文件前必须先 read_file——内容自你读过之后被改动过会拒绝写入。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      content: { type: 'string', description: '文件完整内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '文件',
  category: 'files',
  facet: '读写',
  summary: '整份写出一个文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    const abs = await resolveWritablePath(rootsOf(ctx), String(args.path))
    const content = String(args.content)

    const existing = await readFile(abs, 'utf8').catch(() => null)
    if (existing !== null) {
      const seen = readHashes(ctx).get(abs)
      if (seen === null) {
        return {
          status: 'failure',
          message: `${args.path} 已存在但没读取过。先 read_file 再覆盖。`,
          errorKind: 'stale_write',
        }
      }
      if (seen !== hash(existing)) {
        return {
          status: 'failure',
          message: `${args.path} 在你读取之后被改动过，已拒绝覆盖。请重新 read_file。`,
          errorKind: 'stale_write',
        }
      }
    }

    // 按既有文件的行尾落盘。模型给的整份内容一律是 LF，原样写下去就是把一个
    // CRLF 文件整份改成 LF——而回执是「写入成功」，git diff 里每一行都变了，
    // 没有任何人会去数字节。新文件按 LF。
    const bytes = fromLf(content, existing === null ? '\n' : dominantEol(existing))

    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, bytes, 'utf8')
    // 记的必须是**落盘那一份**：记 content 的话下一次 edit_file 立刻判定「被人改过」。
    readHashes(ctx).set(abs, hash(bytes))

    const change: FileChange = {
      path: displayPath(ctx.workspaceRoot, abs),
      changeType: existing === null ? 'created' : 'modified',
      // 两侧都归一再比：否则整份行尾变化会被报成「每一行都改了」。
      ...countDiff(toLf(existing ?? ''), toLf(bytes)),
    }
    return {
      status: 'success',
      message: `${existing === null ? '创建' : '写入'} ${change.path}`,
      fileChanges: [change],
    }
  },
}

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    '在文件中把一段精确文本替换成另一段。old_string 必须在文件中恰好出现一次——' +
    '出现 0 次或多次都会失败并告诉你实际次数，此时请加长 old_string 让它唯一。' +
    '调用前必须先 read_file。这是修改已有文件的首选方式，比 write_file 安全。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      old_string: { type: 'string', description: '要被替换的原文，需含足够上下文以保证唯一' },
      new_string: { type: 'string', description: '替换后的文本' },
      replace_all: { type: 'boolean', description: '为 true 时替换全部出现处' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '文件',
  category: 'files',
  facet: '读写',
  summary: '按精确串替换改一个文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    const abs = await resolveWritablePath(rootsOf(ctx), String(args.path), {
      mustExist: true,
    })
    const oldStr = String(args.old_string)
    const newStr = String(args.new_string)
    const replaceAll = args.replace_all === true

    const current = await readFile(abs, 'utf8')
    const seen = readHashes(ctx).get(abs)
    if (seen === null) {
      return {
        status: 'failure',
        message: `${args.path} 没读取过。先 read_file。`,
        errorKind: 'stale_write',
      }
    }
    if (seen !== hash(current)) {
      return {
        status: 'failure',
        message: `${args.path} 在你读取之后被改动过。请重新 read_file。`,
        errorKind: 'stale_write',
      }
    }

    /*
     * 定位**行尾不敏感**，在原文上做。
     *
     * 模型看到的正文是归一过的（`read_file` 交出去时去了 CR），它复述回来的
     * `old_string` 必然是 LF；而 CRLF 文件里那几行之间是 `\r\n`。拿原串精确匹配的话，
     * 跨行的 old_string 在 CRLF 文件上**永远**找不到，而 agent 干活的仓库不归我们管。
     *
     * 只替换命中的那一段、其余字节逐字节留着：混合行尾的文件不会因为一次单行编辑
     * 被整份重写。
     */
    const hits = oldStr
      ? [...current.matchAll(new RegExp(eolInsensitivePattern(oldStr), 'g'))].map((m) => ({
          at: m.index,
          len: m[0].length,
        }))
      : []
    if (hits.length === 0) {
      return { status: 'failure', message: 'old_string 未在文件中找到', errorKind: 'no_match' }
    }
    if (hits.length > 1 && !replaceAll) {
      return {
        status: 'failure',
        message: `old_string 命中 ${hits.length} 处，不唯一。请加长上下文，或设 replace_all=true。`,
        errorKind: 'ambiguous_match',
      }
    }
    const occurrences = hits.length

    // 替换段按文件主导行尾编码。从后往前拼——从前往后的话前一次替换会把后面的下标全带偏。
    const replacement = fromLf(newStr, dominantEol(current))
    let next = current
    for (let i = (replaceAll ? hits.length : 1) - 1; i >= 0; i--) {
      const hit = hits[i]
      if (!hit) continue
      next = next.slice(0, hit.at) + replacement + next.slice(hit.at + hit.len)
    }
    await writeFile(abs, next, 'utf8')
    readHashes(ctx).set(abs, hash(next))

    const change: FileChange = {
      path: displayPath(ctx.workspaceRoot, abs),
      changeType: 'modified',
      ...countDiff(current, next),
    }
    return {
      status: 'success',
      message: `编辑 ${change.path}（${occurrences} 处）`,
      fileChanges: [change],
    }
  },
}

export const listDirTool: ToolSpec = {
  name: 'list_dir',
  description:
    '列出一个目录下的条目。默认跳过 node_modules/.git/dist 等噪声目录。' +
    '用于摸清项目结构；找具体文件用 glob，找文件内容用 grep。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径，默认为工作区根' },
    },
    additionalProperties: false,
  },
  actionKind: 'query',
  objectLabel: '目录',
  category: 'files',
  facet: '检索',
  summary: '列一个目录下有什么',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : '.'),
  permissionEffect: 'read',
  parallelSafe: true,
  async fn(args, ctx) {
    const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? '.'), {
      mustExist: true,
    })
    const entries = await readdir(abs, { withFileTypes: true })
    const rows = entries
      .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory()
            ? -1
            : 1,
      )
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))

    return {
      status: 'success',
      message: `${displayPath(ctx.workspaceRoot, abs)}：${rows.length} 项`,
      data: { entries: rows },
    }
  },
}

/**
 * 一次比对最多走多远。超过就报满——差到这个程度基本是整份换掉。
 *
 * 复杂度是 O(D²)，实测 D=4000 约 55ms、D=10000 约 350ms，再往上是分钟级：
 * 一个几万行的生成文件被整份覆盖时不封顶就会把这一次工具调用挂死。
 * **不要在这里回落到别的算法**——同一个字段里混两套口径比偏大更糟。
 */
const MAX_EDIT = 4000

/**
 * 行级增删统计，供 UI 的「+x −y」展示。
 *
 * **必须按位置比，不能按「这一行旧文件里出现过没有」比。** 后者会把空行、`}`、
 * 注释框架行、以及旧文件里别处碰巧有同一份的任何一行都算成「没新增」，整块搬家更是
 * 直接算成 0——实测本仓 128 个文件对少报 24.7%，其中三分之二是空行、括号和注释框架。
 *
 * Myers 贪心，只求编辑距离不还原路径：D = 增 + 删，而 增 − 删 = 新行数 − 旧行数，
 * 两式解出两个数。**先裁公共前后缀**——真实改动裁完通常只剩几十行，这是它快的
 * 全部原因；不裁的话每次编辑都按整个文件长度算。
 */
function countDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  // 空的那一侧不进循环：答案是显然的，而 Myers 要绕满一圈才收敛。
  if (a.length === 0) return { additions: b.length, deletions: 0 }
  if (b.length === 0) return { additions: 0, deletions: a.length }

  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++
  let endA = a.length
  let endB = b.length
  while (endA > lo && endB > lo && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - lo
  const m = endB - lo
  if (n === 0) return { additions: m, deletions: 0 }
  if (m === 0) return { additions: 0, deletions: n }

  // v[k] = 在对角线 k 上能走到的最远 x。max 是下标偏移，让 k 为负时也落在数组里。
  const max = n + m
  const v = new Int32Array(2 * max + 1)
  const limit = Math.min(max, MAX_EDIT)
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      // k = ±max 时这两个下标会落到数组外，取 0 正是那一档要的值（还没走出去过）。
      const down = v[k + 1 + max] ?? 0
      const right = v[k - 1 + max] ?? 0
      let x = k === -d || (k !== d && right < down) ? down : right + 1
      let y = x - k
      while (x < n && y < m && a[lo + x] === b[lo + y]) {
        x++
        y++
      }
      v[k + max] = x
      if (x >= n && y >= m) {
        const deletions = (d + n - m) / 2
        return { additions: d - deletions, deletions }
      }
    }
  }
  return { additions: m, deletions: n }
}
