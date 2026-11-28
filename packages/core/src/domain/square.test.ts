/**
 * 覆盖范围：`square.ts` 的 `checkSquareSnapshot`（按大小与文件头校验、定义文件的上限）、`checkSquareSnapshotBytes`
 * （各类型的规则）与 `squareTextProblem`。
 */

import { describe, expect, test } from 'bun:test'
import {
  checkSquareSnapshot,
  checkSquareSnapshotBytes,
  SQUARE_LIMITS,
  squareTextProblem,
} from './square.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])
const file = (path: string, bytes: Uint8Array | string) => ({
  path,
  bytes: typeof bytes === 'string' ? enc(bytes) : bytes,
})
const error = (r: ReturnType<typeof checkSquareSnapshotBytes>) => (r.ok ? null : r.error)

describe('快照的通用规则', () => {
  test('路径不合法或重复时拒绝', () => {
    for (const path of ['../a.png', 'a//b', 'a\\b', '/abs', './x']) {
      expect(
        error(checkSquareSnapshotBytes('work', { format: 'image' }, [file(path, PNG)])),
      ).toContain('路径不合法')
    }
    expect(
      error(checkSquareSnapshotBytes('pet', {}, [file('pet.json', '{}'), file('pet.json', '{}')])),
    ).toContain('路径重复')
  })

  test('只按大小与文件头校验：内容不在内存中的大文件按声明的大小判定', () => {
    const video = { path: 'video.mp4', size: SQUARE_LIMITS.video, head: MP4 }
    const cover = { path: 'cover.png', size: PNG.length, head: PNG }
    expect(checkSquareSnapshot('work', { format: 'video' }, [video, cover], null)).toMatchObject({
      ok: true,
      mime: { 'video.mp4': 'video/mp4', 'cover.png': 'image/png' },
    })
    expect(
      error(
        checkSquareSnapshot(
          'work',
          { format: 'video' },
          [{ ...video, size: SQUARE_LIMITS.video + 1 }, cover],
          null,
        ),
      ),
    ).toBe('video.mp4 超过 1 GB')
  })

  test('定义文件超过上限时拒绝；快照中有定义文件而未传入其内容时按缺少处理', () => {
    const md = enc('---\nname: a\ndescription: b\n---\n')
    const big = { path: 'SKILL.md', size: SQUARE_LIMITS.definition + 1, head: md }
    expect(error(checkSquareSnapshot('skill', {}, [big], md))).toBe('SKILL.md 超过 20 MB')
    const skill = { path: 'SKILL.md', size: md.length, head: md.subarray(0, 16) }
    expect(checkSquareSnapshot('skill', {}, [skill], md).ok).toBe(true)
    expect(error(checkSquareSnapshot('skill', {}, [skill], null))).toBe('快照中缺少 SKILL.md')
  })

  test('标题与简介', () => {
    expect(squareTextProblem(' ', '')).toBe('标题不能为空')
    expect(squareTextProblem('x'.repeat(61), '')).toContain('标题超过')
    expect(squareTextProblem('标题', 'x'.repeat(501))).toContain('简介超过')
    expect(squareTextProblem('标题', '')).toBeNull()
  })
})

describe('各类型', () => {
  test('提示词：正文必填，不含文件', () => {
    expect(checkSquareSnapshotBytes('prompt', { text: '写一首诗' }, [])).toMatchObject({
      ok: true,
      meta: { text: '写一首诗' },
      cover: null,
    })
    expect(error(checkSquareSnapshotBytes('prompt', { text: ' ' }, []))).toBe('提示词不能为空')
    expect(error(checkSquareSnapshotBytes('prompt', { text: 'a' }, [file('a.txt', 'x')]))).toBe(
      '该类型的快照不含文件',
    )
  })

  test('作品：图片、视频与封面、PPT 与逐页图片；文件头与扩展名一致', () => {
    expect(
      checkSquareSnapshotBytes('work', { format: 'image' }, [file('image.png', PNG)]),
    ).toMatchObject({ ok: true, cover: 'image.png', mime: { 'image.png': 'image/png' } })
    expect(
      error(
        checkSquareSnapshotBytes('work', { format: 'image' }, [file('image.png', enc('<svg/>'))]),
      ),
    ).toContain('不是 PNG')
    expect(
      checkSquareSnapshotBytes('work', { format: 'video', prompt: '海边' }, [
        file('video.mp4', MP4),
        file('cover.png', PNG),
      ]),
    ).toMatchObject({ ok: true, meta: { format: 'video', prompt: '海边' }, cover: 'cover.png' })
    expect(
      error(checkSquareSnapshotBytes('work', { format: 'video' }, [file('video.mp4', MP4)])),
    ).toContain('缺少 cover.png')
    expect(
      checkSquareSnapshotBytes('work', { format: 'pptx' }, [
        file('deck.pptx', ZIP),
        file('pages/1.png', PNG),
        file('pages/2.png', PNG),
      ]),
    ).toMatchObject({ ok: true, cover: 'pages/1.png' })
    expect(
      error(
        checkSquareSnapshotBytes('work', { format: 'pptx' }, [
          file('deck.pptx', ZIP),
          file('pages/1.png', PNG),
          file('notes.txt', 'x'),
        ]),
      ),
    ).toContain('不应有该文件：notes.txt')
  })

  test('画布：引用的文件都在 files/ 下，不含生成记录与待取回的任务记录', () => {
    const doc = (path: string, extra: object = {}) =>
      JSON.stringify({
        version: 1,
        nodes: [{ id: 'n1', type: 'file', path, x: 0, y: 0, w: 100, h: 100 }],
        edges: [],
        ...extra,
      })
    expect(
      checkSquareSnapshotBytes('canvas', {}, [
        file('canvas.json', doc('art/a.png')),
        file('files/art/a.png', PNG),
      ]),
    ).toMatchObject({ ok: true, cover: 'files/art/a.png' })
    expect(
      error(checkSquareSnapshotBytes('canvas', {}, [file('canvas.json', doc('art/a.png'))])),
    ).toContain('缺少 files/art/a.png')
    expect(
      error(checkSquareSnapshotBytes('canvas', {}, [file('canvas.json', doc('../a.png'))])),
    ).toContain('canvas.json 不合法')
    expect(
      error(
        checkSquareSnapshotBytes('canvas', {}, [
          file('canvas.json', doc('out/a.task.json')),
          file('files/out/a.task.json', '{}'),
        ]),
      ),
    ).toContain('不能发布')
  })

  test('插件：清单按电脑端的同一规则校验，id 与版本由清单得出', () => {
    const manifest = {
      id: 'demo.hello',
      name: '示例',
      version: '1.0.0',
      description: '示例插件',
      manifestVersion: 1,
      permissions: [],
      contributes: {},
    }
    expect(
      checkSquareSnapshotBytes('plugin', {}, [
        file('qywork.plugin.json', JSON.stringify(manifest)),
      ]),
    ).toMatchObject({ ok: true, meta: { pluginId: 'demo.hello', name: '示例', version: '1.0.0' } })
    expect(
      error(
        checkSquareSnapshotBytes('plugin', {}, [
          file('qywork.plugin.json', JSON.stringify({ ...manifest, id: 'X' })),
        ]),
      ),
    ).toContain('id 必须是')
  })

  test('技能：SKILL.md 的名称与描述由前置元信息得出', () => {
    expect(
      checkSquareSnapshotBytes('skill', {}, [
        file('SKILL.md', '---\nname: 发版\ndescription: 发布一个版本\n---\n'),
        file('scripts/run.py', 'print(1)'),
      ]),
    ).toMatchObject({ ok: true, meta: { name: '发版', description: '发布一个版本' } })
    expect(
      error(checkSquareSnapshotBytes('skill', {}, [file('SKILL.md', '# 无元信息')])),
    ).toContain('description')
  })

  test('MCP：配置按电脑端的同一规则解析；env 与 headers 只保留键', () => {
    expect(
      checkSquareSnapshotBytes(
        'mcp',
        { name: 'fs', server: { command: 'npx', env: { TOKEN: '' } } },
        [],
      ),
    ).toMatchObject({
      ok: true,
      meta: { name: 'fs', server: { command: 'npx', env: { TOKEN: '' } } },
    })
    expect(
      error(
        checkSquareSnapshotBytes(
          'mcp',
          { name: 'fs', server: { command: 'npx', env: { TOKEN: 'sk-1' } } },
          [],
        ),
      ),
    ).toContain('值须为空串')
    expect(error(checkSquareSnapshotBytes('mcp', { name: 'fs', server: {} }, []))).toContain(
      'command',
    )
  })

  test('宠物：帧图片都在快照中；皮肤：背景图片在快照中', () => {
    const anim = { frames: ['a.png'], fps: 4 }
    const pack = {
      name: '猫',
      size: 96,
      states: { desktop: anim, failed: anim, working: anim, done: anim, idle: anim },
    }
    expect(
      checkSquareSnapshotBytes('pet', {}, [
        file('pet.json', JSON.stringify(pack)),
        file('a.png', PNG),
      ]),
    ).toMatchObject({ ok: true, cover: 'a.png' })
    expect(
      error(checkSquareSnapshotBytes('pet', {}, [file('pet.json', JSON.stringify(pack))])),
    ).toContain('缺少 a.png')
    // GitHub 仓库中的说明与许可证可以随快照一起保存。
    expect(
      checkSquareSnapshotBytes('pet', {}, [
        file('pet.json', JSON.stringify(pack)),
        file('a.png', PNG),
        file('README.md', '# 猫'),
        file('LICENSE', 'MIT'),
      ]).ok,
    ).toBe(true)
    const skin = {
      background: { kind: 'image', file: 'bg.png', fit: 'cover', dim: 0, blur: 0 },
      fog: null,
      opacity: 0.85,
      accent: null,
      flow: null,
    }
    expect(
      checkSquareSnapshotBytes('skin', {}, [
        file('skin.json', JSON.stringify(skin)),
        file('bg.png', PNG),
      ]),
    ).toMatchObject({ ok: true, cover: 'bg.png' })
  })
})
