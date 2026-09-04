/**
 * Session 的装配面：工具集与角色约束。
 *
 * 不测「跑一轮」——那需要真实 provider，归 scripts/smoke-serve.ts。
 * 这里测的是**装配结果**，因为 Agent Team 的角色隔离完全建立在它上面：
 * 一个「只读」角色如果 allowedTools 没生效，它照样能改文件，而配置看着是对的。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DelegatePort, ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY, type TokenDensity } from '@qywork/ai'
import type { ConversationId } from '@qywork/core'
import {
  appendStep,
  createConversation,
  createRun,
  fileReadHash,
  listConversations,
  listDisabledExtras,
  listRecentConversations,
  listRunContextSnapshots,
  listWorkspaces,
  Store,
  setConversationTitle,
  setExtraEnabled,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { configPath, type QyConfig } from './config.ts'
import { buildTailNotes } from './prompt.ts'
import { Session, withAttachments } from './session.ts'

const config: QyConfig = {
  active: { provider: 'p', model: 'deepseek-v4-flash' },
  providers: {
    p: { kind: 'openai_chat_completions', apiKey: 'sk-x', models: { 'deepseek-v4-flash': {} } },
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

const delegate: DelegatePort = {
  resolveModel: (name, provider) => ({ provider: provider ?? 'p', model: name }),
  targets: async () => ({
    roles: [{ id: 'reviewer', name: '审查员', description: '看代码', provider: 'p', model: 'm' }],
    clis: [{ id: 'codex', vendor: 'OpenAI', connected: true }],
  }),
  subagents: async () => [
    {
      id: 'cv_sub',
      kind: 'temp',
      name: '查资料',
      provider: 'p',
      model: 'm',
      status: 'idle',
      resumable: true,
    },
    {
      id: 'cv_cli',
      kind: 'cli',
      name: 'OpenAI codex',
      provider: 'cli',
      model: 'codex',
      status: 'idle',
      resumable: false,
    },
  ],
  dispatch: async () => ({ ok: true, output: '' }),
  join: async () => ({ ok: true, output: '' }),
  settleRun: () => {},
  inflight: () => [],
  runGraph: async () => ({ ok: true }),
}

describe('派活工具只给有派活通道的会话', () => {
  test('顶层会话有 define_role、subagent、workflow；成员会话一个都没有', async () => {
    const top = await session({ delegate })
    expect(top.names()).toContain('define_role')
    expect(top.names()).toContain('subagent')
    expect(top.names()).toContain('workflow')
    top.s.dispose()
    top.store.close()
    const member = await session()
    expect(member.names()).not.toContain('define_role')
    expect(member.names()).not.toContain('subagent')
    expect(member.names()).not.toContain('workflow')
    member.s.dispose()
    member.store.close()
  })
})

describe('附件请求形状', () => {
  test('历史媒体降级为普通文本，只有当前媒体使用内容块数组', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-attachment-'))
    await writeFile(join(root, 'chart.png'), Buffer.from([0]))
    const attachment = {
      type: 'image' as const,
      name: 'chart.png',
      mime: 'image/png',
      size: 1,
      path: 'chart.png',
    }

    const historical = await withAttachments(root, '继续分析', [attachment], false)
    expect(typeof historical).toBe('string')
    expect(historical).toContain('历史附件 chart.png')

    const current = await withAttachments(root, '分析这张图', [attachment])
    expect(Array.isArray(current)).toBe(true)
    expect(current).toEqual([
      expect.objectContaining({ type: 'image' }),
      { type: 'text', text: '分析这张图' },
    ])
  })
})

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

  test('无效工具引用被忽略，其余照常注册', async () => {
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

describe('顶层会话的可分配模型快照', () => {
  const firstEvent = async (s: Session, prompt = '让 glm、qwen 分别建角色处理') => {
    for await (const ev of s.ask(prompt)) return ev
    return null
  }

  test('从当前配置只提取接口与模型，随 run 落库供规划模型选择', async () => {
    const liveConfig: QyConfig = {
      active: { provider: '智谱接口', model: 'glm-5.3-flash' },
      providers: {
        智谱接口: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-never-send-this',
          baseUrl: 'https://private-relay.example/v1',
          headers: { Authorization: 'Bearer also-secret' },
          models: { 'glm-5.3-flash': {} },
        },
        千问接口: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-qwen-secret',
          models: { 'qwen/model-3.8': {} },
        },
      },
    }
    const { s, store } = await session({ config: liveConfig, delegate })

    await firstEvent(s, '第一轮')

    const conv = listRecentConversations(store, 1)[0]!
    const snapshot = listRunContextSnapshots(store, conv.id)[0]!
      .segments.map((segment) => segment.content)
      .join('\n')
    expect(snapshot).toContain('provider 参数 `智谱接口`；model 参数 `glm-5.3-flash`')
    expect(snapshot).toContain('provider 参数 `千问接口`；model 参数 `qwen/model-3.8`')
    // 角色、外部 CLI、本会话已有的子 agent 同一份快照里给出，模型按 id 引用。
    expect(snapshot).toContain('角色 id `reviewer`：审查员，看代码；模型 p / m')
    expect(snapshot).toContain('外部 CLI id `codex`：OpenAI，已接入')
    expect(snapshot).toContain('subagentId `cv_sub`：查资料，临时，模型 p / m，空闲')
    expect(snapshot).toContain(
      'subagentId `cv_cli`：OpenAI codex，外部 CLI，模型 cli / codex，空闲，不可续接：没有会话号，续派它不记得上一轮',
    )
    expect(snapshot).not.toContain('sk-never-send-this')
    expect(snapshot).not.toContain('private-relay.example')
    expect(snapshot).not.toContain('also-secret')
    store.close()
  })

  test('没有派活工具的成员或普通 runtime 会话不携带模型清单', async () => {
    const { s, store } = await session()

    await firstEvent(s)

    const conv = listRecentConversations(store, 1)[0]!
    const snapshot = listRunContextSnapshots(store, conv.id)[0]!
      .segments.map((segment) => segment.content)
      .join('\n')
    expect(snapshot).not.toContain('可分配给子 agent 的已配置模型')
    expect(snapshot).not.toContain('当前项目的角色与外部 CLI')
    expect(snapshot).not.toContain('本会话的子 agent')
    store.close()
  })

  test('会话构造后配置发生变化，下一轮快照读取新值而不是旧前缀缓存', async () => {
    const liveConfig: QyConfig = {
      active: { provider: '主接口', model: 'glm-5.3-flash' },
      providers: {
        主接口: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-test-only',
          models: { 'glm-5.3-flash': {} },
        },
      },
    }
    const { s, store } = await session({ config: liveConfig, delegate })
    await firstEvent(s)

    liveConfig.providers.新增接口 = {
      kind: 'openai_chat_completions',
      apiKey: 'sk-test-only',
      models: { 'qwen/model-3.8': {} },
    }
    await firstEvent(s, '第二轮')

    const second = listRecentConversations(store).find((item) => item.title === '第二轮')!
    const latest = listRunContextSnapshots(store, second.id)[0]!
      .segments.map((segment) => segment.content)
      .join('\n')
    expect(latest).toContain('provider 参数 `新增接口`；model 参数 `qwen/model-3.8`')
    store.close()
  })
})

/**
 * 压缩会把工具结果压成 320 字摘录，workflowId 与 checkpointId 可能整个不在里面。
 * 快照必须把这张图的 id 与各节点续接情况送回模型，否则它只能整张重派。
 */
describe('未完成 workflow 的运行快照', () => {
  const seedWaitingGraph = (store: Store, conversationId: ConversationId) => {
    const run = createRun(store, {
      conversationId,
      workspaceId: listRecentConversations(store, 1)[0]!.workspaceId,
      model: 'deepseek-v4-flash',
      clientRequestId: 'seed-graph',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const args = {
      goal: '两个模型各做一版',
      nodes: [
        { id: 'build-glm', kind: 'temp', name: 'build-glm', task: '做 glm 版' },
        { id: 'build-qwen', kind: 'temp', name: 'build-qwen', task: '做 qwen 版' },
        {
          id: 'audit-builds',
          kind: 'checkpoint',
          label: '主会话验收',
          needs: ['build-glm', 'build-qwen'],
        },
      ],
    }
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_seed_graph',
      status: 'running',
      payload: { kind: 'tool_call', args },
    })
    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args,
      outcome: {
        status: 'success',
        executed: true,
        message: '等待审查',
        data: {
          workflowId: step.id,
          phase: 'waiting_review',
          checkpointId: 'audit-builds',
          receipts: [
            {
              nodeId: 'build-glm',
              label: 'glm',
              status: 'done',
              output: '做完了',
              durationMs: 1,
              subagentId: 'cv_glm',
            },
            {
              nodeId: 'build-qwen',
              label: 'qwen',
              status: 'failed',
              output: '',
              error: '步数用尽，任务没做完',
              durationMs: 1,
              subagentId: 'cv_qwen',
            },
          ],
        },
      },
    })
    return step.id
  }

  test('第二轮快照带上待审查的 workflowId、检查点与各节点续接情况', async () => {
    const { s, store } = await session({ delegate })
    for await (const _ of s.ask('第一轮')) break
    const conversation = listRecentConversations(store, 1)[0]!
    const workflowId = seedWaitingGraph(store, conversation.id)

    for await (const _ of s.ask('第二轮', conversation.id)) break

    const latest = listRunContextSnapshots(store, conversation.id)
      .at(-1)!
      .segments.map((segment) => segment.content)
      .join('\n')
    expect(latest).toContain('未完成的 workflow')
    expect(latest).toContain(`workflowId=${workflowId}`)
    expect(latest).toContain('当前检查点：audit-builds')
    expect(latest).toContain('build-qwen：failed：步数用尽，任务没做完，可续接原会话')
    store.close()
  })

  test('没有派活通道的会话不带这一段', async () => {
    const { s, store } = await session()
    for await (const _ of s.ask('第一轮')) break
    const conversation = listRecentConversations(store, 1)[0]!
    seedWaitingGraph(store, conversation.id)

    for await (const _ of s.ask('第二轮', conversation.id)) break

    const latest = listRunContextSnapshots(store, conversation.id)
      .at(-1)!
      .segments.map((segment) => segment.content)
      .join('\n')
    expect(latest).not.toContain('未完成的 workflow')
    store.close()
  })
})

/**
 * 被拦命令回给模型的那句话。
 *
 * 锁的是**这句话把模型推向哪里**，不是逐字文案（逐字断言改一个字就红，
 * 锁的是文案不是行为）。教它「换一条命令」的代价是具体的：`rm -rf ~/x`
 * 被拦就改写成 `python -c "import shutil; shutil.rmtree(...)"`，
 * 而后者不在 HARD_DENY 表里，因此同一件事照样发生。
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
  /*
   * 项目层的 MCP 要先授权才加载，而授权落在 `config.json` 里。这一份必须写进临时
   * 的 `QYWORK_HOME`，写本机真配置会给用户加上一条指向临时目录的授权。
   * 还原由文件末尾的 `afterEach` 负责。
   */
  process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qywork-sess-home-'))
  await writeFile(configPath(), JSON.stringify({ trustedWorkspaces: [root] }), 'utf8')
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
    await (
      s as unknown as { loadExtensionTools(d: TokenDensity): Promise<void> }
    ).loadExtensionTools(DEFAULT_DENSITY)
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
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    for (const key of over.disabled ?? []) setExtraEnabled(store, conv.id, key, false)

    const s = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: new AbortController().signal,
    })
    await (
      s as unknown as {
        loadExtensionTools(n: TokenDensity, d: ReadonlySet<string>, c: string): Promise<void>
      }
    ).loadExtensionTools(DEFAULT_DENSITY, listDisabledExtras(store, conv.id), conv.id)

    const registry = (s as unknown as { registry: ToolRegistry }).registry
    const nextSnapshot = () => {
      const pending = (
        s as unknown as {
          pendingTools: { index(): { name: string; summary: string }[] } | null
          opts: { workspaceRoot: string }
        }
      ).pendingTools
      return (
        buildTailNotes({
          workspaceRoot: root,
          platform: process.platform,
          mode: 'auto',
          externalTools: pending?.index() ?? [],
        }).find((note) => note.group === 'mcpTools')?.content ?? ''
      )
    }
    return { store, s, conv, registry, nextSnapshot }
  }

  test('超预算时那批工具不进 schemas，只出现一个 load_tool', async () => {
    const { store, s, registry, nextSnapshot } = await assemble()
    const names = registry.schemas().map((t) => t.name)

    expect(names).toContain('load_tool')
    expect(names.filter((n) => n.startsWith('mcp__fat__'))).toEqual([])
    // 但下一次 run 冻结快照时仍能看到待加载清单。
    expect(nextSnapshot()).toContain('mcp__fat__t0')
    s.dispose()
    store.close()
  }, 20_000)

  test('load_tool 装完就进 schemas，下一次 run 的快照不再列它', async () => {
    const { store, s, registry, nextSnapshot } = await assemble()
    const out = await registry.execute(
      'load_tool',
      { names: ['mcp__fat__t0'] },
      (
        s as unknown as { makeToolContext(r: string, e: () => void, m: string, c: string): unknown }
      ).makeToolContext('rn_x', () => {}, 'm', 'cv_x') as never,
    )

    expect(out.status).toBe('success')
    expect(registry.schemas().map((t) => t.name)).toContain('mcp__fat__t0')
    expect(nextSnapshot()).not.toContain('mcp__fat__t0：')
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
        loadExtensionTools(n: TokenDensity, d: ReadonlySet<string>, c: string): Promise<void>
      }
    ).loadExtensionTools(DEFAULT_DENSITY, listDisabledExtras(store, conv.id), conv.id)

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
    const { store, s, registry, nextSnapshot } = await assemble({ disabled: ['mcp:fat'] })
    expect(nextSnapshot()).toBe('')
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
        kind: 'openai_chat_completions',
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
  test("source: 'temp' 的会话不进会话列表", async () => {
    const { store, root } = await askOnce({ source: 'temp', sourceRef: 'reviewer' })
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
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
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
 * 还不存在（界面端是先建会话、后发第一句话），因此取到的只能是空串，
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
    const snapshots = listRunContextSnapshots(store, conv!.id)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.segments.some((segment) => segment.group === 'workspaceState')).toBe(true)
    store.close()
  })

  test('上一份待办全部完成后，第二条指令的 run 快照不再带旧清单', async () => {
    const { s, store } = await session()
    const ws = listWorkspaces(store)[0]!
    const conv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'deepseek-v4-flash',
    })
    const old = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'deepseek-v4-flash',
      clientRequestId: 'old-completed-todos',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    appendStep(store, {
      runId: old.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_todos',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { todos: [{ content: '旧任务', status: 'completed' }] },
      } as never,
    })

    await firstEvent(s, '检查三个新问题并逐项修复', conv.id)

    const snapshot = listRunContextSnapshots(store, conv.id).at(-1)?.segments ?? []
    expect(snapshot.some((segment) => segment.content.includes('## 当前待办清单'))).toBe(false)
    expect(snapshot.map((segment) => segment.content).join('\n')).not.toContain('旧任务')
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

/*
 * 被折叠历史的回读。
 *
 * 摘要里 run 内注入的那句用户消息印的是 `[message:<runId>:<stepId>]` ——
 * 它不在 `messages` 表里。这条通道少了那一手回落，摘要上写着地址、取回却报
 * 「不存在」，压缩就真成了丢信息。
 */
describe('注入消息的回读', () => {
  test('按 <runId>:<stepId> 取得回原文，执行记录那一侧回 null', async () => {
    const { s, store } = await session()
    const ws = listWorkspaces(store)[0]!
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'c1',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'user',
      content: '改成只列文件名',
      payload: { kind: 'user' },
    })

    const make = (
      s as unknown as {
        makeToolContext(r: string, e: () => void, m: string, c: string): ToolContext
      }
    ).makeToolContext.bind(s)
    const ctx = make(run.id, () => {}, 'm', conv.id)
    const address = `${run.id}:${step.id}`

    expect(ctx.history?.message(address)).toEqual({ role: 'user', content: '改成只列文件名' })
    // 执行记录那一侧必须回 null：它的返回形状是 {tool,status,args,outcome}，
    // 套上去只会得到一个 tool:'unknown' 加两个空 JSON——看起来被处理了。
    expect(ctx.history?.step(address)).toBeNull()
    // 搜索按「消息」报，因此模型拿到的标记是 [message:…]，与取回入口对得上。
    expect(ctx.history?.search('只列文件名', 10)).toEqual([
      { id: address, kind: 'message', line: '改成只列文件名' },
    ])
    store.close()
  })
})

/** `workspaceWithMcp` 会改 `QYWORK_HOME`，每条用例跑完还回去。 */
const HOME_BEFORE = process.env.QYWORK_HOME
afterEach(() => {
  if (HOME_BEFORE === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = HOME_BEFORE
})
