/**
 * 脚本产物位置的结构守卫。
 *
 * 覆盖范围：测试进程的系统临时目录，以及 `scripts/` 下所有 `.ts` 与 `.mjs` 里
 * 以仓库根为基准拼接的路径字面量。
 *
 * 临时工作区与截图产物一律放在 `.tmp/<用途>`。在仓库根另建点目录不会产生任何报错，
 * 也不进入 git 状态（`*.sqlite3` 与目录本身不入库），只在文件管理器中不断累积，
 * 且每新增一个都要在 `.gitignore` 与 `biome.json` 中各补一行。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SELF = 'temp-dir.test.ts'

/** 两种以仓库根为基准的写法：`.mjs` 侧的 `ROOT` 常量，`.ts` 侧的 `import.meta.dir` 向上一级。 */
const ANCHORS = [
  /join\(\s*ROOT\s*,\s*'([^']+)'/g,
  /join\(\s*import\.meta\.dir\s*,\s*'\.\.'\s*,\s*'([^']+)'/g,
]

/** 只检查根目录下的第一段：`join(WS_DIR, '.qy')` 等位于工作区内的点目录不在此列。 */
export function detect(file: string, src: string): string[] {
  const hits: string[] = []
  for (const re of ANCHORS) {
    re.lastIndex = 0
    let m = re.exec(src)
    while (m) {
      const seg = m[1] ?? ''
      if (seg.startsWith('.') && seg !== '.tmp') {
        const line = src.slice(0, m.index).split('\n').length
        hits.push(`${file}:${line} 根目录新建了 ${seg}/，改为 '.tmp', '${seg.slice(1)}'`)
      }
      m = re.exec(src)
    }
  }
  return hits
}

describe('脚本产物位置', () => {
  test('测试进程的临时目录位于 .tmp/tests 下的本次运行目录', () => {
    const path = relative(ROOT, tmpdir()).replaceAll('\\', '/')
    expect(path).toMatch(/^\.tmp\/tests\/run-[^/]+$/)
    expect(process.env.GIT_CEILING_DIRECTORIES).toBe(tmpdir())
  })

  test('Cargo 与 Tauri 的构建目录固定在 .tmp', () => {
    const config = readFileSync(join(ROOT, '.cargo', 'config.toml'), 'utf8')
    expect(config).toContain('target-dir = ".tmp/cargo-target"')
  })

  test('根目录下的点目录判定：只放行 .tmp，不检查工作区内的点目录', () => {
    const src = [
      `const a = join(ROOT, '.shoot-ws')`,
      `const b = join(ROOT, '.tmp', 'shots')`,
      `const c = join(import.meta.dir, '..', '.smoke-ws')`,
      `const d = join(WS_DIR, '.qy', 'team.json')`,
      `const e = join(ROOT, 'scripts/seed-demo.ts')`,
    ].join('\n')
    expect(detect('x.ts', src)).toEqual([
      `x.ts:1 根目录新建了 .shoot-ws/，改为 '.tmp', 'shoot-ws'`,
      `x.ts:3 根目录新建了 .smoke-ws/，改为 '.tmp', 'smoke-ws'`,
    ])
  })

  test('临时工作区与产物只放在 .tmp/，不在仓库根另建点目录', () => {
    const hits: string[] = []
    for (const name of readdirSync(join(ROOT, 'scripts'))) {
      if (name === SELF) continue
      if (!name.endsWith('.ts') && !name.endsWith('.mjs')) continue
      hits.push(...detect(`scripts/${name}`, readFileSync(join(ROOT, 'scripts', name), 'utf8')))
    }
    expect(hits).toEqual([])
  })
})
