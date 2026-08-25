/**
 * 覆盖范围：`cli-backend.ts` 的 `extract`（从外部 CLI 的 stdout 里取那段答案），
 * 以及 `runCli` 交出去的两项——追加给它的回执约定、接着问要用的会话 id。
 * 后两条用 `node` 当替身跑，不需要本机装着那几家 CLI。
 *
 * 厂商表本身（调什么、参数长什么样）由真机冒烟覆盖：那是最容易过期的地方，
 * 而替身证明不了它。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract, runCli } from './cli-backend.ts'
import type { CliAgent } from './types.ts'

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n')

describe('取答案', () => {
  test('text 模式原样回整段', () => {
    expect(extract('  可以  \n', { output: 'text' })).toBe('可以')
  })

  test('顶层字段（claude 那种）', () => {
    const out = jsonl([{ type: 'system' }, { result: '可以' }])
    expect(extract(out, { output: 'jsonl', resultField: 'result' })).toBe('可以')
  })

  /**
   * 复现的失败形状：codex 的答案在 `item.text` 上，顶层没有 `result`。
   * 只按顶层键取的话一行都取不到，回退成整段 JSONL，而模型会把那坨当成任务产出。
   */
  test('点分路径（codex 那种），且取最后一条', () => {
    const out = jsonl([
      { type: 'thread.started', thread_id: 'x' },
      { type: 'item.completed', item: { type: 'agent_message', text: '正在读取。' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'cat VERSION' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '0.1.0' } },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
    ])
    expect(extract(out, { output: 'jsonl', resultField: 'item.text' })).toBe('0.1.0')
  })

  test('路径中途不是对象时跳过那一行，不炸', () => {
    const out = jsonl([{ item: '不是对象' }, { item: { text: '答案' } }])
    expect(extract(out, { output: 'jsonl', resultField: 'item.text' })).toBe('答案')
  })

  /**
   * grok 那种：整段 stdout 是**一个**缩进过的对象。
   * 逐行解析对它一行都取不到，会整段回退成一大段 JSON 交给父会话。
   */
  test('整段一个对象（grok 那种）', () => {
    const out = JSON.stringify({ text: '有三个文件', sessionId: 'gk-1' }, null, 2)
    expect(extract(out, { output: 'json', resultField: 'text' })).toBe('有三个文件')
    // 同一段按逐行解析取不到——这正是它需要单独一档的理由。
    expect(extract(out, { output: 'jsonl', resultField: 'text' })).toBe(out)
  })

  /** 一行都取不到时回退整段：回空串在调用方看来是「跑成了但没产出」。 */
  test('取不到就回退整段 stdout', () => {
    expect(extract('横幅\n乱七八糟', { output: 'jsonl', resultField: 'result' })).toBe(
      '横幅\n乱七八糟',
    )
  })
})

/** 一个只会回显自己收到的那段提示词的「CLI」。 */
const echo: CliAgent = {
  id: 'echo',
  vendor: '替身',
  command: 'node',
  args: ['-e', 'process.stdout.write(process.argv[1])', '{prompt}'],
  output: 'text',
}

const run = (agent: CliAgent, root: string) =>
  runCli(agent, {
    prompt: '把 a.txt 改成小写',
    workspaceRoot: root,
    signal: new AbortController().signal,
  })

describe('回执约定', () => {
  test('任务原样在前，约定追加在后', async () => {
    const got = await run(echo, await mkdtemp(join(tmpdir(), 'qy-cli-')))
    expect(got.output.startsWith('把 a.txt 改成小写')).toBe(true)
    expect(got.output).toContain('### 回执')
    // 交付物正文在前是硬要求：`extract` 取的是最后一个非空目标字段，
    // 回执写在前面时，查询型任务的产出会变成一句状态汇报。
    expect(got.output.indexOf('把 a.txt 改成小写')).toBeLessThan(got.output.indexOf('### 回执'))
  })
})

describe('接着问', () => {
  /** 会话 id 认得出来才接得上下一句。取最后一个非空值：同一个字段可能出现好几行。 */
  test('按点分路径取会话 id，取最后一个非空的', async () => {
    const teller: CliAgent = {
      ...echo,
      args: [
        '-e',
        'process.stdout.write([JSON.stringify({thread_id:"t-1"}),JSON.stringify({thread_id:"t-2"})].join(String.fromCharCode(10)))',
        '{prompt}',
      ],
      output: 'jsonl',
      resultField: 'thread_id',
      sessionField: 'thread_id',
    }
    const got = await run(teller, await mkdtemp(join(tmpdir(), 'qy-cli-')))
    expect(got.session).toBe('t-2')
  })

  test('表里没写 sessionField 的那几家不给 session', async () => {
    const got = await run(echo, await mkdtemp(join(tmpdir(), 'qy-cli-')))
    expect('session' in got).toBe(false)
  })

  /** 接着问走的是另一套参数：`{session}` 与 `{prompt}` 都要换掉。 */
  test('接着问时用 resumeArgs，会话 id 替进去', async () => {
    const resumable: CliAgent = {
      ...echo,
      args: ['-e', 'process.stdout.write("新起一条")', '{prompt}'],
      resumeArgs: [
        '-e',
        'process.stdout.write(process.argv[1]+"|"+process.argv[2])',
        '{session}',
        '{prompt}',
      ],
    }
    const got = await runCli(resumable, {
      prompt: '你刚才改了什么',
      workspaceRoot: await mkdtemp(join(tmpdir(), 'qy-cli-')),
      signal: new AbortController().signal,
      resume: 'sess-7',
    })
    expect(got.output.startsWith('sess-7|你刚才改了什么')).toBe(true)
    expect(got.output).toContain('### 回执')
  })
})
