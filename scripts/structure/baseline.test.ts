/**
 * 覆盖范围：`baseline.ts` 的比较规则（`findings`、`check`）、下调（`update`）、首次建立（`init`）与输出格式（`serialize`），
 * 以及 `baseline.json` 的格式。全仓检查分别在 `central-lists.test.ts` 与 `components.test.ts` 中。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  BASELINE_FILE,
  check,
  findings,
  init,
  type Rule,
  readBaseline,
  SECTIONS,
  serialize,
  update,
} from './baseline.ts'

const CAPPED: Rule = { cap: 10, what: '状态', hint: () => '收拢为控制器' }
const UNCAPPED: Rule = { cap: null, what: '', hint: (key) => `${key} 的处理方向` }

const kinds = (rule: Rule, measured: [string, number][], baseline: Record<string, number>) =>
  findings(rule, new Map(measured), baseline).map((f) => [f.key, f.kind])

describe('比较规则', () => {
  test('未列入基线的条目只在超过上限时失败', () => {
    expect(
      kinds(
        CAPPED,
        [
          ['a', 11],
          ['b', 10],
        ],
        {},
      ),
    ).toEqual([['a', 'over-cap']])
  })

  test('列入基线的条目超过基线值时失败，等于基线值时通过', () => {
    expect(
      kinds(
        CAPPED,
        [
          ['a', 21],
          ['b', 20],
        ],
        { a: 20, b: 20 },
      ),
    ).toEqual([['a', 'over-baseline']])
  })

  test('基线不留余量：条目变小、降到上限以内或已不存在时同样失败', () => {
    expect(
      kinds(
        CAPPED,
        [
          ['a', 15],
          ['b', 10],
        ],
        { a: 20, b: 20, c: 20 },
      ),
    ).toEqual([
      ['a', 'shrunk'],
      ['b', 'below-cap'],
      ['c', 'stale'],
    ])
  })

  test('没有上限时每个条目都必须在基线中', () => {
    expect(
      kinds(
        UNCAPPED,
        [
          ['a', 0],
          ['b', 3],
        ],
        { b: 3 },
      ),
    ).toEqual([['a', 'unregistered']])
  })

  test('失败信息给出条目、现状、允许的值与处理方向', () => {
    const lines = check(
      CAPPED,
      new Map([
        ['new.tsx#New', 12],
        ['big.tsx#Big', 31],
        ['short.tsx#Short', 15],
      ]),
      { 'big.tsx#Big': 30, 'short.tsx#Short': 20, 'gone.tsx#Gone': 25 },
    )
    expect(lines).toEqual([
      'big.tsx#Big：状态 31 个，基线 30 个 → 收拢为控制器；基线只能下调',
      'gone.tsx#Gone：已不存在，基线 25 个 → 运行 bun run scripts/structure/baseline.ts --update 移除该条目',
      'new.tsx#New：状态 12 个，上限 10 个 → 收拢为控制器',
      'short.tsx#Short：状态 15 个，基线 20 个 → 运行 bun run scripts/structure/baseline.ts --update 下调基线',
    ])
    expect(check(UNCAPPED, new Map([['a.ts#清单', 4]]), { 'a.ts#清单': 3 })).toEqual([
      'a.ts#清单：4 个，基线 3 个 → a.ts#清单 的处理方向；基线只能下调',
    ])
  })
})

describe('下调与首次建立', () => {
  test('--update 下调变小的条目，移除降到上限以内与已不存在的条目，不修改传入的基线', () => {
    const baseline = { a: 20, b: 20, c: 20, d: 20 }
    const r = update(
      CAPPED,
      new Map([
        ['a', 15],
        ['b', 9],
        ['d', 20],
      ]),
      baseline,
    )
    expect(r.refused).toEqual([])
    expect(r.next).toEqual({ a: 15, d: 20 })
    expect(r.changes).toEqual(['a：20 个 → 15 个', 'b：移除', 'c：移除'])
    expect(baseline).toEqual({ a: 20, b: 20, c: 20, d: 20 })
  })

  test('--update 拒绝上调与新增：超过基线、未列入且超过上限、没有基线值的计数项', () => {
    expect(update(CAPPED, new Map([['a', 21]]), { a: 20 }).refused).toHaveLength(1)
    expect(update(CAPPED, new Map([['n', 11]]), {}).refused).toHaveLength(1)
    expect(update(UNCAPPED, new Map([['n', 0]]), {}).refused).toHaveLength(1)
  })

  test('--init 写入超过上限的条目；没有上限时写入全部条目', () => {
    const measured = new Map([
      ['a', 11],
      ['b', 10],
    ])
    expect(init(CAPPED, measured)).toEqual({ a: 11 })
    expect(init(UNCAPPED, measured)).toEqual({ a: 11, b: 10 })
  })
})

describe('基线文件', () => {
  test('按固定的部分顺序与键的顺序输出，一行一个条目', () => {
    const text = serialize({
      innerComponents: {},
      centralLists: { x: 1 },
      componentStates: { 'b.tsx#B': 9, 'a.tsx#A': 10 },
    })
    expect(text).toBe(
      [
        '{',
        '  "centralLists": {',
        '    "x": 1',
        '  },',
        '  "componentStates": {',
        '    "a.tsx#A": 10,',
        '    "b.tsx#B": 9',
        '  },',
        '  "innerComponents": {}',
        '}',
        '',
      ].join('\n'),
    )
  })

  test('baseline.json 含全部三部分，且与按规则输出的结果逐字节相同', () => {
    const baseline = readBaseline()
    expect(Object.keys(baseline)).toEqual([...SECTIONS])
    expect(readFileSync(BASELINE_FILE, 'utf8')).toBe(serialize(baseline))
  })
})
