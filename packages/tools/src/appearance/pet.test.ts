/**
 * 覆盖 `appearance/pet.ts` 的 `pet` 工具：从工作区目录读取帧并保存、切换与切回内置宠物，
 * 以及 `index.ts` 中按 `pets` 注册。宠物库落盘由 runtime 的 `pets.test.ts` 覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PetPort, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { PetEntry } from '@qywork/core'
import { registerBuiltinTools } from '../index.ts'
import { petTool } from './pet.ts'

function memoryPort(): PetPort & { saved: string[][]; entries: Map<string, PetEntry> } {
  const entries = new Map<string, PetEntry>()
  const saved: string[][] = []
  return {
    entries,
    saved,
    list: async () => [...entries.values()],
    read: async (id) => entries.get(id) ?? null,
    save: async (id, pack, images) => {
      saved.push(images.map((i) => i.name))
      const entry = { id: id ?? 'pet-1', pack, updatedAt: 1 }
      entries.set(entry.id, entry)
      return { ok: true, entry }
    },
  }
}

function ctx(root: string, pets?: PetPort): ToolContext {
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
    requestPermission: async () => ({ allowed: true }),
    ...(pets ? { pets } : {}),
  }
}

const one = (f: string) => ({ frames: [f], fps: 1 })
const pack = {
  name: '猫',
  size: 72,
  states: {
    desktop: one('look.png'),
    failed: one('sad.png'),
    working: { frames: ['w1.png', 'w2.png'], fps: 3 },
    done: one('happy.png'),
    idle: one('idle.png'),
  },
}

describe('pet', () => {
  test('save 从工作区目录读取全部帧并保存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-pet-'))
    await mkdir(join(root, 'pets', 'cat'), { recursive: true })
    for (const f of ['look.png', 'sad.png', 'w1.png', 'w2.png', 'happy.png', 'idle.png']) {
      await writeFile(join(root, 'pets', 'cat', f), new Uint8Array([1]))
    }
    const port = memoryPort()
    const r = await petTool.fn(
      { action: 'save', dir: 'pets/cat', pack_json: JSON.stringify(pack) },
      ctx(root, port),
    )
    expect(r).toMatchObject({ status: 'success', data: { id: 'pet-1' } })
    expect(port.saved[0]?.sort()).toEqual([
      'happy.png',
      'idle.png',
      'look.png',
      'sad.png',
      'w1.png',
      'w2.png',
    ])
  })

  test('宠物包不合法、缺少参数时失败且不保存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-pet-'))
    const port = memoryPort()
    const { idle: _, ...states } = pack.states
    expect(
      await petTool.fn(
        { action: 'save', dir: '.', pack_json: JSON.stringify({ ...pack, states }) },
        ctx(root, port),
      ),
    ).toMatchObject({ status: 'failure', message: '缺少状态 idle' })
    expect(await petTool.fn({ action: 'save', pack_json: '{}' }, ctx(root, port))).toMatchObject({
      status: 'failure',
    })
    expect(port.saved).toEqual([])
  })

  test('apply 返回要切换的 id；default 切回默认宠物，dango 切换到内置的团子', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-pet-'))
    const port = memoryPort()
    port.entries.set('pet-1', { id: 'pet-1', pack, updatedAt: 1 })
    expect(await petTool.fn({ action: 'apply', id: 'pet-1' }, ctx(root, port))).toMatchObject({
      data: { applied: 'pet-1' },
    })
    expect(await petTool.fn({ action: 'apply', id: 'default' }, ctx(root, port))).toMatchObject({
      data: { applied: null },
    })
    expect(await petTool.fn({ action: 'apply', id: 'dango' }, ctx(root, port))).toMatchObject({
      data: { applied: 'dango' },
    })
    expect(await petTool.fn({ action: 'apply', id: 'x' }, ctx(root, port))).toMatchObject({
      status: 'failure',
    })
  })

  test('没有宠物库通道时不注册', () => {
    const r = new ToolRegistry()
    registerBuiltinTools(r, { pets: true })
    expect(r.list().some((t) => t.name === 'pet')).toBe(true)
    const none = new ToolRegistry()
    registerBuiltinTools(none, {})
    expect(none.list().some((t) => t.name === 'pet')).toBe(false)
  })
})
