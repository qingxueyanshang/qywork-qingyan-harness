/**
 * `office.ts` 的 Office 宿主（开关关闭与缺少 Python 时不提供端口），以及 `session.ts` 中与 `office`
 * 相关的装配：有端口时才注册 Office 工具；本轮技能索引中的目录成为工具的只读根。
 *
 * 真实探测（启动 Python、导入文档库、识别办公软件）由 `bun run test:office` 与真机验收覆盖。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OfficePort } from '@qywork/agent'
import type { AgentEvent } from '@qywork/core'
import { Store } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { createOfficeHost } from './office.ts'
import { Session } from './session.ts'

const PORT: OfficePort = {
  python: process.execPath,
  worker: 'worker.py',
  apps: {
    docx: { available: true, reason: '' },
    xlsx: { available: true, reason: '' },
    pptx: { available: true, reason: '' },
  },
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
    store,
    config: config(),
    workspaceRoot: await mkdtemp(join(tmpdir(), 'qywork-office-sess-')),
    signal: new AbortController().signal,
    ...(office ? { office } : {}),
  })
  const names = () =>
    (s as unknown as { registry: { schemas(): { name: string }[] } }).registry
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
