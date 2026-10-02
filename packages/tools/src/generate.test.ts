/**
 * 生成：`generate.ts` 的 `generate_image`、`generate_video`、`generate_audio`、`generateMedia`、`landFiles`，
 * 以及 `index.ts` 里按类别注册的那一条。
 *
 * 端口用一个记录调用的假实现：这里验的是工具这一侧的事——输入怎么读、参数怎么解析、
 * 产物落在哪、已存在的输出路径在调接口之前就拒绝、视频任务记录何时写何时删。
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
} from './generate.ts'
import { registerBuiltinTools } from './index.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 7])

let calls: MediaCall[] = []
let answer: MediaCallResult = { ok: true, provider: 'qwen', model: 'qwen-image-3.0', files: [] }
/** 端口返回之前做的事：视频测试在这里触发任务号回调。 */
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
  test('部分返回仍保存图片，回执同时带上缺少张数的提示', async () => {
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

  test('没给输出路径时写到 generated/，结果只带路径不带字节', async () => {
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

  /** 产物在会话里只经回复中的路径链接展示；说明里不写明时，模型会以 Markdown 图片嵌入或把路径写出多次。 */
  test('三个生成工具的说明都写明产物以路径链接展示、不以图片嵌入', () => {
    for (const tool of Object.values(MEDIA_TOOLS)) {
      expect(tool.description).toContain('回复中以 Markdown 链接写出生成文件的工作区路径')
      expect(tool.description).toContain('不得以 Markdown 图片形式嵌入')
    }
  })

  test('给了参考图就按修改发，图按字节与类型读好', async () => {
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

  /** 生成按次计费：写不进去的调用在花钱之前就要挡掉。 */
  test('输出路径已存在时不调接口、不覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    await writeFile(join(root, 'logo.png'), 'old')
    const out = await run(root, { prompt: 'x', output: 'logo.png' })
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('file_exists')
    expect(calls).toHaveLength(0)
    expect(await readFile(join(root, 'logo.png'), 'utf8')).toBe('old')
  })

  test('多张时第二张起加序号，撞名继续往后加', async () => {
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

  test('参数、模型点名与参考图类型不对时不调接口', async () => {
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

  test('端口的失败消息原样交给大模型，工作区不留文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-gen-'))
    answer = { ok: false, message: '没有发出请求：\n- 参数 n 的值 9 不合法：范围 1–6' }
    const out = await run(root, { prompt: 'x' })
    expect(out.status).toBe('failure')
    expect(out.message).toContain('范围 1–6')
    expect(await readdir(root)).toEqual([])
  })
})

describe('按类别注册', () => {
  test('没有图像模型时不注册出图工具', () => {
    const none = new ToolRegistry()
    registerBuiltinTools(none)
    expect(none.has('generate_image')).toBe(false)
    const image = new ToolRegistry()
    registerBuiltinTools(image, { media: ['image'] })
    expect(image.has('generate_image')).toBe(true)
  })
})

test('输出路径没写扩展名时按实际格式补上', async () => {
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

  test('输入按用途读好；提交即写任务记录，成功落盘后删掉', async () => {
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

  /** 远端还在（等待超时等）：记录留着，消息告诉大模型怎么取回。 */
  test('可接续的失败留下任务记录；终态失败删掉', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    during = submitted
    answer = { ok: false, message: '等待超过 20 分钟仍未完成', pendingTaskId: 'task-1' }
    const pending = await video(root, { prompt: '海浪', output: 'wave' })
    expect(pending.message).toContain('wave.task.json')
    expect(pending.message).toContain('resume')
    expect(await readdir(root)).toEqual(['wave.task.json'])

    answer = { ok: false, message: '远端任务失败：不合规' }
    const failed = await video(root, { prompt: '海浪', output: 'wave2' })
    expect(failed.status).toBe('failure')
    expect(await readdir(root)).toEqual(['wave.task.json'])
  })

  test('按任务记录取回：不再提交，落到记录里的输出位置，取回后删掉记录', async () => {
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
    const out = await video(root, { resume: 'wave.task.json' })
    expect(calls[0]).toMatchObject({
      provider: 'qwen',
      model: 'wan3.0-video',
      resumeTaskId: 'task-7',
    })
    expect(out.fileChanges?.map((c) => c.path)).toEqual(['wave.mp4'])
    expect(await readdir(root)).toEqual(['wave.mp4'])
  })

  test('参考视频必须是视频文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-genv-'))
    await writeFile(join(root, 'a.png'), PNG)
    const out = await video(root, { prompt: 'x', videos: ['a.png'] })
    expect(out.errorKind).toBe('invalid_tool_arguments')
    expect(calls).toHaveLength(0)
  })
})

test('只配了视频模型时只注册出视频的工具', () => {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, { media: ['video'] })
  expect(registry.has('generate_video')).toBe(true)
  expect(registry.has('generate_image')).toBe(false)
})

describe('generate_audio', () => {
  test('文字按 prompt 交给端口，产物按格式补扩展名', async () => {
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

/** 端到端里模型要了 `.mp3`，百炼回的是 WAV：按请求原样落盘的话文件名与内容对不上。 */
test('请求的扩展名与实际格式不符时换成实际格式的，不认识的扩展名原样保留', async () => {
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
  const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])

  test('同一秒并发两次不给输出路径的视频生成，各有各的任务记录与产物', async () => {
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

  test('generateMedia 按路径读输入，任务号到手时回报记录的工作区路径', async () => {
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
  test('audios 按 wav / mp3 读好、用途为 audio；不是音频的在调接口之前退回', async () => {
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
