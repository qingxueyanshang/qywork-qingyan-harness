/**
 * 云端技能标记：本机持有并随请求回传的一行文本，云端网关转发请求时把它替换为云端保存的技能文件中的一个行段。
 * 云端读取接口签发，网关校验；本机只解析与回传，不校验签名，签名密钥只在云端。
 *
 * 格式（一行，字段顺序固定，字段之间一个空格）：
 *
 *   [[qyskill/<契约版本> pkg=<技能包> path=<文件路径> sha256=<内容哈希> lines=<起>-<止> f=<特征计数> sig=<签名>]]
 *
 * - 行以 `\n` 分隔，从 1 起计，含两端。替换内容是这些行以 `\n` 连接的文本，末行之后不带换行。
 * - `sha256` 是整个文件字节的 SHA-256（小写十六进制）。内容按哈希寻址，同一哈希的内容不会改变。
 * - `f` 是替换内容的文本特征计数（`textFeatures`），按 `TEXT_FEATURES` 的顺序以逗号连接，供本机估算占用。
 * - `sig` 是 HMAC-SHA256（base64url），覆盖账号与签名之前的全部文本：任一字段被改动，或换一个账号使用，校验即失败。
 * - 全部字符都不会被 `JSON.stringify` 转义：路径中的 `%`、空白、控制字符、引号、反斜杠与 `]` 按百分号编码，
 *   其余字符原样保留。不要放宽编码范围：被转义的字符会使请求体中的标记与此处的文本不一致，网关无法按整行匹配。
 * - 解析只接受规范形式：按解析结果重新生成的文本须与原文逐字相同，因此同一组字段只有一种写法。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { TEXT_FEATURES, type TextFeature, textFeatures } from '../tokens.ts'

/** 契约版本。格式或签名覆盖范围改变时加一，旧版本的标记不再被解析。 */
export const SKILL_MARKER_VERSION = 1

/** 标记的开头。网关先按它筛选候选行，再完整解析。 */
export const SKILL_MARKER_PREFIX = `[[qyskill/${SKILL_MARKER_VERSION} `

/** 标记指向的内容：技能包中一个文件的一个行段。 */
export interface SkillSegmentRef {
  pkg: string
  /** 技能包内的相对路径，以 `/` 分隔。 */
  path: string
  /** 文件字节的 SHA-256，小写十六进制。 */
  hash: string
  /** 起始行，从 1 起计。 */
  start: number
  /** 结束行，含该行。 */
  end: number
}

export interface SkillMarker extends SkillSegmentRef {
  /** 替换内容的文本特征计数（`textFeatures`）。 */
  features: Record<TextFeature, number>
  sig: string
}

const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HASH = /^[0-9a-f]{64}$/
/** 版本号与数值的规范形式不在此判定，由解析末尾的「重新生成后逐字相同」统一判定。 */
const MARKER =
  /^\[\[qyskill\/\d+ pkg=(\S+) path=(\S+) sha256=(\S+) lines=(\d+)-(\d+) f=(\d+(?:,\d+){9}) sig=([A-Za-z0-9_-]{43})\]\]$/
/** 路径中需要百分号编码的字符。`\s` 含全角空格与行分隔符：它们会使整行匹配与显示产生歧义。 */
const ENCODED = /[%\s"\\\]\p{Cc}]/gu
/** 未配对的代理项：`JSON.stringify` 会把它转义为 `\uXXXX`。 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** 技能包标识：小写字母或数字开头，其后为小写字母、数字、`.`、`_`、`-`，至多 64 个字符。 */
export function isSkillPackageId(id: string): boolean {
  return PACKAGE_ID.test(id)
}

function encodePath(path: string): string {
  return path.replace(ENCODED, (c) => encodeURIComponent(c))
}

function body(m: SkillSegmentRef & { features: Record<TextFeature, number> }): string {
  const f = TEXT_FEATURES.map((k) => m.features[k]).join(',')
  return `${SKILL_MARKER_PREFIX}pkg=${m.pkg} path=${encodePath(m.path)} sha256=${m.hash} lines=${m.start}-${m.end} f=${f}`
}

function signature(text: string, account: string, key: Uint8Array): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([account, text]))
    .digest('base64url')
}

function format(m: SkillMarker): string {
  return `${body(m)} sig=${m.sig}]]`
}

/**
 * 签发标记。`segment` 是该行段的替换内容，特征计数由它算出。
 * 字段不合法时抛出：标记只由云端按数据库中的记录签发，不合法即为调用方的错误。
 */
export function issueSkillMarker(
  ref: SkillSegmentRef,
  segment: string,
  account: string,
  key: Uint8Array,
): { text: string; features: Record<TextFeature, number> } {
  if (!PACKAGE_ID.test(ref.pkg)) throw new Error(`技能包标识不合法：${ref.pkg}`)
  if (!ref.path || LONE_SURROGATE.test(ref.path)) throw new Error(`路径不合法：${ref.path}`)
  if (!HASH.test(ref.hash)) throw new Error(`内容哈希不合法：${ref.hash}`)
  if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end)) {
    throw new Error(`行段不合法：${ref.start}-${ref.end}`)
  }
  if (ref.start < 1 || ref.end < ref.start) throw new Error(`行段不合法：${ref.start}-${ref.end}`)
  const features = textFeatures(segment)
  const unsigned = body({ ...ref, features })
  return { text: `${unsigned} sig=${signature(unsigned, account, key)}]]`, features }
}

/** 解析一行文本。不是规范形式的标记时返回 null；不校验签名。 */
export function parseSkillMarker(text: string): SkillMarker | null {
  const m = MARKER.exec(text)
  if (!m) return null
  const [, pkg = '', rawPath = '', hash = '', start = '', end = '', f = '', sig = ''] = m
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  const counts = f.split(',').map(Number)
  const features = Object.fromEntries(TEXT_FEATURES.map((k, i) => [k, counts[i] ?? 0])) as Record<
    TextFeature,
    number
  >
  const marker: SkillMarker = {
    pkg,
    path,
    hash,
    start: Number(start),
    end: Number(end),
    features,
    sig,
  }
  const valid =
    PACKAGE_ID.test(pkg) &&
    HASH.test(hash) &&
    path !== '' &&
    !LONE_SURROGATE.test(path) &&
    marker.start >= 1 &&
    marker.end >= marker.start &&
    counts.every(Number.isSafeInteger) &&
    format(marker) === text
  return valid ? marker : null
}

/** 校验签名：标记须由同一密钥为 `account` 签发，且签发后未被改动。 */
export function verifySkillMarker(marker: SkillMarker, account: string, key: Uint8Array): boolean {
  const expected = Buffer.from(signature(body(marker), account, key), 'base64url')
  const actual = Buffer.from(marker.sig, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
