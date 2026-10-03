import { describe, expect, test } from 'bun:test'
import {
  addVersions,
  applyCanvasOps,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasOp,
  type CanvasVersion,
  canvasFileKind,
  compilePrompt,
  copyOps,
  emptyCanvas,
  modeOf,
  parseCanvas,
  parseCanvasOps,
  recordRun,
  serializeCanvas,
  settleVersion,
} from './canvas.ts'

/** 依次返回 a1、a2……的 id 生成器，让断言能写死 id。 */
function ids(prefix = 'a'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

function apply(doc: CanvasDoc, ops: CanvasOp[], newId = ids()): CanvasDoc {
  const r = applyCanvasOps(doc, ops, newId)
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

function rejects(doc: CanvasDoc, ops: CanvasOp[]): string {
  const r = applyCanvasOps(doc, ops, ids('z'))
  if (r.ok) throw new Error('应当被拒绝')
  return r.error
}

function gen(doc: CanvasDoc, id: string): CanvasGenerateNode {
  const n = doc.nodes.find((x) => x.id === id)
  if (n?.type !== 'generate') throw new Error(`${id} 不是生成节点`)
  return n
}

const made = { prompt: 'p', provider: 'qwen', model: 'wan', params: {}, inputs: [], at: 't' }
const version = (id: string, path: string): CanvasVersion => ({ id, path, made })

/** 小满、妈妈两张图，视频1（已有一版），视频2 以两张图为参考。 */
function sample(): CanvasDoc {
  let doc = apply(emptyCanvas(), [
    { op: 'add_file', ref: '$xm', path: '角色/小满.png' },
    { op: 'add_file', ref: '$mm', path: '角色/妈妈.png' },
    { op: 'add_generate', ref: '$v1', output: 'video' },
    { op: 'add_generate', ref: '$v2', output: 'video', prompt: '@[$xm] 和 @[$mm] 在校门口' },
  ])
  const r = addVersions(doc, 'a3', [version('v-old', 'generated/1.mp4')])
  if (!r.ok) throw new Error(r.error)
  doc = r.doc
  return doc
}

describe('画布：格式', () => {
  test('模型参数按节点与接口分别记忆，换回来和重开画布均恢复', () => {
    let doc = apply(emptyCanvas(), [
      {
        op: 'add_generate',
        output: 'image',
        provider: 'a',
        model: 'gpt',
        params: { quality: 'max' },
      },
    ])
    doc = apply(doc, [{ op: 'update', id: 'a1', provider: 'b', model: 'qwen' }])
    expect(gen(doc, 'a1').params).toEqual({})
    doc = apply(doc, [{ op: 'update', id: 'a1', params: { seed: 42 } }])
    const reopened = parseCanvas(serializeCanvas(doc))
    if (!reopened.ok) throw new Error(reopened.error)
    doc = apply(reopened.doc, [{ op: 'update', id: 'a1', provider: 'a', model: 'gpt' }])
    expect(gen(doc, 'a1').params).toEqual({ quality: 'max' })
    doc = apply(doc, [{ op: 'update', id: 'a1', provider: 'b', model: 'qwen' }])
    expect(gen(doc, 'a1').params).toEqual({ seed: 42 })
    doc = apply(doc, [{ op: 'update', id: 'a1', provider: 'other', model: 'qwen' }])
    expect(gen(doc, 'a1').params).toEqual({})
  })
  test('文件类别按扩展名判：图片、视频、音频、正文，其余回 null', () => {
    expect(['a.PNG', 'b.mp4', 'c.m4a', 'd.md', 'e.txt', 'f.pdf'].map(canvasFileKind)).toEqual([
      'image',
      'video',
      'audio',
      'text',
      'text',
      null,
    ])
  })

  test('写出再读回，字节不变', () => {
    const text = serializeCanvas(sample())
    const back = parseCanvas(text)
    expect(back.ok).toBe(true)
    if (back.ok) expect(serializeCanvas(back.doc)).toBe(text)
  })

  test('不认识的字段、坏 JSON、不认识的版本都拒绝', () => {
    expect(parseCanvas('{').ok).toBe(false)
    expect(parseCanvas('{"version":2,"nodes":[],"edges":[]}').ok).toBe(false)
    const extra = JSON.parse(serializeCanvas(sample()))
    extra.nodes[0].color = 'red'
    expect(parseCanvas(JSON.stringify(extra)).ok).toBe(false)
  })

  test('生成记录：追加在文档末尾，写出再读回字节不变；没有记录时文件里没有这个键', () => {
    const doc = sample()
    expect(JSON.parse(serializeCanvas(doc))).not.toHaveProperty('runs')
    const r = recordRun(doc, {
      node: 'gone',
      action: 'run',
      start: '2026-10-02T01:00:00.000Z',
      end: '2026-10-02T01:00:09.000Z',
      result: 'failed',
      provider: 'ark',
      model: 'seedance',
      prompt: '走出校门',
      params: { duration: 5 },
      inputs: [{ role: 'first_frame', path: 'a.png' }],
      message: '内容审核未通过',
    })
    if (!r.ok) throw new Error(r.error)
    expect(doc.runs).toBeUndefined()
    const text = serializeCanvas(r.doc)
    expect(Object.keys(JSON.parse(text))).toEqual(['version', 'nodes', 'edges', 'runs'])
    const back = parseCanvas(text)
    if (!back.ok) throw new Error(back.error)
    expect(back.doc.runs).toEqual(r.doc.runs!)
    expect(serializeCanvas(back.doc)).toBe(text)
  })

  test('生成记录：结果词不认识、多出字段、输入不合法的都拒绝', () => {
    const base = { node: 'a1', action: 'run', start: 's', end: 'e', result: 'done' } as const
    expect(recordRun(sample(), { ...base, result: 'ok' as 'done' }).ok).toBe(false)
    const text = (run: unknown) =>
      JSON.stringify({ ...JSON.parse(serializeCanvas(sample())), runs: [run] })
    expect(parseCanvas(text(base)).ok).toBe(true)
    expect(parseCanvas(text({ ...base, color: 'red' })).ok).toBe(false)
    expect(parseCanvas(text({ ...base, inputs: [{ role: 'x', path: 'a.png' }] })).ok).toBe(false)
    expect(parseCanvas(text({ ...base, cost: '1' })).ok).toBe(false)
  })

  test('手改出悬空 @ 的文件读不进来', () => {
    const doc = JSON.parse(serializeCanvas(sample()))
    doc.edges = []
    const r = parseCanvas(JSON.stringify(doc))
    expect(r.ok).toBe(false)
  })
})

describe('画布：操作', () => {
  test('批内名字换成分配的 id，提示词里的 @ 自动连上参考线', () => {
    const doc = sample()
    expect(gen(doc, 'a4').prompt).toBe('@[a1] 和 @[a2] 在校门口')
    expect(doc.edges.map((e) => [e.from, e.to, e.role])).toEqual([
      ['a1', 'a4', 'reference'],
      ['a2', 'a4', 'reference'],
    ])
  })

  test('改提示词新引用未连的视频节点，补一条参考视频线', () => {
    const doc = apply(sample(), [
      { op: 'update', id: 'a4', prompt: '@[a1] 接 @[a3] 的最后一个镜头' },
    ])
    expect(doc.edges.find((e) => e.from === 'a3')).toMatchObject({ to: 'a4', role: 'video' })
    // 从提示词里去掉 @ 不删线：输入只由线决定。
    expect(doc.edges.some((e) => e.from === 'a2' && e.to === 'a4')).toBe(true)
  })

  test('删节点连带删线，别的提示词里对它的 @ 变成名字纯文本', () => {
    const doc = apply(sample(), [{ op: 'remove', id: 'a2' }])
    expect(doc.nodes.some((n) => n.id === 'a2')).toBe(false)
    expect(doc.edges.some((e) => e.from === 'a2')).toBe(false)
    expect(gen(doc, 'a4').prompt).toBe('@[a1] 和 妈妈 在校门口')
  })

  test('单删一条线，对应的 @ 同样变成纯文本', () => {
    const edge = sample().edges.find((e) => e.from === 'a1')!
    const doc = apply(sample(), [{ op: 'remove', id: edge.id }])
    expect(gen(doc, 'a4').prompt).toBe('小满 和 @[a2] 在校门口')
  })

  test('切到首尾帧：前两张图变首帧、尾帧；再切回全变参考', () => {
    let doc = apply(sample(), [
      { op: 'add_file', ref: '$tk', path: '道具/三轮车.png' },
      { op: 'connect', from: '$tk', to: 'a4', role: 'reference' },
      { op: 'update', id: 'a4', prompt: '@[a1] 和 @[a2] 推着 @[$tk]' },
    ])
    doc = apply(doc, [{ op: 'set_mode', id: 'a4', mode: 'first_last' }])
    expect(modeOf(doc, 'a4')).toBe('first_last')
    expect(doc.edges.filter((e) => e.to === 'a4').map((e) => [e.from, e.role])).toEqual([
      ['a1', 'first_frame'],
      ['a2', 'last_frame'],
    ])
    // 断开的那张图在提示词里变成纯文本。
    expect(gen(doc, 'a4').prompt).toBe('@[a1] 和 @[a2] 推着 三轮车')
    doc = apply(doc, [{ op: 'set_mode', id: 'a4', mode: 'reference' }])
    expect(doc.edges.filter((e) => e.to === 'a4').every((e) => e.role === 'reference')).toBe(true)
  })

  test('首尾帧互换：同一批改两条线的用途', () => {
    let doc = apply(sample(), [{ op: 'set_mode', id: 'a4', mode: 'first_last' }])
    const [first, last] = doc.edges.filter((e) => e.to === 'a4')
    doc = apply(doc, [
      { op: 'update', id: first!.id, role: 'last_frame' },
      { op: 'update', id: last!.id, role: 'first_frame' },
    ])
    expect(doc.edges.find((e) => e.id === first!.id)?.role).toBe('last_frame')
  })

  test('首尾帧模式下 @ 一个未连的节点，整批拒绝', () => {
    const doc = apply(sample(), [
      { op: 'set_mode', id: 'a4', mode: 'first_last' },
      { op: 'add_file', ref: '$tk', path: '道具/三轮车.png' },
    ])
    const tk = doc.nodes.at(-1)!.id
    expect(rejects(doc, [{ op: 'update', id: 'a4', prompt: `推着 @[${tk}]` }])).toContain('首尾帧')
    // 连线也一样：首尾帧与参考图不能同时给。
    expect(rejects(doc, [{ op: 'connect', from: tk, to: 'a4', role: 'reference' }])).toContain(
      '首尾帧',
    )
  })

  test('@ 自己、连到自己都拒绝', () => {
    expect(rejects(sample(), [{ op: 'update', id: 'a4', prompt: '@[a4]' }])).toContain('自己')
    expect(rejects(sample(), [{ op: 'connect', from: 'a4', to: 'a4', role: 'video' }])).toContain(
      '自己',
    )
  })

  test('用途方向或类别不对，整批拒绝', () => {
    const doc = sample()
    // 视频连到出图节点、图片当参考视频、连到文件节点、文本当输入。
    const img = apply(doc, [{ op: 'add_generate', output: 'image' }], ids('i'))
    expect(rejects(img, [{ op: 'connect', from: 'a3', to: 'i1', role: 'reference' }])).toContain(
      '只收参考图',
    )
    expect(rejects(doc, [{ op: 'connect', from: 'a1', to: 'a3', role: 'video' }])).toContain(
      '只能作为参考图',
    )
    expect(rejects(doc, [{ op: 'connect', from: 'a3', to: 'a1', role: 'reference' }])).toContain(
      '生成节点',
    )
    const md = apply(doc, [{ op: 'add_file', path: '剧本/第一场.md' }], ids('m'))
    expect(rejects(md, [{ op: 'connect', from: 'm1', to: 'a3', role: 'reference' }])).toContain(
      '不能作为',
    )
  })

  test('一批三条第三条失败，前两条不生效', () => {
    const doc = sample()
    const before = serializeCanvas(doc)
    rejects(doc, [
      { op: 'update', id: 'a1', x: 999 },
      { op: 'add_generate', output: 'image' },
      { op: 'remove', id: 'nope' },
    ])
    expect(serializeCanvas(doc)).toBe(before)
  })

  test('当前版本只能指到存在的版本；删当前版退到最后一版', () => {
    const doc = apply(sample(), [], ids())
    expect(rejects(doc, [{ op: 'update', id: 'a3', current: 'v-none' }])).toContain('当前版本')
    const two = addVersions(doc, 'a3', [version('v-new', 'generated/2.mp4')])
    if (!two.ok) throw new Error(two.error)
    const back = apply(two.doc, [{ op: 'remove', id: 'a3', version: 'v-new' }])
    expect(gen(back, 'a3').current).toBe('v-old')
    expect(rejects(back, [{ op: 'remove', id: 'a3', version: 'v-none' }])).toContain('版本')
  })

  test('操作里写不进版本', () => {
    const r = parseCanvasOps([{ op: 'update', id: 'a3', versions: [] }])
    expect(r.ok).toBe(false)
    expect(parseCanvasOps([{ op: 'toString', id: 'a3' }]).ok).toBe(false)
    expect(parseCanvasOps([{ op: 'remove', id: 'a3' }]).ok).toBe(true)
  })

  test('删掉的节点 id 不会分给同一批新建的节点', () => {
    // 生成器第一次返回被删节点的 id。
    const seq = ['a2', 'fresh']
    const doc = apply(
      sample(),
      [
        { op: 'remove', id: 'a2' },
        { op: 'add_file', path: '角色/妈妈-2.png' },
      ],
      () => seq.shift() ?? 'x',
    )
    expect(doc.nodes.at(-1)!.id).toBe('fresh')
  })

  test('重复 id 的文件读不进来', () => {
    const doc = JSON.parse(serializeCanvas(sample()))
    doc.nodes[1].id = doc.nodes[0].id
    expect(parseCanvas(JSON.stringify(doc)).ok).toBe(false)
  })

  test('默认名按同类最大序号加一', () => {
    const doc = apply(sample(), [{ op: 'add_generate', output: 'video' }], ids('n'))
    expect(gen(doc, 'n1').name).toBe('视频3')
  })

  test('beside 放在源节点右侧的空位：被占就往下挪，同一批加的两个也不相交', () => {
    const base = apply(
      emptyCanvas(),
      [
        { op: 'add_file', ref: '$v', path: 'v.mp4', x: 0, y: 0 },
        { op: 'add_file', path: 'busy.png', x: 400, y: 0 },
      ],
      ids('b'),
    )
    const doc = apply(
      base,
      [
        { op: 'add_file', ref: '$f1', path: 'f1.png', beside: 'b1' },
        { op: 'add_generate', output: 'video', beside: '$f1' },
        { op: 'add_file', path: 'f2.png', beside: 'b1' },
      ],
      ids('n'),
    )
    const box = (id: string) => doc.nodes.find((n) => n.id === id)!
    expect(box('n1').x).toBe(400)
    expect(box('n1').y).toBeGreaterThanOrEqual(box('b2').y + box('b2').h)
    expect(box('n2').x).toBe(box('n1').x + box('n1').w + 100)
    expect(box('n2').y).toBe(box('n1').y)
    const overlaps = (a: CanvasDoc['nodes'][number], b: CanvasDoc['nodes'][number]) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
  })

  test('复制：选区内的连线与 @ 指向副本；不带输入时外部 @ 变名字，带输入时连上外部线', () => {
    const base = apply(
      emptyCanvas(),
      [
        { op: 'add_file', ref: '$a', path: '角色/小满.png', x: 0, y: 0 },
        { op: 'add_file', ref: '$b', path: '场景/街口.png', x: 0, y: 300 },
        {
          op: 'add_generate',
          ref: '$g',
          output: 'video',
          name: '视频1',
          prompt: '@[$a] 走过 @[$b]',
          params: { duration: 5 },
          x: 400,
          y: 0,
        },
      ],
      ids('s'),
    )
    const withVersion = addVersions(base, 's3', [version('p1', 'generated/1.mp4')])
    if (!withVersion.ok) throw new Error(withVersion.error)
    const doc = withVersion.doc

    const plain = apply(doc, copyOps(doc, ['s1', 's3'], doc, { dx: 40, dy: 40 }, false), ids('c'))
    const card = gen(plain, 'c2')
    expect(card).toMatchObject({ name: '视频1', x: 440, y: 40, params: { duration: 5 } })
    expect(card.versions).toEqual([])
    expect(card.prompt).toBe('@[c1] 走过 街口')
    expect(plain.edges.filter((e) => e.to === 'c2').map((e) => e.from)).toEqual(['c1'])

    const linked = apply(doc, copyOps(doc, ['s3'], doc, { dx: 0, dy: 400 }, true), ids('c'))
    expect(gen(linked, 'c1').prompt).toBe('@[s1] 走过 @[s2]')
    expect(
      linked.edges
        .filter((e) => e.to === 'c1')
        .map((e) => e.from)
        .sort(),
    ).toEqual(['s1', 's2'])

    // 粘到另一张没有这两个素材的画布：带输入也连不上，@ 改成名字。
    const other = apply(
      emptyCanvas(),
      copyOps(doc, ['s3'], emptyCanvas(), { dx: 0, dy: 0 }, true),
      ids('o'),
    )
    expect(gen(other, 'o1').prompt).toBe('小满 走过 街口')
    expect(other.edges).toEqual([])
  })

  test('near 以该点为中心放，被占就往下挪；格式不对的点整批拒绝', () => {
    const base = apply(emptyCanvas(), [{ op: 'add_file', path: 'a.png', x: 0, y: 0 }], ids('b'))
    const free = apply(
      base,
      [{ op: 'add_file', path: 'x.png', near: { x: 1000, y: 500 } }],
      ids('n'),
    )
    expect(free.nodes.at(-1)).toMatchObject({ x: 888, y: 416, w: 225, h: 169 })
    const busy = apply(
      base,
      [{ op: 'add_file', path: 'x.png', near: { x: 112.5, y: 84.5 } }],
      ids('n'),
    )
    const added = busy.nodes.at(-1)!
    expect(added.x).toBe(0)
    expect(added.y).toBeGreaterThanOrEqual(169)
    expect(parseCanvasOps([{ op: 'add_generate', output: 'video', near: { x: 1, y: 2 } }]).ok).toBe(
      true,
    )
    expect(parseCanvasOps([{ op: 'add_file', path: 'a.png', near: { x: 1 } }]).ok).toBe(false)
    expect(parseCanvasOps([{ op: 'add_file', path: 'a.png', near: { x: 1, y: 2, z: 3 } }]).ok).toBe(
      false,
    )
  })

  test('beside 给了 x、y 以它们为准；指向不存在的节点整批拒绝', () => {
    const doc = apply(
      sample(),
      [{ op: 'add_file', path: 'x.png', beside: 'a1', x: 7, y: 9 }],
      ids('n'),
    )
    expect(doc.nodes.at(-1)).toMatchObject({ x: 7, y: 9 })
    expect(rejects(sample(), [{ op: 'add_file', path: 'x.png', beside: 'nope' }])).toContain('nope')
    expect(parseCanvasOps([{ op: 'add_generate', output: 'image', beside: 'a1' }]).ok).toBe(true)
  })
})

describe('画布：版本', () => {
  test('追加多版时当前版指向第一张；改指路径按版本 id 找', () => {
    const r = addVersions(sample(), 'a4', [
      version('p1', 'generated/a.png'),
      version('p2', 'generated/a-2.png'),
    ])
    if (!r.ok) throw new Error(r.error)
    expect(gen(r.doc, 'a4').current).toBe('p1')
    const s = settleVersion(r.doc, 'a4', 'p2', 'generated/b.png')
    if (!s.ok) throw new Error(s.error)
    expect(gen(s.doc, 'a4').versions.map((v) => v.path)).toEqual([
      'generated/a.png',
      'generated/b.png',
    ])
    expect(settleVersion(r.doc, 'a4', 'gone', 'x.png').ok).toBe(false)
  })
})

describe('画布：框按媒体比例', () => {
  const box = (doc: CanvasDoc, id: string) => {
    const n = doc.nodes.find((x) => x.id === id)!
    return { w: n.w, h: n.h }
  }
  const sized = (id: string, path: string, w: number, h: number): CanvasVersion => ({
    ...version(id, path),
    size: { w, h },
  })

  test('音频文件与生成节点使用横向紧凑框，放置相邻节点时使用相同尺寸', () => {
    const doc = apply(emptyCanvas(), [
      { op: 'add_file', ref: '$a', path: 'voice.wav' },
      { op: 'add_generate', output: 'audio', beside: '$a' },
    ])
    expect(box(doc, 'a1')).toEqual({ w: 300, h: 96 })
    expect(box(doc, 'a2')).toEqual({ w: 300, h: 96 })
    expect(doc.nodes[1]!.x).toBeGreaterThanOrEqual(doc.nodes[0]!.x + 300)
  })

  test('读取方形默认音频框时更新布局，保留坐标、自定义尺寸与其他媒体，重复读写结果一致', () => {
    const source = apply(emptyCanvas(), [
      { op: 'add_file', path: 'voice.mp3', w: 169, h: 169, x: 70, y: 40 },
      { op: 'add_generate', output: 'audio', w: 169, h: 169 },
      { op: 'add_file', path: 'other.wav', w: 400, h: 120 },
      { op: 'add_generate', output: 'image', w: 169, h: 169 },
    ])
    const parsed = parseCanvas(serializeCanvas(source))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.doc.nodes[0]).toMatchObject({ x: 70, y: 40, w: 300, h: 96 })
    expect(box(parsed.doc, 'a2')).toEqual({ w: 300, h: 96 })
    expect(parsed.doc.nodes.slice(2)).toEqual(source.nodes.slice(2))
    const text = serializeCanvas(parsed.doc)
    const again = parseCanvas(text)
    if (!again.ok) throw new Error(again.error)
    expect(serializeCanvas(again.doc)).toBe(text)
    expect(box(source, 'a1')).toEqual({ w: 169, h: 169 })
  })

  test('短边不变、长边按媒体的宽高比：竖图的宽取横图的高', async () => {
    const { fitBox } = await import('./canvas.ts')
    expect(fitBox({ w: 169, h: 169 }, { w: 1536, h: 1024 })).toEqual({ w: 254, h: 169 })
    expect(fitBox({ w: 169, h: 169 }, { w: 1080, h: 1920 })).toEqual({ w: 169, h: 300 })
  })

  test('出结果时框换成当前版的比例；切版本、删当前版跟着换；没有尺寸的版本不动框', () => {
    let doc = apply(emptyCanvas(), [{ op: 'add_generate', ref: '$g', output: 'image' }])
    expect(box(doc, 'a1')).toEqual({ w: 169, h: 169 })
    const r = addVersions(doc, 'a1', [
      sized('wide', 'generated/a.png', 1536, 1024),
      sized('tall', 'generated/b.png', 1024, 1536),
      version('plain', 'generated/c.webp'),
    ])
    if (!r.ok) throw new Error(r.error)
    doc = r.doc
    expect(box(doc, 'a1')).toEqual({ w: 254, h: 169 })
    doc = apply(doc, [{ op: 'update', id: 'a1', current: 'tall' }])
    expect(box(doc, 'a1')).toEqual({ w: 169, h: 254 })
    doc = apply(doc, [{ op: 'update', id: 'a1', current: 'plain' }])
    expect(box(doc, 'a1')).toEqual({ w: 169, h: 254 })
    doc = apply(doc, [{ op: 'update', id: 'a1', current: 'wide' }])
    doc = apply(doc, [{ op: 'remove', id: 'a1', version: 'wide' }])
    expect(gen(doc, 'a1').current).toBe('plain')
    doc = apply(doc, [{ op: 'remove', id: 'a1', version: 'plain' }])
    expect(gen(doc, 'a1').current).toBe('tall')
    expect(box(doc, 'a1')).toEqual({ w: 169, h: 254 })
    // 同一次操作给了 w / h 时以它们为准。
    doc = apply(doc, [{ op: 'update', id: 'a1', current: 'tall', w: 300, h: 100 }])
    expect(box(doc, 'a1')).toEqual({ w: 300, h: 100 })
  })

  test('取回的视频带尺寸落定后，竖版视频的框变竖', () => {
    const r = addVersions(
      apply(emptyCanvas(), [{ op: 'add_generate', ref: '$v', output: 'video' }]),
      'a1',
      [version('task', 'generated/v.task.json')],
    )
    if (!r.ok) throw new Error(r.error)
    expect(box(r.doc, 'a1')).toEqual({ w: 300, h: 169 })
    const s = settleVersion(r.doc, 'a1', 'task', 'generated/v.mp4', { w: 720, h: 1280 })
    if (!s.ok) throw new Error(s.error)
    expect(gen(s.doc, 'a1').versions[0]!.size).toEqual({ w: 720, h: 1280 })
    expect(box(s.doc, 'a1')).toEqual({ w: 169, h: 300 })
  })

  test('加文件节点带尺寸时按缺省框的短边与文件比例定框；换文件也换比例；尺寸随文档写出读回', () => {
    let doc = apply(emptyCanvas(), [
      { op: 'add_file', ref: '$p', path: 'a.png', size: { w: 1000, h: 1000 } },
      { op: 'add_file', ref: '$q', path: 'b.png' },
    ])
    expect(box(doc, 'a1')).toEqual({ w: 169, h: 169 })
    expect(box(doc, 'a2')).toEqual({ w: 225, h: 169 })
    doc = apply(doc, [{ op: 'update', id: 'a1', path: 'c.png', size: { w: 400, h: 100 } }])
    expect(box(doc, 'a1')).toEqual({ w: 676, h: 169 })

    const r = addVersions(apply(doc, [{ op: 'add_generate', ref: '$g', output: 'image' }]), 'a3', [
      sized('s', 'generated/s.png', 3, 2),
    ])
    if (!r.ok) throw new Error(r.error)
    const text = serializeCanvas(r.doc)
    const back = parseCanvas(text)
    if (!back.ok) throw new Error(back.error)
    expect(gen(back.doc, 'a3').versions[0]!.size).toEqual({ w: 3, h: 2 })
    expect(serializeCanvas(back.doc)).toBe(text)
  })

  test('提交的操作里不认 size：只由服务端核验路径时填', () => {
    const r = parseCanvasOps([{ op: 'add_file', path: 'a.png', size: { w: 1, h: 1 } }])
    expect(r.ok).toBe(false)
  })
})

describe('画布：提示词编译', () => {
  /** 小满、妈妈两张图，视频1 已有一版，视频2 引用两张图与视频1。 */
  function mixed(): CanvasDoc {
    return apply(sample(), [
      { op: 'update', id: 'a4', prompt: '@[a1] 和 @[a2] 接 @[a3]，@[a1] 撑伞' },
    ])
  }
  const SEEDANCE_20 = { image: '图片{n}', video: '视频{n}', audio: '音频{n}' }
  const SEEDANCE_25 = { image: '@图片{n}', video: '@视频{n}', audio: '@音频{n}' }
  const WAN = { image: '图{n}', video: '视频{n}', audio: '音频{n}' }

  test('两张图一段视频混合引用，按各家写法、按类别分别计数；同一节点两次编号相同', () => {
    expect(compilePrompt(mixed(), 'a4', SEEDANCE_20)).toBe('图片1 和 图片2 接 视频1，图片1 撑伞')
    expect(compilePrompt(mixed(), 'a4', SEEDANCE_25)).toBe(
      '@图片1 和 @图片2 接 @视频1，@图片1 撑伞',
    )
    expect(compilePrompt(mixed(), 'a4', WAN)).toBe('图1 和 图2 接 视频1，图1 撑伞')
  })

  test('没登记写法的模型换成名字', () => {
    expect(compilePrompt(mixed(), 'a4')).toBe('小满 和 妈妈 接 视频1，小满 撑伞')
  })

  test('首尾帧模式下 @ 首帧、尾帧编译成名字，不套写法', () => {
    const doc = apply(sample(), [{ op: 'set_mode', id: 'a4', mode: 'first_last' }])
    expect(compilePrompt(doc, 'a4', SEEDANCE_20)).toBe('小满 和 妈妈 在校门口')
  })
})

describe('画布：参考音频', () => {
  test('音频节点连到视频卡用途为 audio，@ 它自动补 audio 线并编成「音频1」', () => {
    const doc = apply(sample(), [
      { op: 'add_file', ref: '$voice', path: '声音/小满.wav' },
      { op: 'update', id: 'a4', prompt: '@[a1] 用 @[$voice] 的声音说话' },
    ])
    const voice = doc.nodes.at(-1)!.id
    expect(doc.edges.find((e) => e.from === voice)).toMatchObject({ to: 'a4', role: 'audio' })
    expect(compilePrompt(doc, 'a4', { image: '图片{n}', audio: '音频{n}' })).toBe(
      '图片1 用 音频1 的声音说话',
    )
  })

  test('音频连不到出图卡、不能当参考图；首尾帧模式不收音频', () => {
    const doc = apply(sample(), [{ op: 'add_file', ref: '$voice', path: '声音/小满.mp3' }])
    const voice = doc.nodes.at(-1)!.id
    const img = apply(doc, [{ op: 'add_generate', output: 'image' }], ids('i'))
    expect(rejects(img, [{ op: 'connect', from: voice, to: 'i1', role: 'reference' }])).toContain(
      '只收参考图',
    )
    expect(rejects(doc, [{ op: 'connect', from: voice, to: 'a3', role: 'reference' }])).toContain(
      '参考音频',
    )
    const frames = apply(doc, [{ op: 'set_mode', id: 'a4', mode: 'first_last' }])
    expect(rejects(frames, [{ op: 'connect', from: voice, to: 'a4', role: 'audio' }])).toContain(
      '参考音频',
    )
  })
})

describe('画布：时间线', () => {
  const clip = (path: string, from: number, to: number) => ({ path, in: from, out: to })

  test('新建空时间线只有轨道高度；放进片段后长出预览区，清空后收回；默认名按序号', () => {
    let doc = apply(emptyCanvas(), [
      { op: 'add_timeline', ref: '$t' },
      { op: 'add_timeline', clips: [clip('素材/a.mp4', 0, 2)] },
    ])
    const [first, second] = doc.nodes
    expect(first).toMatchObject({ type: 'timeline', name: '时间线1', w: 480, h: 120, clips: [] })
    // 预览区按 16:9 铺满框宽：(480 - 16) × 9 / 16 = 261。
    expect(second).toMatchObject({ name: '时间线2', h: 381 })
    doc = apply(doc, [{ op: 'update', id: 'a1', clips: [clip('素材/a.mp4', 1, 3.5)] }])
    expect(doc.nodes[0]).toMatchObject({ h: 381, clips: [clip('素材/a.mp4', 1, 3.5)] })
    doc = apply(doc, [{ op: 'update', id: 'a1', clips: [] }])
    expect(doc.nodes[0]!.h).toBe(120)
  })

  test('片段只收工作区里的视频、入点小于出点；不合法整批拒绝', () => {
    const doc = apply(emptyCanvas(), [{ op: 'add_timeline' }])
    expect(rejects(doc, [{ op: 'update', id: 'a1', clips: [clip('素材/a.png', 0, 1)] }])).toContain(
      '只有视频',
    )
    expect(rejects(doc, [{ op: 'update', id: 'a1', clips: [clip('素材/a.mp4', 2, 2)] }])).toContain(
      '入点出点不合法',
    )
    expect(
      rejects(doc, [{ op: 'update', id: 'a1', clips: [clip('素材/a.mp4', -1, 2)] }]),
    ).toContain('入点出点不合法')
    expect(rejects(doc, [{ op: 'update', id: 'a1', clips: [clip('../a.mp4', 0, 1)] }])).toContain(
      '相对路径',
    )
  })

  test('静音开关；时间线没有提示词，生成卡与文件没有片段；改名不能清空', () => {
    let doc = apply(emptyCanvas(), [{ op: 'add_timeline' }, { op: 'add_file', path: '素材/a.mp4' }])
    doc = apply(doc, [{ op: 'update', id: 'a1', muted: true }])
    expect(doc.nodes[0]).toMatchObject({ muted: true })
    doc = apply(doc, [{ op: 'update', id: 'a1', muted: false }])
    expect('muted' in doc.nodes[0]!).toBe(false)
    expect(rejects(doc, [{ op: 'update', id: 'a1', prompt: 'x' }])).toContain('时间线没有 prompt')
    expect(rejects(doc, [{ op: 'update', id: 'a2', clips: [] }])).toContain('只有时间线')
    expect(rejects(doc, [{ op: 'update', id: 'a1', name: '' }])).toContain('必须有名字')
  })

  test('时间线不能作为生成的输入，也不能被连线指向', () => {
    const doc = apply(sample(), [{ op: 'add_timeline', ref: '$t' }])
    const t = doc.nodes.at(-1)!.id
    expect(rejects(doc, [{ op: 'connect', from: t, to: 'a3', role: 'video' }])).toContain(
      '不能作为',
    )
    expect(rejects(doc, [{ op: 'connect', from: 'a1', to: t, role: 'reference' }])).toContain(
      '只能连到生成节点',
    )
  })

  test('写出再读回不变；复制带上片段与静音；提交的操作按字段表核对', () => {
    const doc = apply(emptyCanvas(), [
      { op: 'add_timeline', name: '粗剪', muted: true, clips: [clip('素材/a.mp4', 0.5, 2)] },
    ])
    const text = serializeCanvas(doc)
    const back = parseCanvas(text)
    expect(back.ok && serializeCanvas(back.doc)).toBe(text)
    const copied = apply(doc, copyOps(doc, ['a1'], doc, { dx: 0, dy: 400 }, false), ids('c'))
    expect(copied.nodes[1]).toMatchObject({
      type: 'timeline',
      name: '粗剪',
      muted: true,
      clips: [clip('素材/a.mp4', 0.5, 2)],
      y: 400,
    })
    expect(parseCanvasOps([{ op: 'add_timeline', clips: [{ path: 'a.mp4', in: 0 }] }]).ok).toBe(
      false,
    )
    expect(parseCanvasOps([{ op: 'update', id: 'a1', muted: 'yes' }]).ok).toBe(false)
    expect(parseCanvas(text.replace('"muted": true', '"muted": false')).ok).toBe(false)
  })
})
