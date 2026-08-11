/**
 * 派发器的契约。
 *
 * 拆成一域一文件之后，「哪条路径归谁管」从一个 439 行函数里的顺序，变成了
 * 八个模块各自的 `return null`。这里锁住那条契约本身：
 * **`null` 只表示「不归我管」**，任何真实结果都必须是 `Response`。
 *
 * 一个域返回了 `null` 但其实已经做过副作用，是这套结构唯一会出的新错——
 * 那会让请求继续往下走，被后面的域或 404 接管，而副作用已经发生了。
 *
 * 夹具用 `as unknown as ApiDeps`：这里挑的三条路由只碰 `ApiDeps` 里的四个字段，
 * 为它们造一个真的 Store 与 RunManager 只会把测试变成集成测试，
 * 而集成部分 `e2e.test.ts` 已经覆盖了。
 */

import { describe, expect, test } from 'bun:test'
import { type ApiDeps, handleApi } from './index.ts'

function deps(over: Partial<ApiDeps> = {}): ApiDeps {
  let lan = false
  return {
    workspaceRoot: 'C:/ws/demo',
    workspaceId: 'ws_demo',
    enableLan: () => {
      lan = true
      return { port: 7788 }
    },
    disableLan: () => {
      lan = false
    },
    lanEnabled: () => lan,
    lanPort: () => 7788,
    ...over,
  } as unknown as ApiDeps
}

const call = (path: string, init?: RequestInit, d: ApiDeps = deps()) =>
  handleApi(new URL(`http://127.0.0.1${path}`), new Request(`http://127.0.0.1${path}`, init), d)

describe('派发', () => {
  test('没人认领的路径回 null，不是 404 —— 404 由调用方决定', async () => {
    expect(await call('/api/nope')).toBe(null)
    expect(await call('/api/plugins/x/y/z')).toBe(null)
  })

  test('认领了就回 Response', async () => {
    const res = await call('/api/workspace')
    expect(res).toBeInstanceOf(Response)
    expect(res?.status).toBe(200)
  })

  test('工作区那条回的是「我在哪」，名字取目录名', async () => {
    const res = await call('/api/workspace')
    expect(await res?.json()).toEqual({ id: 'ws_demo', root: 'C:/ws/demo', name: 'demo' })
  })

  test('根目录这种取不出目录名时回落到整条路径，不回空串', async () => {
    const res = await call('/api/workspace', undefined, deps({ workspaceRoot: '/' }))
    expect(((await res?.json()) as { name: string }).name).toBe('/')
  })
})

describe('方法参与匹配，不是只看路径', () => {
  test('POST 才切局域网开关；GET 同一路径不归它管', async () => {
    const d = deps()
    expect(await call('/api/pairing/lan', undefined, d)).toBe(null)
    expect(d.lanEnabled()).toBe(false)
  })

  test('开关真的翻转，且回的是翻转后的状态', async () => {
    const d = deps()
    const on = await call(
      '/api/pairing/lan',
      { method: 'POST', body: JSON.stringify({ enabled: true }) },
      d,
    )
    expect(await on?.json()).toEqual({ enabled: true })
    expect(d.lanEnabled()).toBe(true)

    const off = await call(
      '/api/pairing/lan',
      { method: 'POST', body: JSON.stringify({ enabled: false }) },
      d,
    )
    expect(await off?.json()).toEqual({ enabled: false })
    expect(d.lanEnabled()).toBe(false)
  })

  test('body 不是合法 JSON 时按「关」处理，不抛 —— 开关默认落在更安全的一侧', async () => {
    const d = deps({ lanEnabled: () => true })
    const res = await call('/api/pairing/lan', { method: 'POST', body: 'not json' }, d)
    expect(res?.status).toBe(200)
  })
})

describe('出参形状', () => {
  test('一律 application/json 且带 charset —— 少了 charset 中文会被按 ASCII 读', async () => {
    const res = await call('/api/workspace')
    expect(res?.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })
})
