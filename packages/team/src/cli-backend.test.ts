/**
 * 覆盖范围：`cli-backend.ts` 的 `extract`（从外部 CLI 的 stdout 里取那段答案），
 * 以及 `runCli` 交出去的两样东西——追加给它的回执约定、跑完量到的改动清单。
 * 后两条用 `node` 当替身跑，不需要本机装着那几家 CLI。
 *
 * 厂商表本身（调什么、参数长什么样）由真机冒烟覆盖：那是最容易过期的地方，
 * 而替身证明不了它。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
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

  /** 一行都取不到时回退整段：回空串会让调用方以为「跑成了但没产出」。 */
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

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-cli-'))
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  await Bun.write(join(dir, 'a.txt'), 'A\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  return dir
}

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

describe('改动清单', () => {
  test('它改了什么由这一侧量出来，不看它说了什么', async () => {
    const dir = await repo()
    const writer: CliAgent = {
      ...echo,
      args: [
        '-e',
        "require('fs').writeFileSync('a.txt','a\\n');require('fs').writeFileSync('b.txt','x\\ny\\n');process.stdout.write('干完了')",
        '{prompt}',
      ],
    }
    const got = await run(writer, dir)
    expect(got.output).toBe('干完了')
    expect(got.changes?.total).toBe(2)
    expect(got.changes?.files.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt'])
    expect(got.changes?.files.find((c) => c.path === 'b.txt')?.changeType).toBe('created')
    // 真改了：不是靠它自述，文件内容也确实变了。
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a\n')
  })

  /** 工作区不是 git 仓库不影响量测：那一侧自带一个临时仓库。 */
  test('工作区不是 git 仓库也照样量得到', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-cli-'))
    const writer: CliAgent = {
      ...echo,
      args: [
        '-e',
        "require('fs').writeFileSync('bare.txt','x\\n');process.stdout.write('好了')",
        '{prompt}',
      ],
    }
    const got = await run(writer, dir)
    expect(got.changesUnmeasured).toBeUndefined()
    expect(got.changes?.files.map((c) => c.path)).toEqual(['bare.txt'])
  })
})
