/**
 * 握手时的「客户端停在哪一条」。
 *
 * 覆盖范围：`handshake.ts` 的补发分支与 `environment` 能力上报
 * （令牌校验由 `e2e.test.ts` 走真连接覆盖）；后者一并覆盖 `api/host.ts` 的
 * 依赖表——那张表同时喂握手和安装路由，分开算必然漂移。
 *
 * 这份测试锁的是一条用户可见的链路：**sidecar 重启之后，重连的客户端必须被告知
 * 要重拉全量**。不告知的代价是界面永远停在断线那一刻——那一轮一直显示执行中，
 * 而账本里它在新进程启动时就被 `recoverStaleRuns` 判成中断了。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, ConversationId, HelloFrame } from '@qywork/core'
import type { CommandShell } from '@qywork/tools'
import type { ServerWebSocket } from 'bun'
import { resolveBashRow, wingetUsable } from './api/host.ts'
import { EventBus } from './bus.ts'
import type { SocketData } from './deps.ts'
import { handleHello } from './handshake.ts'
import { RunManager } from './runs.ts'

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
      impact: string
      required: boolean
      hint: string
      canInstall: boolean
    }[]
  }
}

/** 最小假 socket：只需要 `data` / `send` / `close`。 */
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
  runs = new RunManager(null as never, bus),
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
      announceGit: () => {},
    },
  )
  return sock
}

/**
 * 在跑的会话要**在握手里报出来**。
 *
 * 原始失败形状：sidecar 被杀之后重连，客户端手里那份忙闲还是断线前的——那几轮
 * 早跑完了，左栏对应的行会一直转下去。缺口补不上（resync）时事件那条路补不回来，
 * 这份快照是唯一的纠正机会。
 */
describe('握手报此刻谁在跑', () => {
  test('报的是 RunManager 手里那份，不是账本', () => {
    const bus = new EventBus()
    const runs = new RunManager(null as never, bus)
    runs.reserve(c1)
    expect(shake(bus, {}, runs).ok().busyConversations).toEqual([c1])
  })

  test('一条都没在跑就是空表，不是缺这个字段', () => {
    const bus = new EventBus()
    expect(shake(bus, {}).ok().busyConversations).toEqual([])
  })
})

describe('断线重连的位置', () => {
  test('同一条流、缺口在窗口内 —— 逐条补，不 resync', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    bus.publish(delta('b'), c1)

    const sock = shake(bus, { resume: { streamId: bus.streamId, lastSeq: 1 } })
    expect(sock.ok().resync).toBe(false)
    expect(sock.backlog().map((f) => f.seq)).toEqual([2])
  })

  /**
   * **原始失败形状**：重启后 `seq` 从 0 重新数，拿 `lastSeq >= seq` 判就成了
   * 「已是最新」，因此 resync 为假、补发零条，客户端不会去重拉——那一轮的终态
   * 就此永远到不了界面。
   */
  test('服务端重启过（换了流）—— 必须 resync，而不是判成已是最新', () => {
    const before = new EventBus()
    for (let i = 0; i < 800; i++) before.publish(delta(String(i)), c1)

    const after = new EventBus()
    const sock = shake(after, { resume: { streamId: before.streamId, lastSeq: 800 } })
    expect(sock.ok().resync).toBe(true)
    expect(sock.backlog()).toEqual([])
  })

  test('首连不带位置 —— 不 resync，也不补发', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    const sock = shake(bus, {})
    expect(sock.ok().resync).toBe(false)
    expect(sock.backlog()).toEqual([])
  })

  test('hello.ok 报的是本进程这条流的身份，客户端据此判断要不要重拉', () => {
    const bus = new EventBus()
    expect(shake(bus, {}).ok().streamId).toBe(bus.streamId)
  })
})

describe('能力上报', () => {
  /**
   * `environment` 必须**在握手里就有消费者可读的每一格**。
   *
   * 这条不是形式检查：握手里没有消费者的能力位一律该删（见 `transport.ts`），
   * 所以这一格的验收是「设置页那一节能据此渲染」——
   * 有路径就显示路径，没有就显示影响与下一步，`canInstall` 决定按钮出不出现。
   */
  test('environment 逐条报路径、影响与能不能一键装', () => {
    const env = shake(new EventBus(), {}).ok().capabilities.environment
    // 表里每一条都对应代码里一处真实的 spawn。
    expect(env.map((d) => d.id)).toEqual(['bash', 'git', 'ripgrep', 'node'])
    for (const d of env) {
      expect(d.label.length).toBeGreaterThan(0)
      // 「缺了会怎样」必填：一行「未安装」不告诉用户要不要管它。
      expect(d.impact.length).toBeGreaterThan(0)
      if (d.path === null) expect(d.hint.length).toBeGreaterThan(0)
      // 装上了就没什么可装的——按钮不该在已拥有的那一行出现。
      else expect(d.canInstall).toBe(false)
    }
    // bash 不在这里：批 4 之后它缺了只是语法换成 PowerShell，只有一个 shell
    // 都没有时才是硬伤，而本机有（下一条锁的就是这个前提）。
    expect(env.filter((d) => d.required).map((d) => d.id)).toEqual(['git'])
  })

  test('本机装了 Git，所以 bash 与 git 都报得出路径', () => {
    // 这条锁的是探测真的在探，而不是恒返回 null 也能让上一条通过。
    const env = shake(new EventBus(), {}).ok().capabilities.environment
    const bash = env.find((d) => d.id === 'bash')
    expect(bash?.path?.toLowerCase()).toContain('bash')
    expect(env.find((d) => d.id === 'git')?.path).not.toBeNull()
  })

  /**
   * **winget 的探测不能走 `Bun.which`。** 这条是实测撞出来的 bug 的回归。
   *
   * `WindowsApps\winget.exe` 是应用执行别名（APPEXECLINK 重解析点），不是真文件：
   * `existsSync` 报 ENOENT、`Bun.which` 返回 null、`Bun.spawnSync(['winget',…])`
   * 直接抛「Executable not found in $PATH」，而 `cmd /c winget --version` 是 exit 0。
   * Win10/11 上 winget 一律是这个形状——用 `Bun.which` 探的后果不是偶尔漏，
   * 是**一键装按钮在任何机器上都不会出现**。
   *
   * 断言写成「与 `where.exe` 的结论一致」而不是写死 true：没装 winget 的机器上
   * 两边都该是假，这条测试在那种机器上依然成立。
   */
  /**
   * bash 那一行的三档。**注入着测**：本机装着 Git Bash，只可能命中第一档，
   * 而这一批要修的失败形状（没 bash、有 PowerShell）在开发机上复现不出来。
   */
  describe('bash 那一行随机器落在哪一档', () => {
    const noBash = {
      path: null,
      reason: '没找到 Git for Windows 自带的 bash。装 Git for Windows。',
    }
    const shell = (path: string): CommandShell => ({ path, argv: [path], hint: '' })

    test('有 bash —— 报它自己的路径，没有下一步要说', () => {
      const row = resolveBashRow({
        bash: () => ({ path: '/usr/bin/bash', reason: '' }),
        shell: () => shell('/usr/bin/bash'),
      })
      expect(row).toEqual({ path: '/usr/bin/bash', required: false, hint: '' })
    })

    /**
     * **原始失败形状**：只有 PowerShell 的机器上，模型有 `run_command`，
     * 设置页却报一条必需依赖缺失——用户因此去装一个他并不需要的依赖。
     */
    test('没 bash 但有 PowerShell —— 不报必需，且说清现在跑的是哪个、语法差在哪', () => {
      const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      const row = resolveBashRow({ bash: () => noBash, shell: () => shell(ps) })
      expect(row.required).toBe(false)
      // 用户得知道本机跑的是哪一档 shell，以及 5.1 上 && 为什么不能写。
      expect(row.hint).toContain(ps)
      expect(row.hint).toContain('&&')
    })

    test('三档全空 —— 这才是必需依赖缺失，下一步照 bash 那一档说', () => {
      const row = resolveBashRow({ bash: () => noBash, shell: () => null })
      expect(row.required).toBe(true)
      expect(row.hint).toContain('装 Git for Windows')
    })
  })

  test('winget 探测认得应用执行别名（Bun.which 认不出的那种）', () => {
    if (process.platform !== 'win32') return
    const found =
      Bun.spawnSync(['where.exe', 'winget'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
    expect(wingetUsable()).toBe(found)
    // 反向对照：真是别名的话 Bun 自己解析不出来，这正是本条存在的理由。
    if (found) expect(Bun.which('winget')).toBeNull()
  })
})
