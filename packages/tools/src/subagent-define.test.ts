/**
 * 覆盖范围：`subagent-define.ts`（建子 agent）。
 *
 * 测的是**行为**：写进受保护目录里的那个文件、只动 roles、坏 JSON 不覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { defineSubagentTool } from './subagent-define.ts'

function ctx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    stepId: 'st_test',
    requestPermission: async () => true,
  }
}

const role = { id: 'reviewer', name: '审查员', description: '看代码', systemPrompt: '只读' }

async function ws(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'qy-role-'))
}

describe('建子 agent', () => {
  test('写进 .qy/team.json —— 那是 write_file 进不去的目录', async () => {
    const root = await ws()
    const res = await defineSubagentTool.fn(role, ctx(root))
    expect(res.status).toBe('success')
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles).toHaveLength(1)
    expect(doc.roles[0].id).toBe('reviewer')
  })

  /**
   * 复现的失败形状：让模型整份改写这个文件，它能一并改掉用户配的公共约束与并发闸。
   * 一个开着但不生效的安全开关比没有这个开关更坏。
   */
  test('只动 roles，rules 原样留着', async () => {
    const root = await ws()
    await mkdir(join(root, '.qy'), { recursive: true })
    await writeFile(
      join(root, '.qy', 'team.json'),
      JSON.stringify({ rules: { maxConcurrent: 2, shared: '别删库' }, roles: [] }),
      'utf8',
    )
    await defineSubagentTool.fn(role, ctx(root))
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.rules).toEqual({ maxConcurrent: 2, shared: '别删库' })
    expect(doc.roles).toHaveLength(1)
  })

  test('同一个 id 再建一次是覆盖，不是加一条', async () => {
    const root = await ws()
    await defineSubagentTool.fn(role, ctx(root))
    const res = await defineSubagentTool.fn({ ...role, name: '改了名' }, ctx(root))
    expect((res.data as { replaced: boolean }).replaced).toBe(true)
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles).toHaveLength(1)
    expect(doc.roles[0].name).toBe('改了名')
  })

  test('坏 JSON 不覆盖，如实说解析不了', async () => {
    const root = await ws()
    await mkdir(join(root, '.qy'), { recursive: true })
    await writeFile(join(root, '.qy', 'team.json'), '{ 这不是 json', 'utf8')
    const res = await defineSubagentTool.fn(role, ctx(root))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('解析不了')
    expect(await readFile(join(root, '.qy', 'team.json'), 'utf8')).toBe('{ 这不是 json')
  })

  test('allowedTools 的空数组留着，不当成没填', async () => {
    const root = await ws()
    await defineSubagentTool.fn({ ...role, allowedTools: [] }, ctx(root))
    const doc = JSON.parse(await readFile(join(root, '.qy', 'team.json'), 'utf8'))
    expect(doc.roles[0].allowedTools).toEqual([])
  })

  test('id 不合法当场拒绝', async () => {
    const root = await ws()
    const res = await defineSubagentTool.fn({ ...role, id: '带 空格/斜杠' }, ctx(root))
    expect(res.status).toBe('failure')
  })
})
