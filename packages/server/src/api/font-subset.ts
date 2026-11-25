/**
 * 主机字体按文档用到的字裁剪：`/api/fonts/file` 带 `doc`（工作区中的 Office 文件）与 `v`（其修改时间）时只下发该文档
 * 用到的字形（`subsetFace`）。系统中文字体单个 10–20 MB，裁剪后为 0.4–1 MB；远程访问时 Office 预览的等待主要在此。
 *
 * - 码位取自文档包中全部 XML 成员的字符：正文、页眉页脚、批注、图表、编号与数字格式都在其中，标签与属性名只增加 ASCII。
 *   另加 `BASE_RANGES` 与 `BASE_TEXT`：分页与字段生成、不出现在文档中的文字（页码、日期、编号）。缺少的字形绘制为空白，排版度量不受影响。
 * - 不裁剪（返回 null）：文档不是 ZIP 包；文档包含图元文件（EMF、WMF），其中文字在二进制记录中。
 * - 码位按「路径 + 版本」缓存最近几份：打开一份文档时同时请求十余个字体文件。
 */

import { openZip } from '@qywork/ooxml/zip'

/**
 * 不出现在文档中、由分页、字段与编号生成的字符所在的范围。编号格式的前后缀（`lvlText`）、项目符号与字段的上次结果
 * 写在文档的 XML 中，不在此列；此处只列生成的数字本身：ASCII（阿拉伯数字、罗马数字、字母编号）、不换行空格、
 * 连字符与引号省略号、带圈与带括号的数字（①–⒛）、中文标点、全角数字。
 */
const BASE_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xa0],
  [0x2010, 0x201f],
  [0x2022, 0x2022],
  [0x2026, 0x2026],
  [0x2460, 0x249b],
  [0x3000, 0x3003],
  [0x3008, 0x3011],
  [0xff10, 0xff19],
]

/** 中文编号格式（小写、大写、天干、地支）与日期、页码字段生成的汉字。 */
const BASE_TEXT =
  '〇零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥年月日时分秒上下午星期周第页共'

const CACHED = 8
const cache = new Map<string, Promise<ReadonlySet<number> | null>>()

/** `abs` 为文档的绝对路径，`version` 为界面传入的修改时间。 */
export function documentCodePoints(
  abs: string,
  version: string,
): Promise<ReadonlySet<number> | null> {
  const key = `${abs}\u0000${version}`
  let pending = cache.get(key)
  if (!pending) {
    pending = collect(abs)
    cache.set(key, pending)
    if (cache.size > CACHED) cache.delete(cache.keys().next().value!)
    pending.catch(() => cache.delete(key))
  }
  return pending
}

async function collect(abs: string): Promise<ReadonlySet<number> | null> {
  const zip = openZip(new Uint8Array(await Bun.file(abs).arrayBuffer()))
  if (!zip.ok) return null
  const archive = zip.value
  if (archive.paths.some((p) => /\.(emf|wmf)$/i.test(p))) return null
  const set = new Set<number>()
  for (const [from, to] of BASE_RANGES) for (let c = from; c <= to; c++) set.add(c)
  for (const ch of BASE_TEXT) set.add(ch.codePointAt(0)!)
  for (const path of archive.paths) {
    if (!/\.xml$/i.test(path)) continue
    const text = await archive.text(path)
    if (!text.ok || text.value === null) continue
    for (const ch of text.value) set.add(ch.codePointAt(0)!)
    for (const m of text.value.matchAll(/&#(x[0-9a-f]+|[0-9]+);/gi)) {
      const ref = m[1]!
      set.add(ref[0] === 'x' || ref[0] === 'X' ? Number.parseInt(ref.slice(1), 16) : Number(ref))
    }
  }
  return set
}
