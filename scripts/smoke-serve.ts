#!/usr/bin/env bun
/**
 * `qy serve` 端到端冒烟：启动服务 → 调用 HTTP API → 经 WebSocket 驱动一轮真实 agent。
 *
 * 该路径与桌面端和手机端使用的路径相同，因此验证的不只是服务能否启动，
 * 还包括客户端协议是否可用：握手、订阅、下发指令、接收流式事件、断线补发。
 *
 *   bun run scripts/smoke-serve.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, CommandRejectedFrame, EventEnvelope, HelloOkFrame } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import {
  appendStep,
  createConversation,
  createRun,
  getRun,
  listSteps,
  markRunRunning,
  markStepExecuting,
  Store,
  upsertWorkspace,
} from '@qywork/store'

const WS_DIR = join(import.meta.dir, '..', '.tmp', 'smoke-ws')
const DB = join(WS_DIR, 'smoke.sqlite3')

/**
 * 单轮 agent 的超时。
 *
 * 300 秒不是保守值，而是实测值：同一个任务在 DeepSeek 上的耗时波动很大，
 * 设为 180 秒时多次出现仍在流式输出即被判定超时，即把 provider 的耗时波动
 * 记为本地缺陷，比没有测试更糟。
 */
const RUN_TIMEOUT_MS = 300_000

/**
 * `Response.json()` 返回 unknown。冒烟脚本只关心返回的几个键是否正确，
 * 统一在此处断言一次，调用点不再各自使用 `as`：各自断言会导致类型形状不一致。
 */
async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail)}\n`)
  }
}

async function main(): Promise<number> {
  await rm(WS_DIR, { recursive: true, force: true })
  await mkdir(WS_DIR, { recursive: true })
  await writeFile(
    join(WS_DIR, 'calc.js'),
    'function add(a, b) {\n  return a + b\n}\n\nmodule.exports = { add }\n',
    'utf8',
  )

  const store = new Store({ path: DB })
  const config = await loadConfig()

  // port 0 表示由内核选择空闲端口，避免与开发机上已占用的 7717 冲突。
  const h = serve({
    store,
    config,
    workspaceRoot: WS_DIR,
    port: 0,
    host: '127.0.0.1',
  })
  const base = `http://127.0.0.1:${h.port}`
  const auth = { authorization: `Bearer ${h.token}` }
  process.stdout.write(`\n服务已启动：${base}\n\n`)

  try {
    // ── HTTP ──
    process.stdout.write('HTTP API\n')

    // `Response.json()` 返回 unknown：只断言用到的几个键，
    // 不引入完整的响应类型，冒烟脚本只关心返回是否正确。
    const health = (await json(await fetch(`${base}/api/health`))) as { ok?: boolean }
    check('健康检查免鉴权', health.ok === true)

    const noAuth = await fetch(`${base}/api/workspaces`)
    check('无令牌访问 API 返回 401', noAuth.status === 401, noAuth.status)

    const badAuth = await fetch(`${base}/api/workspaces`, {
      headers: { authorization: `Bearer ${'0'.repeat(h.token.length)}` },
    })
    check('错误令牌返回 401', badAuth.status === 401, badAuth.status)

    const tree = await json<{ nodes?: { name: string }[] }>(
      await fetch(`${base}/api/files/tree?depth=2`, { headers: auth }),
    )
    check(
      '文件树列出 calc.js',
      Array.isArray(tree.nodes) && tree.nodes.some((n) => n.name === 'calc.js'),
      tree,
    )

    const prev = await json(
      await fetch(`${base}/api/files/preview?path=calc.js`, { headers: auth }),
    )
    check('文件预览返回文本与语言', prev.kind === 'text' && prev.language === 'javascript', {
      kind: prev.kind,
      language: prev.language,
    })

    const escapeAttempt = await fetch(`${base}/api/files/preview?path=../../../etc/passwd`, {
      headers: auth,
    })
    check('预览接口拦截路径穿越', escapeAttempt.status >= 400, escapeAttempt.status)

    const gitStatus = await json(await fetch(`${base}/api/git/status`, { headers: auth }))
    check('git 状态可查（非仓库时 repo=false）', typeof gitStatus.repo === 'boolean', gitStatus)

    const created = await json<{ conversation?: { id?: string; model?: string } }>(
      await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '冒烟' }),
      }),
    )
    const conversationId = created.conversation?.id ?? ''
    check('创建会话', typeof conversationId === 'string' && conversationId.startsWith('cv_'))

    // ── WebSocket ──
    process.stdout.write('\nWebSocket 协议\n')

    const badWs = new WebSocket(`ws://127.0.0.1:${h.port}/stream?token=wrong`)
    const badClosed = await new Promise<boolean>((res) => {
      badWs.addEventListener('close', () => res(true), { once: true })
      badWs.addEventListener('error', () => res(true), { once: true })
      setTimeout(() => res(false), 3000)
    })
    check('握手期错误令牌被拒', badClosed)

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/stream?token=${h.token}&origin=desktop`)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })

    const frames: EventEnvelope<AgentEvent>[] = []
    const rejections: CommandRejectedFrame[] = []
    // 放在对象中而不是用 `let`：赋值发生在下方的回调中，而 TS 对只在闭包中赋值的
    // `let` 始终按初值 `null` 收窄，读取时类型变为 never。
    const hello: { ok: HelloOkFrame | null } = { ok: null }
    const done = Promise.withResolvers<void>()

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.ok') {
        hello.ok = msg
        return
      }
      if (msg.type === 'hello.err') {
        done.reject(new Error(`hello 失败: ${msg.message}`))
        return
      }
      if (msg.type === 'command.rejected') {
        rejections.push(msg)
        return
      }
      if (!msg.seq || !msg.event) return

      frames.push(msg)
      const ev = msg.event as AgentEvent

      if (ev.type === 'run.finished') done.resolve()
    })

    ws.send(
      JSON.stringify({
        type: 'hello',
        token: h.token,
        origin: 'desktop',
        subscribe: [conversationId],
      }),
    )
    await Bun.sleep(300)
    check('hello 握手成功', hello.ok?.type === 'hello.ok', hello.ok)
    // 能力位只声明有消费者的项。`pty` / `git` / `fileWatch` 已删除：
    // 前两项没有读取方，第三项没有实现（全仓没有文件监视器）。
    check(
      '能力声明中不再有无消费者的能力位',
      !!hello.ok?.capabilities &&
        !('pty' in hello.ok.capabilities) &&
        !('git' in hello.ok.capabilities) &&
        !('fileWatch' in hello.ok.capabilities),
      hello.ok?.capabilities,
    )

    // ── 指令 fail-closed ──
    // 本组验证「拒绝必须有回执」。未实现的指令若被 default 分支静默丢弃，
    // 客户端将始终收不到任何反馈，与「服务端正在处理」完全无法区分。
    process.stdout.write('\n指令回执（fail-closed）\n')

    ws.send(JSON.stringify({ type: 'no.such.command', foo: 1 }))
    await Bun.sleep(200)

    check(
      '未知指令返回 unknown_command',
      rejections.some((r) => r.command === 'no.such.command' && r.reason === 'unknown_command'),
      rejections,
    )

    // 手动压缩：新会话消息过少，应当返回 skipped，而不是静默不处理。
    // 「没有可压缩的内容」也是用户点击按钮后必须得到的答复。
    rejections.length = 0
    const beforeCompact = frames.length
    ws.send(JSON.stringify({ type: 'conversation.compact', conversationId }))
    await Bun.sleep(600)
    const compactEvents = frames
      .slice(beforeCompact)
      .filter((f) => f.event.type === 'compaction')
      .map((f) => f.event as Extract<AgentEvent, { type: 'compaction' }>)
    check('手动压缩有明确回执（started + 终态）', compactEvents.length >= 2, compactEvents)
    check(
      '空会话压缩返回 skipped 而不是报告成功',
      compactEvents.some((e) => e.phase === 'skipped' && e.reasonCode === 'nothing_to_fold'),
      compactEvents,
    )

    // ── 会话级模型切换 ──
    process.stdout.write('\n会话级模型切换\n')
    const before = await json<{ conversations: { id: string; model?: string }[] }>(
      await fetch(`${base}/api/conversations`, { headers: auth }),
    )
    const originalModel = before.conversations.find((c) => c.id === conversationId)?.model

    const models = await json(await fetch(`${base}/api/models`, { headers: auth }))
    check('模型列表非空', Array.isArray(models.models) && models.models.length > 0)

    ws.send(
      JSON.stringify({ type: 'conversation.setModel', conversationId, model: 'deepseek-v4-pro' }),
    )
    await Bun.sleep(200)

    check(
      '切换后广播 conversation.updated',
      frames.some(
        (f) => f.event.type === 'conversation.updated' && f.event.model === 'deepseek-v4-pro',
      ),
      frames.filter((f) => f.event.type === 'conversation.updated').map((f) => f.event),
    )

    const afterSwitch = await json<{ conversations: { id: string; model?: string }[] }>(
      await fetch(`${base}/api/conversations`, { headers: auth }),
    )
    const newModel = afterSwitch.conversations.find((c) => c.id === conversationId)?.model
    check('模型确实写入数据库（不是静默的虚假成功）', newModel === 'deepseek-v4-pro', {
      originalModel,
      newModel,
    })

    ws.send(JSON.stringify({ type: 'conversation.setModel', conversationId, model: 'nope' }))
    await Bun.sleep(150)
    // 切换回原模型，避免影响下方的真实调用。
    ws.send(JSON.stringify({ type: 'conversation.setModel', conversationId, model: originalModel }))
    await Bun.sleep(200)

    process.stdout.write('  … 正在运行一轮真实 agent（DeepSeek）\n')
    ws.send(
      JSON.stringify({
        type: 'message.send',
        clientRequestId: crypto.randomUUID(),
        conversationId,
        content: '读一下 calc.js，加一个 mul 函数并导出',
      }),
    )

    const timeout = setTimeout(
      () =>
        done.reject(
          new Error(
            (
              `run 超时。事件：${JSON.stringify(
                frames
                  .map((f) => f.event.type)
                  .reduce<Record<string, number>>((acc, t) => {
                    acc[t] = (acc[t] ?? 0) + 1
                    return acc
                  }, {}),
              )}` +
              `；模型：${JSON.stringify(
                frames
                  .filter((f) => f.event.type === 'run.started')
                  .map(
                    (f) => (f.event as Extract<AgentEvent, { type: 'conversation.updated' }>).model,
                  ),
              )}` +
              `；最后 4 个事件：${JSON.stringify(frames.slice(-4).map((f) => f.event))}`
            ).slice(0, 1500),
          ),
        ),
      RUN_TIMEOUT_MS,
    )
    await done.promise
    clearTimeout(timeout)

    // 先单独提取 provider 错误并断言。
    //
    // 否则一次流停滞或容量拒绝会表现为「收到 tool.started ✗」
    // 等多条下游失败，真正的原因混在几十条事件中难以定位。
    // 流空闲看门狗使流停滞变为一条 run.error，而不是等待到脚本超时；
    // 该断言把该错误放在最显眼的位置。
    const errored = frames.find((f) => f.event.type === 'run.error')
    check('本轮没有 provider 错误', errored === undefined, errored?.event)

    /*
     * 工具授权由 `Session.decide()` 在本地裁决（硬边界 → 静态规则 → 分类器），
     * 被拒的调用以 `tool.finished`（`status: 'failure'`、`errorKind: 'permission_denied'`、
     * message 中带理由）出现在事件流中。
     *
     * 不断言「必须出现过拒绝」：本轮运行的是正常任务，没有任何拒绝属于正常情况。
     * 断言的是出现拒绝时形状必须正确：缺少理由时模型只能原样重试，
     * 而重试必然再次被拒。
     */
    const denials = frames
      .map((f) => f.event)
      .filter(
        (ev): ev is Extract<AgentEvent, { type: 'tool.finished' }> =>
          ev.type === 'tool.finished' && ev.outcome?.errorKind === 'permission_denied',
      )
    check(
      `被拒的调用都带有理由（本轮 ${denials.length} 次）`,
      denials.every((d) => String(d.outcome?.message ?? '').length > 10),
      denials.map((d) => d.outcome?.message),
    )

    const types = new Set(frames.map((f) => f.event.type))
    check('收到 tool.started', types.has('tool.started'))
    check('收到 tool.finished', types.has('tool.finished'))
    check('收到 text.delta', types.has('text.delta'))
    check('收到 file.changed', types.has('file.changed'))

    const finished = frames.find((f) => f.event.type === 'run.finished')!.event as Extract<
      AgentEvent,
      { type: 'run.finished' }
    >
    check(`run 正常结束（${finished.stopReason}）`, finished.status === 'done', finished.stopReason)
    // `RunUsage` 的字段是 `cost` 而不是 `costUsd`：单位由同结构的 `currency` 决定，
    // 三家国内厂商按人民币标价，写入名为 usd 的字段会相差约七倍，且界面无法察觉。
    check('计费非零', finished.usage.cost > 0, finished.usage.cost)

    // seq 必须严格单调递增，否则断线补发的缺口计算全部错误。
    const seqs = frames.map((f) => f.seq)
    check(
      'seq 严格单调递增',
      seqs.every((s, i) => i === 0 || s > seqs[i - 1]!),
    )

    // ── 断线补发 ──
    process.stdout.write('\n断线补发\n')
    const midSeq = seqs[Math.floor(seqs.length / 2)]!
    // 补发必须带流身份：新总线的 seq 从 0 重新计数，只比较大小会把
    // 「落后多少」与「落后是否发生在本流上」混为一个判断。
    const at = (lastSeq: number) => ({ streamId: h.bus.streamId, lastSeq })
    const watcher = { id: 'smoke', origin: 'cli' as const, conversations: null, send: () => {} }
    const replay = h.bus.replayFrom(at(midSeq), watcher)
    check(
      '从中途 seq 补发缺口',
      replay !== null && replay.length > 0 && replay.every((f) => f.seq > midSeq),
      { asked: midSeq, got: replay?.length },
    )
    check('已同步的客户端补发为空', h.bus.replayFrom(at(h.bus.currentSeq), watcher)?.length === 0)
    check(
      '流身份变化时返回 null（触发全量重新拉取）',
      h.bus.replayFrom({ streamId: 'another-stream', lastSeq: 0 }, watcher) === null,
    )

    // ── 文件确实已修改 ──
    const after = await Bun.file(join(WS_DIR, 'calc.js')).text()
    check('工作区文件确实被修改', after.includes('mul'), after.slice(0, 200))

    ws.close()
  } finally {
    h.stop()
    store.close()
  }

  // ── 崩溃恢复 ──
  // 模拟上次进程未完成收尾：手动构造一条 running run，重新启动服务检查它是否被回收。
  // 不回收时 isBusy 恒为真，该会话无法再发送消息，即被永久锁定。
  process.stdout.write('\n崩溃恢复\n')
  {
    const store2 = new Store({ path: DB })
    const ws2 = upsertWorkspace(store2, WS_DIR, 'smoke')
    const conv2 = createConversation(store2, {
      workspaceId: ws2.id,
      provider: 'deepseek',
      model: 'deepseek-flash',
      title: '崩溃遗留',
    })
    const stale = createRun(store2, {
      conversationId: conv2.id,
      workspaceId: ws2.id,
      model: 'deepseek-flash',
      clientRequestId: crypto.randomUUID(),
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    markRunRunning(store2, stale.id)
    const step = appendStep(store2, {
      runId: stale.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      status: 'running',
    })
    markStepExecuting(store2, step.id)
    store2.close()

    const store3 = new Store({ path: DB })
    const h2 = serve({
      store: store3,
      config: await loadConfig(),
      workspaceRoot: WS_DIR,
      port: 0,
      host: '127.0.0.1',
    })
    const recovered = getRun(store3, stale.id)!
    check('残留的 running run 被回收为终态', recovered.status === 'interrupted', recovered.status)
    check(
      '工具执行期间中断的 run 判定为结果不可信',
      recovered.stopReason === 'internal_guard',
      recovered.stopReason,
    )
    check(
      '停滞的 step 一并进入终态（不留下持续加载的卡片）',
      listSteps(store3, stale.id)[0]?.status === 'failure',
    )
    h2.stop()
    store3.close()
  }

  // ── 全新用户的第一次运行 ──
  //
  // 空配置下发起一轮，验证的是错误码而不是是否报错：报 auth_failed（Key 无效）
  // 会把用户引向检查一个尚不存在的 key。
  // 不消耗任何 token：请求不会发出。
  process.stdout.write('\n首次运行（空配置）\n')
  {
    const store4 = new Store({ path: join(WS_DIR, 'firstrun.sqlite3') })
    const h3 = serve({
      store: store4,
      config: {
        active: { provider: 'anthropic', model: 'claude-opus-5' },
        providers: { anthropic: { kind: 'anthropic_messages', models: { 'claude-opus-5': {} } } },
      },
      workspaceRoot: WS_DIR,
      port: 0,
      host: '127.0.0.1',
    })
    try {
      const created = await json<{ conversation?: { id?: string; model?: string } }>(
        await fetch(`http://127.0.0.1:${h3.port}/api/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${h3.token}` },
          body: JSON.stringify({ title: '首次运行' }),
        }),
      )

      const sock = new WebSocket(`ws://127.0.0.1:${h3.port}/stream?token=${h3.token}`)
      await new Promise<void>((res, rej) => {
        sock.addEventListener('open', () => res(), { once: true })
        sock.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
      })
      const errored = Promise.withResolvers<Extract<AgentEvent, { type: 'run.error' }>>()
      sock.addEventListener('message', (e) => {
        const msg = JSON.parse(String(e.data))
        if (msg?.event?.type === 'run.error') errored.resolve(msg.event)
      })
      sock.send(
        JSON.stringify({
          type: 'hello',
          token: h3.token,
          origin: 'desktop',
          subscribe: [created.conversation?.id ?? ''],
        }),
      )
      await Bun.sleep(200)
      sock.send(
        JSON.stringify({
          type: 'message.send',
          conversationId: created.conversation?.id ?? '',
          content: '你好',
          clientRequestId: crypto.randomUUID(),
        }),
      )
      const t = setTimeout(() => errored.reject(new Error('10s 内未收到 run.error')), 10_000)
      const ev = await errored.promise
      clearTimeout(t)

      check('空 key 报 no_api_key 而不是 auth_failed', ev.code === 'no_api_key', ev)
      check('报错中带有配置文件路径', String(ev.message).includes('config.json'), ev.message)
      sock.close()
    } catch (err) {
      check('首次运行链路', false, err instanceof Error ? err.message : String(err))
    } finally {
      h3.stop()
      store4.close()
    }
  }

  process.stdout.write(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
