/**
 * 覆盖范围：`team-run.ts` 的 `memberModel`（成员会话用哪一对「接口 × 模型」）
 * 与 `memberOutcome`（一个成员算不算做成了）。
 *
 * `runBuiltinMember` 本身要一整条 `Session` 才跑得起来，由冒烟脚本
 * `scripts/smoke-delegate.ts` 在真机上覆盖；这里锁的是它的选型规则。
 */

import { describe, expect, test } from 'bun:test'
import type { QyConfig } from '@qywork/runtime'
import { memberModel, memberOutcome, resolveModel } from './team-run.ts'

const config = {
  active: { provider: '默认接口', model: 'm-default' },
  providers: {
    默认接口: { kind: 'openai', models: { 'm-default': {}, 'm-other': {} } },
    便宜接口: { kind: 'openai', models: { 'm-cheap': {}, 'm-cheaper': {} } },
  },
} as unknown as QyConfig

const 父会话 = { provider: '便宜接口', model: 'm-cheap' }
const 继承 = { inherit: 父会话 }

describe('成员会话的选型', () => {
  /**
   * 复现的失败形状：用户在界面上把会话切到便宜模型，派出去的子 agent 仍然按
   * `config.active` 发请求——而工具描述向模型承诺的是「当前模型」。
   */
  test('角色没点名时跟父会话那一对，不是配置默认', () => {
    expect(memberModel({ id: 'ad-hoc' }, config, 继承)).toEqual(父会话)
  })

  test('没有可继承的那一对时才落回配置默认', () => {
    expect(memberModel({ id: 'ad-hoc' }, config)).toEqual(config.active)
  })

  test('角色点名了接口，父会话盖不过它', () => {
    expect(
      memberModel({ id: 'r', provider: '便宜接口', model: 'm-cheaper' }, config, 继承),
    ).toEqual({
      provider: '便宜接口',
      model: 'm-cheaper',
    })
  })

  test('点了接口没点模型时用该接口下的第一个', () => {
    expect(memberModel({ id: 'r', provider: '便宜接口' }, config, 继承)).toEqual({
      provider: '便宜接口',
      model: 'm-cheap',
    })
  })

  test('点了不存在的接口当场失败，不静默回落', () => {
    const r = memberModel({ id: 'r', provider: '查无此接口' }, config, 继承)
    expect('error' in r && r.error).toContain('查无此接口')
  })

  /** 只点模型不点接口的那条路按裸模型名发请求，接口靠反查——这一对不能换。 */
  test('角色只点了模型时保持配置默认那一对', () => {
    expect(memberModel({ id: 'r', model: 'm-other' }, config, 继承)).toEqual(config.active)
  })

  /** 用户这一次点名要换个模型跑，角色自己钉的那一对也得让开。 */
  test('用户点名的那一对盖过角色和父会话', () => {
    const explicit = { provider: '默认接口', model: 'm-other' }
    expect(
      memberModel({ id: 'r', provider: '便宜接口' }, config, { explicit, inherit: 父会话 }),
    ).toEqual(explicit)
  })
})

describe('点名的模型解析成一对', () => {
  test('模型 id 唯一时补上它挂在哪个接口下', () => {
    expect(resolveModel('m-cheap', config)).toEqual({ provider: '便宜接口', model: 'm-cheap' })
  })

  test('接口/模型 这种写法照收', () => {
    expect(resolveModel('默认接口/m-other', config)).toEqual({
      provider: '默认接口',
      model: 'm-other',
    })
  })

  /** 挑错接口是端点、key、价目表三样一起换掉且不报错，所以宁可拒。 */
  test('同一个 id 挂在两个接口下时拒绝，不按顺序挑', () => {
    const 撞名 = {
      active: { provider: 'a', model: 'same' },
      providers: { a: { models: { same: {} } }, b: { models: { same: {} } } },
    } as unknown as QyConfig
    const r = resolveModel('same', 撞名)
    expect('error' in r && r.error).toContain('接口/模型')
  })

  test('没配过的模型把能用的列出来', () => {
    const r = resolveModel('查无此模型', config)
    expect('error' in r && r.error).toContain('便宜接口/m-cheap')
  })
})

describe('成员算不算做成了', () => {
  test('跑到自然结束且有产出才算成', () => {
    expect(memberOutcome({ error: null, stop: 'completed', output: '结论' })).toEqual({ ok: true })
  })

  /**
   * 复现的失败形状：子 agent 被步数掐断，但它前面说过话——照「有文字就算成功」判，
   * 父会话收到的是「做完了」，然后拿着半截产出继续往下走。
   */
  test('被掐断时算失败，并把原因带回去', () => {
    const r = memberOutcome({ error: null, stop: 'max_steps', output: '写了一半' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('步数用尽')
  })

  test('没有终态一样不算成', () => {
    expect(memberOutcome({ error: null, stop: null, output: '有话' }).ok).toBe(false)
  })

  test('跑完了但一个字没产出，算失败不算「没什么可说的」', () => {
    const r = memberOutcome({ error: null, stop: 'completed', output: '' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有产出')
  })

  test('报错优先于终态：错误原文要原样带回去', () => {
    const r = memberOutcome({ error: '[no_api_key] 没配 key', stop: null, output: '' })
    expect(r.error).toContain('no_api_key')
  })
})
