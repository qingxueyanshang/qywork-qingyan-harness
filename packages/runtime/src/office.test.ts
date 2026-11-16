/**
 * `office.ts` 的 Office 宿主（开关关闭与缺少 Python 时不提供端口），以及 `session.ts` 与 `session/tool-context.ts` 中与 `office`
 * 相关的装配：有端口时才注册 Office 工具；本轮技能索引中的目录成为工具的只读根。
 *
 * 真实探测（启动 Python、导入文档库、识别办公软件）由 `bun run test:office` 与真机验收覆盖。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ports, provide } from '@qywork/agent'
import type { AgentEvent } from '@qywork/core'
import { ContentStore, Store } from '@qywork/store'
import { OfficePort } from '@qywork/tools'
import type { QyConfig } from './config.ts'
import { createOfficeHost } from './office.ts'
import { Session } from './session.ts'

const blobs = new ContentStore(':memory:')

const PORT: OfficePort = {
  python: process.execPath,
  worker: 'worker.py',
  apps: {
    docx: { available: true, reason: '' },
    xlsx: { available: true, reason: '' },
    pptx: { available: true, reason: '' },
  },
  videoDecoder: false,
  enabled: () => true,
}

describe('Office 宿主', () => {
  test('指定的解释器不存在：不可用，不提供端口', async () => {
    const config = {
      providers: {},
      officePython: join(tmpdir(), 'qywork-no-python.exe'),
    } as QyConfig
    const host = createOfficeHost(() => config)
    const status = await host.refresh()
    expect(status.available).toBe(false)
    expect(status.python).toBeNull()
    expect(status.reason.length).toBeGreaterThan(0)
    expect(host.port()).toBeUndefined()
  })

  /**
   * 探测进程的环境与执行模型代码的 worker 使用同一份剥离判定（`scrubbedEnv`）：配置中显式放行的变量照常传入。
   * 原始失败形状：探测按不带放行名单的规则剥离，放行的变量在探测中缺失、在执行中存在，两者的结论可能不同。
   */
  test('探测进程的环境按配置的放行名单剥离凭证，与执行时相同', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-office-probe-'))
    const dir = join(root, 'office')
    await mkdir(dir)
    // Bun 按 JS 执行任意扩展名的脚本：以 Bun 充当解释器，记录环境并写出探测结果。
    await writeFile(
      join(dir, 'worker.py'),
      `const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const req = JSON.parse(readFileSync(process.argv[2], 'utf8'))
writeFileSync(join(req.call_dir, 'env.json'), JSON.stringify(process.env))
writeFileSync(join(req.call_dir, 'response.json'), JSON.stringify({ probe: { python: '3.12', missing: [], packages: {}, apps: {} } }))
`,
    )
    const previousDir = process.env.QYWORK_OFFICE_DIR
    process.env.QYWORK_HOME = join(root, 'home')
    process.env.QYWORK_OFFICE_DIR = dir
    process.env.QYWORK_PROBE_TOKEN = 'allowed-by-config'
    process.env.QYWORK_PROBE_SECRET = 'stripped'
    try {
      const host = createOfficeHost(
        () =>
          ({
            providers: {},
            officePython: process.execPath,
            envAllowList: ['QYWORK_PROBE_TOKEN'],
          }) as QyConfig,
      )
      await host.refresh()
      const env = JSON.parse(
        await Bun.file(join(root, 'home', 'office', 'probe', 'env.json')).text(),
      ) as Record<string, string>
      expect(env.QYWORK_PROBE_TOKEN).toBe('allowed-by-config')
      expect(env.QYWORK_PROBE_SECRET).toBeUndefined()
    } finally {
      if (previousDir === undefined) delete process.env.QYWORK_OFFICE_DIR
      else process.env.QYWORK_OFFICE_DIR = previousDir
      delete process.env.QYWORK_PROBE_TOKEN
      delete process.env.QYWORK_PROBE_SECRET
    }
  })

  test('开关按读取状态时的配置实时判定', () => {
    let config = { providers: {} } as QyConfig
    const host = createOfficeHost(() => config)
    expect(host.status().enabled).toBe(true)
    config = { providers: {}, officeEnabled: false }
    expect(host.status().enabled).toBe(false)
    expect(host.port()).toBeUndefined()
  })
})

let provider: ReturnType<typeof Bun.serve>
let chat: (turn: number) => string = () => ''
let turn = 0

beforeAll(() => {
  provider = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.text()
      return new Response(chat(++turn), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
})
afterAll(() => provider.stop(true))

const home = process.env.QYWORK_HOME
afterEach(() => {
  if (home === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = home
})

function config(): QyConfig {
  return {
    active: { provider: 'p', model: 'm' },
    providers: {
      p: {
        kind: 'openai_chat_completions',
        apiKey: 'sk-test',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { m: {} },
      },
    },
  }
}

/** 第一轮调用一次工具，第二轮结束。 */
function toolThenStop(name: string, args: Record<string, unknown>) {
  const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
  return (n: number) =>
    n === 1
      ? chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
        'data: [DONE]\n\n'
      : chunk({ choices: [{ delta: { content: '好了' }, finish_reason: null }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n'
}

async function session(office?: OfficePort) {
  const store = new Store({ path: ':memory:' })
  const s = new Session({
    content: blobs,
    store,
    config: config(),
    workspaceRoot: await mkdtemp(join(tmpdir(), 'qywork-office-sess-')),
    signal: new AbortController().signal,
    ...(office ? { ports: new Ports([provide(OfficePort, office)]) } : {}),
  })
  const names = () =>
    (s as unknown as { state: { registry: { schemas(): { name: string }[] } } }).state.registry
      .schemas()
      .map((t) => t.name)
  return { s, store, names }
}

describe('会话装配', () => {
  test('有端口时才注册 office', async () => {
    const withPort = await session(PORT)
    const tools = ['read_office_guide', 'read_office', 'write_office', 'view_office']
    expect(withPort.names()).toEqual(expect.arrayContaining(tools))
    expect(withPort.names()).not.toContain('office')
    const without = await session()
    for (const name of tools) expect(without.names()).not.toContain(name)
    withPort.store.close()
    without.store.close()
  })

  test('全局技能目录中的参考文件可读取，不可写入', async () => {
    process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qywork-office-home-'))
    const dir = join(process.env.QYWORK_HOME, 'skills', 'deck')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: deck\ndescription: 做演示稿\n---\n见 ref.md')
    await writeFile(join(dir, 'ref.md'), '版式参考：标题 32 磅')

    const finished = async (name: string, args: Record<string, unknown>) => {
      turn = 0
      chat = toolThenStop(name, args)
      const { s, store } = await session()
      const events: AgentEvent[] = []
      for await (const ev of s.ask('按技能做')) events.push(ev)
      store.close()
      const ev = events.find((e) => e.type === 'tool.finished')
      if (ev?.type !== 'tool.finished') throw new Error('没有工具结果')
      return ev
    }

    const read = await finished('read_file', { path: join(dir, 'ref.md') })
    expect(read.status).toBe('success')
    expect(read.outcome.message).toContain('ref.md')

    const write = await finished('write_file', { path: join(dir, 'out.md'), content: 'x' })
    expect(write.status).not.toBe('success')
    expect(await Bun.file(join(dir, 'out.md')).exists()).toBe(false)
  })
})
