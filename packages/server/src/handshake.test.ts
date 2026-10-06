/**
 * 握手时客户端的同步位置。
 *
 * 覆盖范围：`handshake.ts` 的补发分支与 `environment` 能力上报
 * （令牌校验由 `e2e.test.ts` 经由真实连接覆盖）；后者一并覆盖 `api/host.ts` 的
 * 依赖表：该表同时供握手与安装路由使用，分别计算必然产生偏差。
 *
 * 本测试锁定一条用户可见的链路：**sidecar 重启之后，必须告知重连的客户端
 * 重新拉取全量**。不告知时界面会一直停留在断线时刻：该轮持续显示执行中，
 * 而账本中它在新进程启动时已被 `recoverStaleRuns` 判定为中断。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, ConversationId, HelloFrame } from '@qywork/core'
import type { CommandShell } from '@qywork/tools'
import type { ServerWebSocket } from 'bun'
import { resolveBashRow, resolveWinget } from './api/host.ts'
import { EventBus } from './bus.ts'
import type { SocketData } from './deps.ts'
import { handleHello } from './handshake.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

const c1 = 'cv_one' as ConversationId
const delta = (s: string): AgentEvent =>
  ({ type: 'text.delta', runId: 'run_x', stepId: 'st_x', delta: s }) as AgentEvent

interface HelloOk {
  type: string
  streamId: string
  currentSeq: number
  resync: boolean
  busyConversations: string[]
  capabilities: {
    environment: {
      id: string
      label: string
      path: string | null
      required: boolean
      hint: string
      canInstall: boolean
    }[]
  }
}

/** 最小的假 socket：只需要 `data` / `send` / `close`。 */
function fakeSocket() {
  const sent: string[] = []
  const ws = {
    data: { id: 'sk_1', authed: false, origin: 'desktop' } as SocketData,
    send: (s: string) => sent.push(s),
    close: () => {},
  } as unknown as ServerWebSocket<SocketData>
  return {
    ws,
    sent,
    ok: () => JSON.parse(sent[0]!) as HelloOk,
    backlog: () => sent.slice(1).map((s) => JSON.parse(s) as { seq: number }),
  }
}

function shake(
  bus: EventBus,
  frame: Omit<HelloFrame, 'type' | 'token' | 'origin'>,
  runs = new RunManager(null as never, bus, new SubagentRegistry()),
) {
  const sock = fakeSocket()
  handleHello(
    sock.ws,
    { type: 'hello', token: 'tk', origin: 'desktop', ...frame },
    {
      bus,
      token: 'tk',
      unsubscribers: new Map(),
      config: { active: { provider: 'p', model: 'm' }, providers: {} },
      runs,
      browser: () => ({
        connected: false,
        runtimeSupported: false,
      }),
      desktop: () => ({
        connected: false,
        workerReady: false,
        authorized: false,
        missing: [],
      }),
      announceGit: () => {},
      announceDesktopTarget: () => {},
    },
  )
  return sock
}

/**
 * 运行中的会话必须**在握手中报告**。
 *
 * 原始失败形状：sidecar 被终止后重连，客户端持有的忙闲状态仍是断线前的状态：相应的轮次
 * 早已执行完毕，左栏对应的行却一直显示运行中。缺口无法补发（resync）时事件路径无法恢复，
 * 该快照是唯一的纠正机会。
 */
describe('握手报告当前运行中的会话', () => {
  test('报告的是 RunManager 持有的状态，不是账本', () => {
    const bus = new EventBus()
    const runs = new RunManager(null as never, bus, new SubagentRegistry())
    runs.reserve(c1)
    expect(shake(bus, {}, runs).ok().busyConversations).toEqual([c1])
  })

  test('没有运行中的会话时为空表，而不是缺少该字段', () => {
    const bus = new EventBus()
    expect(shake(bus, {}).ok().busyConversations).toEqual([])
  })
})

describe('断线重连的位置', () => {
  test('同一条流、缺口在窗口内：逐条补发，不 resync', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    bus.publish(delta('b'), c1)

    const sock = shake(bus, { resume: { streamId: bus.streamId, lastSeq: 1 } })
    expect(sock.ok().resync).toBe(false)
    expect(sock.backlog().map((f) => f.seq)).toEqual([2])
  })

  /**
   * **原始失败形状**：重启后 `seq` 从 0 重新计数，按 `lastSeq >= seq` 判定即得到
   * 「已是最新」，因此 resync 为假、补发零条，客户端不会重新拉取，该轮的终态
   * 永远无法到达界面。
   */
  test('服务端已重启（流已更换）：必须 resync，而不是判定为已是最新', () => {
    const before = new EventBus()
    for (let i = 0; i < 800; i++) before.publish(delta(String(i)), c1)

    const after = new EventBus()
    const sock = shake(after, { resume: { streamId: before.streamId, lastSeq: 800 } })
    expect(sock.ok().resync).toBe(true)
    expect(sock.backlog()).toEqual([])
  })

  test('首次连接不带位置：不 resync，也不补发', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    const sock = shake(bus, {})
    expect(sock.ok().resync).toBe(false)
    expect(sock.backlog()).toEqual([])
  })

  test('hello.ok 报告本进程当前流的身份，客户端据此判断是否重新拉取', () => {
    const bus = new EventBus()
    expect(shake(bus, {}).ok().streamId).toBe(bus.streamId)
  })
})

describe('能力上报', () => {
  /**
   * `environment` 的每个字段必须**在握手中即可被消费方读取**。
   *
   * 这不是形式检查：握手中没有消费方的能力位一律应删除（见 `transport.ts`），
   * 因此该字段的验收标准是「设置页的对应部分能据此渲染」：
   * 有路径时显示路径，没有时显示缺失的影响，`canInstall` 决定是否显示按钮。
   */
  test('environment 逐条报告路径、缺失影响与能否一键安装', () => {
    const env = shake(new EventBus(), {}).ok().capabilities.environment
    // 表中每一条都对应代码中一处真实的 spawn。
    expect(env.map((d) => d.id)).toEqual([
      'bash',
      'git',
      'ripgrep',
      'node',
      'python',
      'office-libs',
      'video-decoder',
    ])
    for (const d of env) {
      expect(d.label.length).toBeGreaterThan(0)
      // 未安装时「缺失影响」必填：仅显示「未安装」无法告诉用户是否需要处理。
      if (d.path === null) expect(d.hint.length).toBeGreaterThan(0)
      // 已安装时无需安装：按钮不应出现在已安装的行上。
      else expect(d.canInstall).toBe(false)
    }
    // bash 不在此列：缺少 bash 时命令语法改为 PowerShell，两种 shell 都缺失时
    // 才影响功能，而本机已安装（下一条用例锁定该前提）。
    expect(env.filter((d) => d.required).map((d) => d.id)).toEqual(['git'])
  })

  test('本机已安装 Git，因此 bash 与 git 都能报告路径', () => {
    // 本用例锁定探测确实执行，而不是恒返回 null 也能使上一条用例通过。
    const env = shake(new EventBus(), {}).ok().capabilities.environment
    const bash = env.find((d) => d.id === 'bash')
    expect(bash?.path?.toLowerCase()).toContain('bash')
    expect(env.find((d) => d.id === 'git')?.path).not.toBeNull()
  })

  /**
   * bash 行的三种情形。**通过注入测试**：本机已安装 Git Bash，只可能命中第一种，
   * 而需要验证的失败形状（没有 bash、有 PowerShell）在开发机上无法复现。
   */
  describe('bash 行按机器环境归入哪一种情形', () => {
    const noBash = {
      path: null,
      reason: '没找到 Git for Windows 自带的 bash。装 Git for Windows。',
    }
    const shell = (path: string): CommandShell => ({ path, argv: [path], hint: '' })

    test('有 bash：报告其路径，无需后续操作', () => {
      const row = resolveBashRow({
        bash: () => ({ path: '/usr/bin/bash', reason: '' }),
        shell: () => shell('/usr/bin/bash'),
      })
      expect(row).toEqual({ path: '/usr/bin/bash', required: false, hint: '' })
    })

    /**
     * **原始失败形状**：只有 PowerShell 的机器上，模型有 `run_command`，
     * 设置页却报告必需依赖缺失，用户因此安装一个并不需要的依赖。
     */
    test('没有 bash 但有 PowerShell：不报告为必需，只说明命令改由 PowerShell 执行', () => {
      const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      const row = resolveBashRow({ bash: () => noBash, shell: () => shell(ps) })
      expect(row.required).toBe(false)
      expect(row.hint).toBe('命令当前由 PowerShell 执行，安装后改用 bash。')
    })

    test('三种都不存在：属于必需依赖缺失，后续操作按 bash 情形说明', () => {
      const row = resolveBashRow({ bash: () => noBash, shell: () => null })
      expect(row.required).toBe(true)
      expect(row.hint).toContain('装 Git for Windows')
    })
  })

  test('winget 探测与 Windows 对应用执行别名的解析一致', () => {
    if (process.platform !== 'win32') return
    const executable = resolveWinget()
    if (executable === null) return
    expect(
      Bun.spawnSync(['cmd.exe', '/d', '/c', executable, '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exitCode,
    ).toBe(0)
  })
})
