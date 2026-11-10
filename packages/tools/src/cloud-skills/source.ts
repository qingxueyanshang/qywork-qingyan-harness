/**
 * 云端技能包的只读访问（`CloudSkillPort`）：虚拟路径，以及按行段投递。云端技能不进入技能索引，不经过 `read_skill`。
 *
 * 不变量：
 * - 云端技能目录以 `cloud-skill://<技能包>` 表示，技能内的文件为该目录下的相对路径。读取类工具
 *   （`read_file`、`list_dir`、`glob`、`grep`）在本会话提供了端口时识别该路径；未提供时这些工具不经过本模块。
 * - 本机不持有原文：读取结果的正文是标记，放在 `data.texts` 中（`@qywork/agent` 的 `textsOf`），
 *   估算、额度、压缩与锚点都按其中的特征计数计。标记不写入 `message` 或 `data` 的其余字段。
 * - 超出单次投递上限时按行段部分投递，并给出续读的起始行。本机没有正文，不按字节截取，也不落盘。
 */

import {
  type CloudSkillErrorCode,
  type CloudSkillPort,
  type CloudSkillSegment,
  chargeBatchBudget,
  outcomeTokens,
  recordCappedSpent,
  type ToolContext,
  type ToolOutcome,
  tokensToMaxBytes,
} from '@qywork/agent'
import { badIntMessage, intArg } from '../args.ts'
import { IGNORED_DIRS } from '../paths.ts'
import { MIN_DELIVERY_BYTES } from '../sink.ts'

/** 云端技能目录的路径前缀。 */
export const CLOUD_SKILL_SCHEME = 'cloud-skill://'

export function cloudSkillDir(pkg: string): string {
  return `${CLOUD_SKILL_SCHEME}${pkg}`
}

/** 一个云端技能路径：技能包与包内的相对路径（空串为技能目录本身）。 */
export interface CloudTarget {
  port: CloudSkillPort
  pkg: string
  path: string
  /** 回执中显示的路径，即模型传入的规范形式。 */
  shown: string
}

function failure(message: string, errorKind: string): ToolOutcome {
  return { status: 'failure', message, errorKind }
}

/**
 * `raw` 是云端技能路径时返回目标，路径不合法或技能包不属于本会话时返回失败结果；
 * 本会话没有云端技能通道或 `raw` 不是云端技能路径时返回 null，调用方按本地路径处理。
 */
export function cloudTarget(
  ctx: Pick<ToolContext, 'cloudSkills'>,
  raw: unknown,
): CloudTarget | ToolOutcome | null {
  const port = ctx.cloudSkills
  if (!port || typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text.startsWith(CLOUD_SKILL_SCHEME)) return null
  const [pkg = '', ...rest] = text.slice(CLOUD_SKILL_SCHEME.length).replaceAll('\\', '/').split('/')
  if (!port.packages.includes(pkg)) {
    return failure(`本会话没有云端技能包：${pkg}`, 'not_found')
  }
  const parts = rest.filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) return failure(`云端技能路径不能包含 ..：${text}`, 'invalid_args')
  const path = parts.join('/')
  return { port, pkg, path, shown: path ? `${cloudSkillDir(pkg)}/${path}` : cloudSkillDir(pkg) }
}

/** 写入类工具收到云端技能路径时的结果。 */
export function cloudReadOnly(target: CloudTarget): ToolOutcome {
  return failure(`云端技能只读，不能写入：${target.shown}`, 'permission_denied')
}

/** 云端读取失败的一句说明。错误码原样作为 `errorKind`。 */
export function cloudFailure(
  error: { code: CloudSkillErrorCode; message: string },
  target: CloudTarget,
): ToolOutcome {
  const text: Record<CloudSkillErrorCode, string> = {
    skill_not_granted: `未获得云端技能包 ${target.pkg} 的使用权益，无法读取。`,
    skill_version_not_found: `云端技能包 ${target.pkg} 没有可读取的版本。`,
    skill_file_not_found: `云端技能包中没有该文件：${target.shown}`,
    skill_file_binary: `${target.shown} 不是文本文件，无法读取。`,
    skill_range_invalid: `读取 ${target.shown} 失败：${error.message}`,
    invalid_request: `读取 ${target.shown} 失败：${error.message}`,
    unavailable: `无法读取云端技能：${error.message}`,
  }
  return failure(text[error.code], error.code)
}

/** `start`/`end` 行段投递后的回执；`complete` 为 false 时是部分投递。 */
type Describe = (
  segment: CloudSkillSegment,
  complete: boolean,
) => { message: string; data: Record<string, unknown> }

/**
 * 按行段二分时最多再读取的次数。每次读取签发一个标记；文件各行长度相近时，按比例取的第一个行段通常即接近上限。
 */
const MAX_PROBES = 8

/**
 * 投递第 `start` 行起的行段：`limit` 为 null 时到文件末尾。能整份容纳时整份投递；否则按特征计数找出
 * 不超过单次投递上限（`chargeBatchBudget` 返回的 `cap`）的最长行段部分投递，记为触及上限（`recordCappedSpent`）。
 *
 * 一行都无法容纳时，该行的字节上界（`tokensToMaxBytes`）不超过 `MIN_DELIVERY_BYTES` 即照常投递该行，
 * 与本地文件的最小份额同一含义；更长的行无法拆分，返回失败并写明该行的估算与上限。
 */
async function deliverCloudLines(
  ctx: ToolContext,
  target: CloudTarget,
  start: number,
  limit: number | null,
  describe: Describe,
): Promise<ToolOutcome> {
  const { port, pkg, path } = target
  let read = await port.read(pkg, path, start)
  if (read.ok && limit !== null && start + limit - 1 < read.value.end) {
    read = await port.read(pkg, path, start, start + limit - 1)
  }
  if (!read.ok) return cloudFailure(read, target)

  const outcome = (segment: CloudSkillSegment, complete: boolean) => {
    const { message, data } = describe(segment, complete)
    return {
      message,
      data: { ...data, texts: [{ text: segment.marker, features: segment.features }] },
    }
  }
  const whole = outcome(read.value, true)
  const charged = chargeBatchBudget(ctx, outcomeTokens(whole, ctx.density))
  if (charged.ok) return { status: 'success', ...whole }

  const cost = (segment: CloudSkillSegment) => outcomeTokens(outcome(segment, false), ctx.density)
  let fit: CloudSkillSegment | null = null
  let lo = start - 1
  let loCost = 0
  let over = read.value
  let overCost = cost(over)
  for (let probe = 0; probe < MAX_PROBES && over.end - lo > 1; probe++) {
    const share = (charged.cap - loCost) / Math.max(1, overCost - loCost)
    const mid = Math.min(over.end - 1, Math.max(lo + 1, lo + Math.floor((over.end - lo) * share)))
    const next = await port.read(pkg, path, start, mid)
    if (!next.ok) return cloudFailure(next, target)
    const c = cost(next.value)
    if (c <= charged.cap) {
      fit = next.value
      lo = mid
      loCost = c
    } else {
      over = next.value
      overCost = c
    }
  }
  if (!fit && over.end > start) {
    const line = await port.read(pkg, path, start, start)
    if (!line.ok) return cloudFailure(line, target)
    over = line.value
    overCost = cost(over)
    if (overCost <= charged.cap) fit = over
  }
  if (!fit && tokensToMaxBytes(overCost) <= MIN_DELIVERY_BYTES) fit = over
  if (!fit) {
    return failure(
      `${target.shown} 第 ${start} 行约 ${overCost} token，超出本次可投递的 ${charged.cap} token。`,
      'over_budget',
    )
  }
  const part = outcome(fit, false)
  recordCappedSpent(ctx, outcomeTokens(part, ctx.density))
  return { status: 'success', ...part }
}

/** `read_file` 读取云端技能文件：`offset` / `limit` 对应行段，回执的形状与本地文本文件相同，正文是标记。 */
export async function readCloudFile(
  ctx: ToolContext,
  target: CloudTarget,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (args.region !== undefined) {
    return failure(`region 只对图片有效，${target.shown} 不是图片`, 'invalid_args')
  }
  const rawOffset = intArg(args.offset, 1)
  const rawLimit = intArg(args.limit, Number.MAX_SAFE_INTEGER)
  if (rawOffset === null || rawLimit === null) {
    const bad = rawOffset === null ? 'offset' : 'limit'
    return failure(badIntMessage(bad, args[bad]), 'invalid_args')
  }
  const limit = args.limit === undefined || args.limit === null ? null : Math.max(1, rawLimit)
  return deliverCloudLines(ctx, target, Math.max(1, rawOffset), limit, (s, complete) => ({
    message: complete
      ? `读取 ${target.shown}（${s.end - s.start + 1} 行${s.end < s.lines ? '，已截断' : ''}）`
      : `读取 ${target.shown} 第 ${s.start}–${s.end} 行（共 ${s.lines} 行）。` +
        `超出上下文剩余空间，从 offset=${s.end + 1} 续读；已读取的段落在压缩时会被折叠，要点写在回复中。`,
    data: {
      startLine: s.start,
      endLine: s.end,
      totalLines: s.lines,
      truncated: s.end < s.lines,
      ...(complete ? {} : { nextOffset: s.end + 1 }),
    },
  }))
}

/** 路径中有一段以 `.` 开头或属于 `IGNORED_DIRS`：与本地 `glob` 跳过的条目相同。 */
export function hiddenPath(rel: string): boolean {
  return rel.split('/').some((seg) => seg.startsWith('.') || IGNORED_DIRS.has(seg))
}

/** `list_dir` 列出云端技能目录：由技能包的文件清单得出该目录的直接子项，目录在前。 */
export async function listCloudDir(target: CloudTarget): Promise<ToolOutcome> {
  const files = await target.port.files(target.pkg)
  if (!files.ok) return cloudFailure(files, target)
  if (files.value.some((f) => f.path === target.path)) {
    return failure(`${target.shown} 是文件，请用 read_file`, 'invalid_args')
  }
  const prefix = target.path ? `${target.path}/` : ''
  const dirs = new Set<string>()
  const names = new Set<string>()
  let found = false
  for (const f of files.value) {
    if (!f.path.startsWith(prefix)) continue
    found = true
    const rest = f.path.slice(prefix.length)
    const at = rest.indexOf('/')
    const name = at < 0 ? rest : rest.slice(0, at)
    if (at >= 0 && IGNORED_DIRS.has(name)) continue
    if (name.startsWith('.') && name !== '.env.example') continue
    if (at < 0) names.add(name)
    else dirs.add(name)
  }
  if (!found) return failure(`云端技能包中没有该目录：${target.shown}`, 'not_found')
  const sorted = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b))
  const entries = [...sorted(dirs).map((d) => `${d}/`), ...sorted(names)]
  return {
    status: 'success',
    message: `${target.shown}：${entries.length} 项`,
    data: { entries },
  }
}
