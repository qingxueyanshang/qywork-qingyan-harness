/**
 * 包依赖方向的结构守卫。
 *
 * 依赖图今天是干净的无环 DAG——但**这件事没有任何东西在守着**。加一条
 * `core → server` 的回边不会有任何报错，等到发现时通常已经绕不回去了。
 * 这个测试就是那个守卫。
 *
 * 判据是**层号**而不是逐包白名单：白名单每加一个依赖就要改一次，改多了就成了
 * 橡皮图章；层号只在「这个包在架构里的位置变了」时才需要动，那本来就该被讨论一次。
 *
 * 覆盖范围：`packages/*` 与 `apps/*` 的 package.json 里所有 `@qywork/*` 依赖。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/**
 * 层号越小越底层。**依赖只能朝小的方向走**，同层之间也不许互相依赖
 * （同层互依 = 它们其实是一个包，或者层分错了）。
 *
 * 新增包必须在这里登记，否则测试直接失败——「忘了登记」不能表现为「悄悄放行」。
 */
const LAYER: Record<string, number> = {
  '@qywork/core': 0,
  '@qywork/store': 1,
  '@qywork/ai': 1,
  '@qywork/agent': 2,
  '@qywork/tools': 3,
  '@qywork/plugins': 3,
  '@qywork/mcp': 3,
  '@qywork/team': 4,
  '@qywork/runtime': 5,
  '@qywork/server': 6,
  '@qywork/cli': 7,
  // 前端与桌面壳是叶子：谁都不许依赖它们。
  '@qywork/web': 90,
  '@qywork/desktop': 90,
}

interface Pkg {
  name: string
  deps: string[]
  dir: string
}

function loadPackages(): Pkg[] {
  const out: Pkg[] = []
  for (const group of ['packages', 'apps']) {
    const base = join(ROOT, group)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      const file = join(base, entry, 'package.json')
      if (!existsSync(file)) continue
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        name: string
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      const deps = [
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
      ].filter((d) => d.startsWith('@qywork/') && d !== json.name)
      out.push({ name: json.name, deps: [...new Set(deps)], dir: `${group}/${entry}` })
    }
  }
  return out
}

describe('包依赖方向', () => {
  const pkgs = loadPackages()

  test('每个工作区包都登记了层号 —— 漏登记不能表现为悄悄放行', () => {
    const missing = pkgs.filter((p) => LAYER[p.name] === undefined).map((p) => p.name)
    expect(missing).toEqual([])
  })

  test('依赖只能朝更底层走，同层之间也不许互依', () => {
    const violations: string[] = []
    for (const p of pkgs) {
      const mine = LAYER[p.name]
      if (mine === undefined) continue
      for (const d of p.deps) {
        const theirs = LAYER[d]
        if (theirs === undefined) {
          violations.push(`${p.name} → ${d}（被依赖方没登记层号）`)
        } else if (theirs >= mine) {
          violations.push(`${p.name}(L${mine}) → ${d}(L${theirs})`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('依赖图无环', () => {
    const graph = new Map(pkgs.map((p) => [p.name, p.deps]))
    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []

    const walk = (node: string, path: string[]): void => {
      if (state.get(node) === 'done') return
      if (state.get(node) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(node)), node].join(' → '))
        return
      }
      state.set(node, 'visiting')
      for (const d of graph.get(node) ?? []) walk(d, [...path, node])
      state.set(node, 'done')
    }
    for (const p of pkgs) walk(p.name, [])
    expect(cycles).toEqual([])
  })

  test('core 谁都不依赖 —— 它是协议与领域类型，一旦有依赖就不再是底座', () => {
    const core = pkgs.find((p) => p.name === '@qywork/core')
    expect(core?.deps ?? []).toEqual([])
  })

  test('没有人依赖前端和桌面壳', () => {
    const leaves = ['@qywork/web', '@qywork/desktop']
    const bad = pkgs.filter((p) => p.deps.some((d) => leaves.includes(d))).map((p) => p.name)
    expect(bad).toEqual([])
  })
})
