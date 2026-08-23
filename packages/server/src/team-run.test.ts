/**
 * 覆盖范围：`team-run.ts` 的 `memberModel`——成员会话用哪一对「接口 × 模型」。
 *
 * `runBuiltinMember` 本身要一整条 `Session` 才跑得起来，由冒烟脚本
 * `scripts/smoke-delegate.ts` 在真机上覆盖；这里锁的是它的选型规则。
 */

import { describe, expect, test } from 'bun:test'
import type { QyConfig } from '@qywork/runtime'
import { memberModel } from './team-run.ts'

const config = {
  active: { provider: '默认接口', model: 'm-default' },
  providers: {
    默认接口: { kind: 'openai', models: { 'm-default': {}, 'm-other': {} } },
    便宜接口: { kind: 'openai', models: { 'm-cheap': {}, 'm-cheaper': {} } },
  },
} as unknown as QyConfig

const 父会话 = { provider: '便宜接口', model: 'm-cheap' }

describe('成员会话的选型', () => {
  /**
   * 复现的失败形状：用户在界面上把会话切到便宜模型，派出去的子 agent 仍然按
   * `config.active` 发请求——而工具描述向模型承诺的是「当前模型」。
   */
  test('角色没点名时跟父会话那一对，不是配置默认', () => {
    expect(memberModel({ id: 'ad-hoc' }, config, 父会话)).toEqual(父会话)
  })

  test('没有可继承的那一对时才落回配置默认', () => {
    expect(memberModel({ id: 'ad-hoc' }, config)).toEqual(config.active)
  })

  test('角色点名了接口，父会话盖不过它', () => {
    expect(
      memberModel({ id: 'r', provider: '便宜接口', model: 'm-cheaper' }, config, 父会话),
    ).toEqual({
      provider: '便宜接口',
      model: 'm-cheaper',
    })
  })

  test('点了接口没点模型时用该接口下的第一个', () => {
    expect(memberModel({ id: 'r', provider: '便宜接口' }, config, 父会话)).toEqual({
      provider: '便宜接口',
      model: 'm-cheap',
    })
  })

  test('点了不存在的接口当场失败，不悄悄回落', () => {
    const r = memberModel({ id: 'r', provider: '查无此接口' }, config, 父会话)
    expect('error' in r && r.error).toContain('查无此接口')
  })

  /** 只点模型不点接口的那条路按裸模型名发请求，接口靠反查——这一对不能换。 */
  test('角色只点了模型时保持配置默认那一对', () => {
    expect(memberModel({ id: 'r', model: 'm-other' }, config, 父会话)).toEqual(config.active)
  })
})
