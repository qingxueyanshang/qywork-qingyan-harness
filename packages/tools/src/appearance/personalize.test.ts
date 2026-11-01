/**
 * 覆盖 `appearance/personalize.ts` 的 `personalize` 工具：读取、按字段合并修改、设图片背景、恢复默认，
 * 以及 `index.ts` 中按 `personalization` 注册。落盘由 runtime 的 `personalization.test.ts` 覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PersonalizationPort, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { DEFAULT_PERSONALIZATION, type Personalization } from '@qywork/core'
import { registerBuiltinTools } from '../index.ts'
import { personalizeTool } from './personalize.ts'

/** 内存中的个性化：记录每次保存收到的图片。 */
function memoryPort(): PersonalizationPort & { images: string[]; value: () => Personalization } {
  let value: Personalization = DEFAULT_PERSONALIZATION
  const images: string[] = []
  return {
    images,
    value: () => value,
    read: async () => ({ ok: true, entry: { personalization: value, updatedAt: 1 } }),
    save: async (next, image) => {
      if (image) images.push(`${image.name}:${image.bytes.byteLength}`)
      value = next
      return { ok: true, entry: { personalization: next, updatedAt: 2 } }
    },
    reset: async () => {
      value = DEFAULT_PERSONALIZATION
      return { personalization: value, updatedAt: 0 }
    },
  }
}

function ctx(root: string, personalization?: PersonalizationPort): ToolContext {
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
    ...(personalization ? { personalization } : {}),
  }
}

describe('personalize', () => {
  test('save 只写要改的字段，其余沿用当前值；雾面逐字段合并', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-personal-'))
    const port = memoryPort()
    const fog = { color: '#ffffff', density: 0.6, speed: 0.4 }
    const r = await personalizeTool.fn(
      { action: 'save', json: JSON.stringify({ opacity: 0.6, fog }) },
      ctx(root, port),
    )
    expect(r.status).toBe('success')
    await personalizeTool.fn(
      { action: 'save', json: JSON.stringify({ fog: { density: 0.3 } }) },
      ctx(root, port),
    )
    expect(port.value()).toEqual({
      ...DEFAULT_PERSONALIZATION,
      opacity: 0.6,
      fog: { ...fog, density: 0.3 },
    })
  })

  test('image 把工作区图片设为背景，保留 json 中给出的填充参数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-personal-'))
    await writeFile(join(root, '星空.png'), new Uint8Array([1, 2, 3, 4]))
    const port = memoryPort()
    const r = await personalizeTool.fn(
      {
        action: 'save',
        image: '星空.png',
        json: JSON.stringify({ background: { kind: 'image', dim: 0.4 } }),
      },
      ctx(root, port),
    )
    expect(r.status).toBe('success')
    expect(port.images).toEqual(['星空.png:4'])
    expect(port.value().background).toEqual({
      kind: 'image',
      file: '星空.png',
      fit: 'cover',
      dim: 0.4,
      blur: 0,
    })
  })

  test('参数不合法、图片格式不支持时失败且不保存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-personal-'))
    await writeFile(join(root, 'a.svg'), '<svg/>')
    const port = memoryPort()
    expect(
      await personalizeTool.fn({ action: 'save', json: '{"opacity":3}' }, ctx(root, port)),
    ).toMatchObject({ status: 'failure', executed: false })
    expect(
      await personalizeTool.fn({ action: 'save', image: 'a.svg' }, ctx(root, port)),
    ).toMatchObject({ status: 'failure' })
    expect(
      await personalizeTool.fn({ action: 'save', json: '[1]' }, ctx(root, port)),
    ).toMatchObject({
      status: 'failure',
    })
    expect(port.value()).toEqual(DEFAULT_PERSONALIZATION)
  })

  test('read 返回当前参数，reset 恢复默认', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-personal-'))
    const port = memoryPort()
    await port.save({ ...DEFAULT_PERSONALIZATION, accent: '#7c3aed' })
    expect(await personalizeTool.fn({ action: 'read' }, ctx(root, port))).toMatchObject({
      status: 'success',
      data: { personalization: { accent: '#7c3aed' } },
    })
    expect(await personalizeTool.fn({ action: 'reset' }, ctx(root, port))).toMatchObject({
      status: 'success',
    })
    expect(port.value()).toEqual(DEFAULT_PERSONALIZATION)
  })

  test('没有个性化通道时不注册', () => {
    const without = new ToolRegistry()
    registerBuiltinTools(without, {})
    expect(without.list().some((t) => t.name === 'personalize')).toBe(false)
    const withPort = new ToolRegistry()
    registerBuiltinTools(withPort, { personalization: true })
    expect(withPort.list().some((t) => t.name === 'personalize')).toBe(true)
  })
})
