/**
 * 覆盖 `actions.ts` 的 `ACTION_DEFS` 与 `act.ts`、`sequence.ts` 两个工具参数 schema 的一致性，
 * 以及 `sequence.ts` 中后置条件的多余参数判定。
 */

import { describe, expect, test } from 'bun:test'
import { Ports, provide, type ToolContext } from '@qywork/agent'
import type { DesktopActionKind } from '@qywork/core'
import { desktopActTool } from './act.ts'
import { ACTION_DEFS, ACTIONS, SEQUENCE_ACTIONS } from './actions.ts'
import { DesktopPort } from './port.ts'
import { desktopActSequenceTool } from './sequence.ts'

/** 按图定位的参数：指针动作接受。 */
const POINT_PARAMS = ['imageRef', 'imageX', 'imageY']

/** 一组动作在动作表中出现的全部参数，含指针动作的按图定位参数。 */
function tableParams(kinds: readonly DesktopActionKind[]): string[] {
  const out = new Set<string>()
  for (const kind of kinds) {
    for (const p of ACTION_DEFS[kind].params) out.add(p)
    if (ACTION_DEFS[kind].target === 'pointer') for (const p of POINT_PARAMS) out.add(p)
  }
  return [...out].sort()
}

function propertiesOf(schema: unknown): string[] {
  return Object.keys((schema as { properties: Record<string, unknown> }).properties)
}

/**
 * 新参数要在动作表的 `params` 与工具 schema 两处同时写。只写在表中时，strict 模式下的模型无法提交该参数；
 * 只写在 schema 中时，参数核对把它作为多余参数拒绝。两份清单必须相同。
 */
describe('动作表与工具 schema 的参数一致', () => {
  test('desktop_act：定位参数之外的 schema 属性恰好是动作表中的参数', () => {
    const own = ['windowId', 'action', 'ref', 'automationId', 'name', 'role']
    const props = propertiesOf(desktopActTool.parameters).filter((p) => !own.includes(p))
    expect(props.sort()).toEqual(tableParams(ACTIONS))
  })

  test('desktop_act_sequence：单步中定位参数与后置条件之外的属性恰好是序列动作的参数', () => {
    const own = ['action', 'ref', 'automationId', 'name', 'role', 'expect']
    const steps = propertiesOf(desktopActSequenceTool.parameters).includes('steps')
      ? (desktopActSequenceTool.parameters as { properties: { steps: { items: unknown } } })
          .properties.steps.items
      : null
    const props = propertiesOf(steps).filter((p) => !own.includes(p))
    expect(props.sort()).toEqual(tableParams(SEQUENCE_ACTIONS))
  })
})

function ctx(): ToolContext {
  const desktop = { elements: () => null, foregroundEnabled: () => true } as unknown as DesktopPort
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    density: { image: null, video: null } as unknown as ToolContext['density'],
    vision: null,
    state: new Map(),
    sink: null,
    port: new Ports([provide(DesktopPort, desktop)]).get,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

/**
 * strict schema 把每个参数列为必填，模型为不属于本动作的参数填写默认值或取值列表中的一项。
 * 原始失败形状：click 附带 `amount: 1` 被拒绝为「click 不接受 amount」；scroll_into_view 附带
 * `button` / `count` / `direction` / `state` / `step` / `windowState` 被拒绝。自由文本仍然拒绝。
 */
test('不属于本动作的参数取默认值或取值有限时不构成多余参数', async () => {
  const run = (args: Record<string, unknown>) =>
    desktopActSequenceTool.fn({ windowId: 'dw_1', steps: [{ ref: 'e1', ...args }] }, ctx())
  const filler = {
    button: 'left',
    count: 1,
    direction: 'down',
    state: 'off',
    step: 'line',
    windowState: 'normal',
    amount: 1,
    dx: 0,
    modifiers: [],
    text: '',
  }
  expect((await run({ ...filler, action: 'click' })).message).not.toContain('不接受')
  expect((await run({ ...filler, action: 'scroll_into_view' })).message).not.toContain('不接受')
  expect((await run({ action: 'click', amount: 3 })).message).toContain('click 不接受 amount')
  expect((await run({ action: 'invoke', value: 'x' })).message).toContain('invoke 不接受 value')
})

/**
 * 后置条件中不属于该种条件的参数，取 0 与 false 时视为空值，与动作参数使用同一判据：strict schema 下模型为
 * 无关参数逐个填写空值。原始失败形状：`until=toggle` 附带 `timeoutMs: 0` 被拒绝，整组未派发。
 */
test('后置条件中不属于该种条件、取 0 的参数视为空值', async () => {
  const run = (expectArgs: Record<string, unknown>) =>
    desktopActSequenceTool.fn(
      {
        windowId: 'dw_1',
        steps: [{ action: 'set_toggle', ref: 'e1', state: 'on', expect: expectArgs }],
      },
      ctx(),
    )
  const zero = await run({ until: 'toggle', state: 'on', timeoutMs: 0 })
  expect(zero.message).not.toContain('不接受')
  const real = await run({ until: 'toggle', state: 'on', timeoutMs: 500 })
  expect(real.message).toContain('until=toggle 不接受 timeoutMs')
})
