/**
 * 生成：`generate.ts` 的 `generate_image`、`generate_video`、`generate_audio`、`generateMedia`、`landFiles`，
 * 以及 `index.ts` 中按类别注册的逻辑。
 *
 * 端口使用记录调用的模拟实现：此处验证工具一侧的行为，包括输入的读取、参数的解析、
 * 产物的写入位置、已存在的输出路径在调用接口之前被拒绝、视频任务记录的写入与删除时机。
 */

import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type MediaCall, type MediaCallResult, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  generateImageTool,
  generateMedia,
  generateVideoTool,
  landFiles,
  MEDIA_TOOLS,
  retrieveVideoTool,
} from './generate.ts'
import { registerBuiltinTools } from './index.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 7])

let calls: MediaCall[] = []
let answer: MediaCallResult = { ok: true, provider: 'qwen', model: 'qwen-image-3.0', files: [] }
/** 端口返回之前执行的操作：视频测试在此触发任务号回调。 */
let during: (call: MediaCall) => Promise<void> = async () => {}

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
    requestPermission: async () => ({ allowed: true }),
    media: {
      async generate(call) {
        calls.push(call)
        await during(call)
        return answer
      },
    },
  }
}

const run = (root: string, args: Record<string, unknown>) => generateImageTool.fn(args, ctx(root))

beforeEach(() => {
  calls = []
  during = async () => {}
  answer = {
    ok: true,
    provider: 'qwen',
    model: 'qwen-image-3.0',
    files: [{ bytes: PNG, mime: 'image/png' }],
  }
})

describe('generate_image', () => {
  test('部分返回时仍保存图片，回执同时提示缺少的张数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-partial-'))
    const reason = '部分图片生成失败：内容审核未通过'
    const warning = `请求 4 张，实际返回 1 张；${reason}`
    if (!answer.ok) throw new Error('测试需要成功的图片产物')
    answer = { ...answer, warning: reason }
    const out = await run(root, { prompt: '海报', params_json: '{"n":4}' })
    expect(out.status).toBe('success')
    expect(out.message).toContain(warning)
    expect(out.data).toMatchObject({ warning })
    expect(out.fileChanges).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  test('未提供输出路径时写入 generated/，结果只含路径不含字节', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    const out = await run(root, { prompt: '一只猫', params_json: '{"size":"1024*1536"}' })
    expect(out.status).toBe('success')
    expect(calls[0]).toEqual({
      type: 'image',
      prompt: '一只猫',
      inputs: [],
      params: { size: '1024*1536' },
    })
    const [name] = await readdir(join(root, 'generated'))
    expect(name).toMatch(/^\d{8}-\d{6}\.png$/)
    expect(out.fileChanges).toEqual([{ path: `generated/${name}`, changeType: 'created' }])
    expect(JSON.stringify(out.data)).not.toContain('base64')
    expect(new Uint8Array(await readFile(join(root, 'generated', name!)))).toEqual(PNG)
  })

  /** 产物在会话中只经由回复中的路径链接展示；说明中不写明时，模型会以 Markdown 图片嵌入或多次写出同一路径。 */
  test('三个生成工具的说明均写明产物以路径链接展示、不以图片嵌入', () => {
    for (const tool of Object.values(MEDIA_TOOLS)) {
      expect(tool.description).toContain('回复中以 Markdown 链接写出生成文件的工作区路径')
      expect(tool.description).toContain('不得以 Markdown 图片形式嵌入')
    }
  })

  test('提供参考图时按编辑请求发送，图片按字节与类型读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    await writeFile(join(root, 'cat.jpg'), JPEG)
    await run(root, {
      prompt: '加一顶帽子',
      images: ['cat.jpg'],
      provider: 'qwen',
      model: 'qwen-image-3.0',
    })
    expect(calls[0]?.inputs).toEqual([
      { role: 'reference', bytes: JPEG, mime: 'image/jpeg', path: join(root, 'cat.jpg') },
    ])
    expect(calls[0]?.provider).toBe('qwen')
  })

  /** 生成按次计费：无法写入的调用必须在产生费用之前拒绝。 */
  test('输出路径已存在时不调用接口、不覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    await writeFile(join(root, 'logo.png'), 'old')
    const out = await run(root, { prompt: 'x', output: 'logo.png' })
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('file_exists')
    expect(calls).toHaveLength(0)
    expect(await readFile(join(root, 'logo.png'), 'utf8')).toBe('old')
  })

  test('多张时自第二张起追加序号，重名时序号继续递增', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    await mkdir(join(root, 'out'))
    await writeFile(join(root, 'out', 'a-2.png'), 'taken')
    answer = {
      ok: true,
      provider: 'qwen',
      model: 'qwen-image-3.0',
      files: [
        { bytes: PNG, mime: 'image/png' },
        { bytes: PNG, mime: 'image/png' },
      ],
    }
    const out = await run(root, { prompt: 'x', output: 'out/a.png' })
    expect(out.fileChanges?.map((c) => c.path)).toEqual(['out/a.png', 'out/a-3.png'])
    expect(await readFile(join(root, 'out', 'a-2.png'), 'utf8')).toBe('taken')
  })

  test('参数、指定模型或参考图类型不合法时不调用接口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    await writeFile(join(root, 'a.txt'), 'x')
    expect((await run(root, { prompt: 'x', params_json: '[1]' })).errorKind).toBe(
      'invalid_tool_arguments',
    )
    expect((await run(root, { prompt: 'x', provider: 'qwen' })).errorKind).toBe(
      'invalid_tool_arguments',
    )
    expect((await run(root, { prompt: 'x', images: ['a.txt'] })).errorKind).toBe(
      'invalid_tool_arguments',
    )
    expect(calls).toHaveLength(0)
  })

  test('端口的失败消息原样交给模型，工作区不留下文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    answer = { ok: false, message: '没有发出请求：\n- 参数 n 的值 9 不合法：范围 1–6' }
    const out = await run(root, { prompt: 'x' })
    expect(out.status).toBe('failure')
    expect(out.message).toContain('范围 1–6')
    expect(await readdir(root)).toEqual([])
  })
})

describe('按类别注册', () => {
  test('没有图像模型时不注册图像生成工具', () => {
    const none = new ToolRegistry()
    registerBuiltinTools(none)
    expect(none.has('generate_image')).toBe(false)
    const image = new ToolRegistry()
    registerBuiltinTools(image, { media: ['image'] })
    expect(image.has('generate_image')).toBe(true)
  })
})

test('输出路径未写扩展名时按实际格式补全', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
  const out = await run(root, { prompt: 'x', output: 'generated/panda' })
  expect(out.fileChanges?.map((c) => c.path)).toEqual(['generated/panda.png'])
})

describe('generate_video', () => {
  const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
  const video = (root: string, args: Record<string, unknown>) =>
    generateVideoTool.fn(args, ctx(root))
  const submitted = async (call: MediaCall) => {
    await call.onTask?.({ taskId: 'task-1', provider: 'qwen', model: 'wan3.0-video' })
  }

  test('输入按用途读取；提交即写入任务记录，落盘成功后删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    await writeFile(join(root, 'a.png'), PNG)
    await writeFile(join(root, 'b.png'), PNG)
    answer = {
      ok: true,
      provider: 'qwen',
      model: 'wan3.0-video',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    }
    let recordDuring = ''
    during = async (call) => {
      await submitted(call)
      recordDuring = await readFile(join(root, 'clips', 'bloom.task.json'), 'utf8')
    }
    const out = await video(root, {
      prompt: '花开',
      first_frame: 'a.png',
      last_frame: 'b.png',
      params_json: '{"resolution":"480P"}',
      output: 'clips/bloom',
    })
    expect(calls[0]?.inputs.map((i) => i.role)).toEqual(['first_frame', 'last_frame'])
    expect(JSON.parse(recordDuring)).toMatchObject({
      provider: 'qwen',
      model: 'wan3.0-video',
      taskId: 'task-1',
      output: 'clips/bloom',
    })
    expect(out.fileChanges?.map((c) => c.path)).toEqual(['clips/bloom.mp4'])
    expect((await readdir(join(root, 'clips'))).sort()).toEqual(['bloom.mp4'])
  })

  /** 远端任务仍存在（如等待超时）：保留记录，消息中告知模型取回方式。 */
  test('可接续的失败保留任务记录；终态失败删除记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    during = submitted
    answer = { ok: false, message: '等待超过 20 分钟仍未完成', pendingTaskId: 'task-1' }
    const pending = await video(root, { prompt: '海浪', output: 'wave' })
    expect(pending.message).toContain('wave.task.json')
    expect(pending.message).toContain('retrieve_video')
    expect(await readdir(root)).toEqual(['wave.task.json'])

    answer = { ok: false, message: '远端任务失败：不合规' }
    const failed = await video(root, { prompt: '海浪', output: 'wave2' })
    expect(failed.status).toBe('failure')
    expect(await readdir(root)).toEqual(['wave.task.json'])
  })

  test('按任务记录取回：不重新提交，写入记录中的输出位置，取回后删除记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    await writeFile(
      join(root, 'wave.task.json'),
      JSON.stringify({ provider: 'qwen', model: 'wan3.0-video', taskId: 'task-7', output: 'wave' }),
    )
    answer = {
      ok: true,
      provider: 'qwen',
      model: 'wan3.0-video',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    }
    const out = await retrieveVideoTool.fn({ path: 'wave.task.json' }, ctx(root))
    expect(out.status).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'qwen',
      model: 'wan3.0-video',
      resumeTaskId: 'task-7',
    })
    expect(out.fileChanges?.map((c) => c.path)).toEqual(['wave.mp4'])
    expect(await readdir(root)).toEqual(['wave.mp4'])
  })

  test('取回必须提供任务路径，生成必须提供提示词；记录无效时不提交生成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    const registry = new ToolRegistry()
    registerBuiltinTools(registry, { media: ['video'] })
    expect(generateVideoTool.parameters.properties).not.toHaveProperty('resume')
    for (const name of ['generate_video', 'retrieve_video']) {
      expect(await registry.execute(name, {}, ctx(root))).toMatchObject({
        status: 'failure',
        executed: false,
        errorKind: 'invalid_tool_arguments',
      })
    }
    await writeFile(join(root, 'invalid.task.json'), '{}')
    for (const path of ['invalid.task.json', 'missing.task.json']) {
      expect((await registry.execute('retrieve_video', { path }, ctx(root))).status).toBe('failure')
    }
    expect(calls).toEqual([])
  })

  test('参考视频必须是视频文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    await writeFile(join(root, 'a.png'), PNG)
    const out = await video(root, { prompt: 'x', videos: ['a.png'] })
    expect(out.errorKind).toBe('invalid_tool_arguments')
    expect(calls).toHaveLength(0)
  })
})

test('只配置视频模型时只注册视频生成工具', () => {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, { media: ['video'] })
  expect(registry.has('generate_video')).toBe(true)
  expect(registry.has('retrieve_video')).toBe(true)
  expect(registry.has('generate_image')).toBe(false)
  const imagesOnly = new ToolRegistry()
  registerBuiltinTools(imagesOnly, { media: ['image'] })
  expect(imagesOnly.has('retrieve_video')).toBe(false)
})

describe('generate_audio', () => {
  test('文本作为 prompt 交给端口，产物按格式补全扩展名', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gena-'))
    const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46])
    answer = {
      ok: true,
      provider: 'qwen',
      model: 'qwen3-tts-flash',
      files: [{ bytes: WAV, mime: 'audio/wav' }],
    }
    const { generateAudioTool } = await import('./generate.ts')
    const out = await generateAudioTool.fn(
      { text: '你好', params_json: '{"voice":"Cherry"}', output: 'voice/hello' },
      ctx(root),
    )
    expect(calls[0]).toMatchObject({
      type: 'audio',
      prompt: '你好',
      inputs: [],
      params: { voice: 'Cherry' },
    })
    expect(out.fileChanges?.map((c) => c.path)).toEqual(['voice/hello.wav'])
  })
})

/** 端到端测试中模型请求 `.mp3`，百炼返回 WAV：按请求原样落盘时文件名与内容不一致。 */
test('请求的扩展名与实际格式不符时改为实际格式的扩展名，无法识别的扩展名原样保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qy-gena-'))
  const { generateAudioTool } = await import('./generate.ts')
  answer = {
    ok: true,
    provider: 'qwen',
    model: 'qwen3-tts-flash',
    files: [{ bytes: new Uint8Array([0x52]), mime: 'audio/wav' }],
  }
  const wav = await generateAudioTool.fn({ text: '晚安', output: 'goodnight.mp3' }, ctx(root))
  expect(wav.fileChanges?.map((c) => c.path)).toEqual(['goodnight.wav'])
  const kept = await generateAudioTool.fn({ text: '晚安', output: 'raw.bin' }, ctx(root))
  expect(kept.fileChanges?.map((c) => c.path)).toEqual(['raw.bin'])
  answer = {
    ok: true,
    provider: 'qwen',
    model: 'qwen-image-3.0',
    files: [{ bytes: JPEG, mime: 'image/jpeg' }],
  }
  const jpeg = await run(root, { prompt: 'x', output: 'cat.jpeg' })
  expect(jpeg.fileChanges?.map((c) => c.path)).toEqual(['cat.jpeg'])
})

describe('generateMedia / landFiles', () => {
  test('同名产物并发落盘各自保留原始字节，不删除其他写入者的临时文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-concurrent-'))
    await mkdir(join(root, 'generated'))
    const part = join(root, 'generated', 'same.png.part')
    await writeFile(part, '正在由其他调用写入')
    const bytes = Array.from({ length: 12 }, (_, i) => new Uint8Array([...PNG, i]))
    const outputs = await Promise.all(
      bytes.map((data) => landFiles(root, [{ bytes: data, mime: 'image/png' }], 'generated/same')),
    )
    expect(new Set(outputs.map((files) => files[0]!.path)).size).toBe(12)
    for (const [i, files] of outputs.entries()) {
      expect(new Uint8Array(await readFile(join(root, files[0]!.path)))).toEqual(bytes[i]!)
    }
    expect(await readFile(part, 'utf8')).toBe('正在由其他调用写入')
    expect(
      (await readdir(join(root, 'generated'))).filter((name) => name.endsWith('.part')),
    ).toEqual(['same.png.part'])
  })
  const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])

  test('同一秒内并发两次未指定输出路径的视频生成，各自拥有独立的任务记录与产物', async () => {
    setSystemTime(new Date(2026, 8, 29, 10, 10, 10))
    try {
      const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
      answer = {
        ok: true,
        provider: 'qwen',
        model: 'wan',
        files: [{ bytes: MP4, mime: 'video/mp4' }],
      }
      let submitted = 0
      let bothSubmitted: () => void = () => {}
      const barrier = new Promise<void>((resolve) => {
        bothSubmitted = resolve
      })
      let records: string[] = []
      during = async (call) => {
        await call.onTask?.({ taskId: `task-${++submitted}`, provider: 'qwen', model: 'wan' })
        if (submitted === 2) {
          const dir = join(root, 'generated')
          records = await Promise.all(
            (await readdir(dir)).map((f) => readFile(join(dir, f), 'utf8')),
          )
          bothSubmitted()
        }
        await barrier
      }
      const video = (args: Record<string, unknown>) => generateVideoTool.fn(args, ctx(root))
      const [a, b] = await Promise.all([video({ prompt: '一' }), video({ prompt: '二' })])
      expect(records.map((r) => JSON.parse(r).taskId).sort()).toEqual(['task-1', 'task-2'])
      expect(a.status).toBe('success')
      expect(b.status).toBe('success')
      expect((await readdir(join(root, 'generated'))).sort()).toEqual([
        '20260929-101010-2.mp4',
        '20260929-101010.mp4',
      ])
    } finally {
      setSystemTime()
    }
  })

  test('generateMedia 按路径读取输入，取得任务号时回报记录的工作区路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    await writeFile(join(root, 'a.png'), PNG)
    const seen: string[] = []
    const outcome = await generateMedia({
      roots: root,
      media: {
        async generate(call) {
          await call.onTask?.({ taskId: 't', provider: 'ark', model: 'seedance' })
          return { ok: false, message: '等待超时', pendingTaskId: 't' }
        },
      },
      signal: new AbortController().signal,
      type: 'video',
      prompt: '走',
      inputs: [{ role: 'first_frame', path: 'a.png' }],
      params: {},
      output: 'clips/walk',
      onTask: ({ record }) => {
        seen.push(record)
      },
    })
    expect(seen).toEqual(['clips/walk.task.json'])
    expect(outcome).toEqual({
      ok: false,
      executed: true,
      message: '等待超时',
      record: 'clips/walk.task.json',
    })
  })

  test('art：当前页面（HTML）作为参考输入读取为 text/html，产物写入 generated/<时间>.html；其他类别不接受 HTML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-art-'))
    await mkdir(join(root, 'generated'))
    await writeFile(join(root, 'generated', '白模.html'), '<html></html>')
    await writeFile(join(root, 'a.png'), PNG)
    const seen: MediaCall[] = []
    const media = {
      async generate(call: MediaCall): Promise<MediaCallResult> {
        seen.push(call)
        return {
          ok: true,
          provider: 'relay',
          model: 'chat',
          files: [{ bytes: new TextEncoder().encode('<html>新</html>'), mime: 'text/html' }],
        }
      },
    }
    const inputs = [
      { role: 'reference' as const, path: 'generated/白模.html' },
      { role: 'reference' as const, path: 'a.png' },
    ]
    const common = { roots: root, media, signal: new AbortController().signal, params: {}, inputs }
    const outcome = await generateMedia({ ...common, type: 'art', prompt: '降低镜头' })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(seen[0]!.inputs.map((i) => i.mime)).toEqual(['text/html', 'image/png'])
    expect(outcome.files[0]!.path).toMatch(/^generated\/\d{8}-\d{6}\.html$/)
    expect(await readFile(join(root, outcome.files[0]!.path), 'utf8')).toBe('<html>新</html>')

    const refused = await generateMedia({ ...common, type: 'image', prompt: '海报' })
    expect(refused).toMatchObject({ ok: false, executed: false })
    expect(seen).toHaveLength(1)
  })

  test('landFiles 不覆盖已有文件，返回工作区相对路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-land-'))
    await mkdir(join(root, 'generated'))
    await writeFile(join(root, 'generated', 'v_尾帧.png'), 'taken')
    const landed = await landFiles(root, [{ bytes: PNG, mime: 'image/png' }], 'generated/v_尾帧')
    expect(landed).toEqual([
      { path: 'generated/v_尾帧-2.png', mime: 'image/png', bytes: PNG.length },
    ])
  })
})

describe('generate_video 的参考音频', () => {
  test('audios 按 wav / mp3 读取、用途为 audio；非音频文件在调用接口之前被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gena-'))
    await writeFile(join(root, 'a.png'), PNG)
    await writeFile(join(root, 'v.wav'), 'RIFF')
    await writeFile(join(root, 'v.txt'), 'x')
    answer = { ok: false, message: '停在这里' }
    await generateVideoTool.fn({ prompt: '说话', images: ['a.png'], audios: ['v.wav'] }, ctx(root))
    expect(calls[0]?.inputs.map((i) => [i.role, i.mime])).toEqual([
      ['reference', 'image/png'],
      ['audio', 'audio/wav'],
    ])
    const bad = await generateVideoTool.fn(
      { prompt: '说话', images: ['a.png'], audios: ['v.txt'] },
      ctx(root),
    )
    expect(bad.errorKind).toBe('invalid_tool_arguments')
    expect(bad.message).toContain('wav / mp3 音频')
    expect(calls).toHaveLength(1)
  })
})
