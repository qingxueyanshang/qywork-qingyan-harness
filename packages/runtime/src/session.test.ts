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
import type { ToolContext, ToolRegistry } from '@qywork/agent'
import {
  createConversation,
  fileReadHash,
  listConversations,
  listDisabledExtras,
  listRecentConversations,
  listWorkspaces,
  Store,
  setConversationTitle,
  setExtraEnabled,
  upsertWorkspace,
} from '@qywork/store'
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
 * 被拦命令回给模型的那句话。
 *
 * 锁的是**这句话把模型推向哪里**，不是逐字文案（逐字断言改一个字就红，
 * 锁的是文案不是行为）。教它「换一条命令」的代价是具体的：`rm -rf ~/x`
 * 被拦就改写成 `python -c "import shutil; shutil.rmtree(...)"`，
 * 而后者不在 HARD_DENY 表里，于是同一件事照样发生。
 */
describe('被拒的裁决怎么说话', () => {
  type Deny = { allowed: false; reason: string }
  const denyFor = async (command: string) => {
    const { s, store } = await session()
    const v = await (
      s as unknown as {
        decide(m: { toolName: string; args: Record<string, unknown> }): Promise<Deny>
      }
    ).decide({ toolName: 'run_command', args: { command } })
    store.close()
    return v
  }

  test('给的是「让用户提权」和「跳过」两条出路', async () => {
    const v = await denyFor('rm -rf ~/')
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain('完全访问')
    expect(v.reason).toContain('跳过')
  })

  test('不引导换写法：提到「换」的地方必须都是否定句', async () => {
    const { reason } = await denyFor('rm -rf ~/')
    const mentions = (reason.match(/换/g) ?? []).length
    const negated = (reason.match(/不要换|不能换|别换/g) ?? []).length
    expect(mentions).toBe(negated)
  })
})

/**
 * 一个真的能握手的 MCP server，工具表由调用方给。
 *
 * 两个 describe 共用：一个测 allowedTools 的过滤，一个测 schema 按量转按需。
 * 两边都要一个真实的 stdio server——照抄一份的代价是它们迟早只有一份被改。
 */
async function workspaceWithMcp(
  server = 'demo',
  tools: { name: string; description: string }[] = [
    { name: 'ping', description: 'p' },
    { name: 'pong', description: 'q' },
  ],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-sess-mcp-'))
  await mkdir(join(root, '.agents'), { recursive: true })
  const NL = String.fromCharCode(10)
  const defs = JSON.stringify(
    tools.map((t) => ({ ...t, inputSchema: { type: 'object' } })),
  ).replaceAll(NL, ' ')
  await writeFile(
    join(root, '.agents', 'server.mjs'),
    [
      "let buf = ''",
      'const NL = String.fromCharCode(10)',
      'const send = (o) => process.stdout.write(JSON.stringify(o) + NL)',
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (c) => { buf += c; for(;;){ const i = buf.indexOf(NL); if (i < 0) break; const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line) } catch { continue }; handle(m) } })",
      'function handle(m) {',
      `  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: '${server}' } } })`,
      "  if (m.method === 'notifications/initialized') return",
      `  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: ${defs} } })`,
      "  send({ jsonrpc: '2.0', id: m.id, result: { content: [] } })",
      '}',
    ].join(NL),
    'utf8',
  )
  await writeFile(
    join(root, '.agents', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        [server]: { command: process.execPath, args: [join(root, '.agents', 'server.mjs')] },
      },
    }),
    'utf8',
  )
  return root
}

/**
 * allowedTools 必须同时管得住扩展工具，也必须**认得出**它们。
 *
 * 只过滤内置工具的话，一个「只读」角色照样能调插件里的写工具；
 * 而判定「这个名字是不是写错了」如果在扩展加载之前做，一个合法的
 * `mcp__demo__ping` 会被报成未知——让人去查一个不存在的问题。
 */
describe('allowedTools 与扩展工具', () => {
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
 * 外部工具的 schema 按量转按需。
 *
 * 锁的是**超预算时那些 schema 真的没进请求**：这一条反过来不会报错，
 * 只会表现为账单照旧——按需加载做了等于没做，谁都不会发现。
 *
 * 阈值与实测的量在 `tools/tool-pool.ts`。这里的胖 server 用长描述凑量，
 * 不依赖具体阈值取值，只依赖「它超了」。
 */
describe('外部工具按量转按需', () => {
  const fatTools = Array.from({ length: 8 }, (_, i) => ({
    name: `t${i}`,
    description: 'x'.repeat(800),
  }))

  async function assemble(over: { disabled?: string[] } = {}) {
    const store = new Store({ path: ':memory:' })
    const root = await workspaceWithMcp('fat', fatTools)
    const ws = upsertWorkspace(store, root, 'ws')
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    for (const key of over.disabled ?? []) setExtraEnabled(store, conv.id, key, false)

    const s = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: new AbortController().signal,
    })
    await (
      s as unknown as {
        loadExtensionTools(d: ReadonlySet<string>, c: string): Promise<void>
      }
    ).loadExtensionTools(listDisabledExtras(store, conv.id), conv.id)

    const registry = (s as unknown as { registry: ToolRegistry }).registry
    const tail = () =>
      (
        (s as unknown as { makeLoop(m: string, c: string): unknown }).makeLoop('m', conv.id) as {
          deps: { tailNotes(): { content: string; group: string }[] }
        }
      ).deps
        .tailNotes()
        .find((n) => n.group === 'mcpTools')?.content ?? ''
    return { store, s, conv, registry, tail }
  }

  test('超预算时那批工具不进 schemas，只出现一个 load_tool', async () => {
    const { store, s, registry, tail } = await assemble()
    const names = registry.schemas().map((t) => t.name)

    expect(names).toContain('load_tool')
    expect(names.filter((n) => n.startsWith('mcp__fat__'))).toEqual([])
    // 但模型得知道它们存在——清单在尾区，不在冻结前缀里。
    expect(tail()).toContain('mcp__fat__t0')
    s.dispose()
    store.close()
  }, 20_000)

  test('load_tool 装完就进 schemas，同时从清单里消失', async () => {
    const { store, s, registry, tail } = await assemble()
    const out = await registry.execute(
      'load_tool',
      { names: ['mcp__fat__t0'] },
      (
        s as unknown as { makeToolContext(r: string, e: () => void, m: string, c: string): unknown }
      ).makeToolContext('rn_x', () => {}, 'm', 'cv_x') as never,
    )

    expect(out.status).toBe('success')
    expect(registry.schemas().map((t) => t.name)).toContain('mcp__fat__t0')
    expect(tail()).not.toContain('mcp__fat__t0：')
    s.dispose()
    store.close()
  }, 20_000)

  /**
   * Session 每条消息新建一个，进程内的「已加载」集合活不过这条消息。
   * 落账本才有意义——不然模型每轮都得重装一遍。
   */
  test('装过的下一条消息直接在工具表里', async () => {
    const { store, s, conv, registry } = await assemble()
    await registry.execute(
      'load_tool',
      { names: ['mcp__fat__t0'] },
      (
        s as unknown as { makeToolContext(r: string, e: () => void, m: string, c: string): unknown }
      ).makeToolContext('rn_x', () => {}, 'm', 'cv_x') as never,
    )
    const root = s as unknown as { opts: { workspaceRoot: string } }

    const next = new Session({
      store,
      config,
      workspaceRoot: root.opts.workspaceRoot,
      signal: new AbortController().signal,
    })
    await (
      next as unknown as {
        loadExtensionTools(d: ReadonlySet<string>, c: string): Promise<void>
      }
    ).loadExtensionTools(listDisabledExtras(store, conv.id), conv.id)

    const names = (next as unknown as { registry: ToolRegistry }).registry
      .schemas()
      .map((t) => t.name)
    expect(names).toContain('mcp__fat__t0')
    // 只把装过的那个放回去，其余照旧待加载。
    expect(names).not.toContain('mcp__fat__t1')
    next.dispose()
    s.dispose()
    store.close()
  }, 20_000)

  /**
   * 会话级开关的语义不能因为转按需就丢：被关掉的工具**连清单里都不该出现**，
   * 否则模型会去 load_tool 一个必然失败的名字。
   */
  test('会话级关掉的 server 连清单都不进', async () => {
    const { store, s, registry, tail } = await assemble({ disabled: ['mcp:fat'] })
    expect(tail()).toBe('')
    expect(registry.schemas().map((t) => t.name)).not.toContain('load_tool')
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
   * 复现原始失败形状：team 成员的子会话不打来源标记的话，每跑一次 team，
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
 * 读记录接没接上。
 *
 * 这条锁的是**装配**：`files.ts` 那边只约定形状，寿命由这里给。没接上的话
 * 它会静默退回 run 内记账，表现是「上一轮读过、这一轮改文件先失败一次」——
 * 而那正是要修的原始形状，且不会有任何报错。
 */
describe('工具上下文的读记录', () => {
  test('两个 run 共用同一份，且落在账本里按会话归属', async () => {
    const { s, store } = await session()
    const ws = listWorkspaces(store)[0]!
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const make = (
      s as unknown as {
        makeToolContext(r: string, e: () => void, m: string, c: string): ToolContext
      }
    ).makeToolContext.bind(s)

    const first = make('rn_1', () => {}, 'm', conv.id)
    const second = make('rn_2', () => {}, 'm', conv.id)
    first.reads?.mark('C:/ws/a.ts', 'h1')

    expect(second.reads?.seen('C:/ws/a.ts')).toBe('h1')
    expect(fileReadHash(store, conv.id, 'C:/ws/a.ts')).toBe('h1')
    store.close()
  })
})

/*
 * 会话标题。
 *
 * **产生点只有这一处**：第一条用户消息落库之后。建会话的时候不取——那一刻正文
 * 还不存在（界面端是先建会话、后发第一句话），于是取到的只能是空串，
 * 侧栏里一整列「新对话」就是这么来的。
 *
 * 这里只吃 `ask()` 的第一条事件就停：标题在那之前就写好了，而再往下走要真的
 * 连 provider。停在这儿测的正好是「不发一次请求也该有标题」。
 */
describe('会话标题', () => {
  const firstEvent = async (s: Session, prompt: string, existing?: string) => {
    for await (const ev of s.ask(prompt, existing as never)) return ev
    return null
  }

  test('第一句话定标题，并当场广播出去', async () => {
    const { s, store } = await session()
    const ev = await firstEvent(s, '帮我把侧栏的时间显示出来\n第二行是细节')
    expect(ev?.type).toBe('conversation.updated')
    const conv = listRecentConversations(store, 1)[0]
    expect(conv?.title).toBe('帮我把侧栏的时间显示出来')
    expect((ev as { title: string }).title).toBe('帮我把侧栏的时间显示出来')
    store.close()
  })

  /* 第二句话不许盖掉第一句定下的名字——列表里那一行会随每次发言变来变去。 */
  test('第二句话不覆盖已有标题', async () => {
    const { s, store } = await session()
    await firstEvent(s, '第一句')
    const conv = listRecentConversations(store, 1)[0]
    await firstEvent(s, '第二句', conv?.id)
    expect(listRecentConversations(store, 1)[0]?.title).toBe('第一句')
    store.close()
  })

  /* 用户改过的名字更不许被下一句话盖掉。 */
  test('用户改过的名字不被覆盖', async () => {
    const { s, store } = await session()
    await firstEvent(s, '第一句')
    const conv = listRecentConversations(store, 1)[0]
    setConversationTitle(store, conv?.id as never, '我自己起的名字')
    await firstEvent(s, '第二句', conv?.id)
    expect(listRecentConversations(store, 1)[0]?.title).toBe('我自己起的名字')
    store.close()
  })
})
