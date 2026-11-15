/**
 * 包依赖方向的结构守卫。
 *
 * 依赖图必须保持为无环 DAG，**本测试是对此的唯一检查**：没有本测试时，添加一条
 * `core → server` 的回边不会产生任何报错，发现时通常已难以撤回。
 *
 * 判据是**层号**而不是逐包白名单：白名单每增加一个依赖就要修改一次，修改频繁后即失去审查作用；
 * 层号只在「该包在架构中的位置改变」时才需要修改，这种改变本应经过讨论。
 *
 * 依赖边取自两处：package.json 的声明与源码中实际的导入。只检查声明不够：未声明的导入同样能够运行，
 * 工作区把全部包链接到根目录的 node_modules 中。导入由 TypeScript 编译器的语法树取得，
 * 不按正则逐行匹配：注释与字符串中的同形文字不是导入。计入的形式有静态 `import`、`export … from`、
 * `import x = require()`、动态 `import()`、`require()` 与类型位置的 `import()`。
 * 类型导入同样计入：它同样使包之间形成依赖，typecheck 也按它解析被导入的包。
 *
 * `scripts/` 与仓库根不属于任何包，不登记层号，也不在导入扫描范围内。它们对包内文件的相对路径导入
 * （测试预载脚本不经包入口）不是包之间的边；包内文件导入不属于任何包的文件同样不构成包之间的边。
 *
 * 覆盖范围：`packages/*` 与 `apps/*` 的 package.json 中所有 `@qywork/*` 依赖；这些包内全部源文件
 * （含测试）的导入；`apps/web/src/lib/store` 及其子目录内模块之间的引用。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..')

/**
 * 层号越小越底层。**依赖只能指向层号更小的包**，同层之间也不得互相依赖
 * （同层互相依赖说明它们应合并为一个包，或层号划分有误）。
 *
 * 新增包必须在此处登记，否则测试直接失败：漏登记不得表现为静默放行。
 */
const LAYER: Record<string, number> = {
  '@qywork/core': 0,
  '@qywork/store': 1,
  '@qywork/ai': 1,
  '@qywork/ooxml': 1,
  '@qywork/agent': 2,
  '@qywork/tools': 3,
  '@qywork/plugins': 3,
  '@qywork/mcp': 3,
  '@qywork/team': 4,
  '@qywork/runtime': 5,
  '@qywork/server': 6,
  '@qywork/cli': 7,
  // 前端与桌面外壳是叶节点：任何包都不得依赖它们。
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

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/
/** 依赖与构建产物目录。`bin` 是 sidecar 的构建产物，`gen` 是外壳的生成文件。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'gen', 'bin', '.tmp'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sourceFiles(join(dir, e.name), out)
    } else if (SOURCE.test(e.name)) out.push(join(dir, e.name))
  }
  return out
}

interface Specifier {
  spec: string
  line: number
  /** `import type`、`export type` 与类型位置的 `import()`：编译后不加载被导入的模块。 */
  typeOnly: boolean
  /** 动态 `import()` 与 `require()`：调用时才加载，不参与模块初始化顺序。 */
  dynamic: boolean
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** 取出文件中全部以字符串字面量给出的模块说明符。参数不是字面量的动态导入无法静态解析，不计入。 */
function specifiers(file: string): Specifier[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    scriptKind(file),
  )
  const out: Specifier[] = []
  const add = (node: ts.Node | undefined, typeOnly: boolean, dynamic: boolean) => {
    if (node === undefined || !ts.isStringLiteralLike(node)) return
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    out.push({ spec: node.text, line, typeOnly, dynamic })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, node.importClause?.isTypeOnly ?? false, false)
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly, false)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, node.isTypeOnly, false)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true, false)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      add(node.arguments[0], false, true)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

interface ImportScan {
  /** 导入了 package.json 中未声明的包。 */
  undeclared: string[]
  /** 导入指向同层或更高层的包。 */
  upward: string[]
  /** 相对路径越过包根，导入了另一个包的内部文件。 */
  crossRelative: string[]
}

/**
 * 扫描各包源文件中的导入，按导入方所在的包裁决。
 *
 * 相对路径按 `resolve(dirname(文件), 说明符)` 解析后判定所属的包：落在另一个包内即越过包根，
 * 同时按指向该包的边参与声明与层号检查；不属于任何包时不构成包之间的边。
 * 说明符中 `?` 之后的部分是构建工具的查询参数（如 `?raw`），解析前去掉。
 */
function scanImports(pkgs: Pkg[]): ImportScan {
  const roots = pkgs.map((p) => ({ pkg: p, root: join(ROOT, p.dir) }))
  const ownerOf = (abs: string) =>
    roots.find((r) => abs === r.root || abs.startsWith(r.root + sep))?.pkg ?? null
  const scan: ImportScan = { undeclared: [], upward: [], crossRelative: [] }
  for (const p of pkgs) {
    const mine = LAYER[p.name]
    for (const file of sourceFiles(join(ROOT, p.dir))) {
      const rel = relative(ROOT, file).replaceAll('\\', '/')
      for (const s of specifiers(file)) {
        const spec = s.spec.replace(/\?.*$/, '')
        const at = `${rel}:${s.line}`
        let target: string
        if (spec.startsWith('@qywork/')) {
          target = spec.split('/').slice(0, 2).join('/')
        } else if (spec.startsWith('.')) {
          const into = ownerOf(resolve(dirname(file), spec))
          if (into === null || into === p) continue
          scan.crossRelative.push(`${at} ${s.spec}（位于 ${into.name} 内，应经包入口导入）`)
          target = into.name
        } else {
          continue
        }
        if (target === p.name) continue
        if (!p.deps.includes(target)) scan.undeclared.push(`${at} → ${target}`)
        const theirs = LAYER[target]
        if (mine !== undefined && (theirs === undefined || theirs >= mine)) {
          scan.upward.push(`${at} ${p.name}(L${mine}) → ${target}(L${theirs ?? '未登记'})`)
        }
      }
    }
  }
  return scan
}

describe('包依赖方向', () => {
  const pkgs = loadPackages()

  test('每个工作区包都登记了层号，漏登记不得表现为静默放行', () => {
    const missing = pkgs.filter((p) => LAYER[p.name] === undefined).map((p) => p.name)
    expect(missing).toEqual([])
  })

  test('依赖只能指向更底层，同层之间也不得互相依赖', () => {
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

  test('core 不依赖任何包：它是协议与领域类型，一旦有依赖就不再是最底层', () => {
    const core = pkgs.find((p) => p.name === '@qywork/core')
    expect(core?.deps ?? []).toEqual([])
  })

  test('没有包依赖前端和桌面外壳', () => {
    const leaves = ['@qywork/web', '@qywork/desktop']
    const bad = pkgs.filter((p) => p.deps.some((d) => leaves.includes(d))).map((p) => p.name)
    expect(bad).toEqual([])
  })
})

describe('源码中实际的导入', () => {
  const imports = scanImports(loadPackages())

  test('每个被导入的包都在导入方的 package.json 中声明', () => {
    expect(imports.undeclared).toEqual([])
  })

  test('导入只指向更底层的包，测试文件同样适用', () => {
    expect(imports.upward).toEqual([])
  })

  test('相对路径不越过包根导入另一个包的内部文件', () => {
    expect(imports.crossRelative).toEqual([])
  })
})

/**
 * 前端状态模块（`apps/web/src/lib/store`）之间同样不得成环：环上的模块按加载顺序取得
 * 尚未初始化的导出，`client` 等常量在另一侧读取为 undefined，只在特定的入口顺序下报错。
 */
describe('前端状态模块', () => {
  test('模块之间没有引用环（只计静态的运行时引用，不计 import type 与动态导入）', () => {
    const dir = join(ROOT, 'apps', 'web', 'src', 'lib', 'store')
    const files = sourceFiles(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
    const known = new Set(files)
    const resolveIn = (from: string, spec: string) => {
      const base = resolve(dirname(from), spec)
      return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((f) => known.has(f))
    }
    const graph = new Map(
      files.map((f) => [
        f,
        specifiers(f)
          .filter((s) => !s.typeOnly && !s.dynamic && s.spec.startsWith('.'))
          .map((s) => resolveIn(f, s.spec))
          .filter((d) => d !== undefined),
      ]),
    )
    const name = (f: string) => relative(dir, f).replaceAll('\\', '/')
    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []
    const walk = (node: string, path: string[]): void => {
      if (state.get(node) === 'done') return
      if (state.get(node) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(node)), node].map(name).join(' → '))
        return
      }
      state.set(node, 'visiting')
      for (const d of graph.get(node) ?? []) walk(d, [...path, node])
      state.set(node, 'done')
    }
    for (const f of files) walk(f, [])
    expect(files.length).toBeGreaterThan(0)
    expect(cycles).toEqual([])
  })
})
