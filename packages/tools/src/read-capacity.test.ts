/**
 * `read_file` 按本次决策的投递额度交付文本。
 *
 * 覆盖范围：`files.ts` 的 `read_file` 文本分支（整份优先、部分投递与续读位置、单行超出额度时
 * 经 `sink.ts` 的 `deliverReadable` 存入正文库并按字节续读）与读取记录的登记时机（失败的读取
 * 不能作为 `edit_file` 的前置条件）。
 *
 * 窗口与密度采用 DeepSeek V4.1 Flash（`deepseek-flash`）的模型目录规格：原始失败发生在 1M 窗口。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openBatchBudget,
  outcomeTokens,
  type SinkPort,
  softLimit,
  type ToolContext,
  ToolRegistry,
} from '@qywork/agent'
import { lookupModel } from '@qywork/ai'
import { registerBuiltinTools } from './index.ts'
import { MIN_DELIVERY_BYTES } from './sink.ts'

const flash = lookupModel('deepseek-flash', 'openai_chat_completions')
const MARKER = 'END_OF_FILE_MARKER'

function fakeSink(): SinkPort & { landed: Uint8Array[] } {
  const landed: Uint8Array[] = []
  return {
    landed,
    land(input) {
      landed.push(input.body)
      return { resourceId: `rs_${landed.length}`, contentHash: 'sha:x' }
    },
    read: () => null,
    stat: () => null,
  }
}

function ctx(root: string, room: number, sink: SinkPort | null = null): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: flash.id,
    contextWindow: flash.contextWindow,
    density: flash.density,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), room),
    sink,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

function registry(): ToolRegistry {
  const r = new ToolRegistry()
  registerBuiltinTools(r)
  return r
}

/** 超过 2000 行、三万余 token 的源码文件，末行为标记。 */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qy-read-capacity-'))
  const lines = Array.from({ length: 2400 }, (_, i) => `const v${i} = f(${i})`)
  await writeFile(join(root, 'big.ts'), [...lines, MARKER].join('\n'))
  return root
}

const contentOf = (r: { data?: Record<string, unknown> }) => (r.data as { content: string }).content

describe('整份优先', () => {
  /** 原始失败形状：三万余 token 的整份读取被 30,000 token 的单次上限拒绝。 */
  test('1M 窗口下超过 2000 行、三万余 token 的文件一次完整读取', async () => {
    const root = await workspace()
    const c = ctx(root, softLimit(flash) - 20_000)
    const r = await registry().execute('read_file', { path: 'big.ts' }, c)
    expect(r.status).toBe('success')
    expect(outcomeTokens(r, flash.density)).toBeGreaterThan(30_000)
    expect(contentOf(r).endsWith(`2401\t${MARKER}`)).toBe(true)
    expect(r.data?.nextOffset).toBeUndefined()
    expect(r.message).toContain('2401 行')
  })

  test('显式范围不被扩大为整份', async () => {
    const root = await workspace()
    const r = await registry().execute(
      'read_file',
      { path: 'big.ts', offset: 10, limit: 5 },
      ctx(root, 1_000_000),
    )
    expect(contentOf(r).split('\n')).toHaveLength(5)
    expect(contentOf(r).startsWith('10\t')).toBe(true)
  })
})

describe('无法容纳时部分投递并给出续读位置', () => {
  /** 占用接近软阈值（790K / 800K）时余量只有 10K：投递可容纳的部分，不拒绝。 */
  test('投递可容纳的最长行前缀，沿 nextOffset 续读可逐行拼回整份', async () => {
    const root = await workspace()
    const r = registry()
    const first = await r.execute('read_file', { path: 'big.ts' }, ctx(root, 10_000))
    expect(first.status).toBe('success')
    expect(outcomeTokens(first, flash.density)).toBeLessThanOrEqual(10_000)
    const next = first.data?.nextOffset as number
    expect(next).toBeGreaterThan(1)
    expect(first.message).toContain(`offset=${next}`)

    // 下一次决策重新计算额度。
    const rest = await r.execute(
      'read_file',
      { path: 'big.ts', offset: next },
      ctx(root, 1_000_000),
    )
    const whole = await r.execute('read_file', { path: 'big.ts' }, ctx(root, 1_000_000))
    expect(`${contentOf(first)}\n${contentOf(rest)}`).toBe(contentOf(whole))
  })

  test('单行无法容纳：该行存储一次，投递开头部分并给出按字节续读的位置与下一行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-read-line-'))
    const line = `${'中文正文🙂'.repeat(20_000)}${MARKER}`
    await writeFile(join(root, 'one.txt'), `${line}\nsecond`)
    const sink = fakeSink()
    const r = await registry().execute('read_file', { path: 'one.txt' }, ctx(root, 5_000, sink))
    expect(r.status).toBe('success')
    const head = contentOf(r).replace(/^1\t/, '')
    expect(line.startsWith(head)).toBe(true)
    expect(head.length).toBeLessThan(line.length)
    expect(new TextDecoder().decode(sink.landed[0]!)).toBe(line)
    expect(r.message).toContain('read_resource')
    expect(r.message).toContain(`offset=${new TextEncoder().encode(head).byteLength}`)
    expect(r.message).toContain('offset=2')
    expect(r.resources?.[0]?.resourceId).toBeTruthy()
  })
})

describe('失败的读取不计为已读', () => {
  /** 报告失败的回合不产出正文；余量为 0 时仍从开头投递最小的整行内容，并给出续读位置。 */
  test('余量为 0 时仍投递开头的整行，不报告失败', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root, 0)
    const read = await r.execute('read_file', { path: 'big.ts' }, c)
    expect(read.status).toBe('success')
    const data = read.data as {
      content: string
      startLine: number
      endLine: number
      nextOffset?: number
    }
    expect(data.startLine).toBe(1)
    expect(data.nextOffset).toBe(data.endLine + 1)
    expect(Buffer.byteLength(data.content)).toBeLessThanOrEqual(MIN_DELIVERY_BYTES)
  })

  test('参数非法的读取不登记', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root, 1_000_000)
    expect((await r.execute('read_file', { path: 'big.ts', offset: 'x' }, c)).status).toBe(
      'failure',
    )
    const edit = {
      path: 'big.ts',
      edits: [{ old_string: `const v7 = f(7)`, new_string: `const v7 = f(70)` }],
    }
    expect((await r.execute('edit_file', edit, c)).status).toBe('failure')
  })
})
