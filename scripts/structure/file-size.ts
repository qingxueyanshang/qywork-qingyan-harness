/**
 * 源文件行数。扫描范围取 `writing-style.ts` 的 `sourceFiles()`：同一组扫描根与跳过目录，不另设清单。
 *
 * 只计非测试的源文件：测试、测试辅助、类型声明与生成文件不计。Rust 文件内的 `#[cfg(test)]` 模块无法与源码分开，
 * 随文件一并计入；移到独立的 `tests.rs` 后不计。
 */

import { readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { sourceFiles } from '../writing-style.ts'

export const ROOT = join(import.meta.dir, '..', '..')

/** 未列入基线的文件允许的最大行数。 */
export const LINE_CAP = 800

const EXTS = new Set(['.ts', '.tsx', '.rs', '.css', '.py', '.mjs'])

/** 不计的文件，按相对仓库根、以 `/` 分隔的路径判定。 */
const EXCLUDED =
  /\.test\.(ts|tsx|mjs|js)$|test-helper\.ts$|\.d\.ts$|\.gen\.ts$|(^|\/)tests?\/|(^|\/)test_\w+\.py$|(^|\/)tests\.rs$/

export function isCounted(rel: string): boolean {
  return EXTS.has(extname(rel)) && !EXCLUDED.test(rel)
}

/**
 * 物理行数：`\n` 的个数，末行没有换行符时另加一行；空文件为 0。
 * CRLF 中的 `\r` 不影响结果，同一内容以 LF 或 CRLF 保存得到相同的行数。
 */
export function countLines(src: string): number {
  let n = 0
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++
  return src.length > 0 && !src.endsWith('\n') ? n + 1 : n
}

/** 计入统计的文件，相对仓库根、以 `/` 分隔，按路径排序。 */
export function countedFiles(): string[] {
  return sourceFiles()
    .map((f) => relative(ROOT, f).replaceAll('\\', '/'))
    .filter(isCounted)
    .sort()
}

export function measureFileLines(): Map<string, number> {
  return new Map(
    countedFiles().map((rel) => [rel, countLines(readFileSync(join(ROOT, rel), 'utf8'))]),
  )
}
