/**
 * 覆盖范围：`file-size.ts` 的行数统计与计入范围，以及全仓非测试源文件对行数基线（`baseline.json` 的 `fileLines`）的检查。
 *
 * 失败表示文件超过上限或基线，或基线留有余量；失败信息给出「文件：现状，允许的行数 → 处理方向」。
 */

import { describe, expect, test } from 'bun:test'
import { check, RULES, readBaseline } from './baseline.ts'
import { countedFiles, countLines, isCounted, measureFileLines } from './file-size.ts'

describe('行数统计', () => {
  test('按换行符计物理行，末行没有换行符时另计一行，空文件为 0', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('\n')).toBe(1)
    expect(countLines('a\n\n')).toBe(2)
  })

  test('CRLF 与 LF 保存的同一内容行数相同', () => {
    expect(countLines('a\r\nb\r\n')).toBe(countLines('a\nb\n'))
    expect(countLines('a\r\nb')).toBe(2)
  })
})

describe('计入范围', () => {
  test('只计非测试源文件：测试、测试辅助、类型声明、生成文件与 tests 目录不计', () => {
    expect(isCounted('packages/agent/src/registry.ts')).toBe(true)
    expect(isCounted('apps/web/src/components/Composer.tsx')).toBe(true)
    expect(isCounted('apps/desktop/src-tauri/src/lib.rs')).toBe(true)
    expect(isCounted('apps/web/src/styles/app/shell.css')).toBe(true)
    expect(isCounted('packages/runtime/office/structure.py')).toBe(true)
    expect(isCounted('scripts/load-ui.mjs')).toBe(true)
    expect(isCounted('packages/agent/src/latest/a.ts')).toBe(true)

    expect(isCounted('packages/agent/src/registry.test.ts')).toBe(false)
    expect(isCounted('apps/web/src/components/Composer.test.tsx')).toBe(false)
    expect(isCounted('packages/core/src/until.test-helper.ts')).toBe(false)
    expect(isCounted('scripts/babel.d.ts')).toBe(false)
    expect(isCounted('packages/ooxml/src/drawingml/geometry/presets.gen.ts')).toBe(false)
    expect(isCounted('packages/runtime/office/tests/test_structure.py')).toBe(false)
    expect(isCounted('scripts/ooxml-fidelity/tests/case.ts')).toBe(false)
    expect(isCounted('scripts/ooxml-fidelity/test_render.py')).toBe(false)
    expect(isCounted('apps/desktop/native/computer-host/src/protocol/tests.rs')).toBe(false)
    expect(isCounted('apps/desktop/native/computer-host/src/contests.rs')).toBe(true)
  })

  test('只计 .ts、.tsx、.rs、.css、.py、.mjs', () => {
    for (const ext of ['.js', '.json', '.toml', '.yml', '.ps1', '.md'])
      expect(isCounted(`packages/agent/src/a${ext}`)).toBe(false)
  })

  test('扫描根与书面语守卫相同，依赖与构建产物目录不计', () => {
    const files = countedFiles()
    for (const prefix of [
      'packages/',
      'apps/web/',
      'apps/desktop/src-tauri/',
      'apps/desktop/native/',
      'scripts/',
    ])
      expect(files.some((f) => f.startsWith(prefix))).toBe(true)
    expect(files.filter((f) => /(^|\/)(node_modules|dist|target|gen|bin)\//.test(f))).toEqual([])
  })
})

describe('全仓行数基线', () => {
  /** 基线不是豁免名单：列入的文件只能变短，未列入的文件按上限检查。 */
  test('未列入基线的文件不超过上限，列入的文件不超过基线值，基线不留余量', () => {
    expect(check(RULES.fileLines, measureFileLines(), readBaseline().fileLines)).toEqual([])
  })
})
