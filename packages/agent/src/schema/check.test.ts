/** 覆盖 `schema/check.ts`：按工具定义核对参数。 */

import { expect, test } from 'bun:test'
import { normalizeArgs, schemaProblems } from './check.ts'

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    nested: {
      type: 'object',
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
      additionalProperties: false,
    },
  },
  required: ['name'],
  additionalProperties: false,
}

test('符合定义时没有问题', () => {
  expect(
    schemaProblems(SCHEMA, {
      name: 'x',
      count: 2,
      ratio: 0.5,
      mode: 'a',
      tags: ['t'],
      nested: { flag: true },
    }),
  ).toEqual([])
  // 整数也是数字。
  expect(schemaProblems(SCHEMA, { name: 'x', ratio: 1 })).toEqual([])
})

test('逐项报告缺少的必填项、未声明的参数、类型、枚举与数量', () => {
  expect(
    schemaProblems(SCHEMA, {
      count: 1.5,
      mode: 'c',
      tags: [],
      extra: 1,
      nested: { other: 1 },
    }),
  ).toEqual([
    '参数 缺少必填项 name',
    '参数.count 应为整数，收到数字',
    '参数.mode 须为下列之一："a"、"b"',
    '参数.tags 至少 1 项',
    '参数 不接受 extra',
    '参数.nested 缺少必填项 flag',
    '参数.nested 不接受 other',
  ])
})

test('可选参数写成 null 时按类型不符报告，类型声明含 null 时接受', () => {
  expect(schemaProblems(SCHEMA, { name: 'x', count: null })).toEqual([
    '参数.count 应为整数，收到空值（null）',
  ])
  expect(schemaProblems({ type: ['string', 'null'] }, null)).toEqual([])
})

/**
 * 原始失败形状（2026-11-19 真实模型回归）：DeepSeek 调用按需的 pet 时写出 `{"action":"list","id":null,"pack_json":null,"dir":null}`，
 * 三个 null 都按「应为字符串」被拒绝；常驻工具的同一写法由适配器还原为未提供。
 */
test('可选参数写为 null 时视为未提供，必填参数与类型含 null 的参数保留', () => {
  const schema = {
    type: 'object',
    properties: {
      action: { type: 'string' },
      id: { type: 'string' },
      note: { type: ['string', 'null'] },
    },
    required: ['action'],
  }
  expect(normalizeArgs(schema, { action: 'list', id: null, note: null })).toEqual({
    action: 'list',
    note: null,
  })
  expect(normalizeArgs(schema, { action: null })).toEqual({ action: null })
})

/**
 * 原始失败形状（2026-11-19 真实模型回归）：Claude 调用按需的 personalize 时把定义为 JSON 文本的 `json` 写成对象，
 * 连续三次按「应为字符串，收到对象」被拒绝后以无进展停止。
 */
test('字符串参数收到对象或数组时取其 JSON 文本，其余不转换', () => {
  const schema = {
    type: 'object',
    properties: {
      json: { type: 'string' },
      list: {
        type: 'array',
        items: { type: 'object', properties: { pack_json: { type: 'string' } } },
      },
      count: { type: 'integer' },
    },
  }
  expect(
    normalizeArgs(schema, { json: { accent: '#22c55e' }, list: [{ pack_json: [1] }], count: '2' }),
  ).toEqual({ json: '{"accent":"#22c55e"}', list: [{ pack_json: '[1]' }], count: '2' })
  // 未声明的参数原样保留，由 schemaProblems 报告。
  expect(normalizeArgs(schema, { other: { a: 1 } })).toEqual({ other: { a: 1 } })
})

test('数组元素按 items 核对并写明下标', () => {
  expect(schemaProblems(SCHEMA, { name: 'x', tags: ['a', 2] })).toEqual([
    '参数.tags[1] 应为字符串，收到整数',
  ])
})
