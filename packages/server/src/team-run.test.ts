/**
 * 覆盖范围：`team-run.ts` 的 `memberModel`（成员会话使用的「接口 × 模型」）、
 * `memberOutcome`（成员是否算作成功）与 `ownerWorkspace`（浏览器控制所属的工作区）。
 *
 * `runBuiltinMember` 本身需要完整的 `Session` 才能运行，由冒烟脚本
 * `scripts/smoke-delegate.ts` 在真机上覆盖；此处锁定的是它的模型选择规则。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationId, WorkspaceId } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { createConversation, Store, upsertWorkspace } from '@qywork/store'
import { memberModel, memberOutcome, ownerWorkspace, resolveModel } from './team-run.ts'

const config = {
  active: { provider: '默认接口', model: 'm-default' },
  providers: {
    默认接口: { kind: 'openai', models: { 'm-default': {}, 'm-other': {} } },
    便宜接口: { kind: 'openai', models: { 'm-cheap': {}, 'm-cheaper': {} } },
  },
} as unknown as QyConfig

const 父会话 = { provider: '便宜接口', model: 'm-cheap' }
const 继承 = { inherit: 父会话 }

describe('成员会话的模型选择', () => {
  /**
   * 复现的失败形状：用户在界面上把会话切换到低价模型后，已派发的子 agent 仍按
   * `config.active` 发送请求，而工具描述向模型承诺的是「当前模型」。
   */
  test('角色未指定时沿用父会话的接口与模型，而非配置默认值', () => {
    expect(memberModel({ id: 'ad-hoc' }, config, 继承)).toEqual(父会话)
  })

  test('没有可继承的接口与模型时回退到配置默认值', () => {
    expect(memberModel({ id: 'ad-hoc' }, config)).toEqual({
      provider: '默认接口',
      model: 'm-default',
    })
  })

  test('既无可继承值也无配置默认模型时明确返回错误，不返回缺少模型的结果', () => {
    const noModel = { providers: config.providers } as unknown as QyConfig
    const r = memberModel({ id: 'ad-hoc' }, noModel)
    expect('error' in r).toBe(true)
  })

  test('角色指定的接口优先于父会话', () => {
    expect(
      memberModel({ id: 'r', provider: '便宜接口', model: 'm-cheaper' }, config, 继承),
    ).toEqual({
      provider: '便宜接口',
      model: 'm-cheaper',
    })
  })

  test('只指定接口时使用该接口下的第一个模型', () => {
    expect(memberModel({ id: 'r', provider: '便宜接口' }, config, 继承)).toEqual({
      provider: '便宜接口',
      model: 'm-cheap',
    })
  })

  test('指定的接口没有模型时本地拒绝', () => {
    const empty = {
      ...config,
      providers: { ...config.providers, 空接口: { kind: 'openai', models: {} } },
    } as unknown as QyConfig
    const r = memberModel({ id: 'r', provider: '空接口' }, empty, 继承)
    expect('error' in r && r.error).toContain('没有配置模型')
  })

  test('指定不存在的接口时立即失败，不静默回退', () => {
    const r = memberModel({ id: 'r', provider: '查无此接口' }, config, 继承)
    expect('error' in r && r.error).toContain('查无此接口')
  })

  /** 只指定模型时也必须在创建会话前确定所属接口，不能先使用默认接口再依据模型名推测。 */
  test('角色只指定模型时反查并固定其所属接口', () => {
    expect(memberModel({ id: 'r', model: 'm-cheap' }, config, 继承)).toEqual({
      provider: '便宜接口',
      model: 'm-cheap',
    })
  })

  test('角色模型不存在时本地拒绝，不回退到默认接口', () => {
    const r = memberModel({ id: 'r', model: '写错的模型' }, config, 继承)
    expect('error' in r && r.error).toContain('配置中没有模型')
  })

  test('角色指定接口时，模型也必须属于该接口', () => {
    const r = memberModel({ id: 'r', provider: '默认接口', model: 'm-cheap' }, config, 继承)
    expect('error' in r && r.error).toContain('不存在的模型')
  })

  /** 用户本次指定其他模型运行时，该指定优先于角色固定的接口与模型。 */
  test('用户指定的接口与模型优先于角色与父会话', () => {
    const explicit = { provider: '默认接口', model: 'm-other' }
    expect(
      memberModel({ id: 'r', provider: '便宜接口' }, config, { explicit, inherit: 父会话 }),
    ).toEqual(explicit)
  })
})

describe('将指定的模型解析为接口与模型', () => {
  test('模型 id 唯一时补全其所属接口', () => {
    expect(resolveModel('m-cheap', config)).toEqual({ provider: '便宜接口', model: 'm-cheap' })
  })

  test('「接口/模型」拼接字符串不作为第二种选择方式', () => {
    expect(resolveModel('默认接口/m-other', config)).toMatchObject({
      error: expect.stringContaining('配置中没有模型'),
    })
  })

  test('带斜杠的接口只能通过结构化 provider 与 model 选择', () => {
    const legacy = {
      active: { provider: '官方/中转', model: 'm' },
      providers: { '官方/中转': { models: { m: {} } } },
    } as unknown as QyConfig
    expect(resolveModel('官方/中转/m', legacy)).toMatchObject({
      error: expect.stringContaining('配置中没有模型'),
    })
  })

  test('结构化的接口与模型不受名称中斜杠的影响', () => {
    const slash = {
      active: { provider: '官方/中转', model: 'anthropic/claude-opus-5' },
      providers: {
        '官方/中转': { models: { 'anthropic/claude-opus-5': {} } },
      },
    } as unknown as QyConfig
    expect(resolveModel('anthropic/claude-opus-5', slash, '官方/中转')).toEqual({
      provider: '官方/中转',
      model: 'anthropic/claude-opus-5',
    })
  })

  test('结构化接口存在但模型不属于该接口时本地拒绝', () => {
    const r = resolveModel('m-cheap', config, '默认接口')
    expect('error' in r && r.error).toContain('接口 默认接口 下没有模型 m-cheap')
  })

  /** 选错接口会同时更换端点、key 与价目表且不报错，因此直接拒绝。 */
  test('同一模型 id 配置在两个接口下时拒绝，不按顺序选择', () => {
    const 撞名 = {
      active: { provider: 'a', model: 'same' },
      providers: { a: { models: { same: {} } }, b: { models: { same: {} } } },
    } as unknown as QyConfig
    const r = resolveModel('same', 撞名)
    expect('error' in r && r.error).toContain('同时指定 provider 与 model')
  })

  test('未配置的模型返回可用模型清单', () => {
    const r = resolveModel('查无此模型', config)
    expect('error' in r && r.error).toContain('provider="便宜接口", model="m-cheap"')
  })
})

describe('成员是否算作成功', () => {
  test('执行到自然结束且有产出才算成功', () => {
    expect(memberOutcome({ error: null, stop: 'completed', output: '结论' })).toEqual({ ok: true })
  })

  test('连续无进展时算失败，并返回原因', () => {
    const r = memberOutcome({ error: null, stop: 'no_progress', output: '写了一半' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有任何进展')
  })

  test('没有终态时同样不算成功', () => {
    expect(memberOutcome({ error: null, stop: null, output: '有话' }).ok).toBe(false)
  })

  test('执行完毕但没有任何产出时算失败，不视为无内容可报告', () => {
    const r = memberOutcome({ error: null, stop: 'completed', output: '' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有产出')
  })

  test('错误优先于终态：错误原文原样返回', () => {
    const r = memberOutcome({ error: '[no_api_key] 没配 key', stop: null, output: '' })
    expect(r.error).toContain('no_api_key')
  })
})

describe('成员的浏览器控制所属的工作区', () => {
  const dirs: string[] = []
  const stores: Store[] = []
  afterAll(() => {
    for (const s of stores) s.close()
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  })

  function freshStore(): { store: Store; workspaceId: WorkspaceId } {
    const dir = mkdtempSync(join(tmpdir(), 'qywork-team-'))
    dirs.push(dir)
    const store = new Store({ path: join(dir, 'a.sqlite3') })
    stores.push(store)
    const ws = upsertWorkspace(store, dir, 'W')
    return { store, workspaceId: ws.id }
  }

  test('读取派发该成员的顶层会话所在的工作区', () => {
    const { store, workspaceId } = freshStore()
    const top = createConversation(store, { workspaceId, provider: 'p', model: 'm' })
    expect(ownerWorkspace(store, top.id)).toBe(workspaceId)
  })

  /** 未查到顶层会话行时返回 `null`，调用方据此不创建端口；不传空字符串让宿主推测。 */
  test('未查到会话行时返回 null', () => {
    const { store } = freshStore()
    expect(ownerWorkspace(store, 'cv_查无此会话' as ConversationId)).toBeNull()
  })
})
