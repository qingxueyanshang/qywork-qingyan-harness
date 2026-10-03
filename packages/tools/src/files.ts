/**
 * 文件工具：read / write / edit / list。
 *
 * 两条贯穿全部写操作的规则：
 *
 * 1. **新建不覆盖；修改前必须读过。** edit/write 的修改模式要求先读过且内容未变。
 *    这挡住的是「模型基于陈旧内容覆盖掉用户刚做的修改」——最贵的一类事故，
 *    而且用户往往到很久以后才发现。
 * 2. **edit 的 old_string 必须唯一命中。** 命中 0 次或多次都是失败，不猜第一个。
 *    猜错的那次会静默改错地方。
 */

import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  chargeBatchBudget,
  deliveryCap,
  outcomeTokens,
  recordBatchSpent,
  type ToolContext,
  type ToolOutcome,
  type ToolSpec,
  tokensToMaxBytes,
  videoDelivery,
} from '@qywork/agent'
import { MEDIA_TOKENS } from '@qywork/ai'
import type { FileChange } from '@qywork/core'
import { isInlineImage, isInlineVideo, mimeOf } from '@qywork/core'
import { badIntMessage, intArg } from './args.ts'
import { dominantEol, eolInsensitivePattern, fromLf, toLf } from './eol.ts'
import { shrinkImage } from './image.ts'
import { readVideoFrames } from './office-worker.ts'
import {
  displayPath,
  IGNORED_DIRS,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
} from './paths.ts'
import { redactSecrets } from './secrets.ts'
import { deliverReadable, MIN_DELIVERY_BYTES } from './sink.ts'

/** 没有会话级 port 时的退路：把读记录暂存在 run 内的便签上。 */
const READ_STATE_KEY = 'files.readHashes'

/**
 * 读记录的取用口。
 *
 * **寿命由装配方决定，不由这里决定。** 接上 `ctx.reads`（runtime 按会话落账本）
 * 就是会话级；没接上退回 run 内的便签——那是更严的一侧（每轮头一次写要先读），
 * 所以漏接不会放宽边界。这里只管「读的时候记、写之前比」。
 */
export interface ReadHashes {
  get(path: string): string | null
  set(path: string, hash: string): void
}

/** `office` 用同一个记录口：读过的 Office 文件按文件字节的 SHA-256 记账，写之前比对。 */
export function readHashes(ctx: ToolContext): ReadHashes {
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

/**
 * 读记录的哈希：正文按 UTF-8 编码后的 SHA-256。
 *
 * 读取一侧边读边算（`scanLines`），写入与编辑一侧对整份正文算，两侧必须是同一个函数。
 * 不要换成只能一次算完的哈希：流式读取时整份正文不在内存里。
 */
function hash(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

/**
 * 图片与 PDF 各有自己的上限：图片按 provider 的单请求上限（10 MB base64 约 13 MB），
 * PDF 按解析时的内存占用（`unpdf` 整份读进内存）。文本没有大小上限：按行流式读，
 * 内存只放得下本轮要投递的那几行（`scanLines`）。
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
 * 改动它的人看不出这一行在匹配什么。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 NUL 正是本意——判断文件是不是二进制的标准做法
const BINARY_SNIFF = /\x00/

/** 一次按行读取的结果：请求范围内保留下来的行、文件总行数、范围内的行是否全部保留、整份正文的哈希。 */
interface LineScan {
  lines: string[]
  total: number
  complete: boolean
  digest: string
}

/**
 * 按行读正文：只保留第 `offset` 行起至多 `limit` 行、累计不超过 `keepBytes` 的行（至少一行），
 * 同时数出总行数、算出整份正文的哈希。行按 LF 切，行尾的 CR 去掉，与 `toLf` 后再按 `\n` 切同形。
 *
 * 开头 4096 个字符里有 NUL 即判为二进制，不再往下读。
 * 不要改回整份读进内存再切：几百 MB 的日志装进一个字符串就是几百 MB 的 UTF-16，
 * 而一次最多只投递得下一个窗口的量。
 */
async function scanLines(
  chunks: AsyncIterable<string>,
  offset: number,
  limit: number,
  keepBytes: number,
): Promise<LineScan | 'binary'> {
  const hasher = new Bun.CryptoHasher('sha256')
  const lines: string[] = []
  let kept = 0
  let total = 0
  let complete = true
  let pending = ''
  let sniffed = false
  const take = (line: string) => {
    total++
    if (total < offset || total - offset >= limit) return
    if (lines.length > 0 && kept >= keepBytes) {
      complete = false
      return
    }
    lines.push(line)
    kept += Buffer.byteLength(line) + 1
  }
  for await (const text of chunks) {
    hasher.update(text)
    const buf = pending + text
    if (!sniffed && buf.length >= 4096) {
      if (BINARY_SNIFF.test(buf.slice(0, 4096))) return 'binary'
      sniffed = true
    }
    let start = 0
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n', start)) {
      take(
        buf.charCodeAt(nl - 1) === 13 && nl > start
          ? buf.slice(start, nl - 1)
          : buf.slice(start, nl),
      )
      start = nl + 1
    }
    pending = buf.slice(start)
  }
  if (!sniffed && BINARY_SNIFF.test(pending.slice(0, 4096))) return 'binary'
  take(pending)
  return { lines, total, complete, digest: hasher.digest('hex') }
}

/**
 * 文件正文按 UTF-8 流式解码成字符串片段。
 *
 * 用 `StringDecoder` 而不是 `TextDecoder`：前者与 `readFile(abs, 'utf8')` 同一套规则（保留 BOM、
 * 非法字节的替换方式相同），写入与编辑一侧按后者算哈希，两侧解码不同就永远判成「读取之后被改过」。
 */
async function* decodeFile(abs: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  for await (const chunk of createReadStream(abs)) {
    const text = decoder.write(chunk as Buffer)
    if (text) yield text
  }
  const rest = decoder.end()
  if (rest) yield rest
}

/** 已在内存里的正文（PDF 抽取结果）当作一个片段交给 `scanLines`。 */
async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text
}

/**
 * 读不成文本的那一类的回执。
 *
 * **必须带下一步，且明说不要再读。** 只回「无法作为文本读取」的话，模型除了换个
 * 参数再读一遍没有别的选择，而每一遍都会失败。音频与压缩包还多一条：请求体里没有
 * 它们的内容块，换模型也没用。视频在前面单独分派（`readVideo`）。
 */
function notText(path: string, office: boolean): { status: 'failure'; message: string } {
  if (office && OFFICE_FILE.test(path)) {
    return {
      status: 'failure',
      message: `${path} 是 Office 文件，read_file 读不出内容。用 read_office 读取它的结构与文字。`,
    }
  }
  return {
    status: 'failure',
    message:
      `${path} 不是文本文件，读不出内容。不要再读它——` +
      `音频与压缩包无法作为文本读取，也不能作为内容发给模型；` +
      `需要里面的信息就用 run_command 调外部工具处理，或请用户描述。`,
  }
}

/** 视频读取的区间（秒）。不合法时交回给模型看的一句原因。 */
function timeRange(args: Record<string, unknown>): { start?: number; end?: number } | string {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const start = num(args.start)
  const end = num(args.end)
  if (start !== undefined && start < 0) return 'start 不能小于 0'
  if (start !== undefined && end !== undefined && end <= start) return 'end 必须大于 start'
  return { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) }
}

/** `office` 工具处理的文件类型。 */
const OFFICE_FILE = /\.(docx|dotx|xlsx|xltx|pptx|potx)$/i

/**
 * 读一段视频。走原生还是抽帧由 `agent` 的 `videoDelivery` 判，与发送时同一条判据：
 * 原生时交出路径引用，由请求装配在发出前内联或上传（`videosOf` 与 `materialize`），
 * 按一份 `MEDIA_TOKENS` 扣投递额度。
 *
 * 抽帧时经 Office 的 Python worker 按时间取帧，帧作为图片返回（`readVideoFrames`），
 * `start` / `end` 指定区间。读不了时**在这里就回绝**并说明下一步：交出路径的话，
 * 发送时会被替换成一句说明，这次读取没有产出，而回执显示成功。
 */
async function readVideo(
  ctx: ToolContext,
  abs: string,
  size: number,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const shown = displayPath(ctx.workspaceRoot, abs)
  const delivery = videoDelivery(size, {
    video: ctx.video === true,
    ...(ctx.videoUploadAbove !== undefined ? { mediaUploadAbove: ctx.videoUploadAbove } : {}),
  })
  if (delivery === 'frames') {
    // 收原生视频、但这段太大又不能上传时同样抽帧：内联的话下一步就被换出，模型只看到一眼。
    const cause = ctx.video
      ? `这段视频 ${(size / 1024 / 1024).toFixed(1)} MB，超出请求里常驻媒体的上限，当前接口又不能上传`
      : '当前模型不接受原生视频'
    if (ctx.vision === false) {
      return {
        status: 'failure',
        message:
          `${ctx.video ? `${cause}，` : ''}当前模型既不接受视频也不接受图片，${shown} 读不出内容。` +
          `不要再读这个文件——换一个支持图片或视频的模型，或请用户描述视频内容。`,
      }
    }
    if (!ctx.office) {
      return {
        status: 'failure',
        message:
          `${cause}，按时间抽帧要用 Office 的 Python 运行环境，这里没有可用的环境，${shown} 读不出内容。` +
          `不要再读这个文件——换一个支持视频的模型，或请用户描述视频内容。`,
      }
    }
    const range = timeRange(args)
    if (typeof range === 'string') return { status: 'failure', message: range }
    const read = await readVideoFrames(ctx, ctx.office, abs, shown, range)
    return ctx.video && read.status === 'success'
      ? { ...read, message: `${cause}，改为按时间抽帧。\n${read.message}` }
      : read
  }
  if (!chargeBatchBudget(ctx, MEDIA_TOKENS).ok) recordBatchSpent(ctx, MEDIA_TOKENS)
  return {
    status: 'success',
    message: `读取 ${shown}（视频）`,
    data: { videos: [{ path: abs, mime: mimeOf(abs) }] },
  }
}

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    '读取工作区内一个文件。文本返回带行号的正文；PNG/JPG/GIF/WebP 作为图片返回；' +
    'MP4/MOV/WebM/MKV 在当前模型支持视频输入时作为视频返回，否则按时间抽取若干帧作为图片返回，' +
    '回执写明看到的时间点与未看到的区间，start/end（秒）指定一段续读；' +
    'PDF 提取正文后作为文本返回（不保留版式，中文可能出现同形异码，不适用于逐字匹配；没有文字层时返回失败）。' +
    '修改任何已存在的文件前必须先用它读一次——' +
    'write_file 和 edit_file 会校验你读到的内容是否仍是磁盘上的最新版本。' +
    '默认读整份；超出上下文剩余空间时返回放得下的部分与续读位置。需要某一段时用 offset/limit。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      offset: { type: 'integer', description: '起始行号（1 起），默认 1' },
      limit: { type: 'integer', description: '最多读取行数，默认读到文件末尾' },
      start: { type: 'number', description: '视频抽帧区间的起点（秒），默认从头。只对视频有效' },
      end: { type: 'number', description: '视频抽帧区间的终点（秒），默认到结尾。只对视频有效' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '文件',
  category: 'files',
  facet: '读写',
  summary: '读一个文件（默认整份，可分段）',
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
     * 图片与 PDF 在**二进制嗅探之前**分派：它们开头的字节里有 NUL，放到按行读取之后会先被判成
     * 二进制而拒绝。这两条各有自己的上限。
     */
    // PDF 抽取缓存的键：文件改了就是另一份内容，缓存自然不命中。
    const fingerprint = `${Math.trunc(info.mtimeMs)}:${info.size}`
    if (isInlineImage(abs)) {
      /*
       * 当前模型不收图片：**在读字节之前就回绝**，并把原因说全。
       *
       * 判据只认 `false`（约定见 `ai` 的 `ModelSpec.vision`）。这里回绝的是
       * 一件重试永远不会成功的事，所以话里要带**下一步该干什么**——只说
       * 「读取失败」的话，模型除了原样再读一遍没有别的选择，而每一遍都会失败。
       */
      if (ctx.vision === false) {
        return {
          status: 'failure',
          message:
            `当前模型不接受图片输入，${displayPath(ctx.workspaceRoot, abs)} 读不出内容。` +
            `不要再读这个文件——换一个支持图片的模型，或请用户描述图里的内容。`,
        }
      }
      if (info.size > MAX_IMAGE_BYTES) {
        return {
          status: 'failure',
          message: `图片过大（${Math.round(info.size / 1024 / 1024)} MB），上限 10 MB`,
        }
      }
      // 余量放不下一张图时照样投递：报失败的回合不产出内容，超出的这一张由下一次发送前的压缩收回。
      if (!chargeBatchBudget(ctx, MEDIA_TOKENS).ok) recordBatchSpent(ctx, MEDIA_TOKENS)
      /*
       * **记一次读记录，且只在图确实交出去时记。** 图片走不到下面文本那条 `readHashes(...).set`，
       * 不补这一笔的话模型读过一张图再 `write_file` 同一个路径，会拿到「已存在但没读取过。
       * 先 read_file 再覆盖」——而它照做也永远过不去，那句话就成了假的。
       *
       * **按 utf8 解码后再哈希，不按原始字节。** 判据是「和校验方算的是不是同一个数」
       * ——`write_file` 那侧读的就是 utf8（`readFile(abs, 'utf8')`）。
       * 对二进制来说这个解码是有损的，但它是确定性的，两侧算出来一样就够。
       */
      readHashes(ctx).set(abs, hash(await readFile(abs, 'utf8')))
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
         * 附件那条**不走这里**，由 `runtime` 的 `withAttachments` 在每次发送前按路径编码：
         * 那是用户自己的文件，没有理由复制它。判据是「这是一次观察，还是一个引用」。
         */
        data: { images: [shrunk] },
      }
    }

    if (isInlineVideo(abs)) return readVideo(ctx, abs, info.size, args)

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
      // 没有文字层（扫描件、纯图片页）时返回空正文会被当成「这份 PDF 是空的」。
      // 下一步只指向这一轮真的能用的能力：office 关着或模型不收图时，指过去就是一次必然失败的调用。
      if (!pdf.trim()) {
        return {
          status: 'failure',
          message:
            ctx.office?.enabled() === true && ctx.vision !== false
              ? `${args.path} 没有文字层（扫描件或纯图片页），read_file 读不出内容。用 view_office 按页查看。`
              : `${args.path} 没有文字层（扫描件或纯图片页），read_file 读不出内容，当前也没有查看 PDF 页面的工具。`,
        }
      }
    }

    // 读不出整数就在这里终止。`Math.max` 是下界钳位（`offset: 0` 取 1），它挡不住 NaN：
    // `Math.max(1, NaN)` 还是 NaN，继续往下走就是一次「成功读取 0 行」。
    const rawOffset = intArg(args.offset, 1)
    const rawLimit = intArg(args.limit, Number.MAX_SAFE_INTEGER)
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

    // 只留本轮放得下的那几行：保留量取余量折成字节的上界，量完不超额度的前缀必然在其内。
    const keepBytes = Math.max(MIN_DELIVERY_BYTES, tokensToMaxBytes(deliveryCap(ctx), ctx.density))
    const scan = await scanLines(
      pdf === null ? decodeFile(abs) : oneChunk(pdf),
      offset,
      limit,
      keepBytes,
    )
    if (scan === 'binary') return notText(String(args.path), ctx.office !== undefined)
    const slice = scan.lines
    const totalLines = scan.total
    const shown = displayPath(ctx.workspaceRoot, abs)
    const secrets = ctx.secrets ?? EMPTY_SECRETS

    /*
     * 所请求范围的前 n 行组成的结果。
     *
     * **正文过一遍脱敏。** 这条路不接凭证保护的话，`read_file` 就是直接把磁盘上的字节交给模型：
     * 工作区里的 `.env`、误提交的私钥、`config/*.local.json` 里的 token，读一次就进上下文、
     * 随下一次请求发给 provider，而那是不可撤回的。模型拿不到 `cat .env` 的输出，换 `read_file`
     * 就拿到的话，等于没拦。脱敏的是交给模型的那一份，磁盘上的文件一个字节没动；
     * `edit_file` 的读回校验用的是原文哈希，不受影响。
     */
    const firstLines = (n: number): { message: string; data: Record<string, unknown> } => {
      const numbered = slice
        .slice(0, n)
        .map((l, i) => `${offset + i}\t${l}`)
        .join('\n')
      const end = offset - 1 + n
      const complete = n === slice.length && scan.complete
      return {
        message: complete
          ? `读取 ${shown}（${n} 行${end < totalLines ? '，已截断' : ''}）`
          : `读取 ${shown} 第 ${offset}–${end} 行（共 ${totalLines} 行）。` +
            `超出上下文剩余空间，从 offset=${end + 1} 续读；已读的段落在压缩时会收起，要点写在回复里。`,
        data: {
          content: redactSecrets(numbered, secrets),
          startLine: offset,
          endLine: end,
          totalLines,
          truncated: end < totalLines,
          ...(complete ? {} : { nextOffset: end + 1 }),
        },
      }
    }

    // 哈希按**磁盘原文**算：它回答的是「磁盘现在是什么」，换成归一后的那份，
    // 文件行尾被别人改过就查不出来了。交给模型的正文才归一。
    // 只在确实交出内容之后记：失败的读取不能成为 edit 的前置证据。
    const markRead = () => readHashes(ctx).set(abs, scan.digest)

    /*
     * 投递：所请求的范围整份装得下就整份给；装不下给装得下的最长行前缀和下一行的 offset，
     * 不拒绝。拒绝的回合不产出正文，模型只能按建议再读一遍。
     *
     * 行数用二分按真实结果量出来，不要按平均行长估：行长不均时估出来的行数装不下。
     */
    const whole = firstLines(slice.length)
    if (scan.complete && chargeBatchBudget(ctx, outcomeTokens(whole, ctx.density)).ok) {
      markRead()
      return { status: 'success', ...whole }
    }
    const remaining = deliveryCap(ctx)
    // 余量连一段都放不下时仍给 `MIN_DELIVERY_BYTES` 以内的整行，不报失败。
    const fits = (n: number) => {
      const part = firstLines(n)
      return (
        outcomeTokens(part, ctx.density) <= remaining ||
        Buffer.byteLength(String(part.data.content)) <= MIN_DELIVERY_BYTES
      )
    }
    if (scan.complete && fits(slice.length)) {
      recordBatchSpent(ctx, outcomeTokens(whole, ctx.density))
      markRead()
      return { status: 'success', ...whole }
    }
    let fit = 0
    let over = slice.length
    while (over - fit > 1) {
      const mid = (fit + over) >> 1
      if (fits(mid)) fit = mid
      else over = mid
    }
    if (fit > 0) {
      const part = firstLines(fit)
      const tokens = outcomeTokens(part, ctx.density)
      if (!chargeBatchBudget(ctx, tokens).ok) recordBatchSpent(ctx, tokens)
      markRead()
      return { status: 'success', ...part }
    }

    // 第一行都装不下：行偏移切不到一行中间，这一行存一次，按字节续读。
    const line = redactSecrets(slice[0] ?? '', secrets)
    const message = `读取 ${shown} 第 ${offset} 行（共 ${totalLines} 行）`
    const nextLine = offset < totalLines ? offset + 1 : null
    const more = nextLine === null ? {} : { nextOffset: nextLine }
    const result = deliverReadable(ctx, {
      toolName: 'read_file',
      sourceType: 'file:line',
      whole: {
        message,
        data: {
          content: `${offset}\t${line}`,
          startLine: offset,
          endLine: offset,
          totalLines,
          truncated: true,
          ...more,
        },
      },
      body: line,
      partial: (head, note) => ({
        message: `${message}，该行只投递了开头${nextLine === null ? '' : `，下一行从 offset=${nextLine} 用 read_file 读`}。${note}`,
        data: {
          content: `${offset}\t${head}`,
          startLine: offset,
          endLine: offset,
          totalLines,
          truncated: true,
          ...more,
        },
      }),
    })
    if (result.status === 'success') markRead()
    return result
  },
}

/** 没有配置任何 secret 时的空集合。形状脱敏与它无关，照常生效。 */
const EMPTY_SECRETS = { values: [] }

export const writeFileTool: ToolSpec = {
  name: 'write_file',
  description:
    '整份写入文件，必须用 mode 明确区分新建与覆盖修改。' +
    'create 只新建，绝不覆盖已有文件；普通重名会提示先 list_dir 核对目录。' +
    '用户要新作品且没有指定固定文件名时，使用 create 和 on_conflict=rename：工具在本地自动选空闲名称，直接写入本次 content，无需重新生成。后续操作使用回执里的实际 path。' +
    'overwrite 只修改已有文件，必须先 read_file 且内容未变；局部修改优先 edit_file。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      mode: {
        type: 'string',
        enum: ['create', 'overwrite'],
        description: 'create 新建独立文件；overwrite 覆盖修改已有文件，必须先读取。',
      },
      on_conflict: {
        type: 'string',
        enum: ['error', 'rename'],
        description:
          '新建重名时的处理，默认 error。仅当文件名可以自由选择时用 rename，自动追加 -2、-3 等后缀；固定文件名使用 error。覆盖修改不能使用 rename。',
      },
      content: { type: 'string', description: '文件完整内容' },
    },
    required: ['path', 'mode', 'content'],
    additionalProperties: false,
  },
  actionKind: (args) => (args.mode === 'overwrite' ? 'edit' : 'write'),
  objectLabel: '文件',
  category: 'files',
  facet: '读写',
  summary: '整份写出一个文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    const mode = args.mode
    const conflict = args.on_conflict ?? 'error'
    if (
      (mode !== 'create' && mode !== 'overwrite') ||
      (conflict !== 'error' && conflict !== 'rename') ||
      (mode === 'overwrite' && conflict === 'rename')
    ) {
      return {
        status: 'failure',
        executed: false,
        message:
          'mode 必须为 create 或 overwrite；on_conflict 必须为 error 或 rename，rename 仅用于允许自由命名的新建文件。',
        errorKind: 'invalid_tool_arguments',
      }
    }
    const requested = String(args.path)
    const content = String(args.content)
    let abs: string
    let existing: string | null = null
    let bytes = content
    if (mode === 'create') {
      const { dir, name, ext } = parse(requested)
      for (let suffix = 1; ; suffix++) {
        ctx.signal.throwIfAborted()
        const candidate = suffix === 1 ? requested : join(dir, `${name}-${suffix}${ext}`)
        abs = await resolveWritablePath(rootsOf(ctx), candidate, { followFinalSymlink: false })
        await mkdir(dirname(abs), { recursive: true })
        // 悬挂软链同样占用名称，不能只依赖 wx 对目标存在性的检查。
        const occupied = await lstat(abs).then(
          () => true,
          (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return false
            throw err
          },
        )
        if (!occupied) {
          try {
            // 独占创建处理查名后被其他创建者占用的情况，内容在本次调用内复用。
            await writeFile(abs, bytes, { encoding: 'utf8', flag: 'wx' })
            break
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          }
        }
        if (conflict === 'rename') continue
        const parent = await resolveWritablePath(rootsOf(ctx), dirname(requested))
        return {
          status: 'failure',
          executed: false,
          message:
            `${requested} 已存在，新建不会覆盖。先 list_dir ${JSON.stringify({ path: displayPath(ctx.workspaceRoot, parent) })} ` +
            '核对目录中的文件名，再选择未占用的路径；若必须使用这个名字，请先确认已有文件应如何处理。',
          errorKind: 'file_exists',
        }
      }
    } else {
      abs = await resolveWritablePath(rootsOf(ctx), requested, { mustExist: true })
      existing = await readFile(abs, 'utf8')
      const seen = readHashes(ctx).get(abs)
      if (seen === null) {
        return {
          status: 'failure',
          executed: false,
          message: `${requested} 没读取过，已拒绝覆盖修改。先 read_file 再覆盖。`,
          errorKind: 'stale_write',
        }
      }
      if (seen !== hash(existing)) {
        return {
          status: 'failure',
          executed: false,
          message: `${requested} 在你读取之后被改动过，已拒绝覆盖。请重新 read_file。`,
          errorKind: 'stale_write',
        }
      }
      bytes = fromLf(content, dominantEol(existing))
      // r+ 不创建文件：目标被并发删除时不能把覆盖修改变成新建。
      const file = await open(abs, 'r+')
      try {
        await file.writeFile(bytes, 'utf8')
        await file.truncate(Buffer.byteLength(bytes, 'utf8'))
      } finally {
        await file.close()
      }
    }
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
      data: { path: change.path },
      fileChanges: [change],
    }
  },
}

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    '在文件中把一段精确文本替换成另一段。old_string 必须在文件中恰好出现一次——' +
    '出现 0 次或多次都会失败并告诉你实际次数，此时请加长 old_string 让它唯一。' +
    '调用前必须先 read_file。修改已有文件优先使用本工具：替换范围由 old_string 限定，不影响文件其余内容。',
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
     * 跨行的 old_string 在 CRLF 文件上**永远**找不到，而目标仓库的行尾不受本仓控制。
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
    '用于了解项目结构；查找具体文件用 glob，查找文件内容用 grep。',
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
 * Myers 贪心，只求编辑距离不还原路径：D = 增 + 删，而增 − 删 = 新行数 − 旧行数，
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
