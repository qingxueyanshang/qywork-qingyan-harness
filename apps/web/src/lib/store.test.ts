/**
 * 前端状态里两块**纯逻辑**的回归锁。
 *
 * 只测不需要连接、不需要 DOM 的部分。组件级行为（面板真的展开了没有、密钥有没有
 * 出现在响应里）不在这里测：那些要么已由端到端实测覆盖，要么该由服务端测试锁，
 * 搬进单测只会变成测桩。
 *
 * ## 为什么要先补几个浏览器全局
 *
 * `store.ts` 顶层 `new QyClient(...)`，而 `QyClient` 有个**字段初始化器**
 * `private readonly endpoint = resolveEndpoint()`——构造函数体是空的，但字段
 * 在实例化时就跑，它要读 `location` / `sessionStorage` / `matchMedia`。
 * 所以这里先把这三样补上再动态 import，而不是去改产品代码加
 * `typeof location === 'undefined'` 的判断：那种判断只为测试存在，
 * 生产路径上永远走不到，属于 CLAUDE.md B5 说的空壳分支。
 */

import { describe, expect, test } from 'bun:test'

const g = globalThis as Record<string, unknown>
g.location = {
  hash: '',
  href: 'http://127.0.0.1:5180/',
  search: '',
  pathname: '/',
  origin: 'http://127.0.0.1:5180',
}
g.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
g.matchMedia = () => ({ matches: false })

const { explainApiError, openPanel, setSidePanel, sidePanel, togglePanel } = await import(
  './store.ts'
)

describe('右侧面板：一个按钮管开合，并记住上次看的视图', () => {
  test('收起状态下点开，回到默认的文件视图', () => {
    setSidePanel(null)
    togglePanel()
    expect(sidePanel()).toBe('files')
  })

  test('展开状态下点，收起', () => {
    openPanel('git')
    togglePanel()
    expect(sidePanel()).toBe(null)
  })

  test('收起再展开，回到上次待的地方而不是一律跳回文件', () => {
    openPanel('git')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('git')
  })

  test('换过几次视图后，记住的是最后那个', () => {
    openPanel('files')
    openPanel('git')
    openPanel('team')
    togglePanel()
    togglePanel()
    expect(sidePanel()).toBe('team')
  })

  test('反复开合不漂移 —— 偶数次回到展开，奇数次收起，视图始终是那一个', () => {
    openPanel('team')
    for (let i = 0; i < 6; i++) togglePanel()
    expect(sidePanel()).toBe('team')
    togglePanel()
    expect(sidePanel()).toBe(null)
    togglePanel()
    expect(sidePanel()).toBe('team')
  })
})

describe('接口错误还原成人话', () => {
  const err = (body: unknown) =>
    new Error(`422 /api/config: ${typeof body === 'string' ? body : JSON.stringify(body)}`)

  test('挖出 problems 数组，逐条说清哪里不合格', () => {
    const msg = explainApiError(
      err({ error: 'invalid', problems: ['缺 model', '缺 baseUrl'] }),
      '保存失败',
    )
    expect(msg).toBe('缺 model；缺 baseUrl')
  })

  test('没有 problems 就用 message', () => {
    expect(explainApiError(err({ message: '档案不存在' }), '保存失败')).toBe('档案不存在')
  })

  test('problems 优先于 message', () => {
    expect(explainApiError(err({ problems: ['甲'], message: '乙' }), 'x')).toBe('甲')
  })

  test('空的 problems 数组不算数，继续找 message', () => {
    expect(explainApiError(err({ problems: [], message: '乙' }), 'x')).toBe('乙')
  })

  test('响应体被截断解析不了时，回落到原文而不是泛化提示 —— 原文再难看也带着信息', () => {
    const raw = '422 /api/config: {"problems":["缺 mod'
    expect(explainApiError(new Error(raw), '保存失败')).toBe(raw)
  })

  test('压根不是 JSON 的错误，原样交出去', () => {
    expect(explainApiError(new Error('fetch failed'), '保存失败')).toBe('fetch failed')
  })

  test('非 Error 抛出物也不崩', () => {
    expect(explainApiError('炸了', '保存失败')).toBe('炸了')
  })

  test('只有空消息时才用兜底文案', () => {
    expect(explainApiError(new Error(''), '保存失败')).toBe('保存失败')
  })
})
