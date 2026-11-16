/**
 * 中心清单计数：结构改造后已改为表或端口的几处位置，以现状值为上限。
 *
 * 每一项都是「新增一种能力就要在此处追加一段」的位置被改造后剩下的形状。计数超过基线说明该结构被绕开：
 * 新端口重新成为 `ToolContext` 的字段，事件处理回到连接层。语法树由 TypeScript 编译器解析，
 * 注释与字符串中的同形文字不计入。统计目标不存在时返回 null，守卫随之失败：结构变化后守卫须同步修改。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')

/** 接口的成员数：属性（含可选属性）、方法签名、调用签名与索引签名各计一个；同名的多个声明合并计数。 */
export function interfaceMembers(sf: ts.SourceFile, name: string): number | null {
  const decls = sf.statements.filter(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
  )
  return decls.length === 0 ? null : decls.reduce((n, d) => n + d.members.length, 0)
}

/** 函数的某个参数以对象类型字面量声明时的成员数。函数或参数不存在、参数不是类型字面量时返回 null。 */
export function optionMembers(sf: ts.SourceFile, fn: string, param: string): number | null {
  const decl = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === fn,
  )
  const p = decl?.parameters.find((x) => ts.isIdentifier(x.name) && x.name.text === param)
  return p?.type && ts.isTypeLiteralNode(p.type) ? p.type.members.length : null
}

/**
 * 按 `type` 字段的分支数：`x.type` 与字符串字面量的相等或不等比较，以及 `switch (x.type)` 的 `case` 标签
 * （`default` 不计）。
 */
export function typeBranches(sf: ts.SourceFile): number {
  const isTypeAccess = (n: ts.Node) => ts.isPropertyAccessExpression(n) && n.name.text === 'type'
  const isLiteral = (n: ts.Node) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
  const EQUALITY = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ])
  let n = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      EQUALITY.has(node.operatorToken.kind) &&
      ((isTypeAccess(node.left) && isLiteral(node.right)) ||
        (isLiteral(node.left) && isTypeAccess(node.right)))
    )
      n++
    if (ts.isSwitchStatement(node) && isTypeAccess(node.expression))
      n += node.caseBlock.clauses.filter(ts.isCaseClause).length
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

export interface Target {
  /** 相对仓库根的文件。 */
  file: string
  /** 计数项的名称，与文件组成基线中的键 `文件#名称`。 */
  label: string
  count(sf: ts.SourceFile): number | null
  /** 超过基线时的处理方向。 */
  hint: string
}

export const TARGETS: readonly Target[] = [
  {
    file: 'packages/agent/src/registry.ts',
    label: 'ToolContext 的成员',
    count: (sf) => interfaceMembers(sf, 'ToolContext'),
    hint: '只被部分工具使用的能力定义为端口，经 ctx.port(key) 取用，并写入使用它的工具的 requires',
  },
  {
    file: 'packages/runtime/src/session/types.ts',
    label: 'SessionOptions 的成员',
    count: (sf) => interfaceMembers(sf, 'SessionOptions'),
    hint: '装配方提供的能力放入 ports，不增加构造参数',
  },
  {
    file: 'packages/tools/src/index.ts',
    label: 'registerBuiltinTools 的选项成员',
    count: (sf) => optionMembers(sf, 'registerBuiltinTools', 'opts'),
    hint: '工具按 ToolSpec.requires 中的端口是否齐备注册，不增加注册开关',
  },
  {
    file: 'apps/web/src/lib/store/connection.ts',
    label: '按事件类型的分支',
    count: typeBranches,
    hint: '事件处理写入 events/ 下所属域的处理表，连接层不判断事件类型',
  },
]

export function keyOf(t: Target): string {
  return `${t.file}#${t.label}`
}

export interface CentralCounts {
  counts: Map<string, number>
  /** 不存在的统计目标，每项一条失败信息。 */
  missing: string[]
}

export function measureCentralLists(): CentralCounts {
  const counts = new Map<string, number>()
  const missing: string[] = []
  for (const t of TARGETS) {
    const abs = join(ROOT, t.file)
    const n = existsSync(abs)
      ? t.count(
          ts.createSourceFile(t.file, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true),
        )
      : null
    if (n === null)
      missing.push(
        `${keyOf(t)}：统计目标不存在 → 按现状修改 scripts/structure/central-lists.ts 的 TARGETS`,
      )
    else counts.set(keyOf(t), n)
  }
  return { counts, missing }
}
