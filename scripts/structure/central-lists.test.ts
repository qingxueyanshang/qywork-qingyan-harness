/**
 * 覆盖范围：`central-lists.ts` 的三种计数（接口成员、选项对象成员、按 `type` 的分支），
 * 以及全仓各计数项对基线（`baseline.json` 的 `centralLists`）的检查。
 *
 * 失败表示表或端口结构被绕开，或统计目标已随结构变化而不存在；后者须按现状修改 `TARGETS`。
 */

import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { check, RULES, readBaseline } from './baseline.ts'
import {
  interfaceMembers,
  measureCentralLists,
  optionMembers,
  TARGETS,
  typeBranches,
} from './central-lists.ts'

const parse = (src: string) => ts.createSourceFile('a.ts', src, ts.ScriptTarget.Latest, true)

describe('接口成员', () => {
  test('可选属性、方法签名、调用签名与索引签名各计一个，同名声明合并计数', () => {
    const sf = parse(
      [
        'export interface Ctx {',
        '  a: string',
        '  /** 说明 */',
        '  b?: number',
        '  port<T>(key: Key<T>): T | null',
        "  emit(channel: 'stdout', delta: string): void",
        '  readonly [key: string]: unknown',
        '  (x: number): void',
        '}',
        'interface Ctx {',
        '  c?: true',
        '}',
        'interface Other {',
        '  d: string',
        '}',
      ].join('\n'),
    )
    expect(interfaceMembers(sf, 'Ctx')).toBe(7)
    expect(interfaceMembers(sf, 'Other')).toBe(1)
  })

  test('接口不存在时返回 null；类型别名不视为接口', () => {
    const sf = parse('export type Ctx = { a: string }')
    expect(interfaceMembers(sf, 'Ctx')).toBeNull()
  })
})

describe('选项对象成员', () => {
  test('统计指定参数的类型字面量成员，含可选成员', () => {
    const sf = parse(
      [
        'export function register(',
        '  registry: Registry,',
        '  ports: Ports = new Ports(),',
        '  opts: {',
        '    /** 说明 */',
        '    panel?: boolean',
        '    media?: readonly string[] | null',
        '    member?: boolean',
        '  } = {},',
        '): void {}',
      ].join('\n'),
    )
    expect(optionMembers(sf, 'register', 'opts')).toBe(3)
  })

  test('函数或参数不存在、参数改为具名类型时返回 null，守卫随之失败', () => {
    const sf = parse('export function register(registry: Registry, opts: RegisterOptions): void {}')
    expect(optionMembers(sf, 'register', 'opts')).toBeNull()
    expect(optionMembers(sf, 'register', 'options')).toBeNull()
    expect(optionMembers(sf, 'missing', 'opts')).toBeNull()
  })
})

describe('按 type 的分支', () => {
  test('计 x.type 与字符串字面量的比较和 switch (x.type) 的 case 标签', () => {
    const sf = parse(
      [
        "if (ev.type === 'a') {}",
        "if ('b' !== frame.event.type) {}",
        'switch (ev.type) {',
        "  case 'c':",
        "  case 'd':",
        '    break',
        '  default:',
        '}',
      ].join('\n'),
    )
    expect(typeBranches(sf)).toBe(4)
  })

  test('注释、字符串、其他字段与非字面量的比较不计', () => {
    const sf = parse(
      [
        "// ev.type === 'a'",
        'const s = "ev.type === \'b\'"',
        "if (state === 'unauthorized') {}",
        "if (ev.kind === 'c') {}",
        'if (ev.type === other) {}',
        'switch (ev.kind) {',
        "  case 'd':",
        '}',
      ].join('\n'),
    )
    expect(typeBranches(sf)).toBe(0)
  })
})

describe('全仓中心清单', () => {
  const { counts, missing } = measureCentralLists()

  test('每个统计目标都存在：结构变化后守卫须同步修改，不得静默通过', () => {
    expect(missing).toEqual([])
    expect(counts.size).toBe(TARGETS.length)
  })

  test('各计数项不超过基线，基线不留余量', () => {
    expect(check(RULES.centralLists, counts, readBaseline().centralLists)).toEqual([])
  })
})
