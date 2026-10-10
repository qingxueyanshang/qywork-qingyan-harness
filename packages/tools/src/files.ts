/**
 * 文件工具：read / write / edit / list。
 *
 * 全部写操作遵循的两条规则：
 *
 * 1. **新建不覆盖；修改前必须已读取。** edit/write 的修改模式要求先读取且内容未变。
 *    该规则防止模型基于过期内容覆盖用户刚做的修改：此类覆盖代价最高，
 *    且通常很晚才被发现。
 * 2. **edit 每一项的 old_string 必须唯一命中。** 命中 0 次或多次的项不写入，不推测为第一处。
 *    推测错误时会静默修改错误的位置。
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

/** 没有会话级 port 时的后备方案：把读取记录暂存在 run 内的临时存储中。 */
const READ_STATE_KEY = 'files.readHashes'

/**
 * 读取记录的访问入口。
 *
 * 生命周期由装配方决定，不由此处决定。接入 `ctx.reads`（runtime 按会话写入账本）时
 * 为会话级；未接入时退回 run 内的临时存储：这是更严格的一侧（每轮首次写入前必须先读取），
 * 因此遗漏接入不会放宽边界。此处只负责读取时记录、写入前比对。
 */
export interface ReadHashes {
  get(path: string): string | null
  set(path: string, hash: string): void
}

/** `office` 使用同一个记录入口：已读取的 Office 文件按文件字节的 SHA-256 记录，写入前比对。 */
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
 * 读取记录的哈希：正文按 UTF-8 编码后的 SHA-256。
 *
 * 读取一侧边读取边计算（`scanLines`），写入与编辑一侧对整份正文计算，两侧必须使用同一个函数。
 * 不要换成只能一次性计算的哈希：流式读取时整份正文不在内存中。
 */
function hash(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

/**
 * 图片与 PDF 各有上限：图片按 provider 的单请求上限（10 MB base64 约 13 MB），
 * PDF 按解析时的内存占用（`unpdf` 把整份文件读入内存）。文本没有大小上限：按行流式读取，
 * 内存只保留本轮要投递的行（`scanLines`）。
 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024

/** PDF 提取结果的 run 内缓存。键包含指纹，文件修改后缓存即失效。 */
const PDF_STATE_KEY = 'files.pdfText'

/**
 * 提取 PDF 正文，同一文件在一个 run 内只提取一次。
 *
 * 不缓存时 offset/limit 分页读取是 O(n²)：提取一页必须先解析整份文档，
 * 而翻页正是模型收到「已截断」之后必然执行的操作（实测一页约 550 ms，
 * 两百页的文档每翻一页都要付出解析整份文档的开销）。
 *
 * 键中包含 `mtimeMs:size`：文件被修改后即为另一份内容，缓存不会命中。
 * 判据与图像块的指纹（`ai` 的 `ImageSource.stamp`）使用同一组字段，不另设规则。
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

  // 动态 import：`unpdf` 大小为 2.4 MB，绝大多数会话不读取任何 PDF，
  // 顶层引入会使每次启动进程都付出一次解析开销。
  const { extractText, getDocumentProxy } = await import('unpdf')
  const bytes = new Uint8Array(await readFile(abs))
  const doc = await getDocumentProxy(bytes)
  // `mergePages: true` 时返回单个字符串；类型上仍是联合类型，此处收窄一次。
  const { text } = await extractText(doc, { mergePages: true })
  const out = String(text)
  cache.set(key, out)
  return out
}

/**
 * 二进制检测：NUL 字节。
 *
 * 使用转义写法，不要把控制字符直接嵌入正则字面量：后者在编辑器和 diff 中不可见，
 * 修改者无法看出该行匹配的内容。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 有意匹配 NUL，这是判断文件是否为二进制的标准做法
const BINARY_SNIFF = /\x00/

/** 一次按行读取的结果：请求范围内保留下来的行、文件总行数、范围内的行是否全部保留、整份正文的哈希。 */
interface LineScan {
  lines: string[]
  total: number
  complete: boolean
  digest: string
}

/**
 * 按行读取正文：只保留从第 `offset` 行起至多 `limit` 行、累计不超过 `keepBytes` 的行（至少一行），
 * 同时统计总行数并计算整份正文的哈希。行按 LF 切分并去除行尾的 CR，结果与先 `toLf` 再按 `\n` 切分相同。
 *
 * 开头 4096 个字符中有 NUL 即判定为二进制，不再继续读取。
 * 不要改为把整份文件读入内存再切分：几百 MB 的日志放入一个字符串即占用几百 MB 的 UTF-16 内存，
 * 而一次最多只能投递一个上下文窗口的量。
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
 * 把文件正文按 UTF-8 流式解码为字符串片段。
 *
 * 使用 `StringDecoder` 而不是 `TextDecoder`：前者与 `readFile(abs, 'utf8')` 规则相同（保留 BOM、
 * 非法字节的替换方式相同），写入与编辑一侧按后者计算哈希，两侧解码不一致时会始终判定为读取之后已被修改。
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

/** 把已在内存中的正文（PDF 提取结果）作为一个片段交给 `scanLines`。 */
async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text
}

/**
 * 无法作为文本读取的文件的回执。
 *
 * 必须给出下一步，并明确说明不要再次读取。只返回「无法作为文本读取」时，模型只能更换
 * 参数再读取一次，而每次都会失败。音频与压缩包另需说明：请求体中没有
 * 它们的内容块，更换模型也无效。视频在此之前单独分派（`readVideo`）。
 */
function notText(path: string, office: boolean): { status: 'failure'; message: string } {
  if (office && OFFICE_FILE.test(path)) {
    return {
      status: 'failure',
      message: `${path} 是 Office 文件，read_file 无法读取其内容。用 read_office 读取其结构与文字。`,
    }
  }
  return {
    status: 'failure',
    message:
      `${path} 不是文本文件，无法读取内容。不要再读取该文件：` +
      `音频与压缩包无法作为文本读取，也不能作为内容发给模型；` +
      `如需其中的信息，用 run_command 调用外部工具处理，或请用户描述。`,
  }
}

/** 视频读取的区间（秒）。不合法时返回给模型的原因说明。 */
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
 * 读取一段视频。使用原生视频还是抽帧由 `agent` 的 `videoDelivery` 判定，与发送时使用同一判据：
 * 原生时返回路径引用，由请求装配在发出前内联或上传（`videosOf` 与 `materialize`），
 * 按一份 `MEDIA_TOKENS` 扣除投递额度。
 *
 * 抽帧时经 Office 的 Python worker 按时间取帧，帧作为图片返回（`readVideoFrames`），
 * `start` / `end` 指定区间。无法读取时在此处直接拒绝并说明下一步：若返回路径，
 * 发送时会被替换为一句说明，本次读取没有产出，而回执显示成功。
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
    // 模型接受原生视频，但该视频过大且无法上传时同样抽帧：内联的视频在下一步即被移出请求，模型只能看到一次。
    const cause = ctx.video
      ? `该视频 ${(size / 1024 / 1024).toFixed(1)} MB，超出请求中常驻媒体的上限，且当前接口不支持上传`
      : '当前模型不接受原生视频'
    if (ctx.vision === false) {
      return {
        status: 'failure',
        message:
          `${ctx.video ? `${cause}，` : ''}当前模型既不接受视频也不接受图片，${shown} 无法读取内容。` +
          `不要再读取该文件：更换支持图片或视频的模型，或请用户描述视频内容。`,
      }
    }
    if (!ctx.office) {
      return {
        status: 'failure',
        message:
          `${cause}，按时间抽帧需要 Office 的 Python 运行环境，当前没有可用的环境，${shown} 无法读取内容。` +
          `不要再读取该文件：更换支持视频的模型，或请用户描述视频内容。`,
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
    '回执写明已看到的时间点与未看到的区间，start/end（秒）指定续读区间；' +
    'PDF 提取正文后作为文本返回（不保留版式，中文可能出现同形异码，不适用于逐字匹配；没有文字层时返回失败）。' +
    '修改任何已存在的文件前必须先用本工具读取一次：' +
    'write_file 和 edit_file 会校验已读取的内容是否仍是磁盘上的最新版本。' +
    '默认读取整个文件；超出上下文剩余空间时返回可容纳的部分与续读位置。读取指定范围时用 offset/limit。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      offset: { type: 'integer', description: '起始行号（1 起），默认 1' },
      limit: { type: 'integer', description: '最多读取行数，默认读取到文件末尾' },
      start: { type: 'number', description: '视频抽帧区间的起点（秒），默认从开头。只对视频有效' },
      end: { type: 'number', description: '视频抽帧区间的终点（秒），默认到结尾。只对视频有效' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '文件',
  category: 'files',
  facet: '读写',
  summary: '读取文件（默认读取全文，可分段读取）',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'read',
  // 读操作互不干扰，可以并行；资源键使同一文件的读写不会进入同一批。
  parallelSafe: true,
  resourceKeys: (a) => (typeof a.path === 'string' ? [`file:${a.path}`] : []),
  async fn(args, ctx) {
    const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path), { mustExist: true })
    const info = await stat(abs)
    if (info.isDirectory()) {
      return { status: 'failure', message: `${args.path} 是目录，请用 list_dir` }
    }

    /*
     * 图片与 PDF 在二进制检测之前分派：它们开头的字节中有 NUL，放在按行读取之后会先被判定为
     * 二进制而拒绝。这两类各有上限。
     */
    // PDF 提取缓存的键：文件修改后即为另一份内容，缓存不会命中。
    const fingerprint = `${Math.trunc(info.mtimeMs)}:${info.size}`
    if (isInlineImage(abs)) {
      /*
       * 当前模型不接受图片：在读取字节之前即拒绝，并完整说明原因。
       *
       * 判据只接受 `false`（约定见 `ai` 的 `ModelSpec.vision`）。此处拒绝的操作
       * 重试必然失败，因此消息中必须给出下一步操作：只说明
       * 「读取失败」时，模型只能原样再读取一次，而每次都会失败。
       */
      if (ctx.vision === false) {
        return {
          status: 'failure',
          message:
            `当前模型不接受图片输入，${displayPath(ctx.workspaceRoot, abs)} 无法读取内容。` +
            `不要再读取该文件：更换支持图片的模型，或请用户描述图片内容。`,
        }
      }
      if (info.size > MAX_IMAGE_BYTES) {
        return {
          status: 'failure',
          message: `图片过大（${Math.round(info.size / 1024 / 1024)} MB），上限 10 MB`,
        }
      }
      // 余量不足以容纳一张图时仍然投递：报告失败的回合不产出内容，超出的部分由下一次发送前的压缩回收。
      if (!chargeBatchBudget(ctx, MEDIA_TOKENS).ok) recordBatchSpent(ctx, MEDIA_TOKENS)
      /*
       * 记录一次读取，且只在图像确实返回时记录。图片不经过下方文本分支的 `readHashes(...).set`，
       * 此处不记录时，模型读取图片后对同一路径执行 `write_file` 会被拒绝为「尚未读取」，
       * 按提示重新读取后仍被拒绝，该提示即为错误陈述。
       *
       * 按 utf8 解码后再计算哈希，不按原始字节计算。判据是与校验方计算的值是否相同：
       * `write_file` 一侧按 utf8 读取（`readFile(abs, 'utf8')`）。
       * 对二进制而言该解码有损，但它是确定性的，两侧计算结果一致即可。
       */
      readHashes(ctx).set(abs, hash(await readFile(abs, 'utf8')))
      /*
       * 超出上限时才缩放，在上限内原样通过，不要读取图像后无条件重编码：
       * 一张 1440×900 的网页截图重编码后体积增大到 2.4 倍（实测，见 `image.ts`）。
       */
      const raw = new Uint8Array(await readFile(abs))
      const fit = await shrinkImage(raw, mimeOf(abs))
      const shrunk = { data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime }
      const note = fit.bytes.length < raw.length ? '，已缩放' : ''
      return {
        status: 'success',
        message: `读取 ${displayPath(ctx.workspaceRoot, abs)}（图片${note}）`,
        /*
         * 字节在读取时固定保存，不返回路径。
         *
         * 一次读取是一次观察，观察结果应保留在执行记录中，与本工具读取
         * 文本、`run_command` 保留 stdout 相同。
         *
         * 返回路径时，记录中保存的是查看位置而不是观察到的内容，而该位置的内容
         * 会变化：模型修改页面后重新截图覆盖同名文件（对比修改前后的
         * 常规操作），历史中的原图像无法再取回。捕获必须发生在观察时，
         * 事后无法补救。
         *
         * 附件不经过此处，由 `runtime` 的 `withAttachments` 在每次发送前按路径编码：
         * 附件是用户自己的文件，无需复制。判据是这是一次观察还是一个引用。
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
      // 没有文字层（扫描件、纯图片页）时返回空正文会被理解为该 PDF 没有内容。
      // 下一步只指向本轮实际可用的能力：office 未启用或模型不接受图片时，指向它必然导致一次失败的调用。
      if (!pdf.trim()) {
        return {
          status: 'failure',
          message:
            ctx.office?.enabled() === true && ctx.vision !== false
              ? `${args.path} 没有文字层（扫描件或纯图片页），read_file 无法读取内容。用 view_office 按页查看。`
              : `${args.path} 没有文字层（扫描件或纯图片页），read_file 无法读取内容，当前也没有查看 PDF 页面的工具。`,
        }
      }
    }

    // 无法解析为整数时在此处终止。`Math.max` 是下界钳位（`offset: 0` 取 1），无法拦截 NaN：
    // `Math.max(1, NaN)` 仍为 NaN，继续执行会得到一次「成功读取 0 行」。
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

    // 只保留本轮额度能容纳的行：保留量取余量折算为字节后的上界，计量后不超额度的前缀必然在其范围内。
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
     * 由所请求范围的前 n 行组成的结果。
     *
     * 正文经过脱敏处理。该路径不接入凭证保护时，`read_file` 会把磁盘上的字节直接交给模型：
     * 工作区中的 `.env`、误提交的私钥、`config/*.local.json` 中的 token，读取一次即进入上下文
     * 并随下一次请求发送给 provider，且无法撤回。模型无法取得 `cat .env` 的输出，却能经由 `read_file`
     * 取得时，拦截即失效。脱敏只作用于交给模型的文本，磁盘上的文件不做任何修改；
     * `edit_file` 的读取校验使用原文哈希，不受影响。
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
            `超出上下文剩余空间，从 offset=${end + 1} 续读；已读取的段落在压缩时会被折叠，要点写在回复中。`,
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

    // 哈希按磁盘原文计算：它表示磁盘上的当前内容；改用归一后的文本时，
    // 无法检测到文件行尾被他人修改。只有交给模型的正文经过归一。
    // 只在确实返回内容之后记录：失败的读取不能作为 edit 的前置证据。
    const markRead = () => readHashes(ctx).set(abs, scan.digest)

    /*
     * 投递：所请求的范围能够整份容纳时整份返回；否则返回可容纳的最长行前缀与下一行的 offset，
     * 不拒绝。拒绝的回合不产出正文，模型只能按建议再读取一次。
     *
     * 行数用二分法按实际结果计量，不要按平均行长估算：行长不均时估算出的行数会超出额度。
     */
    const whole = firstLines(slice.length)
    if (scan.complete && chargeBatchBudget(ctx, outcomeTokens(whole, ctx.density)).ok) {
      markRead()
      return { status: 'success', ...whole }
    }
    const remaining = deliveryCap(ctx)
    // 余量连一段都无法容纳时仍返回 `MIN_DELIVERY_BYTES` 以内的整行，不报告失败。
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

    // 第一行即超出额度：行偏移无法定位到行中间，因此把该行保存一次，按字节续读。
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
        message: `${message}，该行只投递了开头部分${nextLine === null ? '' : `，下一行从 offset=${nextLine} 用 read_file 读取`}。${note}`,
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

/** 没有配置任何 secret 时使用的空集合。按格式脱敏与它无关，照常生效。 */
const EMPTY_SECRETS = { values: [] }

export const writeFileTool: ToolSpec = {
  name: 'write_file',
  description:
    '写入整个文件，必须用 mode 明确区分新建与覆盖修改。' +
    'create 只新建，不覆盖已有文件；重名时自动追加 -2、-3 等后缀，写入未占用的名称，无需重新生成，后续操作使用回执中的实际 path。' +
    '用户明确要求必须使用原文件名时传 on_conflict=error，重名即失败、不写入。' +
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
          '新建重名时的处理，默认 rename：自动追加 -2、-3 等后缀。error：重名即失败，用于用户明确要求必须使用原文件名的情况。覆盖修改不能使用 rename。',
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
  summary: '写入整个文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    const mode = args.mode
    const conflict = args.on_conflict ?? (mode === 'create' ? 'rename' : 'error')
    if (
      (mode !== 'create' && mode !== 'overwrite') ||
      (conflict !== 'error' && conflict !== 'rename') ||
      (mode === 'overwrite' && conflict === 'rename')
    ) {
      return {
        status: 'failure',
        executed: false,
        message:
          'mode 必须为 create 或 overwrite；on_conflict 必须为 error 或 rename，rename 仅用于新建文件。',
        errorKind: 'invalid_tool_arguments',
      }
    }
    const requested = String(args.path)
    const content = String(args.content)
    let abs: string
    let existing: string | null = null
    let bytes = content
    /** 原名已被占用，已改用带后缀的名称。 */
    let renamed = false
    if (mode === 'create') {
      const { dir, name, ext } = parse(requested)
      for (let suffix = 1; ; suffix++) {
        ctx.signal.throwIfAborted()
        const candidate = suffix === 1 ? requested : join(dir, `${name}-${suffix}${ext}`)
        abs = await resolveWritablePath(rootsOf(ctx), candidate, { followFinalSymlink: false })
        await mkdir(dirname(abs), { recursive: true })
        // 悬空符号链接同样占用名称，不能只依赖 wx 对目标存在性的检查。
        const occupied = await lstat(abs).then(
          () => true,
          (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return false
            throw err
          },
        )
        if (!occupied) {
          try {
            // 独占创建（`wx`）处理检查名称之后被其他创建者占用的情况；内容在本次调用内复用。
            await writeFile(abs, bytes, { encoding: 'utf8', flag: 'wx' })
            renamed = suffix > 1
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
            '核对目录中的文件名，再选择未占用的路径；若必须使用该名称，请先确认已有文件应如何处理。',
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
          message: `${requested} 尚未读取，已拒绝覆盖修改。先 read_file 再覆盖。`,
          errorKind: 'stale_write',
        }
      }
      if (seen !== hash(existing)) {
        return {
          status: 'failure',
          executed: false,
          message: `${requested} 在读取之后已被修改，已拒绝覆盖。请重新 read_file。`,
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
    // 记录的必须是落盘后的内容：记录 content 时，下一次 edit_file 会立即判定文件在读取后已被修改。
    readHashes(ctx).set(abs, hash(bytes))

    const change: FileChange = {
      path: displayPath(ctx.workspaceRoot, abs),
      changeType: existing === null ? 'created' : 'modified',
      // 两侧都归一后再比较：否则整份行尾变化会被报告为每一行都已修改。
      ...countDiff(toLf(existing ?? ''), toLf(bytes)),
    }
    return {
      status: 'success',
      message:
        existing !== null
          ? `写入 ${change.path}`
          : renamed
            ? `${requested} 已存在，已创建 ${change.path}`
            : `创建 ${change.path}`,
      data: { path: change.path },
      fileChanges: [change],
    }
  },
}

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    '在一个文件中按顺序执行一组精确文本替换，同一文件的多处修改放在同一次调用的 edits 中。' +
    '每一项的 old_string 必须在文件中恰好出现一次：出现 0 次或多次时该项不写入，回执给出实际次数，' +
    '此时请加长 old_string 使其唯一。各项依次在前一项替换后的内容上执行；命中的项写入文件，' +
    '未写入的项在回执中逐项列出，只需重新提交这些项。' +
    '调用前必须先 read_file。修改已有文件优先使用本工具：替换范围由 old_string 限定，不影响文件其余内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      edits: {
        type: 'array',
        description: '按顺序执行的替换',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: '要被替换的原文，需含足够上下文以保证唯一' },
            new_string: { type: 'string', description: '替换后的文本' },
            replace_all: { type: 'boolean', description: '为 true 时替换全部出现处' },
          },
          required: ['old_string', 'new_string'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '文件',
  category: 'files',
  facet: '读写',
  summary: '按精确字符串替换修改一个文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    const abs = await resolveWritablePath(rootsOf(ctx), String(args.path), {
      mustExist: true,
    })
    const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : []
    if (edits.length === 0) {
      return { status: 'failure', message: 'edits 不能为空', errorKind: 'invalid_tool_arguments' }
    }

    const current = await readFile(abs, 'utf8')
    const seen = readHashes(ctx).get(abs)
    if (seen === null) {
      return {
        status: 'failure',
        message: `${args.path} 尚未读取。先 read_file。`,
        errorKind: 'stale_write',
      }
    }
    if (seen !== hash(current)) {
      return {
        status: 'failure',
        message: `${args.path} 在读取之后已被修改。请重新 read_file。`,
        errorKind: 'stale_write',
      }
    }

    /*
     * 定位时不区分行尾，在原文上执行。
     *
     * 模型看到的正文经过归一（`read_file` 返回时去除了 CR），它复述的
     * `old_string` 必然是 LF；而 CRLF 文件中各行之间是 `\r\n`。用原串精确匹配时，
     * 跨行的 old_string 在 CRLF 文件上始终无法匹配，而目标仓库的行尾不受本仓库控制。
     *
     * 只替换命中的片段，其余字节原样保留：混合行尾的文件不会因一次单行编辑
     * 被整份重写。
     *
     * 各项逐一生效，未命中的项跳过。不要改为整组不写入：一项未命中即须重发全部项。
     */
    const eol = dominantEol(current)
    let next = current
    const skipped: { index: number; message: string; errorKind: 'no_match' | 'ambiguous_match' }[] =
      []
    edits.forEach((edit, index) => {
      const oldStr = String(edit.old_string ?? '')
      const replaceAll = edit.replace_all === true
      const hits = oldStr
        ? [...next.matchAll(new RegExp(eolInsensitivePattern(oldStr), 'g'))].map((m) => ({
            at: m.index,
            len: m[0].length,
          }))
        : []
      if (hits.length === 0) {
        skipped.push({ index, message: 'old_string 未在文件中找到', errorKind: 'no_match' })
        return
      }
      if (hits.length > 1 && !replaceAll) {
        skipped.push({
          index,
          message: `old_string 命中 ${hits.length} 处，不唯一。请加长上下文，或设 replace_all=true`,
          errorKind: 'ambiguous_match',
        })
        return
      }
      // 替换片段按文件的主导行尾编码。从后向前拼接：从前向后拼接时，前一次替换会使后续下标全部偏移。
      const replacement = fromLf(String(edit.new_string ?? ''), eol)
      for (let i = (replaceAll ? hits.length : 1) - 1; i >= 0; i--) {
        const hit = hits[i]
        if (!hit) continue
        next = next.slice(0, hit.at) + replacement + next.slice(hit.at + hit.len)
      }
    })

    const notes = skipped.map((s) => `第 ${s.index + 1} 项未写入：${s.message}`)
    const first = skipped[0]
    if (skipped.length === edits.length && first) {
      return { status: 'failure', message: notes.join('\n'), errorKind: first.errorKind }
    }
    await writeFile(abs, next, 'utf8')
    readHashes(ctx).set(abs, hash(next))

    const change: FileChange = {
      path: displayPath(ctx.workspaceRoot, abs),
      changeType: 'modified',
      ...countDiff(current, next),
    }
    const written = `编辑 ${change.path}（${edits.length - skipped.length}/${edits.length} 项已写入）`
    // 部分写入记为失败：文件已改动，但请求未全部完成；fileChanges 照常记录实际改动。
    if (first) {
      return {
        status: 'failure',
        message: [written, ...notes].join('\n'),
        errorKind: first.errorKind,
        fileChanges: [change],
      }
    }
    return { status: 'success', message: written, fileChanges: [change] }
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
  summary: '列出一个目录下的条目',
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
 * 单次比对的最大编辑距离。超过时按上限报告：差异达到该程度基本等同于整份替换。
 *
 * 复杂度为 O(D²)，实测 D=4000 约 55ms、D=10000 约 350ms，更大时达到分钟级：
 * 几万行的生成文件被整份覆盖时，不设上限会使本次工具调用长时间阻塞。
 * 不要在此处退回其他算法：同一字段混用两套统计口径比数值偏大更糟。
 */
const MAX_EDIT = 4000

/**
 * 行级增删统计，供 UI 的「+x −y」展示。
 *
 * 必须按位置比较，不能按该行是否在旧文件中出现过比较。后者会把空行、`}`、
 * 注释框架行，以及旧文件中其他位置恰好存在相同内容的任何一行都计为未新增，整块移动更会
 * 直接计为 0：实测本仓库 128 个文件对少报 24.7%，其中三分之二是空行、括号和注释框架。
 *
 * 使用 Myers 贪心算法，只求编辑距离而不还原路径：D = 增 + 删，而增 − 删 = 新行数 − 旧行数，
 * 由两式解出两个数。先裁剪公共前后缀：实际改动裁剪后通常只剩几十行，这是该算法速度快的
 * 全部原因；不裁剪时每次编辑都按整个文件长度计算。
 */
function countDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  // 为空的一侧不进入循环：结果可直接得出，而 Myers 需要完整迭代一轮才收敛。
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

  // v[k] = 对角线 k 上能到达的最远 x。max 是下标偏移，使 k 为负时下标仍在数组范围内。
  const max = n + m
  const v = new Int32Array(2 * max + 1)
  const limit = Math.min(max, MAX_EDIT)
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      // k = ±max 时这两个下标会超出数组范围，取 0 正是该情况所需的值（尚未前进过）。
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
