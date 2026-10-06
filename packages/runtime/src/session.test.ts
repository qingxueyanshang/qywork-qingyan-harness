/**
 * Session 的装配结果：工具集与角色约束。
 *
 * 不测试完整执行一轮：完整执行需要真实 provider，由 scripts/smoke-serve.ts 覆盖。
 * 此处测试装配结果，因为 Agent Team 的角色隔离完全建立在装配结果之上：
 * 「只读」角色的 allowedTools 未生效时，该角色仍能修改文件，而配置看起来正确。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserPort, DelegatePort, ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY, lookupModel, type TokenDensity } from '@qywork/ai'
import type { ConversationId } from '@qywork/core'
import {
  appendStep,
  createConversation,
  createRun,
  fileReadHash,
  listConversations,
  listMessages,
  listRecentConversations,
  listRunContextSnapshots,
  listWorkspaces,
  Store,
  setConversationTitle,
  setStepNodeState,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { NO_MODEL_MESSAGE, type QyConfig } from './config.ts'
import { buildTailNotes, outputLimitNote } from './prompt.ts'
import { Session, withAttachments } from './session.ts'

const config: QyConfig = {
  active: { provider: 'p', model: 'deepseek-v4-flash' },
  providers: {
    p: {
      kind: 'openai_chat_completions',
      apiKey: 'sk-x',
      baseUrl: 'https://relay.example/v1',
      models: { 'deepseek-v4-flash': {} },
    },
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
  // 工具表是私有的，经由公开的 `schemas()` 读取：测试的是模型实际看到的内容。
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
  dispatch: async () => ({ ok: true, subagentId: 'cv_stub' }),
  runGraph: async () => ({ ok: true }),
  inflight: () => [],
}

describe('派发工具只提供给有派发通道的会话', () => {
  test('顶层会话有 define_role、subagent、workflow；成员会话均没有', async () => {
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
  /** 1×1 的 PNG：在缩放上限与 300 KB 以内，按原样编码。 */
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const attachment = (name: string, type: 'image' | 'video' | 'file') => ({
    type,
    name,
    mime: '',
    size: 0,
    path: name,
  })

  /** 每一轮的图片都放入内容块，正文中保留名称与路径：换出之后模型依据该行定位原文件。 */
  test('图片编码为 base64 图像块，正文保留名称与路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-attachment-'))
    await writeFile(join(root, 'chart.png'), PNG_1X1)
    const out = await withAttachments(root, '分析这张图', [attachment('chart.png', 'image')])
    expect(out).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'base64', data: PNG_1X1.toString('base64') },
      },
      { type: 'text', text: expect.stringContaining('分析这张图') },
    ])
    const text = (out as { type: string; text?: string }[])[1]!.text!
    expect(text).toContain(`（附件 chart.png：${join(root, 'chart.png').replaceAll('\\', '/')}）`)
  })

  test('视频放入路径块，普通文件只保留路径，无法读取的附件保留一行说明', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-attachment-'))
    await writeFile(join(root, 'clip.mp4'), Buffer.from([0, 0, 0]))
    await writeFile(join(root, 'notes.txt'), 'x')
    const out = (await withAttachments(root, '看看', [
      attachment('clip.mp4', 'video'),
      attachment('notes.txt', 'file'),
      attachment('gone.png', 'image'),
    ])) as { type: string; text?: string; source?: unknown }[]
    expect(out[0]).toMatchObject({
      type: 'video',
      source: { kind: 'path', path: join(root, 'clip.mp4').replaceAll('\\', '/') },
    })
    expect(out[1]!.type).toBe('text')
    expect(out[1]!.text).toContain('（附件 notes.txt：')
    expect(out[1]!.text).toContain('（附件 gone.png 已不存在，跳过）')
  })

  /** 附件是实时引用：文件修改后，下一轮读取新内容，不返回缓存中的旧编码。 */
  test('文件修改后重新编码', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-attachment-'))
    const path = join(root, 'live.png')
    await writeFile(path, PNG_1X1)
    const first = (await withAttachments(root, 'a', [attachment('live.png', 'image')])) as {
      source?: { data?: string }
    }[]
    const changed = Buffer.concat([PNG_1X1, Buffer.from([0])])
    await writeFile(path, changed)
    const second = (await withAttachments(root, 'a', [attachment('live.png', 'image')])) as {
      source?: { data?: string }
    }[]
    expect(first[0]!.source!.data).toBe(PNG_1X1.toString('base64'))
    expect(second[0]!.source!.data).toBe(changed.toString('base64'))
  })
})

describe('工具集', () => {
  test('不传 allowedTools 时注册全部内置工具', async () => {
    const { names, store } = await session()
    expect(names()).toContain('read_file')
    expect(names()).toContain('run_command')
    expect(names().length).toBeGreaterThan(10)
    store.close()
  })

  test('传入时只注册所列工具', async () => {
    const { names, store } = await session({ allowedTools: ['read_file', 'grep'] })
    expect(names().sort()).toEqual(['grep', 'read_file'])
    store.close()
  })

  /**
   * 空数组与不传语义不同。合并两者会使「只做分析、不提供任何工具」
   * 这类角色配置静默变为「允许全部工具」，且无法察觉。
   */
  test('空数组表示不提供任何工具，不回退到全部工具', async () => {
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

/** 按 `makeLoop` 的真实入参取得系统提示词：构造 loop 时只读取适配器的 `spec`。 */
function systemPromptFor(
  s: Session,
  model: string,
  kind: 'anthropic_messages' | 'openai_chat_completions',
) {
  const loop = (
    s as unknown as {
      makeLoop(m: string, adapter: unknown): { deps: { systemPrompt: string } }
    }
  ).makeLoop(model, { spec: lookupModel(model, kind) })
  return loop.deps.systemPrompt
}

describe('角色约束', () => {
  test('extraSystem 写入冻结前缀', async () => {
    const { s, store } = await session({ extraSystem: '你只做代码审查，不改任何文件' })
    expect(systemPromptFor(s, 'deepseek-flash', 'openai_chat_completions')).toContain(
      '你只做代码审查',
    )
    store.close()
  })

  test('不传时前缀与默认完全一致，避免多出一段导致缓存失效', async () => {
    const { s, store } = await session()
    expect(systemPromptFor(s, 'deepseek-flash', 'openai_chat_completions')).not.toContain('## 角色')
    store.close()
  })
})

describe('输出上限说明', () => {
  test('按本轮模型的目录条目决定：Claude 附加上限原文，其他厂商不附加', async () => {
    const { s, store } = await session()
    expect(systemPromptFor(s, 'claude-opus-5-5', 'anthropic_messages')).toContain(
      outputLimitNote(128_000),
    )
    expect(systemPromptFor(s, 'deepseek-flash', 'openai_chat_completions')).not.toContain(
      'Everything Claude produces',
    )
    store.close()
  })
})

describe('顶层会话的可分配模型快照', () => {
  const firstEvent = async (s: Session, prompt = '让 glm、qwen 分别建角色处理') => {
    for await (const ev of s.ask(prompt)) return ev
    return null
  }

  test('从当前配置只提取接口与模型，随 run 写入数据库供规划模型选择', async () => {
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
    // 角色、外部 CLI、本会话已有的子 agent 在同一份快照中给出，模型按 id 引用。
    expect(snapshot).toContain('角色 id `reviewer`：审查员，看代码；模型 p / m')
    expect(snapshot).toContain('外部 CLI id `codex`：OpenAI，本机进程，自带模型与账号，已接入')
    expect(snapshot).toContain('subagentId `cv_sub`：查资料，临时，模型 p / m，空闲')
    expect(snapshot).toContain(
      'subagentId `cv_cli`：OpenAI codex，外部 CLI，模型 cli / codex，空闲，不可续接：缺少会话号，再次派发时不保留上一轮上下文',
    )
    expect(snapshot).not.toContain('sk-never-send-this')
    expect(snapshot).not.toContain('private-relay.example')
    expect(snapshot).not.toContain('also-secret')
    store.close()
  })

  test('没有派发工具的成员或普通 runtime 会话不携带模型清单', async () => {
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
 * 压缩会将工具结果缩减为 320 字摘录，workflowId 与 checkpointId 可能完全不在其中。
 * 快照必须将该任务图的 id 与各节点续接情况重新提供给模型，否则模型只能重新派发整张图。
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
    // 回执即节点的终态：两个节点都已进入终态，因此当前检查点是待审查的那一个。
    setStepNodeState(store, step.id, 'build-glm', {
      phase: 'done',
      label: 'glm',
      output: '做完了',
      durationMs: 1,
      subagentId: 'cv_glm' as never,
    })
    setStepNodeState(store, step.id, 'build-qwen', {
      phase: 'failed',
      label: 'qwen',
      error: '步数用尽，任务没做完',
      durationMs: 1,
      subagentId: 'cv_qwen' as never,
    })
    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args,
      outcome: {
        status: 'success',
        executed: true,
        message: '已起跑',
        data: { workflowId: step.id, dispatched: ['build-glm', 'build-qwen'] },
      },
    })
    return step.id
  }

  test('第二轮快照包含待审查的 workflowId、检查点与各节点续接情况', async () => {
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

  test('没有派发通道的会话不包含该段', async () => {
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
 * 被拦截的命令返回给模型的说明。
 *
 * 锁定的是该说明引导模型采取的行为，不是逐字文案（逐字断言在改动一个字时即失败，
 * 锁定的是文案而不是行为）。引导模型「换一条命令」会使拦截失效：`rm -rf ~/x`
 * 被拦截后改写为 `python -c "import shutil; shutil.rmtree(...)"`，
 * 而后者不在 HARD_DENY 表中，因此同一操作仍会执行。
 */
describe('被拒绝时返回的说明', () => {
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

  test('给出「由用户提升权限」与「跳过」两种处理方式', async () => {
    const v = await denyFor('rm -rf ~/')
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain('完全访问')
    expect(v.reason).toContain('跳过')
  })

  test('不引导更换写法：提及「换」之处必须都是否定句', async () => {
    const { reason } = await denyFor('rm -rf ~/')
    const mentions = (reason.match(/换/g) ?? []).length
    const negated = (reason.match(/不要换|不能换|别换/g) ?? []).length
    expect(mentions).toBe(negated)
  })
})

/**
 * 可真实完成握手的 MCP server，工具表由调用方提供。
 *
 * 两个 describe 共用：一个测试 allowedTools 的过滤，一个测试 schema 按总量转为按需加载。
 * 两者都需要真实的 stdio server：复制为两份会导致后续修改只作用于其中一份。
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
   * 加载时会合并全局层的 `mcp.json`，因此指向临时的 `QYWORK_HOME`，不连接本机真实配置中的 server。
   * 还原由文件末尾的 `afterEach` 负责。
   */
  process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qywork-sess-home-'))
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
 * allowedTools 必须同时约束扩展工具，也必须识别它们。
 *
 * 只过滤内置工具时，一个「只读」角色仍能调用插件中的写工具；
 * 而「名称是否写错」的判定如果在扩展加载之前执行，合法的
 * `mcp__demo__ping` 会被报告为未知，导致用户排查一个不存在的问题。
 */
describe('allowedTools 与扩展工具', () => {
  test('allowedTools 中可以指定 MCP 工具，且只放行指定的工具', async () => {
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
    // 同一 server 的另一个工具未被指定，不应出现。
    expect(names).not.toContain('mcp__demo__pong')
    s.dispose()
    store.close()
  }, 20_000)
})

/**
 * 外部工具的 schema 按总量转为按需加载。
 *
 * 锁定的是超出预算时这些 schema 确实未进入请求：该约束失效时不会报错，
 * 只会使费用不变，按需加载失去作用且无法察觉。
 *
 * 阈值与实测数据在 `tools/tool-pool.ts`。此处的大体积 server 用长描述增加总量，
 * 不依赖具体阈值，只依赖总量超出预算。
 */
describe('外部工具按总量转为按需加载', () => {
  const fatTools = Array.from({ length: 8 }, (_, i) => ({
    name: `t${i}`,
    description: 'x'.repeat(800),
  }))

  async function assemble() {
    const store = new Store({ path: ':memory:' })
    const root = await workspaceWithMcp('fat', fatTools)
    const ws = upsertWorkspace(store, root, 'ws')
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })

    const s = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: new AbortController().signal,
    })
    await (
      s as unknown as { loadExtensionTools(n: TokenDensity, c: string): Promise<void> }
    ).loadExtensionTools(DEFAULT_DENSITY, conv.id)

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

  test('超出预算时外部工具不进入 schemas，只出现一个 load_tool', async () => {
    const { store, s, registry, nextSnapshot } = await assemble()
    const names = registry.schemas().map((t) => t.name)

    expect(names).toContain('load_tool')
    expect(names.filter((n) => n.startsWith('mcp__fat__'))).toEqual([])
    // 但下一次 run 冻结快照时仍能看到待加载清单。
    expect(nextSnapshot()).toContain('mcp__fat__t0')
    s.dispose()
    store.close()
  }, 20_000)

  test('load_tool 加载后即进入 schemas，下一次 run 的快照不再列出该工具', async () => {
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
   * 每条消息新建一个 Session，进程内的「已加载」集合无法跨消息保留。
   * 只有写入账本才有效，否则模型每轮都须重新加载。
   */
  test('已加载的工具在下一条消息中直接位于工具表内', async () => {
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
      next as unknown as { loadExtensionTools(n: TokenDensity, c: string): Promise<void> }
    ).loadExtensionTools(DEFAULT_DENSITY, conv.id)

    const names = (next as unknown as { registry: ToolRegistry }).registry
      .schemas()
      .map((t) => t.name)
    expect(names).toContain('mcp__fat__t0')
    // 只恢复已加载的工具，其余仍待加载。
    expect(names).not.toContain('mcp__fat__t1')
    next.dispose()
    s.dispose()
    store.close()
  }, 20_000)
})

/**
 * 新建会话的来源标记。
 *
 * `ask` 不带 conversationId 时会立即创建会话：这一步发生在任何 provider
 * 调用之前，因此使用必然无法连接的 baseUrl 即可测试：请求失败，
 * 但会话已写入数据库。
 */
describe('新建会话的来源', () => {
  const offline: QyConfig = {
    active: { provider: 'p', model: 'deepseek-v4-flash' },
    providers: {
      p: {
        kind: 'openai_chat_completions',
        apiKey: 'sk-x',
        // 端口 1 上没有监听方，连接立即被拒绝：不访问网络，也不等待超时。
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
    const controller = new AbortController()
    const s = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: controller.signal,
    })
    try {
      for await (const ev of s.ask('查一下这个函数', undefined, over)) {
        // 只需执行到第一次 provider 调用，不检查产出。该事件说明该次调用已经
        // 失败，其后是分钟量级的重发退避，因此在此中止。
        if (ev.type === 'run.retrying') controller.abort()
      }
    } catch {
      // 连接失败符合预期。
    }
    s.dispose()
    return { store, root }
  }

  /**
   * 复现原始失败形状：team 成员的子会话不带来源标记时，每执行一次 team，
   * 用户的会话列表中就多出 N 条以成员 prompt 开头的条目。
   */
  test("source: 'temp' 的会话不列入会话列表", async () => {
    const { store, root } = await askOnce({ source: 'temp', sourceRef: 'reviewer' })
    const ws = upsertWorkspace(store, root, 'x')
    expect(listConversations(store, ws.id)).toEqual([])
    expect(listRecentConversations(store)).toEqual([])
    store.close()
  })

  /** 不填写时仍为用户会话：`qy run "..."` 使用此路径，此类会话必须能被列出。 */
  test('未填写来源的仍为用户会话', async () => {
    const { store, root } = await askOnce()
    const ws = upsertWorkspace(store, root, 'x')
    expect(listConversations(store, ws.id)).toHaveLength(1)
    expect(listConversations(store, ws.id)[0]?.source).toBeNull()
  })

  /**
   * 未配置模型时发送被拒绝：在创建 run 之前抛出，且不创建会话；不能先写入一条没有模型、
   * 无法发出请求的会话再报错。此处测试的是行为，不是调用次数。
   */
  test('未配置模型时在创建 run 之前拒绝，且不创建会话', async () => {
    const store = new Store({ path: ':memory:' })
    const root = await mkdtemp(join(tmpdir(), 'qywork-src-'))
    const noModel = { providers: {} } as QyConfig
    const s = new Session({
      store,
      config: noModel,
      workspaceRoot: root,
      signal: new AbortController().signal,
    })
    let threw: unknown = null
    try {
      for await (const _ of s.ask('随便问一句')) break
    } catch (e) {
      threw = e
    }
    s.dispose()
    expect((threw as Error | null)?.message).toBe(NO_MODEL_MESSAGE)
    const ws = upsertWorkspace(store, root, 'x')
    expect(listConversations(store, ws.id)).toEqual([])
    store.close()
  })
})

/**
 * 读取记录是否已接入。
 *
 * 本组锁定装配：`files.ts` 只约定形状，生命周期由此处提供。未接入时
 * 它会静默回退到 run 内记账，上一轮已读取的文件在本轮修改时因此先失败一次：
 * 即原始失败形状，且不产生任何报错。
 */
describe('工具上下文的读取记录', () => {
  test('两个 run 共用同一份记录，且写入账本并按会话归属', async () => {
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
 * 标题只在一处产生：第一条用户消息写入数据库之后。创建会话时不生成标题：此时正文
 * 尚不存在（界面端先创建会话、后发送第一条消息），只能取得空串，
 * 侧栏会因此显示一整列「新对话」。
 *
 * 此处只消费 `ask()` 的第一条事件即停止：标题在此之前已写入，继续执行则需要真实
 * 连接 provider。在此处停止同时验证：不发出任何请求时标题已经存在。
 */
describe('会话标题', () => {
  const firstEvent = async (s: Session, prompt: string, existing?: string) => {
    for await (const ev of s.ask(prompt, existing as never)) return ev
    return null
  }

  test('第一条消息确定标题，并立即广播', async () => {
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

  test('上一份待办全部完成后，第二条指令的 run 快照不再包含旧清单', async () => {
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

  /* 第二条消息不得覆盖第一条消息确定的名称，否则列表中该行会随每次发言变化。 */
  test('第二条消息不覆盖已有标题', async () => {
    const { s, store } = await session()
    await firstEvent(s, '第一句')
    const conv = listRecentConversations(store, 1)[0]
    await firstEvent(s, '第二句', conv?.id)
    expect(listRecentConversations(store, 1)[0]?.title).toBe('第一句')
    store.close()
  })

  /* 用户修改过的名称同样不得被下一条消息覆盖。 */
  test('用户修改过的名称不被覆盖', async () => {
    const { s, store } = await session()
    await firstEvent(s, '第一句')
    const conv = listRecentConversations(store, 1)[0]
    setConversationTitle(store, conv?.id as never, '我自己起的名字')
    await firstEvent(s, '第二句', conv?.id)
    expect(listRecentConversations(store, 1)[0]?.title).toBe('我自己起的名字')
    store.close()
  })

  /*
   * 处理第一条消息时，读取会话与写入自动标题之间间隔若干 await。在其间必经的 `delegate.targets()` 中改名，
   * 复现发出第一条消息后立即改名的情况：自动标题不得覆盖该名称。
   */
  test('读取会话之后、写入自动标题之前用户修改了名称：保留用户的名称', async () => {
    let target: Store | null = null
    const renaming: DelegatePort = {
      ...delegate,
      targets: async () => {
        const conv = target ? listRecentConversations(target, 1)[0] : undefined
        if (target && conv) setConversationTitle(target, conv.id, '中途改的名字')
        return delegate.targets()
      },
    }
    const { s, store } = await session({ delegate: renaming })
    target = store
    await firstEvent(s, '第一句')
    expect(listRecentConversations(store, 1)[0]?.title).toBe('中途改的名字')
    s.dispose()
    store.close()
  })
})

/*
 * 被折叠历史的读取。
 *
 * 摘要中 run 内注入的用户消息标记为 `[message:<runId>:<stepId>]`，
 * 该消息不在 `messages` 表中。此通道缺少这一回退时，摘要中写有地址、取回却报告
 * 不存在，压缩即造成信息丢失。
 */
describe('注入消息的读取', () => {
  test('按 <runId>:<stepId> 取回原文，执行记录入口返回 null', async () => {
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
    // 执行记录入口必须返回 null：其返回形状是 {tool,status,args,outcome}，
    // 套用到该记录只会得到 tool:'unknown' 与两个空 JSON，看起来已被处理。
    expect(ctx.history?.step(address)).toBeNull()
    // 搜索按消息类型报告，因此模型取得的标记是 [message:…]，与取回入口一致。
    expect(ctx.history?.search('只列文件名', 10)).toEqual([
      { id: address, kind: 'message', line: '改成只列文件名' },
    ])
    store.close()
  })

  /**
   * 助手正文位于 text step 中。摘要中给出的地址是本次生成的第一条 text step，
   * 读取结果必须是整段正文（思考将其切分为多条），执行记录入口返回 null，搜索按消息类型报告。
   */
  test('助手正文按 <runId>:<stepId> 取回整段且可被搜索，执行记录入口返回 null', async () => {
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
    const first = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'text',
      content: '先定签名算法：',
      providerBatchId: 'bt_1',
    })
    appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'thinking',
      content: '想',
      providerBatchId: 'bt_1',
    })
    const rest = appendStep(store, {
      runId: run.id,
      seq: 3,
      kind: 'text',
      content: '用 RS256。',
      providerBatchId: 'bt_1',
    })

    const make = (
      s as unknown as {
        makeToolContext(r: string, e: () => void, m: string, c: string): ToolContext
      }
    ).makeToolContext.bind(s)
    const ctx = make(run.id, () => {}, 'm', conv.id)
    const address = `${run.id}:${first.id}`

    expect(ctx.history?.message(address)).toEqual({
      role: 'assistant',
      content: '先定签名算法：用 RS256。',
    })
    expect(ctx.history?.step(address)).toBeNull()
    // 命中的是切分后的其中一条；按其地址读取的仍是整段。
    expect(ctx.history?.search('RS256', 10)).toEqual([
      { id: `${run.id}:${rest.id}`, kind: 'message', line: '用 RS256。' },
    ])
    expect(ctx.history?.message(`${run.id}:${rest.id}`)?.content).toBe('先定签名算法：用 RS256。')
    store.close()
  })
})

/*
 * 带图执行记录的读取。
 *
 * 图像字节固定保存在 step payload 的 `outcome.data.images` 中；取回时必须作为图像块返回，
 * outcome 文本中不得包含 base64：模型无法理解这段正文，却按全额计费。
 */
describe('带图执行记录的读取', () => {
  test('call_id 与 step id 两个入口都将图片拆分为图像块，outcome 文本不含字节', async () => {
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
    const shot = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: 'call_shot',
      providerBatchId: 'bt_1',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, shot.id, 'success', {
      kind: 'tool_result',
      args: { path: 'shot.png' },
      outcome: {
        status: 'success',
        executed: true,
        message: '读取 shot.png（图片）',
        data: { images: [{ data: 'QUJD', mime: 'image/png' }] },
      },
    } as never)
    const plain = appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: 'call_plain',
      providerBatchId: 'bt_2',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, plain.id, 'success', {
      kind: 'tool_result',
      args: { path: 'a.ts' },
      outcome: { status: 'success', executed: true, message: '读取 a.ts', data: { lines: 3 } },
    } as never)

    const make = (
      s as unknown as {
        makeToolContext(r: string, e: () => void, m: string, c: string): ToolContext
      }
    ).makeToolContext.bind(s)
    const ctx = make(run.id, () => {}, 'm', conv.id)

    const byCall = ctx.history?.byCallId('call_shot')
    expect(byCall?.images).toEqual([{ data: 'QUJD', mime: 'image/png' }])
    expect(byCall?.outcome).not.toContain('QUJD')
    expect(JSON.parse(byCall?.outcome ?? '{}')).toMatchObject({ message: '读取 shot.png（图片）' })
    expect(ctx.history?.step(`${run.id}:${shot.id}`)).toEqual(byCall)

    // 没有图的记录不带 `images` 键，`data` 原样保留。
    const text = ctx.history?.byCallId('call_plain')
    expect(text).not.toHaveProperty('images')
    expect(JSON.parse(text?.outcome ?? '{}')).toMatchObject({ data: { lines: 3 } })
    store.close()
  })
})

/** `workspaceWithMcp` 会修改 `QYWORK_HOME`，每条用例执行完毕后恢复原值。 */
const HOME_BEFORE = process.env.QYWORK_HOME
afterEach(() => {
  if (HOME_BEFORE === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = HOME_BEFORE
})

describe('浏览器控制与本轮执行绑定', () => {
  /** 只记录调用情况。断言的是释放时机，不是调用次数。 */
  function fakeBrowser(): { port: BrowserPort; released: () => number } {
    let released = 0
    const tab = { tabId: 'bt_1', url: 'https://a', title: 'A', controlled: true }
    const observation = {
      tabId: 'bt_1',
      url: 'https://a',
      title: 'A',
      observationId: 'ob_1',
      elements: [],
      truncated: false,
    }
    const port = {
      tabs: async () => [tab],
      open: async () => tab,
      bind: async () => tab,
      close: async () => {},
      navigate: async () => ({ observation }),
      observe: async () => observation,
      act: async () => ({ observation }),
      wait: async () => ({ met: true, observation }),
      upload: async () => ({ files: [] }),
      download: async () => ({}),
      release: async () => {
        released += 1
      },
    } satisfies BrowserPort
    return { port, released: () => released }
  }

  test('用户停止时立即撤销控制，不等待本轮收尾', async () => {
    const browser = fakeBrowser()
    const ac = new AbortController()
    const { s, store } = await session({ browser: browser.port, signal: ac.signal })
    expect(browser.released()).toBe(0)
    ac.abort()
    await new Promise((r) => setTimeout(r, 0))
    expect(browser.released()).toBe(1)
    s.dispose()
    store.close()
  })

  test('收尾时同样释放一次，重复调用由端口自行处理', async () => {
    const browser = fakeBrowser()
    const { s, store } = await session({ browser: browser.port })
    s.dispose()
    await new Promise((r) => setTimeout(r, 0))
    expect(browser.released()).toBe(1)
    store.close()
  })

  /** 七个内置浏览器工具。整组按通道注册，不单独开关。 */
  const SEVEN = [
    'browser_tabs',
    'browser_navigate',
    'browser_observe',
    'browser_act',
    'browser_wait',
    'browser_upload',
    'browser_download',
  ]

  test('没有端口时七个浏览器工具均不注册，不保留必然报错的工具名', async () => {
    const { s, store, names } = await session()
    const listed = names()
    for (const name of SEVEN) expect(listed).not.toContain(name)
    s.dispose()
    store.close()
  })

  test('接入端口之后七个工具均进入工具表', async () => {
    const browser = fakeBrowser()
    const { s, store, names } = await session({ browser: browser.port })
    const listed = names()
    for (const name of SEVEN) expect(listed).toContain(name)
    s.dispose()
    store.close()
  })

  test('角色的 allowedTools 同样筛选浏览器工具', async () => {
    const browser = fakeBrowser()
    const { s, store, names } = await session({
      browser: browser.port,
      allowedTools: ['browser_observe', 'read_file'],
    })
    const listed = names()
    expect(listed).toContain('browser_observe')
    expect(listed).not.toContain('browser_act')
    s.dispose()
    store.close()
  })

  test('成员会话没有端口，即使指定也无法注册', async () => {
    const { s, store, names } = await session({
      allowedTools: ['browser_observe', 'read_file'],
    })
    const listed = names()
    expect(listed).toContain('read_file')
    expect(listed).not.toContain('browser_observe')
    s.dispose()
    store.close()
  })

  test('没有端口时工具上下文中没有浏览器通道', async () => {
    const { s, store } = await session()
    const ctx = (
      s as unknown as {
        makeToolContext(r: string, e: () => void, t: string, c: string): ToolContext
      }
    ).makeToolContext('run_1', () => {}, 'deepseek-v4-flash', 'cv_1')
    expect(ctx.browser).toBeUndefined()
    s.dispose()
    store.close()
  })

  test('有端口时原样透传给工具上下文', async () => {
    const browser = fakeBrowser()
    const { s, store } = await session({ browser: browser.port })
    const ctx = (
      s as unknown as {
        makeToolContext(r: string, e: () => void, t: string, c: string): ToolContext
      }
    ).makeToolContext('run_1', () => {}, 'deepseek-v4-flash', 'cv_1')
    expect(ctx.browser).toBe(browser.port)
    s.dispose()
    store.close()
  })
})

/*
 * 同一会话被另一个进程占用（例如终端的 qy 正在运行该会话，桌面端又发送了一条消息）。
 * 占用进程是 `store` 包的测试子进程，创建一轮后不退出。
 */
describe('会话被另一个进程占用', () => {
  test('创建轮次被拒绝并说明占用方，该消息不写入数据库', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-sess-busy-'))
    const path = join(dir, 'ledger.sqlite3')
    const store = new Store({ path, owner: 'serve' })
    const s = new Session({
      store,
      config,
      workspaceRoot: dir,
      signal: new AbortController().signal,
    })
    const ws = listWorkspaces(store)[0]!
    const conv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'deepseek-v4-flash',
    })
    const holder = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../../store/src/concurrency-child.ts')],
      {
        env: {
          ...process.env,
          QY_CC_MODE: 'hold',
          QY_CC_DB: path,
          QY_CC_ARG: `${conv.id}|${ws.id}`,
          QY_CC_OWNER: 'cli',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    try {
      const reader = holder.stdout.getReader()
      let text = ''
      while (!text.includes(String.fromCharCode(10))) {
        const { value, done } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
      }
      expect(JSON.parse(text.trim()).ok).toBe(true)

      let error: unknown = null
      try {
        for await (const _ of s.ask('桌面端发的一句', conv.id)) {
          // 被拒绝时不应产生任何事件。
        }
      } catch (err) {
        error = err
      }
      expect(String((error as Error | null)?.message)).toContain(
        `该会话已在终端的 qy 中执行（pid ${holder.pid}）`,
      )
      expect(listMessages(store, conv.id)).toEqual([])
    } finally {
      holder.kill()
      await holder.exited
      s.dispose()
      store.close()
    }
  }, 30_000)
})
