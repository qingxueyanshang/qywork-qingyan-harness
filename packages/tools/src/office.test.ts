/**
 * `office.ts` 的 `officeTool`：请求组装、读后再写的冲突检查、结果映射（写入记录、文件变更、图片）、
 * worker 没有写出结果时以 cleanup 再起一次；`index.ts` 按通道注册的那一条；
 * `files.ts` 遇到 Office 文件与没有文字层的 PDF 时的指路。
 *
 * worker 用 `office-worker.test-helper.ts`（由 Bun 执行）代替 Python：这里验的是工具这一侧，
 * worker 本身的行为由 `packages/runtime/office/tests` 与真机验收覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type OfficePort, openBatchBudget, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { readFileTool } from './files.ts'
import { registerBuiltinTools } from './index.ts'
import { officeTool } from './office.ts'

const PORT: OfficePort = {
  python: process.execPath,
  worker: join(import.meta.dir, 'office-worker.test-helper.ts'),
  apps: {
    docx: { available: true, reason: '' },
    xlsx: { available: true, reason: '' },
    pptx: { available: true, reason: '' },
  },
  enabled: () => true,
}

function ctx(root: string, office: OfficePort | null = PORT): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), 100_000),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    ...(office ? { office } : {}),
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qy-office-'))
  await writeFile(join(root, 'make.py'), 'print(1)\n')
  return root
}

/** 一页空白、没有任何文字的最小 PDF。 */
function blankPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

async function requests(root: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, '.tmp', 'office', 'requests.jsonl'), 'utf8').catch(
    () => '',
  )
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('office write', () => {
  test('新建输出：回执带页数与检查，文件变更为 created，之后再写同一路径不需要先读', async () => {
    const root = await workspace()
    const c = ctx(root)
    const first = await officeTool.fn(
      { action: 'write', script: 'make.py', outputs: ['out/report.docx'] },
      c,
    )
    expect(first.status).toBe('success')
    expect(first.message).toContain('out/report.docx：已写入（3 页）')
    expect(first.message).toContain('[warning] 预期 无')
    expect(first.message).toContain('脚本输出')
    expect(first.fileChanges).toEqual([{ path: 'out/report.docx', changeType: 'created' }])

    const second = await officeTool.fn(
      { action: 'write', script: 'make.py', outputs: ['out/report.docx'] },
      c,
    )
    expect(second.status).toBe('success')
    expect(second.fileChanges).toEqual([{ path: 'out/report.docx', changeType: 'modified' }])
    const [, again] = await requests(root)
    const expected = (again?.outputs as { expected_sha256: string }[])[0]?.expected_sha256
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
  })

  test('已存在而没读取过的输出：不起 worker，直接拒绝', async () => {
    const root = await workspace()
    await writeFile(join(root, 'old.xlsx'), 'user data')
    const res = await officeTool.fn(
      { action: 'write', script: 'make.py', outputs: ['old.xlsx'] },
      ctx(root),
    )
    expect(res.status).toBe('failure')
    expect(res.executed).toBe(false)
    expect(res.message).toContain('先用 office(action=read) 读取')
    expect(await requests(root)).toEqual([])
    expect(await readFile(join(root, 'old.xlsx'), 'utf8')).toBe('user data')
  })

  test('read 之后再写：预期哈希就是读到的那一版', async () => {
    const root = await workspace()
    await writeFile(join(root, 'deck.pptx'), 'v1')
    const c = ctx(root)
    const read = await officeTool.fn({ action: 'read', path: 'deck.pptx' }, c)
    expect(read.status).toBe('success')
    expect(read.message).toContain('段落 1：标题')
    const res = await officeTool.fn(
      { action: 'write', script: 'make.py', outputs: ['deck.pptx'], export_pdf: true },
      c,
    )
    expect(res.status).toBe('success')
    const write = (await requests(root)).find((r) => r.action === 'write')
    const sha = new Bun.CryptoHasher('sha256').update('v1').digest('hex')
    expect((write?.outputs as { expected_sha256: string }[])[0]?.expected_sha256).toBe(sha)
    expect(res.fileChanges).toContainEqual({ path: 'deck.pdf', changeType: 'created' })
  })

  test('worker 没有写出结果：以 cleanup 再起一次，回执写明残留处理', async () => {
    const root = await workspace()
    await writeFile(join(root, 'crash.py'), 'raise SystemExit(1)\n')
    const res = await officeTool.fn(
      { action: 'write', script: 'crash.py', outputs: ['a.docx'] },
      ctx(root),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('残留处理：已结束 1 个本次调用的办公软件进程')
    expect((await requests(root)).map((r) => r.action)).toEqual(['write', 'cleanup'])
  })

  test('脚本不是 .py、输出不是 Office 文件：参数错误，不起 worker', async () => {
    const root = await workspace()
    const bad1 = await officeTool.fn(
      { action: 'write', script: 'make.sh', outputs: ['a.docx'] },
      ctx(root),
    )
    const bad2 = await officeTool.fn(
      { action: 'write', script: 'make.py', outputs: ['a.txt'] },
      ctx(root),
    )
    expect(bad1.errorKind).toBe('invalid_args')
    expect(bad2.errorKind).toBe('invalid_args')
    expect(await requests(root)).toEqual([])
  })
})

describe('office view 与 guide', () => {
  test('view 返回图片字节与页标签，请求带当前文件哈希', async () => {
    const root = await workspace()
    await writeFile(join(root, 'r.docx'), 'doc')
    const res = await officeTool.fn({ action: 'view', path: 'r.docx', pages: ['2'] }, ctx(root))
    expect(res.status).toBe('success')
    expect(res.message).toContain('第 2 页')
    const images = (res.data as { images: { data: string; mime: string }[] }).images
    expect(images).toHaveLength(1)
    expect(images[0]?.mime).toBe('image/png')
    const view = (await requests(root)).find((r) => r.action === 'view')
    expect(view?.expected_sha256).toBe(new Bun.CryptoHasher('sha256').update('doc').digest('hex'))
  })

  test('view 收 PDF 原件，read 不收', async () => {
    const root = await workspace()
    await writeFile(join(root, 'scan.pdf'), 'pdf')
    const view = await officeTool.fn({ action: 'view', path: 'scan.pdf' }, ctx(root))
    expect(view.status).toBe('success')
    expect((await requests(root)).find((r) => r.action === 'view')?.path).toBe(
      join(root, 'scan.pdf'),
    )
    const read = await officeTool.fn({ action: 'read', path: 'scan.pdf' }, ctx(root))
    expect(read.status).toBe('failure')
    expect(read.errorKind).toBe('invalid_args')
    expect((await requests(root)).filter((r) => r.action === 'read')).toEqual([])
  })

  test('模型不收图片时 view 直接拒绝', async () => {
    const root = await workspace()
    await writeFile(join(root, 'r.docx'), 'doc')
    const res = await officeTool.fn(
      { action: 'view', path: 'r.docx' },
      { ...ctx(root), vision: false },
    )
    expect(res.status).toBe('failure')
    expect(await requests(root)).toEqual([])
  })

  test('开关在调用前现判：关掉之后的调用不起 worker', async () => {
    const root = await workspace()
    const res = await officeTool.fn(
      { action: 'guide', format: 'docx' },
      ctx(root, { ...PORT, enabled: () => false }),
    )
    expect(res.status).toBe('failure')
    expect(res.executed).toBe(false)
    expect(await requests(root)).toEqual([])
  })

  test('guide 返回该格式的说明', async () => {
    const root = await workspace()
    const res = await officeTool.fn({ action: 'guide', format: 'xlsx' }, ctx(root))
    expect(res.message).toBe('做法：xlsx')
  })
})

describe('注册与指路', () => {
  test('有 Office 通道才注册 office', () => {
    const without = new ToolRegistry()
    registerBuiltinTools(without, {})
    expect(without.has('office')).toBe(false)
    const withOffice = new ToolRegistry()
    registerBuiltinTools(withOffice, { office: true })
    expect(withOffice.has('office')).toBe(true)
  })

  test('read_file 读 Office 文件：有 office 时指向 office(action=read)，没有时照旧', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.docx'), new Uint8Array([0x50, 0x4b, 0, 0, 1]))
    const withOffice = await readFileTool.fn({ path: 'a.docx' }, ctx(root))
    expect(withOffice.message).toContain('office(action=read)')
    const withoutOffice = await readFileTool.fn({ path: 'a.docx' }, ctx(root, null))
    expect(withoutOffice.message).toContain('run_command')
  })

  test('read_file 读没有文字层的 PDF：能看页面时指向 office(action=view)，否则写明没有这个能力', async () => {
    const root = await workspace()
    await writeFile(join(root, 'scan.pdf'), blankPdf())
    const viewable = await readFileTool.fn({ path: 'scan.pdf' }, ctx(root))
    expect(viewable.status).toBe('failure')
    expect(viewable.message).toContain('office(action=view)')
    for (const c of [
      ctx(root, null),
      { ...ctx(root), vision: false as const },
      ctx(root, { ...PORT, enabled: () => false }),
    ]) {
      const res = await readFileTool.fn({ path: 'scan.pdf' }, c)
      expect(res.status).toBe('failure')
      expect(res.message).not.toContain('office')
      expect(res.message).toContain('没有文字层')
    }
  })
})

describe('read_file 读视频：不收原生视频时按时间抽帧', () => {
  async function clip(): Promise<string> {
    const root = await workspace()
    await writeFile(join(root, 'clip.mp4'), new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))
    return root
  }

  /** 帧作为图片返回，说明原样交给模型；start / end 传到 worker，回执里看得到。 */
  test('收图片、不收视频：经 worker 抽帧，帧作为图片返回', async () => {
    const root = await clip()
    const res = await readFileTool.fn(
      { path: 'clip.mp4', start: 2, end: 8 },
      { ...ctx(root), video: false, vision: true },
    )
    expect(res.status).toBe('success')
    const images = (res.data as { images: { mime: string }[] }).images
    expect(images).toHaveLength(2)
    expect(res.message).toBe('区间 2–8；声音没有处理')
    expect(res.data).not.toHaveProperty('videos')
    // 帧已经定格进回执，调用目录里那批图要删掉，不在工作区里越积越多。
    const calls = await readdir(join(root, '.tmp', 'office'))
    for (const call of calls.filter((c) => c !== 'cache' && !c.endsWith('.jsonl'))) {
      expect(await readdir(join(root, '.tmp', 'office', call))).not.toContain('frames')
    }
  })

  /**
   * 收原生视频的模型：接口能上传就交路径；不能上传又超过常驻上限时同样抽帧，并说明原因，
   * 判据与发送时的 `videoDelivery` 同一条。
   */
  test('收原生视频但太大：能上传交路径，不能上传改为抽帧', async () => {
    const root = await workspace()
    await writeFile(join(root, 'big.mp4'), new Uint8Array(5 * 1024 * 1024))
    const upload = await readFileTool.fn(
      { path: 'big.mp4' },
      { ...ctx(root), video: true, videoUploadAbove: 2 * 1024 * 1024 },
    )
    expect(upload.data).toEqual({
      videos: [{ path: await realpath(join(root, 'big.mp4')), mime: 'video/mp4' }],
    })
    const inline = await readFileTool.fn({ path: 'big.mp4' }, { ...ctx(root), video: true })
    expect(inline.status).toBe('success')
    expect(inline.message.startsWith('这段视频 5.0 MB')).toBe(true)
    expect(inline.message).toContain('改为按时间抽帧')
    expect((inline.data as { images: unknown[] }).images).toHaveLength(2)
  })

  test('区间不成立时不起 worker，直接说原因', async () => {
    const root = await clip()
    const res = await readFileTool.fn(
      { path: 'clip.mp4', start: 5, end: 5 },
      { ...ctx(root), video: false, vision: true },
    )
    expect(res).toEqual({ status: 'failure', message: 'end 必须大于 start' })
  })

  test('收原生视频的模型照旧交出路径，不抽帧', async () => {
    const root = await clip()
    const res = await readFileTool.fn({ path: 'clip.mp4' }, { ...ctx(root), video: true })
    expect(res.status).toBe('success')
    expect(res.data).toEqual({
      videos: [{ path: await realpath(join(root, 'clip.mp4')), mime: 'video/mp4' }],
    })
  })

  test('没有 Office 环境，或模型连图片也不收：回绝并带下一步', async () => {
    const root = await clip()
    const noOffice = await readFileTool.fn(
      { path: 'clip.mp4' },
      { ...ctx(root, null), video: false, vision: true },
    )
    expect(noOffice.status).toBe('failure')
    expect(noOffice.message).toContain('不接受原生视频')
    expect(noOffice.message).toContain('不要再读')
    const noImages = await readFileTool.fn(
      { path: 'clip.mp4' },
      { ...ctx(root), video: false, vision: false },
    )
    expect(noImages.message).toContain('既不接受视频也不接受图片')
  })
})
