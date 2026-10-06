/**
 * 覆盖范围：`define-role.ts`（创建角色）。
 *
 * 测试对象是行为：写入受保护目录中的配置文件、只修改 roles、JSON 无法解析时不覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { defineRoleTool } from './define-role.ts'

function ctx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    stepId: 'st_test',
    requestPermission: async () => ({ allowed: true }),
  }
}

function withModels(root: string, models: { provider: string; model: string }[]): ToolContext {
  return {
    ...ctx(root),
    delegate: {
      resolveModel: (name, provider) => {
        const hits = models.filter(
          (item) => item.model === name && (!provider || item.provider === provider),
        )
        return hits.length === 1
          ? hits[0]!
          : {
              error: `配置中没有模型 ${name}。当前可用的是：${models.map((item) => item.model).join('、')}`,
            }
      },
      targets: async () => ({ roles: [], clis: [] }),
      subagents: async () => [],
      dispatch: async () => ({ ok: true, subagentId: 'cv_stub' }),
      runGraph: async () => ({ ok: true }),
      inflight: () => [],
    },
  }
}

const role = { id: 'reviewer', name: '审查员', description: '看代码', systemPrompt: '只读' }

async function ws(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'qy-role-'))
}

describe('创建角色', () => {
  test('写入 .qy/team.json：write_file 无法写入该目录', async () => {
    const root = await ws()
    const res = await defineRoleTool.fn(role, ctx(root))
    expect(res.status).toBe('success')
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles).toHaveLength(1)
    expect(doc.roles[0].id).toBe('reviewer')
  })

  /**
   * 复现的失败形状：模型整份改写该文件时，会一并修改用户配置的公共约束与并发上限。
   * 已开启却不生效的安全开关比没有该开关危害更大。
   */
  test('只修改 roles，rules 原样保留', async () => {
    const root = await ws()
    await mkdir(join(root, '.qy'), { recursive: true })
    await writeFile(
      join(root, '.qy', 'team.json'),
      JSON.stringify({ rules: { maxConcurrent: 2, shared: '别删库' }, roles: [] }),
      'utf8',
    )
    await defineRoleTool.fn(role, ctx(root))
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.rules).toEqual({ maxConcurrent: 2, shared: '别删库' })
    expect(doc.roles).toHaveLength(1)
  })

  test('同一 id 再次创建时覆盖原角色，不新增条目', async () => {
    const root = await ws()
    await defineRoleTool.fn(role, ctx(root))
    const res = await defineRoleTool.fn({ ...role, name: '改了名' }, ctx(root))
    expect((res.data as { replaced: boolean }).replaced).toBe(true)
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles).toHaveLength(1)
    expect(doc.roles[0].name).toBe('改了名')
  })

  test('覆盖已有角色时移除遗留的 maxSteps，不把步数限制写回配置', async () => {
    const root = await ws()
    await mkdir(join(root, '.qy'), { recursive: true })
    await writeFile(
      join(root, '.qy', 'team.json'),
      JSON.stringify({ roles: [{ ...role, maxSteps: 40 }] }),
      'utf8',
    )

    await defineRoleTool.fn(role, ctx(root))

    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles[0].maxSteps).toBeUndefined()
  })

  test('JSON 无法解析时不覆盖，并如实报告无法解析', async () => {
    const root = await ws()
    await mkdir(join(root, '.qy'), { recursive: true })
    await writeFile(join(root, '.qy', 'team.json'), '{ 这不是 json', 'utf8')
    const res = await defineRoleTool.fn(role, ctx(root))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('无法解析')
    expect(await readFile(join(root, '.qy', 'team.json'), 'utf8')).toBe('{ 这不是 json')
  })

  test('allowedTools 的空数组原样保留，不视为未填写', async () => {
    const root = await ws()
    await defineRoleTool.fn({ ...role, allowedTools: [] }, ctx(root))
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles[0].allowedTools).toEqual([])
  })

  test('模型名有误时不落盘，并返回可用模型', async () => {
    const root = await ws()
    const res = await defineRoleTool.fn(
      { ...role, model: 'glm5.3flash' },
      withModels(root, [{ provider: '智谱接口', model: 'glm-5.3-flash' }]),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('glm-5.3-flash')
    expect(await readFile(join(root, '.qy', 'team.json'), 'utf8').catch(() => null)).toBeNull()
  })

  test('配置中的接口与模型作为两个字段校验并落盘', async () => {
    const root = await ws()
    const res = await defineRoleTool.fn(
      { ...role, provider: '智谱/中转', model: 'glm/model-5.3-flash' },
      withModels(root, [{ provider: '智谱/中转', model: 'glm/model-5.3-flash' }]),
    )
    expect(res.status).toBe('success')
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles[0].provider).toBe('智谱/中转')
    expect(doc.roles[0].model).toBe('glm/model-5.3-flash')
  })

  test('只提供 provider 而未提供 model 时拒绝，不写入不完整的角色配置', async () => {
    const root = await ws()
    const res = await defineRoleTool.fn({ ...role, provider: '智谱接口' }, withModels(root, []))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('同时指定 model')
    expect(await readFile(join(root, '.qy', 'team.json'), 'utf8').catch(() => null)).toBeNull()
  })

  test('id 不合法时立即拒绝', async () => {
    const root = await ws()
    const res = await defineRoleTool.fn({ ...role, id: '带 空格/斜杠' }, ctx(root))
    expect(res.status).toBe('failure')
  })
})
