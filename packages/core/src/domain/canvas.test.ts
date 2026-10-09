import { describe, expect, test } from 'bun:test'
import { ART_MENTION } from './art.ts'
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

/** 依次返回 a1、a2……的 id 生成器，使断言可以使用固定 id。 */
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

const overlaps = (a: CanvasDoc['nodes'][number], b: CanvasDoc['nodes'][number]) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** 两张图（小满、妈妈），视频1（已有一个版本），视频2 以两张图为参考。 */
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
  test('模型参数按节点与接口分别保存，切换回原接口和重新打开画布后均恢复', () => {
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
  test('文件类别按扩展名判定：图片、视频、音频、HTML、正文，其余返回 null', () => {
    expect(
      ['a.PNG', 'b.mp4', 'c.m4a', 'g.html', 'h.HTM', 'd.md', 'e.txt', 'f.pdf'].map(canvasFileKind),
    ).toEqual(['image', 'video', 'audio', 'art', 'art', 'text', 'text', null])
  })

  test('写出后重新读取，字节不变', () => {
    const text = serializeCanvas(sample())
    const back = parseCanvas(text)
    expect(back.ok).toBe(true)
    if (back.ok) expect(serializeCanvas(back.doc)).toBe(text)
  })

  test('未知字段、无效 JSON、未知版本均被拒绝', () => {
    expect(parseCanvas('{').ok).toBe(false)
    expect(parseCanvas('{"version":2,"nodes":[],"edges":[]}').ok).toBe(false)
    const extra = JSON.parse(serializeCanvas(sample()))
    extra.nodes[0].color = 'red'
    expect(parseCanvas(JSON.stringify(extra)).ok).toBe(false)
  })

  test('生成记录：追加在文档末尾，写出后重新读取字节不变；没有记录时文件中不含该键', () => {
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

  test('生成记录：结果值未知、含多余字段、输入不合法时均被拒绝', () => {
    const base = { node: 'a1', action: 'run', start: 's', end: 'e', result: 'done' } as const
    expect(recordRun(sample(), { ...base, result: 'ok' as 'done' }).ok).toBe(false)
    const text = (run: unknown) =>
      JSON.stringify({ ...JSON.parse(serializeCanvas(sample())), runs: [run] })
    expect(parseCanvas(text(base)).ok).toBe(true)
    expect(parseCanvas(text({ ...base, color: 'red' })).ok).toBe(false)
    expect(parseCanvas(text({ ...base, inputs: [{ role: 'x', path: 'a.png' }] })).ok).toBe(false)
    expect(parseCanvas(text({ ...base, cost: '1' })).ok).toBe(false)
  })

  test('手动修改后含悬空 @ 的文件无法读取', () => {
    const doc = JSON.parse(serializeCanvas(sample()))
    doc.edges = []
    const r = parseCanvas(JSON.stringify(doc))
    expect(r.ok).toBe(false)
  })
})

describe('画布：操作', () => {
  test('批内名称替换为分配的 id，提示词中的 @ 自动建立参考图连线', () => {
    const doc = sample()
    expect(gen(doc, 'a4').prompt).toBe('@[a1] 和 @[a2] 在校门口')
    expect(doc.edges.map((e) => [e.from, e.to, e.role])).toEqual([
      ['a1', 'a4', 'reference'],
      ['a2', 'a4', 'reference'],
    ])
  })

  test('批内名称含 $ 后不允许的字符时整批拒绝，报错写明允许的字符', () => {
    const error = rejects(emptyCanvas(), [{ op: 'add_file', ref: '$林悦', path: 'a.png' }])
    expect(error).toContain('英文字母、数字、下划线或连字符')
    expect(error).toContain('$林悦')
  })

  test('修改提示词后新引用未连接的视频节点，补充一条参考视频连线', () => {
    const doc = apply(sample(), [
      { op: 'update', id: 'a4', prompt: '@[a1] 接 @[a3] 的最后一个镜头' },
    ])
    expect(doc.edges.find((e) => e.from === 'a3')).toMatchObject({ to: 'a4', role: 'video' })
    // 从提示词中删除 @ 不删除连线：输入只由连线决定。
    expect(doc.edges.some((e) => e.from === 'a2' && e.to === 'a4')).toBe(true)
  })

  test('删除节点时一并删除连线，其他提示词中对它的 @ 变为名称纯文本', () => {
    const doc = apply(sample(), [{ op: 'remove', id: 'a2' }])
    expect(doc.nodes.some((n) => n.id === 'a2')).toBe(false)
    expect(doc.edges.some((e) => e.from === 'a2')).toBe(false)
    expect(gen(doc, 'a4').prompt).toBe('@[a1] 和 妈妈 在校门口')
  })

  test('单独删除一条连线，对应的 @ 同样变为纯文本', () => {
    const edge = sample().edges.find((e) => e.from === 'a1')!
    const doc = apply(sample(), [{ op: 'remove', id: edge.id }])
    expect(gen(doc, 'a4').prompt).toBe('小满 和 @[a2] 在校门口')
  })

  test('切换到首尾帧：前两张图变为首帧、尾帧；切换回来后全部变为参考', () => {
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
    // 断开的图片在提示词中变为纯文本。
    expect(gen(doc, 'a4').prompt).toBe('@[a1] 和 @[a2] 推着 三轮车')
    doc = apply(doc, [{ op: 'set_mode', id: 'a4', mode: 'reference' }])
    expect(doc.edges.filter((e) => e.to === 'a4').every((e) => e.role === 'reference')).toBe(true)
  })

  test('首尾帧互换：同一批修改两条连线的用途', () => {
    let doc = apply(sample(), [{ op: 'set_mode', id: 'a4', mode: 'first_last' }])
    const [first, last] = doc.edges.filter((e) => e.to === 'a4')
    doc = apply(doc, [
      { op: 'update', id: first!.id, role: 'last_frame' },
      { op: 'update', id: last!.id, role: 'first_frame' },
    ])
    expect(doc.edges.find((e) => e.id === first!.id)?.role).toBe('last_frame')
  })

  test('首尾帧模式下 @ 未连接的节点，整批拒绝', () => {
    const doc = apply(sample(), [
      { op: 'set_mode', id: 'a4', mode: 'first_last' },
      { op: 'add_file', ref: '$tk', path: '道具/三轮车.png' },
    ])
    const tk = doc.nodes.at(-1)!.id
    expect(rejects(doc, [{ op: 'update', id: 'a4', prompt: `推着 @[${tk}]` }])).toContain('首尾帧')
    // 连线同理：首尾帧与参考图不能同时提供。
    expect(rejects(doc, [{ op: 'connect', from: tk, to: 'a4', role: 'reference' }])).toContain(
      '首尾帧',
    )
  })

  test('@ 自身、连接到自身均被拒绝', () => {
    expect(rejects(sample(), [{ op: 'update', id: 'a4', prompt: '@[a4]' }])).toContain('自己')
    expect(rejects(sample(), [{ op: 'connect', from: 'a4', to: 'a4', role: 'video' }])).toContain(
      '自己',
    )
  })

  test('用途方向或类别不符时整批拒绝', () => {
    const doc = sample()
    // 视频连接到出图节点、图片作为参考视频、连接到文件节点、文本作为输入。
    const img = apply(doc, [{ op: 'add_generate', output: 'image' }], ids('i'))
    expect(rejects(img, [{ op: 'connect', from: 'a3', to: 'i1', role: 'reference' }])).toContain(
      '只接受参考图',
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

  test('一批三条操作中第三条失败，前两条不生效', () => {
    const doc = sample()
    const before = serializeCanvas(doc)
    rejects(doc, [
      { op: 'update', id: 'a1', x: 999 },
      { op: 'add_generate', output: 'image' },
      { op: 'remove', id: 'nope' },
    ])
    expect(serializeCanvas(doc)).toBe(before)
  })

  test('当前版本只能指向存在的版本；删除当前版本后回退到最后一个版本', () => {
    const doc = apply(sample(), [], ids())
    expect(rejects(doc, [{ op: 'update', id: 'a3', current: 'v-none' }])).toContain('当前版本')
    const two = addVersions(doc, 'a3', [version('v-new', 'generated/2.mp4')])
    if (!two.ok) throw new Error(two.error)
    const back = apply(two.doc, [{ op: 'remove', id: 'a3', version: 'v-new' }])
    expect(gen(back, 'a3').current).toBe('v-old')
    expect(rejects(back, [{ op: 'remove', id: 'a3', version: 'v-none' }])).toContain('版本')
  })

  test('操作中无法写入版本', () => {
    const r = parseCanvasOps([{ op: 'update', id: 'a3', versions: [] }])
    expect(r.ok).toBe(false)
    expect(parseCanvasOps([{ op: 'toString', id: 'a3' }]).ok).toBe(false)
    expect(parseCanvasOps([{ op: 'remove', id: 'a3' }]).ok).toBe(true)
  })

  test('被删除节点的 id 不会分配给同一批新建的节点', () => {
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

  test('含重复 id 的文件无法读取', () => {
    const doc = JSON.parse(serializeCanvas(sample()))
    doc.nodes[1].id = doc.nodes[0].id
    expect(parseCanvas(JSON.stringify(doc)).ok).toBe(false)
  })

  test('默认名称取同类最大序号加一', () => {
    const doc = apply(sample(), [{ op: 'add_generate', output: 'video' }], ids('n'))
    expect(gen(doc, 'n1').name).toBe('视频3')
  })

  test('beside 排在源节点所在行右侧的第一个空位：被占用时向右越过，多个节点 beside 同一个节点时排成一行', () => {
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
    expect(box('n1')).toMatchObject({ x: 400 + 225 + 100, y: 0 })
    expect(box('n2')).toMatchObject({ x: box('n1').x + 225 + 100, y: 0 })
    // 视频空卡按横竖两种形状占位，宽 300。
    expect(box('n3')).toMatchObject({ x: box('n2').x + 300 + 100, y: 0 })
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
  })

  test('尚无结果的图片、视频卡按横竖两种形状占位：结果改变卡片形状后与相邻的卡仍不相交', () => {
    let doc = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', ref: '$a', output: 'image' },
        { op: 'add_generate', ref: '$b', output: 'image', beside: '$a' },
        { op: 'add_generate', output: 'video', below: '$a' },
        { op: 'add_generate', output: 'image', beside: '$b' },
      ],
      ids('n'),
    )
    const box = (id: string) => doc.nodes.find((n) => n.id === id)!
    expect(box('n2')).toMatchObject({ x: 300 + 100, y: 0 })
    expect(box('n3')).toMatchObject({ x: 0, y: 300 + 100 })
    const results = [
      ['n1', { w: 1672, h: 941 }],
      ['n2', { w: 1080, h: 1920 }],
      ['n3', { w: 1080, h: 1920 }],
      ['n4', { w: 1920, h: 1080 }],
    ] as const
    for (const [id, size] of results) {
      const r = addVersions(doc, id, [{ ...version(`p-${id}`, `generated/${id}.png`), size }])
      if (!r.ok) throw new Error(r.error)
      doc = r.doc
    }
    expect(box('n1')).toMatchObject({ w: 300, h: 169 })
    expect(box('n2')).toMatchObject({ w: 169, h: 300 })
    expect(box('n2').x - (box('n1').x + box('n1').w)).toBe(100)
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
  })

  test('复制：选区内的连线与 @ 指向副本；不带输入时外部 @ 变为名称，带输入时连接外部连线', () => {
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

    // 粘贴到不含这两个素材的另一张画布：带输入也无法连接，@ 改为名称。
    const other = apply(
      emptyCanvas(),
      copyOps(doc, ['s3'], emptyCanvas(), { dx: 0, dy: 0 }, true),
      ids('o'),
    )
    expect(gen(other, 'o1').prompt).toBe('小满 走过 街口')
    expect(other.edges).toEqual([])
  })

  test('near 以该点为中心放置，被占用时向下移动；坐标格式错误时整批拒绝', () => {
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

  test('字段类型不符时报错写明期望类型与收到的类型：params 写成 JSON 字符串时指出应为对象', () => {
    const r = parseCanvasOps([
      { op: 'add_generate', output: 'video', params: '{"resolution":"480P","duration":15}' },
    ])
    expect(!r.ok && r.error).toBe('第 1 条操作 的 params 类型错误：应为对象，收到的是字符串')
    const n = parseCanvasOps([{ op: 'update', id: 'a1', x: '12' }])
    expect(!n.ok && n.error).toBe('第 1 条操作 的 x 类型错误：应为数字，收到的是字符串')
  })

  test('beside 同时给出 x、y 时以 x、y 为准；指向不存在的节点时整批拒绝', () => {
    const doc = apply(
      sample(),
      [{ op: 'add_file', path: 'x.png', beside: 'a1', x: 7, y: 9 }],
      ids('n'),
    )
    expect(doc.nodes.at(-1)).toMatchObject({ x: 7, y: 9 })
    expect(rejects(sample(), [{ op: 'add_file', path: 'x.png', beside: 'nope' }])).toContain('nope')
    expect(parseCanvasOps([{ op: 'add_generate', output: 'image', beside: 'a1' }]).ok).toBe(true)
  })

  test('未给出相邻节点时作为新的一组：放在全部节点右侧相隔 200 并与最上方节点对齐，内容远离原点时同样相邻', () => {
    const base = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', output: 'image', x: -2263, y: 1346 },
        { op: 'add_generate', output: 'video', x: -1972, y: 1600 },
      ],
      ids('b'),
    )
    const doc = apply(
      base,
      [
        { op: 'add_generate', ref: '$a', output: 'image' },
        { op: 'add_generate', output: 'image' },
        { op: 'add_generate', output: 'image', below: '$a' },
      ],
      ids('n'),
    )
    const box = (id: string) => doc.nodes.find((n) => n.id === id)!
    // 已有节点尚无结果，按 300 见方占位，最右处为 -1972 + 300。
    expect(box('n1')).toMatchObject({ x: -1672 + 200, y: 1346 })
    expect(box('n2')).toMatchObject({ x: -1472 + 300 + 200, y: 1346 })
    expect(box('n3')).toMatchObject({ x: -1472, y: 1346 + 300 + 100 })
    expect(apply(emptyCanvas(), [{ op: 'add_file', path: 'a.png' }]).nodes[0]).toMatchObject({
      x: 0,
      y: 0,
    })
  })

  test('below 排在源节点下方的第一个空位，被占用时向下越过；素材按列、分镜按行换行时互不相交', () => {
    const doc = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', ref: '$c1', output: 'image' },
        { op: 'add_generate', output: 'image', below: '$c1' },
        { op: 'add_generate', output: 'image', below: '$c1' },
        { op: 'add_generate', ref: '$s1', output: 'video' },
        { op: 'add_generate', output: 'video', beside: '$s1' },
        { op: 'add_generate', output: 'video', below: '$s1' },
      ],
      ids('n'),
    )
    const box = (id: string) => doc.nodes.find((n) => n.id === id)!
    expect(box('n2')).toMatchObject({ x: 0, y: 300 + 100 })
    expect(box('n3')).toMatchObject({ x: 0, y: 800 })
    expect(box('n4')).toMatchObject({ x: 300 + 200, y: 0 })
    expect(box('n5')).toMatchObject({ x: 900, y: 0 })
    expect(box('n6')).toMatchObject({ x: 500, y: 400 })
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
    expect(parseCanvasOps([{ op: 'add_timeline', below: 'a1' }]).ok).toBe(true)
    expect(
      rejects(emptyCanvas(), [{ op: 'add_file', path: 'a.png', beside: 'a1', below: 'a2' }]),
    ).toContain('beside 与 below 只能给出一个')
  })
})

describe('画布：版本', () => {
  test('追加多个版本时当前版本指向第一张；修改版本路径时按版本 id 查找', () => {
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

describe('画布：框按媒体比例调整', () => {
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

  test('短边不变、长边按媒体宽高比计算：竖图的宽度取横图的高度', async () => {
    const { fitBox } = await import('./canvas.ts')
    expect(fitBox({ w: 169, h: 169 }, { w: 1536, h: 1024 })).toEqual({ w: 254, h: 169 })
    expect(fitBox({ w: 169, h: 169 }, { w: 1080, h: 1920 })).toEqual({ w: 169, h: 300 })
  })

  test('取得结果时框改为当前版本的比例；切换版本、删除当前版本时随之调整；没有尺寸的版本不改变框', () => {
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
    // 同一次操作给出 w / h 时以其为准。
    doc = apply(doc, [{ op: 'update', id: 'a1', current: 'tall', w: 300, h: 100 }])
    expect(box(doc, 'a1')).toEqual({ w: 300, h: 100 })
  })

  test('取回的视频带尺寸确定后，竖版视频的框变为竖向', () => {
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

  test('添加带尺寸的文件节点时按缺省框的短边与文件比例确定框；更换文件时比例随之更换；尺寸随文档写出并读取', () => {
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

  test('提交的操作中不接受 size：只由服务端核验路径时填写', () => {
    const r = parseCanvasOps([{ op: 'add_file', path: 'a.png', size: { w: 1, h: 1 } }])
    expect(r.ok).toBe(false)
  })
})

describe('画布：提示词编译', () => {
  /** 两张图（小满、妈妈），视频1 已有一个版本，视频2 引用两张图与视频1。 */
  function mixed(): CanvasDoc {
    return apply(sample(), [
      { op: 'update', id: 'a4', prompt: '@[a1] 和 @[a2] 接 @[a3]，@[a1] 撑伞' },
    ])
  }
  const SEEDANCE_20 = { image: '图片{n}', video: '视频{n}', audio: '音频{n}' }
  const SEEDANCE_25 = { image: '@图片{n}', video: '@视频{n}', audio: '@音频{n}' }
  const WAN = { image: '图{n}', video: '视频{n}', audio: '音频{n}' }

  test('两张图与一段视频混合引用，按各模型的写法、按类别分别计数；同一节点两次引用编号相同', () => {
    expect(compilePrompt(mixed(), 'a4', SEEDANCE_20)).toBe('图片1 和 图片2 接 视频1，图片1 撑伞')
    expect(compilePrompt(mixed(), 'a4', SEEDANCE_25)).toBe(
      '@图片1 和 @图片2 接 @视频1，@图片1 撑伞',
    )
    expect(compilePrompt(mixed(), 'a4', WAN)).toBe('图1 和 图2 接 视频1，图1 撑伞')
  })

  test('未登记写法的模型替换为名称', () => {
    expect(compilePrompt(mixed(), 'a4')).toBe('小满 和 妈妈 接 视频1，小满 撑伞')
  })

  test('首尾帧模式下 @ 首帧、尾帧编译为名称，不套用写法', () => {
    const doc = apply(sample(), [{ op: 'set_mode', id: 'a4', mode: 'first_last' }])
    expect(compilePrompt(doc, 'a4', SEEDANCE_20)).toBe('小满 和 妈妈 在校门口')
  })
})

describe('画布：参考音频', () => {
  test('音频节点连接到视频卡时用途为 audio，@ 它时自动补充 audio 连线并编译为「音频1」', () => {
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

  test('音频不能连接到出图卡、不能作为参考图；首尾帧模式不接受音频', () => {
    const doc = apply(sample(), [{ op: 'add_file', ref: '$voice', path: '声音/小满.mp3' }])
    const voice = doc.nodes.at(-1)!.id
    const img = apply(doc, [{ op: 'add_generate', output: 'image' }], ids('i'))
    expect(rejects(img, [{ op: 'connect', from: voice, to: 'i1', role: 'reference' }])).toContain(
      '只接受参考图',
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

  test('新建的空时间线只有轨道高度；放入片段后出现预览区，清空后移除；默认名称按序号生成', () => {
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

  test('片段只接受工作区中的视频，且入点小于出点；不合法时整批拒绝', () => {
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

  test('静音开关；时间线没有提示词，生成卡与文件没有片段；改名时名称不能为空', () => {
    let doc = apply(emptyCanvas(), [{ op: 'add_timeline' }, { op: 'add_file', path: '素材/a.mp4' }])
    doc = apply(doc, [{ op: 'update', id: 'a1', muted: true }])
    expect(doc.nodes[0]).toMatchObject({ muted: true })
    doc = apply(doc, [{ op: 'update', id: 'a1', muted: false }])
    expect('muted' in doc.nodes[0]!).toBe(false)
    expect(rejects(doc, [{ op: 'update', id: 'a1', prompt: 'x' }])).toContain('时间线没有 prompt')
    expect(rejects(doc, [{ op: 'update', id: 'a2', clips: [] }])).toContain('只有时间线')
    expect(rejects(doc, [{ op: 'update', id: 'a1', name: '' }])).toContain('必须有名称')
  })

  test('时间线不能作为生成的输入，也不能被连线指向', () => {
    const doc = apply(sample(), [{ op: 'add_timeline', ref: '$t' }])
    const t = doc.nodes.at(-1)!.id
    expect(rejects(doc, [{ op: 'connect', from: t, to: 'a3', role: 'video' }])).toContain(
      '不能作为',
    )
    expect(rejects(doc, [{ op: 'connect', from: 'a1', to: t, role: 'reference' }])).toContain(
      '只能连接到生成节点',
    )
  })

  test('写出后重新读取内容不变；复制时带上片段与静音设置；提交的操作按字段表核对', () => {
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

describe('画布：Art', () => {
  test('新建 Art 卡为 16:9 横向框，默认名称按 Art 计数', () => {
    const doc = apply(emptyCanvas(), [
      { op: 'add_generate', output: 'art' },
      { op: 'add_generate', output: 'art' },
    ])
    expect([gen(doc, 'a1').name, gen(doc, 'a2').name]).toEqual(['Art1', 'Art2'])
    expect([gen(doc, 'a1').w, gen(doc, 'a1').h]).toEqual([300, 169])
  })

  test('Art 卡只接受图片作参考图；Art 节点不能作为任何生成卡的输入', () => {
    const doc = apply(emptyCanvas(), [
      { op: 'add_file', ref: '$img', path: '参考/街口.png' },
      { op: 'add_file', ref: '$mov', path: '参考/走位.mp4' },
      { op: 'add_file', ref: '$page', path: 'generated/白模.html' },
      { op: 'add_generate', ref: '$art', output: 'art' },
      { op: 'add_generate', ref: '$pic', output: 'image' },
      { op: 'add_generate', ref: '$vid', output: 'video' },
      { op: 'connect', from: '$img', to: '$art', role: 'reference' },
    ])
    expect(doc.edges).toHaveLength(1)
    expect(rejects(doc, [{ op: 'connect', from: 'a2', to: 'a4', role: 'video' }])).toContain(
      '只接受参考图',
    )
    for (const to of ['a4', 'a5']) {
      expect(rejects(doc, [{ op: 'connect', from: 'a3', to, role: 'reference' }])).toContain(
        '只接受参考图',
      )
    }
    expect(rejects(doc, [{ op: 'connect', from: 'a3', to: 'a6', role: 'video' }])).toContain(
      '不能作为',
    )
    // 在提示词中 @ 一个 Art 节点：无法补充连线，整批拒绝。
    expect(rejects(doc, [{ op: 'update', id: 'a6', prompt: '参考 @[a3]' }])).toContain('不能作为')
  })

  test('参考图在提示词中按「图n」编号，编号与连线顺序（即发送顺序）一致', () => {
    const doc = apply(emptyCanvas(), [
      { op: 'add_file', ref: '$a', path: 'a.png' },
      { op: 'add_file', ref: '$b', path: 'b.png' },
      { op: 'add_generate', ref: '$art', output: 'art', prompt: '按 @[$b] 的构图，@[$a] 的配色' },
    ])
    expect(doc.edges.map((e) => e.from)).toEqual(['a2', 'a1'])
    expect(compilePrompt(doc, 'a3', ART_MENTION)).toBe('按 图1 的构图，图2 的配色')
  })
})
