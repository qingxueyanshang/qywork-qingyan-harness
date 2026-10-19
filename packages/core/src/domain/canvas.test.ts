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
  markdownHeadings,
  modeOf,
  parseCanvas,
  parseCanvasOps,
  recordRun,
  serializeCanvas,
  settleVersion,
  textReferenceOf,
  textReferenceProblems,
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
      version: 'old-version',
      output: 'generated/original.mp4',
      prompt: '走出校门',
      params: { duration: 5 },
      inputs: [{ role: 'first_frame', path: 'a.png' }],
      message: '内容审核未通过',
      diagnostic: {
        stage: 'upload',
        outcome: 'rejected',
        kind: 'connection',
        host: 'example.com',
        elapsedMs: 100,
      },
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

  test('引用卡片可写卡片名称：操作中的字段与提示词中的 @[名称] 都换成 id，跨批有效；卡片不存在、名称重复或批内名称跨批时整批拒绝', () => {
    const first = apply(
      emptyCanvas(),
      [{ op: 'add_file', ref: '$照片', path: '照片.png', name: '旧照片', x: 0, y: 0 }],
      ids('b'),
    )
    const next = apply(
      first,
      [
        { op: 'add_generate', output: 'video', name: '镜头1', prompt: '@[旧照片] 被翻开' },
        { op: 'update', id: '镜头1', prompt: '@[旧照片] 被合上' },
      ],
      ids('n'),
    )
    expect(gen(next, 'n1').prompt).toBe('@[b1] 被合上')
    expect(next.edges.filter((e) => e.from === 'b1' && e.to === 'n1')).toHaveLength(1)
    expect(rejects(next, [{ op: 'connect', from: '新照片', to: '镜头1', role: 'reference' }])).toBe(
      '未找到卡片「新照片」：引用卡片时写画布上已有的卡片名称或 id',
    )
    const twin = apply(
      next,
      [{ op: 'add_file', path: 'b.png', name: '旧照片', x: 500, y: 0 }],
      ids('t'),
    )
    expect(rejects(twin, [{ op: 'remove', id: '旧照片' }])).toContain('名称「旧照片」对应 2 张卡')
    expect(rejects(first, [{ op: 'add_generate', output: 'image', prompt: '@[$照片] 微笑' }])).toBe(
      '$照片 未定义：批内名称只在同一批操作中有效，引用卡片时写卡片名称',
    )
  })

  test('批内名称可用中文；含空格或标点时整批拒绝，报错写明允许的字符', () => {
    const doc = apply(
      emptyCanvas(),
      [
        { op: 'add_file', ref: '$林悦', path: 'a.png' },
        { op: 'add_generate', output: 'image', prompt: '@[$林悦] 微笑' },
      ],
      ids('n'),
    )
    expect(gen(doc, 'n2').prompt).toBe('@[n1] 微笑')
    const error = rejects(emptyCanvas(), [{ op: 'add_file', ref: '$林 悦', path: 'a.png' }])
    expect(error).toContain('字母、数字、下划线或连字符，不含空格与标点')
    expect(error).toContain('$林 悦')
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

  test('edit_prompt 只替换提示词中的一段，其余原文不变；新写的 @[名称] 换成 id 并补连线，替换值中的 $ 原样保留', () => {
    const long = `${'【整体风格】保持胶片质感。'.repeat(80)}\n@[a1]用于小满的脸。\n@[a2]用于妈妈的背包带。`
    const doc = apply(sample(), [{ op: 'update', id: 'a4', prompt: long }])
    const next = apply(doc, [
      { op: 'edit_prompt', id: 'a4', old: '妈妈的背包带', new: '妈妈的右胳膊' },
      { op: 'edit_prompt', id: 'a4', old: '\n@[a1]用于小满的脸。', new: '' },
      { op: 'edit_prompt', id: 'a4', old: '右胳膊。', new: '右胳膊，@[a3] 的末尾 $& 接上。' },
    ])
    expect(gen(next, 'a4').prompt).toBe(
      `${'【整体风格】保持胶片质感。'.repeat(80)}\n@[a2]用于妈妈的右胳膊，@[a3] 的末尾 $& 接上。`,
    )
    expect(next.edges.find((e) => e.from === 'a3')).toMatchObject({ to: 'a4', role: 'video' })
    // 删除 @ 不删除连线：输入只由连线决定。
    expect(next.edges.some((e) => e.from === 'a1' && e.to === 'a4')).toBe(true)

    const named = apply(doc, [
      { op: 'update', id: 'a3', name: '镜头1' },
      { op: 'edit_prompt', id: 'a4', old: '小满的脸', new: '@[镜头1] 结尾的小满' },
    ])
    expect(gen(named, 'a4').prompt).toContain('@[a1]用于@[a3] 结尾的小满。')
  })

  /**
   * 原始失败形状：后补的素材只能排在输入末尾，要调到中间只能断开再重连；
   * 断开的批次结束时提示词中的 @ 已变为纯文本，发送时不再编号，模型因此改为直接改写画布文件。
   */
  test('order_inputs 重排输入：连线、用途与提示词不变，提示词编号随之改变，其他节点的输入顺序不变', () => {
    const style = { image: '图片{n}' }
    let doc = apply(sample(), [
      { op: 'add_file', ref: '$tk', path: '道具/三轮车.png' },
      { op: 'add_generate', ref: '$g', output: 'image', prompt: '@[a2] 和 @[a1]' },
    ])
    const truck = doc.nodes.find((n) => n.type === 'file' && n.path === '道具/三轮车.png')!.id
    const other = doc.nodes.find((n) => n.type === 'generate' && n.output === 'image')!.id
    doc = apply(doc, [{ op: 'edit_prompt', id: 'a4', old: ' 和 ', new: ` 推着 @[${truck}] 和 ` }])
    expect(compilePrompt(doc, 'a4', style)).toBe('图片1 推着 图片3 和 图片2 在校门口')

    const ordered = apply(doc, [{ op: 'order_inputs', id: 'a4', inputs: ['a1', truck, 'a2'] }])
    const from = (d: CanvasDoc, id: string) => d.edges.filter((e) => e.to === id).map((e) => e.from)
    expect(from(ordered, 'a4')).toEqual(['a1', truck, 'a2'])
    expect(from(ordered, other)).toEqual(['a2', 'a1'])
    expect(gen(ordered, 'a4').prompt).toBe(gen(doc, 'a4').prompt)
    expect(compilePrompt(ordered, 'a4', style)).toBe('图片1 推着 图片2 和 图片3 在校门口')
    const key = (d: CanvasDoc) => d.edges.map((e) => `${e.id}:${e.from}>${e.to}:${e.role}`).sort()
    expect(key(ordered)).toEqual(key(doc))

    // 同一批中先连接再排序：新连线参与排序。
    const added = apply(sample(), [
      { op: 'add_file', ref: '$tk', path: '道具/三轮车.png' },
      { op: 'connect', from: '$tk', to: 'a4', role: 'reference' },
      { op: 'order_inputs', id: 'a4', inputs: ['$tk', 'a1', 'a2'] },
    ])
    expect(from(added, 'a4')).toEqual([added.nodes.at(-1)!.id, 'a1', 'a2'])
    expect(gen(added, 'a4').prompt).toBe('@[a1] 和 @[a2] 在校门口')
  })

  test('order_inputs 漏列、重复、多列输入或目标不是生成节点时整批拒绝，报错列出当前输入', () => {
    const doc = sample()
    const listed = 'inputs 须按新顺序列出「视频2」的全部输入，每项一次；当前输入：小满、妈妈'
    expect(rejects(doc, [{ op: 'order_inputs', id: 'a4', inputs: ['a2'] }])).toBe(listed)
    expect(rejects(doc, [{ op: 'order_inputs', id: 'a4', inputs: ['a2', 'a2'] }])).toBe(listed)
    expect(rejects(doc, [{ op: 'order_inputs', id: 'a4', inputs: ['a2', 'a1', 'a3'] }])).toBe(
      listed,
    )
    expect(rejects(doc, [{ op: 'order_inputs', id: 'a1', inputs: [] }])).toBe('只有生成节点有输入')
    expect(parseCanvasOps([{ op: 'order_inputs', id: 'a4', inputs: 'a1' }])).toEqual({
      ok: false,
      error: '第 1 条操作 的 inputs 类型错误：应为字符串数组，收到的是字符串',
    })
  })

  test('edit_prompt 的 old 未出现、出现多次、为空或目标不是生成节点时整批拒绝', () => {
    const doc = sample()
    expect(rejects(doc, [{ op: 'edit_prompt', id: 'a4', old: '操场', new: '教室' }])).toBe(
      '「视频2」的提示词中没有 old 指定的文字',
    )
    expect(rejects(doc, [{ op: 'edit_prompt', id: 'a4', old: '@[a', new: '' }])).toBe(
      '「视频2」的提示词中 old 出现 2 次，加长 old 使其只出现一次',
    )
    expect(rejects(doc, [{ op: 'edit_prompt', id: 'a4', old: '', new: 'x' }])).toBe('old 不能为空')
    expect(rejects(doc, [{ op: 'edit_prompt', id: 'a1', old: 'x', new: 'y' }])).toBe(
      '只有生成节点有提示词',
    )
    const half = rejects(doc, [
      { op: 'edit_prompt', id: 'a4', old: '校门口', new: '操场' },
      { op: 'edit_prompt', id: 'a4', old: '校门口', new: '教室' },
    ])
    expect(half).toBe('「视频2」的提示词中没有 old 指定的文字')
    expect(gen(doc, 'a4').prompt).toBe('@[a1] 和 @[a2] 在校门口')
    expect(parseCanvasOps([{ op: 'edit_prompt', id: 'a4', old: '校门口' }])).toMatchObject({
      ok: false,
    })
  })

  /**
   * 原始失败形状：10 张卡整段替换【剧本内容】时，old 须照抄整段旧原文，模型改用脚本以正则替换画布文件。
   * 按前后标记替换只需给出两个标记。
   */
  test('edit_prompt 按 from / to 标记替换两者之间的文字，标记保留；省略 to 时替换到末尾', () => {
    const prompt = '【视频约束】中文。\n【剧本内容】\n0-5秒：旧。\n【画面一致】保持服装。'
    const doc = apply(sample(), [{ op: 'update', id: 'a4', prompt }])
    const mid = apply(doc, [
      {
        op: 'edit_prompt',
        id: 'a4',
        from: '【剧本内容】',
        to: '【画面一致】',
        new: '\n0-3秒：新。\n',
      },
    ])
    expect(gen(mid, 'a4').prompt).toBe(
      '【视频约束】中文。\n【剧本内容】\n0-3秒：新。\n【画面一致】保持服装。',
    )
    const tail = apply(doc, [{ op: 'edit_prompt', id: 'a4', from: '【画面一致】', new: '无。' }])
    expect(gen(tail, 'a4').prompt).toBe(
      '【视频约束】中文。\n【剧本内容】\n0-5秒：旧。\n【画面一致】无。',
    )
  })

  test('edit_prompt 的标记不存在、出现多次、顺序颠倒或与 old 同时给出时不成立', () => {
    const doc = apply(sample(), [{ op: 'update', id: 'a4', prompt: '甲【一】乙【二】丙【一】' }])
    expect(rejects(doc, [{ op: 'edit_prompt', id: 'a4', from: '【三】', new: 'x' }])).toBe(
      '「视频2」的提示词中没有 from 指定的标记「【三】」',
    )
    expect(rejects(doc, [{ op: 'edit_prompt', id: 'a4', from: '【一】', new: 'x' }])).toBe(
      '「视频2」的提示词中 from 标记「【一】」出现多次，加长标记使其只出现一次',
    )
    expect(
      rejects(doc, [{ op: 'edit_prompt', id: 'a4', from: '【二】', to: '乙', new: 'x' }]),
    ).toBe('「视频2」的提示词中 to 标记「乙」位于 from 标记之前')
    expect(
      rejects(doc, [{ op: 'edit_prompt', id: 'a4', old: '甲', from: '【二】', new: 'x' }]),
    ).toBe('old 与 from 须给出其中一个')
    expect(rejects(doc, [{ op: 'edit_prompt', id: 'a4', to: '【二】', old: '甲', new: 'x' }])).toBe(
      'to 须与 from 一起给出',
    )
  })

  /** 原始失败形状：10 张道具卡把同一段「暖黄灯光」换成「自然光」，工具只能逐张整段改写。 */
  test('replace_text 把提示词中出现的原文全部替换；一处都没有、目标不是生成节点时不成立', () => {
    const doc = apply(sample(), [{ op: 'update', id: 'a4', prompt: '暖黄灯光，暖黄灯光下 @[a1]' }])
    const next = apply(doc, [{ op: 'replace_text', id: 'a4', old: '暖黄灯光', new: '自然光 $&' }])
    expect(gen(next, 'a4').prompt).toBe('自然光 $&，自然光 $&下 @[a1]')
    expect(rejects(doc, [{ op: 'replace_text', id: 'a4', old: '冷光', new: 'x' }])).toBe(
      '「视频2」的提示词中没有「冷光」',
    )
    expect(rejects(doc, [{ op: 'replace_text', id: 'a1', old: 'x', new: 'y' }])).toBe(
      '只有生成节点有提示词',
    )
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
      '是文本，只能被提示词引用',
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
    // 视频空卡缺省为横向，按当前框占位。
    expect(box('n2')).toMatchObject({ x: box('n1').x + 225 + 100, y: 0 })
    expect(box('n3')).toMatchObject({ x: box('n2').x + 300 + 100, y: 0 })
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
  })

  /**
   * 原始失败形状：给出 1:1 的方形空卡按 300 见方占位，人物列每 400 一张、列与列相隔 400，出图后空白约 230。
   * 带组的卡按当前框排位，出图变大后推开同列下方与右侧的卡，间距仍为 100。
   */
  test('带组的方形空卡按当前框排位；出图变大后推开同列下方与右侧各列，间距保持 100', () => {
    let doc = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', output: 'image', group: '角色/甲' },
        { op: 'add_generate', output: 'image', group: '角色/乙' },
        { op: 'add_generate', output: 'image', group: '角色/丙', w: 300, h: 169 },
        { op: 'add_generate', output: 'image', group: '角色/丁' },
        { op: 'add_generate', output: 'image', group: '场景/山门' },
        { op: 'add_generate', output: 'image', group: '场景/书房' },
      ],
      ids('n'),
    )
    const at = (id: string) => {
      const n = doc.nodes.find((x) => x.id === id)!
      return [n.x, n.y, n.w, n.h]
    }
    expect(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map(at)).toEqual([
      [0, 0, 169, 169],
      [0, 269, 169, 169],
      [0, 538, 300, 169],
      [0, 807, 169, 169],
      [400, 0, 169, 169],
      [400, 269, 169, 169],
    ])
    const results = [
      ['n1', { w: 1672, h: 941 }],
      ['n2', { w: 1080, h: 1920 }],
      ['n5', { w: 1536, h: 1024 }],
    ] as const
    for (const [id, size] of results) {
      const r = addVersions(doc, id, [{ ...version(`p-${id}`, `generated/${id}.png`), size }])
      if (!r.ok) throw new Error(r.error)
      doc = r.doc
    }
    // n2 变高 131，下方两张下移 131；n1 变宽到 300，与「场景」列的间距仍为 100，不必移动；n5 变宽，列内不受影响。
    expect(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map(at)).toEqual([
      [0, 0, 300, 169],
      [0, 269, 169, 300],
      [0, 669, 300, 169],
      [0, 938, 169, 169],
      [400, 0, 254, 169],
      [400, 269, 169, 169],
    ])
    const wide = addVersions(doc, 'n1', [
      { ...version('p2-n1', 'generated/n1-2.png'), size: { w: 2520, h: 1080 } },
    ])
    if (!wide.ok) throw new Error(wide.error)
    doc = wide.doc
    // n1 换成 21:9 的结果，宽 394：「场景」整列右移到 394 + 100，与 n1 不相邻的 n6 随列移动，仍对齐。
    expect([at('n1'), at('n5'), at('n6')]).toEqual([
      [0, 0, 394, 169],
      [494, 0, 254, 169],
      [494, 269, 169, 169],
    ])
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
  })

  test('界面添加的卡与画布排列的卡规则相同：按当前框放置，变大时推开相邻的节点', () => {
    let doc = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', ref: '$a', output: 'image', x: 0, y: 0 },
        { op: 'add_file', path: 'b.png', beside: '$a' },
        { op: 'add_file', path: 'c.png', x: 0, y: 350 },
      ],
      ids('u'),
    )
    expect(doc.nodes.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [169 + 100, 0],
      [0, 350],
    ])
    const r = addVersions(doc, 'u1', [
      { ...version('p', 'generated/u1.png'), size: { w: 1080, h: 1920 } },
    ])
    if (!r.ok) throw new Error(r.error)
    doc = r.doc
    expect(doc.nodes.map((n) => [n.x, n.y, n.w, n.h])).toEqual([
      [0, 0, 169, 300],
      [269, 0, 225, 169],
      // 原间距 181，按 CARD_GAP 保留 100：下移 50。
      [0, 400, 225, 169],
    ])
  })

  test('变小时收回：紧挨着的卡随之移回，隔得更远的卡不动', () => {
    let doc = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', output: 'video', group: '山门·镜头', w: 300, h: 169 },
        { op: 'add_generate', output: 'image', group: '场景/山门', w: 169, h: 300 },
      ],
      ids('g'),
    )
    doc = apply(
      doc,
      [
        { op: 'add_file', path: 'tail.png', beside: 'g2' },
        { op: 'add_file', path: 'far.png', x: 2000, y: 0 },
      ],
      ids('m'),
    )
    const at = (id: string) => {
      const n = doc.nodes.find((x) => x.id === id)!
      return [n.x, n.y]
    }
    expect([at('g2'), at('m1'), at('m2')]).toEqual([
      [400, 0],
      [669, 0],
      [2000, 0],
    ])
    const tall = addVersions(doc, 'g1', [
      { ...version('p1', 'generated/g1.mp4'), size: { w: 720, h: 1280 } },
    ])
    if (!tall.ok) throw new Error(tall.error)
    doc = tall.doc
    // g1 宽 300 → 169：「场景」列与紧挨着它的界面卡各左移 131，间距仍为 100；远处的卡不动。
    expect([at('g1'), at('g2'), at('m1'), at('m2')]).toEqual([
      [0, 0],
      [269, 0],
      [538, 0],
      [2000, 0],
    ])
  })

  test('推开时界面放置的节点一并移开；与变大的卡不相对的节点不动', () => {
    let doc = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', output: 'image', group: '角色/甲' },
        { op: 'add_generate', output: 'video', group: '山门·镜头', w: 300, h: 169 },
        { op: 'add_generate', output: 'video', group: '山门·镜头', w: 300, h: 169 },
      ],
      ids('g'),
    )
    doc = apply(
      doc,
      [
        { op: 'add_file', path: 'note.png', x: 269 + 300 + 100, y: 269 },
        { op: 'add_file', path: 'far.png', x: 500, y: 3000 },
      ],
      ids('m'),
    )
    const at = (id: string) => {
      const n = doc.nodes.find((x) => x.id === id)!
      return [n.x, n.y]
    }
    expect([at('g2'), at('g3'), at('m1')]).toEqual([
      [269, 0],
      [269, 269],
      [669, 269],
    ])
    const grow = addVersions(doc, 'g1', [
      { ...version('p1', 'generated/g1.png'), size: { w: 1672, h: 941 } },
    ])
    if (!grow.ok) throw new Error(grow.error)
    doc = grow.doc
    // 「镜头」整列右移 131；界面放在第二张镜头右侧的卡随之右移，间距不变；远处的卡不动。
    expect([at('g2'), at('g3'), at('m1'), at('m2')]).toEqual([
      [400, 0],
      [400, 269],
      [800, 269],
      [500, 3000],
    ])
    // 视频出竖图：宽变小、高变大。下方的镜头下移；界面放置的卡仍与第二张镜头相对，间距已是 100，不动。
    const tall = addVersions(doc, 'g2', [
      { ...version('p2', 'generated/g2.mp4'), size: { w: 720, h: 1280 } },
    ])
    if (!tall.ok) throw new Error(tall.error)
    doc = tall.doc
    expect([at('g2'), at('g3'), at('m1')]).toEqual([
      [400, 0],
      [400, 300 + 100],
      [800, 269],
    ])
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

  test('beside 同时给出 x、y 时以 x、y 为准；指向不存在的节点时整批拒绝；可按卡片名称指定', () => {
    const doc = apply(
      sample(),
      [{ op: 'add_file', path: 'x.png', beside: 'a1', x: 7, y: 9 }],
      ids('n'),
    )
    expect(doc.nodes.at(-1)).toMatchObject({ x: 7, y: 9 })
    expect(rejects(sample(), [{ op: 'add_file', path: 'x.png', beside: 'nope' }])).toContain('nope')
    const named = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', output: 'video', name: '镜头1', x: 0, y: 0 },
        { op: 'add_generate', output: 'video', beside: '镜头1' },
      ],
      ids('n'),
    )
    expect(named.nodes[1]).toMatchObject({ x: 300 + 100, y: 0 })
    expect(parseCanvasOps([{ op: 'add_generate', output: 'image', beside: 'a1' }]).ok).toBe(true)
  })

  test('类别成列：第 1 幕建角色、场景、道具与两个场景的分镜和时间线，第 2 幕补衣服、新人物、新场景、新道具与分镜', () => {
    const card = (name: string, group: string, w: number, h: number, prompt = ''): CanvasOp => ({
      op: 'add_generate',
      output: 'image',
      name,
      group,
      prompt,
      w,
      h,
    })
    const person = (name: string, prompt = '') =>
      card(name, `角色/${name.slice(0, name.indexOf('_'))}`, 169, 300, prompt)
    const wide = (name: string, group: string, prompt = '') => card(name, group, 300, 169, prompt)
    let doc = apply(
      emptyCanvas(),
      [
        person('沈砚_主参考'),
        person('沈砚_便装', '@[沈砚_主参考] 换便装'),
        person('顾衡_主参考'),
        person('顾衡_便装', '@[顾衡_主参考] 换便装'),
        wide('山门_雨夜', '场景/山门'),
        wide('山门_白天', '场景/山门'),
        wide('书房', '场景/书房'),
        wide('玉佩', '道具/玉佩'),
        wide('长剑', '道具/长剑'),
        wide('镜头1-1', '山门·分镜', '@[沈砚_主参考] @[山门_雨夜]'),
        wide('镜头1-2', '山门·分镜', '@[顾衡_主参考] @[山门_雨夜]'),
        wide('镜头1-3', '山门·分镜', '@[玉佩]'),
        wide('镜头1-4', '书房·分镜', '@[沈砚_便装] @[书房]'),
        wide('镜头1-5', '书房·分镜', '@[长剑] @[书房]'),
        { op: 'add_timeline', name: '第1幕成片' },
      ],
      ids('a'),
    )
    doc = apply(
      doc,
      [
        person('沈砚_夜行衣', '@[沈砚_主参考] 换夜行衣'),
        person('林婉_主参考'),
        wide('竹林', '场景/竹林'),
        wide('令牌', '道具/令牌'),
        wide('镜头2-1', '竹林·分镜', '@[林婉_主参考] @[竹林]'),
        wide('镜头2-2', '竹林·分镜', '@[沈砚_夜行衣] @[竹林]'),
        wide('镜头2-3', '竹林·分镜', '@[令牌]'),
        wide('镜头2-4', '山门·分镜', '@[顾衡_便装] @[山门_白天]'),
      ],
      ids('b'),
    )
    // 每一列自上而下的卡片名称，列按从左到右排列。
    const columns = new Map<number, CanvasDoc['nodes']>()
    for (const n of doc.nodes) columns.set(n.x, [...(columns.get(n.x) ?? []), n])
    const layout = [...columns]
      .sort(([a], [b]) => a - b)
      .map(([, ns]) => ns.sort((a, b) => a.y - b.y).map((n) => n.name))
    expect(layout).toEqual([
      ['沈砚_主参考', '沈砚_便装', '沈砚_夜行衣', '顾衡_主参考', '顾衡_便装', '林婉_主参考'],
      ['山门_雨夜', '山门_白天', '书房', '竹林'],
      ['玉佩', '长剑', '令牌'],
      ['镜头1-1', '镜头1-2', '镜头1-3', '镜头2-4'],
      ['镜头1-4', '镜头1-5'],
      ['第1幕成片'],
      ['镜头2-1', '镜头2-2', '镜头2-3'],
    ])
    const at = (name: string) => {
      const n = doc.nodes.find((x) => x.name === name)!
      return [n.x, n.y]
    }
    // 补沈砚的夜行衣时，顾衡的两张卡下移一张卡与一个间距，林婉接在列末。
    expect(['沈砚_夜行衣', '顾衡_主参考', '顾衡_便装', '林婉_主参考'].map(at)).toEqual([
      [0, 800],
      [0, 1200],
      [0, 1600],
      [0, 2000],
    ])
    expect([at('山门_雨夜'), at('玉佩'), at('镜头1-1'), at('镜头1-4'), at('第1幕成片')]).toEqual([
      [269, 0],
      [669, 0],
      [1069, 0],
      [1469, 0],
      [1869, 0],
    ])
    expect(at('镜头2-1')).toEqual([1869 + 480 + 100, 0])
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
    expect(apply(emptyCanvas(), [{ op: 'add_file', path: 'a.png' }]).nodes[0]).toMatchObject({
      x: 0,
      y: 0,
      group: '图片',
    })
  })

  test('从已有内容右侧开始；同一列不折列；时间线建好之后补镜头仍接在本列末尾；补衣服时下方的人物下移', () => {
    const base = apply(
      emptyCanvas(),
      [
        { op: 'add_generate', output: 'image', x: -2263, y: 1346 },
        { op: 'add_generate', output: 'video', x: -1972, y: 1600 },
      ],
      ids('p'),
    )
    const outfit = (name: string): CanvasOp => ({
      op: 'add_generate',
      output: 'image',
      name,
      group: `角色/${name.slice(0, name.indexOf('_'))}`,
      w: 169,
      h: 300,
    })
    const shot = (name: string, ref: string): CanvasOp => ({
      op: 'add_generate',
      output: 'video',
      name,
      group: '客厅·分镜',
      prompt: `@[${ref}] 回头`,
      w: 300,
      h: 169,
    })
    let doc = apply(
      base,
      Array.from({ length: 7 }, (_, i) => outfit(`林悦_造型${i + 1}`)),
      ids('a'),
    )
    const at = (id: string) => {
      const n = doc.nodes.find((x) => x.id === id)!
      return [n.x, n.y]
    }
    // 已有内容的最右处为视频卡的右缘 -1972 + 300。
    const x0 = -1672 + 100
    const y0 = 1346
    expect([at('a1'), at('a7')]).toEqual([
      [x0, y0],
      [x0, y0 + 6 * 400],
    ])
    doc = apply(doc, [shot('镜头1', '林悦_造型1'), { op: 'add_timeline', name: '成片' }], ids('b'))
    expect([at('b1'), at('b2')]).toEqual([
      [x0 + 269, y0],
      [x0 + 669, y0],
    ])
    doc = apply(doc, [shot('镜头2', '林悦_造型2'), outfit('奶奶_家常')], ids('c'))
    expect([at('c1'), at('c2')]).toEqual([
      [x0 + 269, y0 + 269],
      [x0, y0 + 7 * 400],
    ])
    doc = apply(doc, [outfit('林悦_造型8')], ids('d'))
    expect([at('d1'), at('c2')]).toEqual([
      [x0, y0 + 7 * 400],
      [x0, y0 + 8 * 400],
    ])
    for (const a of doc.nodes) {
      for (const b of doc.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false)
    }
  })

  /**
   * 按固定种子生成多批随机操作：各列、各对象随机交错地新增卡片，穿插时间线；部分卡片是方形空卡，
   * 每一批之后随机为其中几张写入横图、竖图、方图或 21:9 的结果。
   * 每一批之后检查：互不相交；同一列的卡横坐标相同，上下相邻两张正好相隔一个间距；
   * 同一对象的卡片在列中相连；不同列不共用一个横坐标，纵向相对的两张卡横向至少相隔一个间距。
   */
  test('随机多批新增与出图：同列紧接、同一对象相连、不同列相隔不少于一个间距、互不相交', () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed >>> 16) % n
    }
    const groups = [
      '角色/甲',
      '角色/乙',
      '角色/丙',
      '场景/山门',
      '场景/书房',
      '道具/玉佩',
      '山门·分镜',
      '书房·分镜',
    ]
    const columnOf = (g: string) => g.split('/')[0]!
    const shape = (g: string) =>
      ['角色/丙', '道具/玉佩', '书房·分镜'].includes(g)
        ? {}
        : g.startsWith('角色')
          ? { w: 169, h: 300 }
          : { w: 300, h: 169 }
    const results = [
      { w: 1672, h: 941 },
      { w: 1080, h: 1920 },
      { w: 1024, h: 1024 },
      { w: 2520, h: 1080 },
    ]
    let doc = emptyCanvas()
    let count = 0
    for (let batch = 0; batch < 30; batch++) {
      const ops: CanvasOp[] = []
      for (let k = rand(4) + 1; k > 0; k--) {
        const g = groups[rand(groups.length)]!
        const ref = doc.nodes.find((n) => n.type === 'generate')?.name
        ops.push({
          op: 'add_generate',
          output: 'image',
          name: `卡${++count}`,
          group: g,
          prompt: ref && rand(2) ? `@[${ref}] 参考` : '',
          ...shape(g),
        })
      }
      if (rand(6) === 0) ops.push({ op: 'add_timeline', name: `时间线${batch}` })
      doc = apply(doc, ops, ids(`b${batch}_`))
      for (let k = rand(3); k > 0; k--) {
        const blank = doc.nodes.filter(
          (n) => n.type === 'generate' && n.w === n.h && n.versions.length === 0,
        )
        const card = blank[rand(blank.length || 1)]
        if (!card) break
        const size = results[rand(results.length)]!
        const r = addVersions(doc, card.id, [
          { ...version(`r${batch}_${k}`, `generated/${card.id}.png`), size },
        ])
        if (!r.ok) throw new Error(r.error)
        doc = r.doc
      }
      const cards = doc.nodes.filter((n) => n.type === 'generate')
      const xs = new Map<string, number>()
      for (const column of new Set(groups.map(columnOf))) {
        const members = cards.filter((n) => columnOf(n.group!) === column).sort((a, b) => a.y - b.y)
        if (!members.length) continue
        expect(new Set(members.map((n) => n.x)).size).toBe(1)
        xs.set(column, members[0]!.x)
        for (let i = 1; i < members.length; i++) {
          expect(members[i]!.y - members[i - 1]!.y - members[i - 1]!.h).toBe(100)
        }
        const runs = members.map((n) => n.group).filter((g, i, all) => g !== all[i - 1])
        expect(new Set(runs).size).toBe(runs.length)
      }
      expect(new Set(xs.values()).size).toBe(xs.size)
      const keyOf = (n: CanvasDoc['nodes'][number]) =>
        n.type === 'timeline' ? n.id : columnOf(n.group!)
      for (const a of doc.nodes) {
        for (const b of doc.nodes) {
          if (a === b) continue
          expect(overlaps(a, b)).toBe(false)
          const facing = a.y < b.y + b.h && b.y < a.y + a.h
          if (facing && keyOf(a) !== keyOf(b) && b.x >= a.x + a.w) {
            expect(b.x - a.x - a.w).toBeGreaterThanOrEqual(100)
          }
        }
      }
    }
    expect(count).toBeGreaterThan(50)
    expect(
      doc.nodes.filter((n) => n.type === 'generate' && n.versions.length).length,
    ).toBeGreaterThan(10)
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
      { op: 'add_file', ref: '$a', path: 'voice.wav', x: 0, y: 0 },
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
  test('音频卡接受参考音频并将标签按顺序编译为 @voiceN，拒绝图片输入', () => {
    const doc = apply(sample(), [
      { op: 'add_file', ref: '$voice', path: '声音/旁白.opus' },
      { op: 'add_generate', ref: '$audio', output: 'audio', prompt: '@[$voice] 说你好' },
    ])
    const audio = doc.nodes.at(-1)!.id
    const voice = doc.nodes.at(-2)!.id
    expect(doc.edges.find((e) => e.to === audio)).toMatchObject({ from: voice, role: 'audio' })
    expect(compilePrompt(doc, audio, { audio: '@voice{n}' })).toBe('@voice1 说你好')
    expect(rejects(doc, [{ op: 'connect', from: 'a1', to: audio, role: 'reference' }])).toContain(
      '只接受参考音频',
    )
  })
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

/**
 * 原始失败形状：剧本 md 与卡片【剧本内容】各存一份，模型手工搬运时改写内容，两份不一致；
 * 20 张设计稿卡各带一份相同的公共要求。文本卡被提示词引用后，运行时展开为文件当前的内容，不复制。
 */
describe('画布：文本卡引用', () => {
  /** 一张文本卡（制作脚本）、一张图、一张视频卡。 */
  function withScript(): CanvasDoc {
    return apply(emptyCanvas(), [
      { op: 'add_file', ref: '$md', path: '作品/制作脚本.md', name: '制作脚本' },
      { op: 'add_file', ref: '$img', path: '角色/小满.png', name: '小满' },
      { op: 'add_generate', ref: '$v', output: 'video', name: '1-2 入梦' },
    ])
  }
  const SCRIPT =
    '# 第1集\n\n## 1-1 修车铺\n阿七推门。\n\n## 1-2 入梦\n阿七说：“手给我。”\n\n### 细节\n铜铃响。\n\n## 1-3 教室\n空教室。\n'

  test('引用文本卡即以 text 连线，带标题的引用换成 id；编译时展开全文或该标题下的段落', () => {
    const doc = apply(withScript(), [
      { op: 'update', id: '1-2 入梦', prompt: '@[制作脚本#1-2 入梦]\n@[小满] 用于阿七的脸' },
    ])
    expect(gen(doc, 'a3').prompt).toBe('@[a1#1-2 入梦]\n@[a2] 用于阿七的脸')
    expect(doc.edges.map((e) => [e.from, e.role])).toEqual([
      ['a1', 'text'],
      ['a2', 'reference'],
    ])
    const texts = new Map([['a1', SCRIPT]])
    expect(compilePrompt(doc, 'a3', { image: '@Image{n}' }, texts)).toBe(
      '阿七说：“手给我。”\n\n### 细节\n铜铃响。\n@Image1 用于阿七的脸',
    )
    const whole = apply(doc, [{ op: 'update', id: 'a3', prompt: '@[制作脚本]' }])
    expect(compilePrompt(whole, 'a3', {}, texts)).toBe(SCRIPT.trim())
  })

  test('删除引用即断开文本连线；断开连线或删除文本卡时从提示词中删除引用；连接文本卡即在末尾插入引用', () => {
    const doc = apply(withScript(), [
      { op: 'update', id: 'a3', prompt: '开头 @[制作脚本#1-2 入梦]' },
    ])
    const unmentioned = apply(doc, [{ op: 'update', id: 'a3', prompt: '开头' }])
    expect(unmentioned.edges).toEqual([])
    const edge = doc.edges[0]!
    expect(gen(apply(doc, [{ op: 'remove', id: edge.id }]), 'a3').prompt).toBe('开头 ')
    expect(gen(apply(doc, [{ op: 'remove', id: 'a1' }]), 'a3').prompt).toBe('开头 ')
    const linked = apply(withScript(), [
      { op: 'update', id: 'a3', prompt: '剧情：' },
      { op: 'connect', from: '制作脚本', to: '1-2 入梦', role: 'text' },
    ])
    expect(gen(linked, 'a3').prompt).toBe('剧情： @[a1]')
    expect(linked.edges.map((e) => e.role)).toEqual(['text'])
  })

  test('文本卡只能以 text 连接，媒体不能以 text 连接；首尾帧模式的视频卡同样可以引用文本', () => {
    const doc = withScript()
    expect(
      rejects(doc, [{ op: 'connect', from: '制作脚本', to: '1-2 入梦', role: 'reference' }]),
    ).toBe('「制作脚本」 是文本，只能被提示词引用')
    expect(rejects(doc, [{ op: 'connect', from: '小满', to: '1-2 入梦', role: 'text' }])).toBe(
      '「小满」 不是文本卡（.md / .txt），不能以 text 连接',
    )
    const frames = apply(doc, [
      { op: 'connect', from: '小满', to: '1-2 入梦', role: 'first_frame' },
      { op: 'update', id: '1-2 入梦', prompt: '@[制作脚本#1-2 入梦]' },
    ])
    expect(frames.edges.map((e) => e.role).sort()).toEqual(['first_frame', 'text'])
  })

  test('展开的内容不含代码块的围栏行，块内文字与块外标题保留', () => {
    const md = [
      '#### 1-1 视频提示词',
      '',
      '```text',
      '【视频约束】全片台词说中文普通话。',
      '',
      '【剧本内容】0-4秒：推门。',
      '```',
      '',
      '#### 1-2 视频提示词',
      '~~~',
      '握手。',
      '~~~',
      '',
    ].join('\n')
    expect(textReferenceOf(md, '1-1 视频提示词')).toBe(
      '【视频约束】全片台词说中文普通话。\n\n【剧本内容】0-4秒：推门。',
    )
    expect(textReferenceOf(md)).toBe(
      '#### 1-1 视频提示词\n\n【视频约束】全片台词说中文普通话。\n\n【剧本内容】0-4秒：推门。\n\n#### 1-2 视频提示词\n握手。',
    )
  })

  test('标题段落到下一个同级或更高级标题为止；标题列表按出现顺序；引用的文件或标题不存在时报出', () => {
    expect(textReferenceOf(SCRIPT, '1-1 修车铺')).toBe('阿七推门。')
    expect(textReferenceOf(SCRIPT, '细节')).toBe('铜铃响。')
    expect(textReferenceOf(SCRIPT, '1-9')).toBeNull()
    expect(markdownHeadings(SCRIPT).map((h) => `${h.level}${h.title}`)).toEqual([
      '1第1集',
      '21-1 修车铺',
      '21-2 入梦',
      '3细节',
      '21-3 教室',
    ])
    const doc = apply(withScript(), [
      { op: 'update', id: 'a3', prompt: '@[制作脚本#1-9 结尾] @[制作脚本#1-2 入梦]' },
    ])
    expect(textReferenceProblems(doc, 'a3', new Map([['a1', SCRIPT]]))).toEqual([
      '@[制作脚本#1-9 结尾]：文中没有标题「1-9 结尾」',
    ])
    expect(textReferenceProblems(doc, 'a3', new Map())).toEqual([
      '@[制作脚本#1-9 结尾]：文件不存在',
      '@[制作脚本#1-2 入梦]：文件不存在',
    ])
  })

  test('复制卡片时保留引用的标题', () => {
    const doc = apply(withScript(), [{ op: 'update', id: 'a3', prompt: '@[制作脚本#1-2 入梦]' }])
    const copy = apply(doc, copyOps(doc, ['a1', 'a3'], doc, { dx: 0, dy: 500 }, false), ids('c'))
    const pasted = copy.nodes.find((n) => n.id !== 'a3' && n.type === 'generate')
    expect(pasted?.type === 'generate' && pasted.prompt).toMatch(/^@\[c\d#1-2 入梦\]$/)
  })
})
