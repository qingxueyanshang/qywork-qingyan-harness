/**
 * 桌面宿主协议的跨语言样例。覆盖 `packages/core/src/protocol/native-desktop.samples.json`
 * 与 `core/protocol/native-desktop.ts` 的字段是否一一对应，以及 `desktop/bridge.ts` 按样例
 * 发出请求帧、按样例认领结果帧。
 *
 * 同一份样例由宿主（`src-tauri/src/desktop/frames.rs`）与 worker
 * （`computer-host/src/protocol.rs`）的测试读取：worker 逐字序列化出 `workerResponses`，
 * 宿主把它转成 `results`、把 `requests` 转成 `workerRequests`。这里锁住最后一段：
 * 样例里的字段集合与 TS 类型的键集合相等。
 *
 * 键集合用 `Record<keyof T, true>` 字面量写出：类型多一个键或少一个键，编译即报错，
 * 所以这张表不是手抄的第二份词表，它由 TS 类型本身校验。
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DesktopBlockingWindow,
  DesktopCompleteness,
  DesktopEventFrame,
  DesktopHostReadyFrame,
  DesktopImageBody,
  DesktopImageGeometry,
  DesktopNode,
  DesktopNodeAction,
  DesktopOp,
  DesktopRangeState,
  DesktopRect,
  DesktopRequestFrame,
  DesktopResultFrame,
  DesktopScrollState,
  DesktopSelectionState,
  DesktopTarget,
  DesktopTextBody,
  DesktopTextSelection,
  DesktopTreeBody,
  DesktopWindow,
} from '@qywork/core'
import { DesktopBridge, type DesktopCallResult, type DesktopRequestParams } from './bridge.ts'

type Json = Record<string, unknown>

const samples = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '..',
      '..',
      '..',
      'core',
      'src',
      'protocol',
      'native-desktop.samples.json',
    ),
    'utf8',
  ),
) as {
  hostReady: Json
  workerState: Json
  requests: Record<string, Json>
  results: Record<string, Json>
}

function keysOf(record: Record<string, true>): string[] {
  return Object.keys(record).sort()
}

/** 一组样例对象的键的并集。可选字段分散在不同样例里，并集才是完整的字段集合。 */
function union(...objects: unknown[]): string[] {
  const out = new Set<string>()
  for (const o of objects) for (const k of Object.keys(o as Json)) out.add(k)
  return [...out].sort()
}

const REQUEST: Record<keyof DesktopRequestFrame, true> = {
  type: true,
  requestId: true,
  actionId: true,
  connectionEpoch: true,
  hostId: true,
  hostEpoch: true,
  executorId: true,
  deadline: true,
  foreground: true,
  op: true,
  target: true,
  ref: true,
  point: true,
  action: true,
  maxChars: true,
  value: true,
  maxNodes: true,
  maxDepth: true,
  timeBudgetMs: true,
  root: true,
  role: true,
  nameContains: true,
  includeValue: true,
  includeState: true,
  until: true,
  name: true,
  pollMs: true,
  timeoutMs: true,
  region: true,
  expectGeneration: true,
  maxEdge: true,
  maxBytes: true,
}
const RESULT: Record<keyof DesktopResultFrame, true> = {
  type: true,
  requestId: true,
  connectionEpoch: true,
  hostId: true,
  hostEpoch: true,
  dispatch: true,
  reason: true,
  observation: true,
  observationError: true,
  blocking: true,
}
const HOST_READY: Record<keyof DesktopHostReadyFrame, true> = {
  type: true,
  hostId: true,
  hostEpoch: true,
  connectionEpoch: true,
  platform: true,
  workerReady: true,
  authorized: true,
}
const EVENT: Record<keyof DesktopEventFrame, true> = {
  type: true,
  connectionEpoch: true,
  hostId: true,
  hostEpoch: true,
  kind: true,
  workerReady: true,
  authorized: true,
}
const TARGET: Record<keyof DesktopTarget, true> = {
  window: true,
  pid: true,
  processStartedAt: true,
}
const RECT: Record<keyof DesktopRect, true> = { x: true, y: true, width: true, height: true }
const WINDOW: Record<keyof DesktopWindow, true> = {
  handle: true,
  pid: true,
  processStartedAt: true,
  app: true,
  title: true,
}
const BLOCKING: Record<keyof DesktopBlockingWindow, true> = { ...WINDOW, appeared: true }
const TREE: Record<keyof DesktopTreeBody, true> = {
  window: true,
  capturedAt: true,
  scope: true,
  windowEnabled: true,
  windowCovered: true,
  completeness: true,
  nodeCount: true,
  nodes: true,
}
const COMPLETENESS: Record<keyof DesktopCompleteness, true> = {
  complete: true,
  truncatedBy: true,
  filteredBy: true,
  visited: true,
}
const NODE: Record<keyof DesktopNode, true> = {
  ref: true,
  parentRef: true,
  depth: true,
  role: true,
  name: true,
  automationId: true,
  value: true,
  enabled: true,
  offscreen: true,
  focused: true,
  rect: true,
  actions: true,
  range: true,
  toggle: true,
  expand: true,
  selected: true,
  selection: true,
  scroll: true,
  text: true,
  weakIdentity: true,
}
const NODE_ACTION: Record<keyof DesktopNodeAction, true> = {
  action: true,
  delivery: true,
  unavailable: true,
}
const RANGE: Record<keyof DesktopRangeState, true> = {
  value: true,
  min: true,
  max: true,
  smallChange: true,
  largeChange: true,
}
const SELECTION: Record<keyof DesktopSelectionState, true> = {
  multiple: true,
  required: true,
  selected: true,
  truncated: true,
}
const SCROLL: Record<keyof DesktopScrollState, true> = { horizontal: true, vertical: true }
const TEXT: Record<keyof DesktopTextBody, true> = {
  window: true,
  capturedAt: true,
  scope: true,
  text: true,
  truncated: true,
  selectionSupport: true,
  selection: true,
}
const TEXT_SELECTION: Record<keyof DesktopTextSelection, true> = {
  start: true,
  text: true,
  truncated: true,
}
const IMAGE: Record<keyof DesktopImageBody, true> = {
  window: true,
  capturedAt: true,
  source: true,
  geometry: true,
  mime: true,
  bytes: true,
}
const GEOMETRY: Record<keyof DesktopImageGeometry, true> = {
  imageWidth: true,
  imageHeight: true,
  screen: true,
  dpi: true,
  generation: true,
}

test('样例的字段集合与协议类型的键集合一致', () => {
  const { requests, results } = samples
  const observation = (key: string) => results[key]!.observation as Json
  const tree = observation('tree')
  const node = (tree.nodes as Json[])[1]!

  expect(union(...Object.values(requests))).toEqual(keysOf(REQUEST))
  expect(union(...Object.values(results))).toEqual(keysOf(RESULT))
  expect(union(samples.hostReady)).toEqual(keysOf(HOST_READY))
  expect(union(samples.workerState)).toEqual(keysOf(EVENT))
  expect(union(requests.read_tree!.target)).toEqual(keysOf(TARGET))
  expect(union(node.rect, requests.capture_image!.region)).toEqual(keysOf(RECT))

  expect(union(...(observation('windows').windows as Json[]))).toEqual(keysOf(WINDOW))
  expect(union(...(results.act_blocked!.blocking as Json[]))).toEqual(keysOf(BLOCKING))
  expect(union(tree)).toEqual(keysOf({ ...TREE, kind: true }))
  expect(union(observation('wait'))).toEqual(
    keysOf({ ...TREE, kind: true, found: true, reason: true }),
  )
  expect(union(tree.completeness)).toEqual(keysOf(COMPLETENESS))
  expect(union(...(tree.nodes as Json[]))).toEqual(keysOf(NODE))
  expect(union(...(node.actions as Json[]))).toEqual(keysOf(NODE_ACTION))
  expect(union(node.range)).toEqual(keysOf(RANGE))
  expect(union(node.selection)).toEqual(keysOf(SELECTION))
  expect(union(node.scroll)).toEqual(keysOf(SCROLL))
  expect(union(observation('text'))).toEqual(keysOf({ ...TEXT, kind: true }))
  expect(union(...(observation('text').selection as Json[]))).toEqual(keysOf(TEXT_SELECTION))
  expect(union(observation('image'))).toEqual(keysOf({ ...IMAGE, kind: true }))
  expect(union(observation('image').geometry)).toEqual(keysOf(GEOMETRY))
})

/** 一个只记录发出帧的宿主连接。bridge 只用到 `send` 与 `close`。 */
function fakeSocket(): { sent: string[]; ws: never } {
  const sent: string[] = []
  return { sent, ws: { send: (s: string) => sent.push(s), close: () => {} } as never }
}

const ENVELOPE = new Set([
  'type',
  'requestId',
  'connectionEpoch',
  'hostId',
  'hostEpoch',
  'deadline',
  'foreground',
  'op',
])

test('bridge 按样例发出请求帧，并按样例认领结果帧', async () => {
  let foreground = false
  const bridge = new DesktopBridge('k', () => foreground)
  const { sent, ws } = fakeSocket()
  bridge.open(ws)
  bridge.message(ws, JSON.stringify(samples.hostReady))

  for (const [key, sample] of Object.entries(samples.requests)) {
    foreground = sample.foreground === true
    const params = Object.fromEntries(
      Object.entries(sample).filter(([k]) => !ENVELOPE.has(k)),
    ) as unknown as DesktopRequestParams
    const call = bridge.request(sample.op as DesktopOp, params)
    const frame = JSON.parse(sent.at(-1)!) as Json
    expect({ ...frame, requestId: 'dr_1', deadline: sample.deadline }).toEqual(sample as never)

    const result = samples.results.tree!
    bridge.message(ws, JSON.stringify({ ...result, requestId: frame.requestId }))
    expect((await call).observation, key).toEqual(result.observation as never)
  }

  for (const [key, result] of Object.entries(samples.results)) {
    const call = bridge.request('list_windows', { executorId: 'cv_a' })
    const frame = JSON.parse(sent.at(-1)!) as Json
    bridge.message(ws, JSON.stringify({ ...result, requestId: frame.requestId }))
    const expected: DesktopCallResult = {
      dispatch: result.dispatch as DesktopCallResult['dispatch'],
      ...Object.fromEntries(
        ['reason', 'observation', 'observationError', 'blocking']
          .filter((k) => result[k] !== undefined)
          .map((k) => [k, result[k]]),
      ),
    }
    expect(await call, key).toEqual(expected)
  }
})
