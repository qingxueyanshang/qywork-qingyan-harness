/**
 * 覆盖 `appearance/skin.ts` 的 `skin` 工具：列出、读取、按字段合并修改、设图片背景、切换与取消，
 * 以及 `index.ts` 中按 `skins` 注册。皮肤库的落盘由 runtime 的 `skins.test.ts` 覆盖，
 * 界面收到 apply 结果后切换由 `apps/web/src/components/appearance/appearance.test.tsx` 覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SkinPort, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { DEFAULT_SKIN, type Skin, type SkinEntry } from '@qywork/core'
import { registerBuiltinTools } from '../index.ts'
import { skinTool } from './skin.ts'

/** 内存中的皮肤库：记录每次保存收到的图片。 */
function memoryPort(): SkinPort & { images: string[]; entries: Map<string, SkinEntry> } {
  const entries = new Map<string, SkinEntry>()
  const images: string[] = []
  let n = 0
  return {
    entries,
    images,
    list: async () => [...entries.values()],
    read: async (id) => entries.get(id) ?? null,
    save: async (id, skin: Skin, image) => {
      if (image) images.push(`${image.name}:${image.bytes.byteLength}`)
      const entry = { id: id ?? `skin-${++n}`, skin, updatedAt: Date.now() }
      entries.set(entry.id, entry)
      return { ok: true, entry }
    },
  }
}

function ctx(root: string, skins?: SkinPort): ToolContext {
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
    ...(skins ? { skins } : {}),
  }
}

describe('skin', () => {
  test('新建只写要改的字段，其余取默认值；修改按参数组合并', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-skin-'))
    const port = memoryPort()
    const created = await skinTool.fn(
      { action: 'save', skin_json: JSON.stringify({ name: '星夜', surface: { opacity: 0.6 } }) },
      ctx(root, port),
    )
    expect(created).toMatchObject({ status: 'success', data: { id: 'skin-1' } })
    expect(port.entries.get('skin-1')?.skin).toEqual({
      ...DEFAULT_SKIN,
      name: '星夜',
      surface: { opacity: 0.6 },
    })

    const fog = { kind: 'fog' as const, color: '#ffffff', density: 0.6, speed: 0.4 }
    await skinTool.fn(
      { action: 'save', id: 'skin-1', skin_json: JSON.stringify({ effect: fog }) },
      ctx(root, port),
    )
    await skinTool.fn(
      { action: 'save', id: 'skin-1', skin_json: JSON.stringify({ effect: { density: 0.3 } }) },
      ctx(root, port),
    )
    expect(port.entries.get('skin-1')?.skin.effect).toEqual({ ...fog, density: 0.3 })
  })

  test('image 把工作区图片设为背景，保留 skin_json 中给出的填充参数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-skin-'))
    await writeFile(join(root, '星空.png'), new Uint8Array([1, 2, 3, 4]))
    const port = memoryPort()
    const r = await skinTool.fn(
      {
        action: 'save',
        image: '星空.png',
        skin_json: JSON.stringify({ background: { kind: 'image', dim: 0.4 } }),
      },
      ctx(root, port),
    )
    expect(r.status).toBe('success')
    expect(port.images).toEqual(['星空.png:4'])
    expect(port.entries.get('skin-1')?.skin.background).toEqual({
      kind: 'image',
      file: '星空.png',
      fit: 'cover',
      dim: 0.4,
      blur: 0,
    })
  })

  test('参数不合法、图片格式不支持、皮肤不存在时失败且不保存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-skin-'))
    await writeFile(join(root, 'a.svg'), '<svg/>')
    const port = memoryPort()
    const bad = await skinTool.fn(
      { action: 'save', skin_json: JSON.stringify({ surface: { opacity: 3 } }) },
      ctx(root, port),
    )
    expect(bad).toMatchObject({ status: 'failure', executed: false })
    expect(await skinTool.fn({ action: 'save', image: 'a.svg' }, ctx(root, port))).toMatchObject({
      status: 'failure',
    })
    expect(
      await skinTool.fn({ action: 'save', id: 'nope', skin_json: '{"name":"x"}' }, ctx(root, port)),
    ).toMatchObject({ status: 'failure', message: '皮肤不存在：nope' })
    expect(await skinTool.fn({ action: 'save', skin_json: '[1]' }, ctx(root, port))).toMatchObject({
      status: 'failure',
    })
    expect(port.entries.size).toBe(0)
  })

  test('apply 返回要切换的 id；none 取消皮肤；不存在时失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-skin-'))
    const port = memoryPort()
    await port.save('night', DEFAULT_SKIN)
    expect(await skinTool.fn({ action: 'apply', id: 'night' }, ctx(root, port))).toMatchObject({
      status: 'success',
      data: { applied: 'night' },
    })
    expect(await skinTool.fn({ action: 'apply', id: 'none' }, ctx(root, port))).toMatchObject({
      status: 'success',
      data: { applied: null },
    })
    expect(await skinTool.fn({ action: 'apply', id: 'x' }, ctx(root, port))).toMatchObject({
      status: 'failure',
    })
  })

  test('list 与 read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-skin-'))
    const port = memoryPort()
    expect(await skinTool.fn({ action: 'list' }, ctx(root, port))).toMatchObject({
      status: 'success',
      message: '皮肤库为空',
    })
    await port.save('night', { ...DEFAULT_SKIN, name: '夜' })
    const list = await skinTool.fn({ action: 'list' }, ctx(root, port))
    expect(list.message).toContain('night：夜（dark）')
    const read = await skinTool.fn({ action: 'read', id: 'night' }, ctx(root, port))
    expect(read).toMatchObject({ status: 'success', data: { id: 'night' } })
  })

  test('没有皮肤库通道时不注册', () => {
    const without = new ToolRegistry()
    registerBuiltinTools(without, {})
    expect(without.list().some((t) => t.name === 'skin')).toBe(false)
    const withSkins = new ToolRegistry()
    registerBuiltinTools(withSkins, { skins: true })
    expect(withSkins.list().some((t) => t.name === 'skin')).toBe(true)
  })
})
