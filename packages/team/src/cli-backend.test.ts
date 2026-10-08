/**
 * 覆盖范围：`cli-backend.ts` 的 `extract`（从外部 CLI 的 stdout 中提取答案）、
 * 流中正文的解析入口（实时页与回执共用），`runCli` 交给 CLI 的两项内容，
 * 即追加的回执约定与续问所用的会话 id，以及中断时的进程树终止。后四组用 `node` 作为替身运行，
 * 无需本机安装相应的 CLI。
 *
 * 厂商表本身（调用哪个 CLI、参数格式）由真机冒烟测试覆盖：厂商表最容易过期，
 * 替身无法验证它。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract, runCli } from './cli-backend.ts'
import type { CliAgent } from './types.ts'

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n')

describe('提取答案', () => {
  test('text 模式原样返回整段输出', () => {
    expect(extract('  可以  \n', { output: 'text' }, '')).toBe('可以')
  })

  test('顶层字段（claude 格式）', () => {
    const out = jsonl([{ type: 'system' }, { result: '可以' }])
    expect(extract(out, { output: 'jsonl', resultField: 'result' }, '')).toBe('可以')
  })

  /**
   * 复现的失败形状：codex 的答案在 `item.text` 上，顶层没有 `result`。
   * 只按顶层键提取时无法取得任何一行，回退为整段 JSONL，模型会将整段内容当作任务产出。
   */
  test('点分路径（codex 格式），且取最后一条', () => {
    const out = jsonl([
      { type: 'thread.started', thread_id: 'x' },
      { type: 'item.completed', item: { type: 'agent_message', text: '正在读取。' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'cat VERSION' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '0.1.0' } },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
    ])
    expect(extract(out, { output: 'jsonl', resultField: 'item.text' }, '')).toBe('0.1.0')
  })

  test('路径中途不是对象时跳过该行，不抛错', () => {
    const out = jsonl([{ item: '不是对象' }, { item: { text: '答案' } }])
    expect(extract(out, { output: 'jsonl', resultField: 'item.text' }, '')).toBe('答案')
  })

  /**
   * grok 格式：整段 stdout 是一个缩进后的对象。
   * 逐行解析无法取得任何一行，会回退为整段 JSON 交给父会话。
   */
  test('整段为一个对象（grok 格式）', () => {
    const out = JSON.stringify({ text: '有三个文件', sessionId: 'gk-1' }, null, 2)
    expect(extract(out, { output: 'json', resultField: 'text' }, '')).toBe('有三个文件')
    // 同一段输出按逐行解析无法取得结果，因此需要单独设置该格式。
    expect(extract(out, { output: 'jsonl', resultField: 'text' }, '')).toBe('')
  })

  /**
   * 复现的失败形状：中途被终止的 stream-json 没有 `result` 行，回退到整段输出即将
   * 二十六万字符的计数事件当作子 agent 的产出交给模型，一条结果即占满整个上下文窗口。
   */
  test('jsonl 无法取得 result 时返回流中的正文，不回退到整段输出', () => {
    expect(extract('横幅\n乱七八糟', { output: 'jsonl', resultField: 'result' }, '读完了')).toBe(
      '读完了',
    )
    expect(extract('横幅\n乱七八糟', { output: 'jsonl', resultField: 'result' }, '')).toBe('')
  })
})

/** 只回显所收到提示词的 CLI 替身。 */
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

/** 真实子进程回放厂商输出，验证进程退出与结构化终态共同参与判定。 */
describe('CLI 执行结果', () => {
  const replay = (output: string, exitCode = 0, stderr = ''): CliAgent => ({
    ...echo,
    args: [
      '-e',
      `process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${exitCode}`,
    ],
  })

  test('所有输出格式的空结果均失败，不能仅凭零退出码报成功', async () => {
    for (const id of ['codex', 'claude', 'grok', 'gemini', 'qwen', 'kimi']) {
      const protocol = id === 'codex' || id === 'claude' || id === 'grok' ? id : undefined
      const agent: CliAgent = {
        ...replay(''),
        id,
        output: id === 'grok' ? 'json' : protocol ? 'jsonl' : 'text',
        ...(protocol ? { protocol } : {}),
      }
      const got = await run(agent, await mkdtemp(join(tmpdir(), 'qy-cli-')))
      expect(got.ok).toBe(false)
      expect(got.exitCode).toBe(0)
      expect(got.error).toBeTruthy()
    }
  })

  test('Codex 只有 stdout 错误时返回原因、退出码与会话号', async () => {
    const got = await run(
      {
        ...replay(
          jsonl([
            { type: 'thread.started', thread_id: 'codex-error-1' },
            { type: 'turn.failed', error: { message: '模型没有访问权限' } },
          ]),
          1,
        ),
        output: 'jsonl',
        protocol: 'codex',
        resultField: 'item.text',
        sessionField: 'thread_id',
      },
      await mkdtemp(join(tmpdir(), 'qy-cli-')),
    )
    expect(got).toMatchObject({ ok: false, exitCode: 1, stderr: '', session: 'codex-error-1' })
    expect(got.error).toContain('模型没有访问权限')
    expect(got.error).toContain('退出码 1')
  })

  test('Claude 错误终态与 Grok 取消即使退出码为零也失败', async () => {
    const cases: CliAgent[] = [
      {
        ...replay(
          jsonl([{ type: 'result', subtype: 'error_max_turns', errors: ['达到轮次上限'] }]),
        ),
        output: 'jsonl',
        protocol: 'claude',
      },
      {
        ...replay(JSON.stringify({ text: '开始修改', stopReason: 'cancelled' })),
        output: 'json',
        protocol: 'grok',
        resultField: 'text',
      },
    ]
    for (const agent of cases) {
      const got = await run(agent, await mkdtemp(join(tmpdir(), 'qy-cli-')))
      expect(got.ok).toBe(false)
      expect(got.error).toBeTruthy()
      expect(got.exitCode).toBe(0)
    }
  })

  test('结构化成功不能覆盖非零退出码，stderr 启动错误仍保留', async () => {
    const got = await run(
      {
        ...replay(JSON.stringify({ text: '完成', stopReason: 'end_turn' }), 2, '收尾失败'),
        output: 'json',
        protocol: 'grok',
        resultField: 'text',
      },
      await mkdtemp(join(tmpdir(), 'qy-cli-')),
    )
    expect(got.ok).toBe(false)
    expect(got.output).toBe('完成')
    expect(got.error).toContain('收尾失败')
  })

  test('纯文本失败保留 stdout，正常退出时 stderr 提示不误报失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-cli-'))
    const failed = await run(replay('登录已失效', 1), root)
    expect(failed.error).toContain('登录已失效')
    const success = await run(replay('任务完成', 0, '存在新版本'), root)
    expect(success.ok).toBe(true)
    expect(success.error).toBeUndefined()
  })

  test('新回传的错误与实时正文先脱敏，再截断和投递', async () => {
    const secret = 'local-test-credential-123456789'
    const chunks: string[] = []
    const got = await runCli(
      {
        ...replay(
          jsonl([
            { type: 'item.completed', item: { type: 'agent_message', text: `读取 ${secret}` } },
            { type: 'turn.failed', error: { message: `认证失败 ${secret}` } },
          ]),
          1,
          `stderr ${secret}`,
        ),
        output: 'jsonl',
        protocol: 'codex',
        resultField: 'item.text',
        narrate: { text: 'item.text' },
      },
      {
        prompt: '检查',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'qy-cli-')),
        signal: new AbortController().signal,
        secrets: { values: [secret] },
        onChunk: (text) => chunks.push(text),
      },
    )
    expect(JSON.stringify(got)).not.toContain(secret)
    expect(chunks.join('')).not.toContain(secret)
    expect(got.error).toContain('认证失败')
    expect(got.error).toContain('[REDACTED]')
    expect(chunks.join('')).toContain('[REDACTED]')
  })
})

describe('回执约定', () => {
  test('Windows npm 入口原样传递多行、引号与命令字符，不执行提示词内容', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'qy-cli-shim-'))
    const bin = join(root, 'bin with space')
    const entry = join(bin, 'node_modules', 'fake-cli', 'index.js')
    await mkdir(join(bin, 'node_modules', 'fake-cli'), { recursive: true })
    await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const command = join(bin, 'fake.cmd')
    await writeFile(
      command,
      [
        '@ECHO off',
        'SET dp0=%~dp0',
        'SET "_prog=node"',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\index.js" %*',
        '',
      ].join('\r\n'),
    )
    const prompt = '第一行\r\n" & echo injected>injected.txt & rem "\n%PATH% !PATH! | <> ^ () 中文'
    const got = await runCli(
      { ...echo, command, args: ['--prompt', '{prompt}', '--tail'] },
      { prompt, workspaceRoot: root, signal: new AbortController().signal },
    )
    expect(got.ok).toBe(true)
    const args = JSON.parse(got.output) as string[]
    expect(args).toHaveLength(3)
    expect(args[0]).toBe('--prompt')
    expect(args[1]?.startsWith(prompt)).toBe(true)
    expect(args[1]).toContain('### 回执')
    expect(args[2]).toBe('--tail')
    expect(await Bun.file(join(root, 'injected.txt')).exists()).toBe(false)
  })

  test('任务原文在前，约定追加在后', async () => {
    const got = await run(echo, await mkdtemp(join(tmpdir(), 'qy-cli-')))
    expect(got.output.startsWith('把 a.txt 改成小写')).toBe(true)
    expect(got.output).toContain('### 回执')
    // 交付物正文必须在前：`extract` 取最后一个非空目标字段，
    // 回执约定写在前面时，查询型任务的产出会被替换为一句状态汇报。
    expect(got.output.indexOf('把 a.txt 改成小写')).toBeLessThan(got.output.indexOf('### 回执'))
  })
})

describe('续问', () => {
  /** 识别出会话 id 才能续问。取最后一个非空值：同一字段可能出现在多行中。 */
  test('按点分路径提取会话 id，取最后一个非空值', async () => {
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

  test('厂商表未声明 sessionField 的 CLI 不返回 session', async () => {
    const got = await run(echo, await mkdtemp(join(tmpdir(), 'qy-cli-')))
    expect('session' in got).toBe(false)
  })

  /** 续问使用另一套参数：`{session}` 与 `{prompt}` 都需要替换。 */
  test('续问时使用 resumeArgs，并代入会话 id', async () => {
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

/**
 * 原始失败形状：POSIX 上 CLI 不是独立进程组，中断与静默超时的进程树终止只能终止 CLI 本身，
 * 其派生的子进程继续运行并占用端口。替身派生一个监听端口的子进程，端口关闭即表示进程树已全部终止。
 * 静默超时使用同一套进程树终止，时限为 `MAX_TIMEOUT_MS`，此处以中断触发。
 */
describe('进程树终止', () => {
  /** 选用不易冲突的端口；发生冲突时本测试以「中断前无法连接」失败，不会误判为成功。 */
  const PORT = 18949
  const hit = async (): Promise<boolean> => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) })
      return r.ok
    } catch {
      return false
    }
  }

  test('中断时外部 CLI 派生的子进程一并结束', async () => {
    const server = `require('http').createServer((_,r)=>r.end('alive')).listen(${PORT},'127.0.0.1')`
    // 子进程的 pid 写入 stdout，测试失败时据此清理，不留下占用端口的孤立进程。
    const spawner: CliAgent = {
      ...echo,
      args: [
        '-e',
        `var c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(function(){},1000)`,
        '{prompt}',
      ],
    }
    const controller = new AbortController()
    const running = runCli(spawner, {
      prompt: '起个服务',
      workspaceRoot: await mkdtemp(join(tmpdir(), 'qy-cli-')),
      signal: controller.signal,
    })
    let up = false
    for (let i = 0; i < 50 && !up; i++) {
      await Bun.sleep(100)
      up = await hit()
    }
    controller.abort()
    const got = await running
    try {
      expect(up).toBe(true)
      let down = false
      for (let i = 0; i < 20 && !down; i++) {
        await Bun.sleep(100)
        down = !(await hit())
      }
      expect(down).toBe(true)
    } finally {
      const pid = Number.parseInt(got.output, 10)
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 进程已结束。
        }
      }
    }
  }, 30_000)
})

/**
 * 输出 stream-json 的 CLI 替身。
 *
 * `hang` 为真时末行带换行符、写入后不退出，用于验证被中断时回执中保留的内容；
 * 为假时末行不带换行符，即进程结束时缓冲区中仍有一行未处理的情形。
 */
function streamer(lines: unknown[], hang = false): CliAgent {
  const payload = lines.map((l) => JSON.stringify(l)).join('\n') + (hang ? '\n' : '')
  return {
    id: 'streamer',
    vendor: '替身',
    command: 'node',
    args: [
      '-e',
      `process.stdout.write(${JSON.stringify(payload)});${hang ? 'setInterval(function(){},1000)' : ''}`,
    ],
    output: 'jsonl',
    resultField: 'result',
    narrate: { text: 'message.content[].text', tool: 'message.content[].name' },
  }
}

const spoke = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: '先读一遍 game.js。' }] },
}
const called = {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
}
const inited = { type: 'system', subtype: 'init', session_id: 'sess-1' }

describe('从流中提取正文', () => {
  test('实时页取得的是正文与工具名，不是原始 JSON 行', async () => {
    const chunks: string[] = []
    const got = await runCli(streamer([inited, spoke, called]), {
      prompt: '审一遍',
      workspaceRoot: await mkdtemp(join(tmpdir(), 'qy-cli-')),
      signal: new AbortController().signal,
      onChunk: (text) => chunks.push(text),
    })
    const live = chunks.join('')
    expect(live).toContain('先读一遍 game.js。')
    expect(live).toContain('Read')
    // 计数与状态行不转发，信封字段均不应出现在实时页上。
    expect(live).not.toContain('session_id')
    expect(live).not.toContain('"type"')
    // 没有 result 行时回执即该段正文，与实时页来自同一次解析。
    expect(got.output).toContain('先读一遍 game.js。')
    expect(got.output).not.toContain('session_id')
  })

  /**
   * 复现的失败形状：进程在中途被终止，流中没有 `result` 行。回退整段 stdout 时
   * 模型取得的是几十万字符的事件流，而不是子 agent 已输出的正文。
   */
  test('被中断时回执是已输出的正文', async () => {
    const controller = new AbortController()
    const got = await runCli(streamer([inited, spoke], true), {
      prompt: '审一遍',
      workspaceRoot: await mkdtemp(join(tmpdir(), 'qy-cli-')),
      signal: controller.signal,
      onChunk: () => controller.abort(),
    })
    expect(got.output).toBe('先读一遍 game.js。')
  })

  /** 表项不完整时不转发：`json` 格式须在输出结束后整段解析，流中没有可转发的内容。 */
  test('未声明正文路径的 CLI 不转发，也不报错', async () => {
    const chunks: string[] = []
    const quiet: CliAgent = { ...streamer([inited, spoke]), output: 'json' }
    delete quiet.narrate
    const got = await runCli(quiet, {
      prompt: '审一遍',
      workspaceRoot: await mkdtemp(join(tmpdir(), 'qy-cli-')),
      signal: new AbortController().signal,
      onChunk: (text) => chunks.push(text),
    })
    expect(chunks).toEqual([])
    expect(got.output).toBe('')
  })
})
