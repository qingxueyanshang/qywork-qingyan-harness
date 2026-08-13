/**
 * Session 的装配面：工具集与角色约束。
 *
 * 不测「跑一轮」——那需要真实 provider，归 scripts/smoke-serve.ts。
 * 这里测的是**装配结果**，因为 Agent Team 的角色隔离完全建立在它上面：
 * 一个「只读」角色如果 allowedTools 没生效，它照样能改文件，而配置看着是对的。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listConversations, listRecentConversations, Store, upsertWorkspace } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { Session } from './session.ts'

const config: QyConfig = {
  active: { provider: 'p', model: 'deepseek-v4-flash' },
  providers: {
    p: { kind: 'openai_compatible', apiKey: 'sk-x', models: { 'deepseek-v4-flash': {} } },
  },
}

async function session(over: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const store = new Store({ path: ':memory:' })
  const s = new Session({
    store,
    config,
    workspaceRoot: await mkdtemp(join(tmpdir(), 'qywork-sess-')),
    signal: new AbortController().signal,
    ...over,
  })
  // 工具表是私有的，从公开的 schema 出口读——测的是模型实际看到什么。
  const names = () =>
    (s as unknown as { registry: { schemas(): { name: string }[] } }).registry
      .schemas()
      .map((t) => t.name)
  return { s, store, names }
}

describe('工具集', () => {
  test('不传 allowedTools 时是全部内置工具', async () => {
    const { names, store } = await session()
    expect(names()).toContain('read_file')
    expect(names()).toContain('run_command')
    expect(names().length).toBeGreaterThan(10)
    store.close()
  })

  test('传了就只注册这些', async () => {
    const { names, store } = await session({ allowedTools: ['read_file', 'grep'] })
    expect(names().sort()).toEqual(['grep', 'read_file'])
    store.close()
  })

  /**
   * 空数组与不传是两回事。合并它们会让「只让它分析、不给任何工具」
   * 这类角色配置静默变成「什么都能干」——而且看不出来。
   */
  test('空数组 = 一个工具都不给，不是「回落到全部」', async () => {
    const { names, store } = await session({ allowedTools: [] })
    expect(names()).toEqual([])
    store.close()
  })

  test('未知工具名被忽略，其余照常注册', async () => {
    const { names, store } = await session({ allowedTools: ['read_file', 'read_files'] })
    expect(names()).toEqual(['read_file'])
    store.close()
  })
})

describe('角色约束', () => {
  test('extraSystem 进冻结前缀', async () => {
    const { s, store } = await session({ extraSystem: '你只做代码审查，不改任何文件' })
    const loop = (
      s as unknown as { makeLoop(m: string): { deps: { systemPrompt: string } } }
    ).makeLoop('deepseek-v4-flash')
    expect((loop as unknown as { deps: { systemPrompt: string } }).deps.systemPrompt).toContain(
      '你只做代码审查',
    )
    store.close()
  })

  test('不传时前缀与默认完全一致 —— 免得平白多一段把缓存冲掉', async () => {
    const { s, store } = await session()
    const prompt = (
      (s as unknown as { makeLoop(m: string): unknown }).makeLoop('deepseek-v4-flash') as {
        deps: { systemPrompt: string }
      }
    ).deps.systemPrompt
    expect(prompt).not.toContain('## 角色')
    store.close()
  })
})

/**
 * allowedTools 必须同时管得住扩展工具，也必须**认得出**它们。
 *
 * 只过滤内置工具的话，一个「只读」角色照样能调插件里的写工具；
 * 而判定「这个名字是不是写错了」如果在扩展加载之前做，一个合法的
 * `mcp__demo__ping` 会被报成未知——让人去查一个不存在的问题。
 */
describe('allowedTools 与扩展工具', () => {
  async function workspaceWithMcp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'qywork-sess-mcp-'))
    await mkdir(join(root, '.agents'), { recursive: true })
    const NL = String.fromCharCode(10)
    await writeFile(
      join(root, '.agents', 'server.mjs'),
      [
        "let buf = ''",
        'const NL = String.fromCharCode(10)',
        'const send = (o) => process.stdout.write(JSON.stringify(o) + NL)',
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (c) => { buf += c; for(;;){ const i = buf.indexOf(NL); if (i < 0) break; const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line) } catch { continue }; handle(m) } })",
        'function handle(m) {',
        "  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo' } } })",
        "  if (m.method === 'notifications/initialized') return",
        "  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }, { name: 'pong', description: 'q', inputSchema: { type: 'object' } }] } })",
        "  send({ jsonrpc: '2.0', id: m.id, result: { content: [] } })",
        '}',
      ].join(NL),
      'utf8',
    )
    await writeFile(
      join(root, '.agents', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          demo: { command: process.execPath, args: [join(root, '.agents', 'server.mjs')] },
        },
      }),
      'utf8',
    )
    return root
  }

  test('allowedTools 里可以点名 MCP 工具，且只放行点到的那个', async () => {
    const store = new Store({ path: ':memory:' })
    const root = await workspaceWithMcp()
    const s = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: new AbortController().signal,
      allowedTools: ['read_file', 'mcp__demo__ping'],
    })
    await (s as unknown as { loadExtensionTools(): Promise<void> }).loadExtensionTools()
    const names = (s as unknown as { registry: { schemas(): { name: string }[] } }).registry
      .schemas()
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(['mcp__demo__ping', 'read_file'])
    // 同一个 server 的另一个工具没被点名，就不该出现。
    expect(names).not.toContain('mcp__demo__pong')
    s.dispose()
    store.close()
  }, 20_000)
})

/**
 * 新建会话的来源标记。
 *
 * `ask` 不带 conversationId 时会**当场建一个会话**——这一步在任何 provider
 * 调用之前发生，所以下面用一个必然连不上的 baseUrl 就能测到它：请求失败，
 * 但会话已经在库里了。
 */
describe('新建会话的来源', () => {
  const offline: QyConfig = {
    active: { provider: 'p', model: 'deepseek-v4-flash' },
    providers: {
      p: {
        kind: 'openai_compatible',
        apiKey: 'sk-x',
        // 端口 1 上不会有人在听，连接立刻被拒——不出网、不等超时。
        baseUrl: 'http://127.0.0.1:1/v1',
        models: { 'deepseek-v4-flash': {} },
      },
    },
  }

  async function askOnce(
    over?: Partial<Parameters<Session['ask']>[2]>,
    config: QyConfig = offline,
  ) {
    const store = new Store({ path: ':memory:' })
    const root = await mkdtemp(join(tmpdir(), 'qywork-src-'))
    const s = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: new AbortController().signal,
    })
    try {
      for await (const _ of s.ask('查一下这个函数', undefined, over)) {
        // 只要跑到第一次 provider 调用就够了，产出不关心。
      }
    } catch {
      // 连不上是预期的。
    }
    s.dispose()
    return { store, root }
  }

  /**
   * 复现原始失败形状：team 成员的子会话曾经不打来源标记，于是每跑一次 team，
   * 用户的会话列表里就多出 N 条以成员 prompt 开头的条目。
   */
  test("source: 'workflow' 的会话不进会话列表", async () => {
    const { store, root } = await askOnce({ source: 'workflow', sourceRef: 'reviewer' })
    const ws = upsertWorkspace(store, root, 'x')
    expect(listConversations(store, ws.id)).toEqual([])
    expect(listRecentConversations(store)).toEqual([])
    store.close()
  })

  /** 不填仍然是用户会话——`qy run "..."` 走的就是这条，它必须能被列出来。 */
  test('不填来源的仍然是用户会话', async () => {
    const { store, root } = await askOnce()
    const ws = upsertWorkspace(store, root, 'x')
    expect(listConversations(store, ws.id)).toHaveLength(1)
    expect(listConversations(store, ws.id)[0]?.source).toBeNull()
  })
})

/**
 * 裁决分类器实际发出去的请求。
 *
 * **必须看真实请求体。** 这条链路上出过的事故正是「两头都对、中间那节把值丢了」：
 * 分类器要求 `thinking:{mode:'disabled'}`，而兼容协议的装配层只看 `effort`，
 * 那条指令被静默吃掉，DeepSeek 照常思考，512 的预算全被推理烧光
 * （落盘的 `usage_ledger` 里 `output_tokens=512, reasoning_tokens=512`），
 * 正文一个字都没有 → `parseVerdict('')` 返回 null → 两段判定都失败 → fail-closed。
 *
 * 表现是 **auto 模式下每一条静态规则判不了的命令都必然被拒**，而给用户看的理由
 * 是「分类器回复解析失败」——从那句话完全看不出问题在请求装配上。
 *
 * 归因也是错的：「裁决不需要思考」这个前提对 DeepSeek 根本不成立，
 * 它的控制面只有 high / max 两档，**没有关闭档**。所以现在不再要求关思考，
 * 而是跟着主循环那一档走。
 */
describe('分类器的请求装配', () => {
  /** 主循环带工具，分类器不带——假端点靠这个区分该回哪一种流。 */
  const isClassifier = (body: any) => !(body.tools?.length > 0)

  const TOOL_CALL =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":' +
    '{"name":"run_command","arguments":"{\\"command\\":\\"npm test\\"}"}}]},' +
    '"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'

  const text = (s: string) =>
    `data: {"choices":[{"delta":{"content":${JSON.stringify(s)}},"finish_reason":null}]}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n'

  async function run(effort?: 'low' | 'high' | 'max') {
    const bodies: any[] = []
    let mainTurns = 0
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as any
        bodies.push(body)
        if (isClassifier(body)) {
          // 判 block：命令因此不会真的执行，测试不落任何副作用。
          return new Response(text('{"decision":"block","reason":"测试固定拒绝"}'), {
            headers: { 'content-type': 'text/event-stream' },
          })
        }
        mainTurns += 1
        return new Response(mainTurns === 1 ? TOOL_CALL : text('好了'), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const store = new Store({ path: ':memory:' })
    const root = await mkdtemp(join(tmpdir(), 'qywork-cls-'))
    const s = new Session({
      store,
      config: {
        active: { provider: 'p', model: 'deepseek-v4-flash' },
        providers: {
          p: {
            kind: 'openai_compatible',
            apiKey: 'sk-x',
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            models: { 'deepseek-v4-flash': effort ? { effort } : {} },
          },
        },
      },
      workspaceRoot: root,
      signal: new AbortController().signal,
    })
    try {
      for await (const _ of s.ask('跑一下测试')) {
        // 产出不关心，要的是发出去的那几个请求体。
      }
    } finally {
      s.dispose()
      store.close()
      server.stop(true)
    }
    return bodies.filter(isClassifier)
  }

  test('不再要求关思考——DeepSeek 没有关闭档', async () => {
    const [first] = await run('max')
    expect(first).toBeDefined()
    expect(first.thinking).not.toEqual({ type: 'disabled' })
  })

  /**
   * 档位取**分类器自己那个模型**的那一格，不自己挑、也不借用主循环那一档。
   *
   * `config.classifier` 可以指向另一个模型（这条配置存在的理由就是「裁决不必和
   * 主循环同一个模型」）。借用主循环那一档的话，主循环在 Claude 上跑 `xhigh`、
   * 分类器指向 DeepSeek 时那一档它根本没有——档位集合逐模型不同。
   */
  test('档位取这个模型自己那一格', async () => {
    const [first] = await run('max')
    expect(first.thinking).toEqual({ type: 'enabled' })
    expect(first.reasoning_effort).toBe('max')
  })

  /** 没选过就一个思考字段都不发，让模型走自己的默认。 */
  test('没选过档位就不发思考字段', async () => {
    const [first] = await run()
    expect('thinking' in first).toBe(false)
    expect('reasoning_effort' in first).toBe(false)
  })

  /**
   * 预算要容得下**思考 + 正文**。
   *
   * 512 是按正文长度给的，而实测（2026-08-13，deepseek-v4-flash）光正文那一段
   * 就要 1109 token（high 档峰值）——原来的值连思考都不够，正文自然一个字不剩。
   */
  test('预算容得下思考加正文', async () => {
    const [first] = await run('max')
    expect(first.max_tokens).toBe(4096)
  })
})
