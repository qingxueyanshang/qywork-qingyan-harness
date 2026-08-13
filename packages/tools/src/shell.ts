/**
 * shell 工具。
 *
 * 这是权限模型里最危险的一个工具：一条命令能做的事没有上界。设计取舍是
 * **不假装能靠字符串检查把它变安全**——命令注入的黑名单从来挡不住构造。
 * 真正的防线是：
 *
 * 1. 每次调用都过权限闸（`auto` 模式下由规则与分类器裁决，不弹窗）。
 * 2. cwd 强制锁在允许的根目录内（工作区 + 显式配置的额外目录）。
 * 3. **凭证不进这个进程**，输出里出现的凭证明文也要屏蔽掉，见下。
 * 4. 硬性超时 + 输出上限，防止把内存和上下文撑爆。
 * 5. 不经 shell 解释符做「安全化」处理——原样交给裁决过的那条命令。
 * 6. **有内核沙箱的平台上再套一层**（`sandbox.ts`）：这一层不看命令长什么样，
 *    所以前五条里唯一挡不住「没想到的写法」的那个缺口在这里被真正堵上。
 *
 * ## 为什么第 3 条单独算一条防线
 *
 * 这里曾经是 `env: { ...process.env }`——模型自己编的命令继承整份环境，
 * 包括 `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`。而模型的输出是不可信输入：
 * 它读到的网页、依赖的 README、`AGENTS.md` 里一句提示注入就够了。
 *
 * 对照过的三个同类项目（Claude Code 克隆、pi、Codex）都不剥环境变量——
 * 它们的答案是 OS 级沙箱。而 OS 沙箱**有平台就有，没有就没有**：
 * 原生 Windows 上目前一层都没有（`sandbox.ts` 会如实这么报）。
 * 剥环境变量则在每个平台上都成立，所以它不是沙箱的替代品，是它的下位保底：
 * 拿不到明文，泄露就不会跨出这台机器。
 *
 * 剥的同时输出侧也要屏蔽：只堵输入侧的话，一句 `cat .env` 照样把 key
 * 送进上下文再发给 provider。屏蔽发生在**落盘与回传之前**——
 * 先落盘再屏蔽的话，磁盘上那份仍是明文。
 *
 * agent 用的是管道（不是 PTY）：交互式终端面板走 Tauri 的 portable-pty，
 * 那是给人用的，与这里无关。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'
import type { IntermediateResourceRef } from '@qywork/core'
import { PROTECTED_DIRS, resolveInWorkspace, rootsOf } from './paths.ts'
import { type SandboxPolicy, spawnGuarded } from './sandbox.ts'
import { createStreamRedactor, scrubEnv } from './secrets.ts'
import { deliver } from './sink.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

/**
 * 这条调用实际会在多少毫秒后被强制终止。
 *
 * **导出是因为裁决层要用同一个数。** `run_command` 的超时到点是无条件
 * `proc.kill()`，所以「这条命令会不会一直挂着」在这个工具里有个确定答案——
 * 而分类器原来看不到它，只能按命令字面判，于是把带 3 秒超时的
 * `python -m http.server` 按「不会自己退出的服务器」拒掉了。
 *
 * 两处各算一遍必然漂移，而漂移的表现是**裁决时说的那个数和真正生效的不是同一个**
 * ——那比不告诉它更糟。
 */
export function resolveCommandTimeout(timeoutMs: unknown): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeoutMs ?? DEFAULT_TIMEOUT_MS)))
}

export const shellTool: ToolSpec = {
  name: 'run_command',
  description:
    '在工作区里执行一条 shell 命令并返回 stdout/stderr 与退出码。' +
    '用于构建、测试、包管理、git 等操作。命令会流式回传输出。' +
    '需要读文件用 read_file，需要找文件用 glob/grep——它们更快也更省上下文，不要用 cat/find/grep 代替。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令' },
      cwd: { type: 'string', description: '工作目录（工作区相对路径），默认工作区根' },
      timeout_ms: { type: 'integer', description: `超时毫秒，默认 ${DEFAULT_TIMEOUT_MS}` },
    },
    required: ['command'],
    additionalProperties: false,
  },
  actionKind: 'execute',
  objectLabel: '命令',
  targetExtractor: (a) => (typeof a.command === 'string' ? a.command : null),
  permissionEffect: 'execute',
  // 永不并行：命令之间的顺序几乎总是携带意图（先装依赖再构建）。
  parallelSafe: false,
  async fn(args, ctx) {
    const command = String(args.command ?? '').trim()
    if (!command) return { status: 'failure', message: '命令为空' }

    const cwd = await resolveInWorkspace(rootsOf(ctx), String(args.cwd ?? '.'), {
      mustExist: true,
    })
    const timeout = resolveCommandTimeout(args.timeout_ms)

    // 缺 secrets 时按空集合处理——那是「没有已知凭证」，不是「不用剥」。
    const secrets = ctx.secrets ?? { values: [], envNames: [] }

    /*
     * 沙箱策略与路径层用**同一份根目录清单**。
     *
     * 两边分别算的话，一条 `additionalDirectories` 只接了路径层的后果是：
     * 工具参数放行了、内核拒绝了，而模型收到的是一条 EACCES——
     * 它会以为是文件权限问题，然后开始 chmod。反过来只接沙箱层，
     * 表现是参数被我们自己拒掉，而内核那边本来是允许的。
     * 两种都表现为「配了但不管用」，且错误信息互不相干。
     */
    const policy: SandboxPolicy = {
      workspaceRoot: ctx.workspaceRoot,
      ...(ctx.additionalDirectories?.length ? { writableRoots: ctx.additionalDirectories } : {}),
      readOnlySubdirs: PROTECTED_DIRS,
      ...(ctx.denyNetwork ? { denyNetwork: true } : {}),
    }

    const { proc, sandbox } = spawnGuarded({
      command,
      cwd,
      policy,
      // NON_INTERACTIVE_ENV 放在剥离**之后**：它是我们自己加的，
      // 里面没有凭证，也不该被名字规则误伤（比如将来加个带 TOKEN 的变量）。
      env: {
        ...scrubEnv(process.env, secrets, { allow: ctx.envAllowList ?? DEFAULT_ENV_ALLOW }),
        ...NON_INTERACTIVE_ENV,
      },
    })

    let out = ''
    let err = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeout)

    // 中断信号要能真正杀掉子进程，否则用户点了停止但构建还在跑。
    const onAbort = () => proc.kill()
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    // 每条流一个脱敏器：它们各自带跨片缓冲，共用一个会把两条流的尾巴串起来。
    const pump = async (stream: ReadableStream<Uint8Array>, channel: 'stdout' | 'stderr') => {
      const decoder = new TextDecoder()
      const redactor = createStreamRedactor(secrets)
      const take = (text: string) => {
        if (!text) return
        if (channel === 'stdout') out += text
        else err += text
        ctx.emit(channel, text)
      }
      for await (const chunk of stream) {
        take(redactor.push(decoder.decode(chunk, { stream: true })))
      }
      // 不调 flush 会静默吞掉输出末尾——那比泄露更难发现，因为没人会去数字节。
      take(redactor.flush())
    }

    try {
      await Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')])
      const code = await proc.exited
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)

      const delivered = deliverStreams(ctx, command, out, err)

      if (timedOut) {
        return {
          status: 'failure',
          message: `命令超时（${timeout}ms）已终止`,
          data: { ...delivered.data, timedOut: true },
          ...(delivered.resources.length ? { resources: delivered.resources } : {}),
          errorKind: 'timeout',
        }
      }

      return {
        // 非零退出码是**事实**不是异常：模型需要看到失败输出才能修。
        status: code === 0 ? 'success' : 'failure',
        message:
          code === 0 ? '命令执行成功' : `命令退出码 ${code}${sandboxHint(sandbox.active, err)}`,
        data: { exitCode: code, ...delivered.data },
        ...(delivered.resources.length ? { resources: delivered.resources } : {}),
      }
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  },
}

/**
 * 沙箱造成的失败要说人话。
 *
 * 内核拒绝写入的报错是 `Read-only file system` / `EROFS` / `Permission denied`——
 * 模型看到这些会去 `chmod`、去 `sudo`、去换一个同样在工作区外的路径，
 * 一连试好几轮，而这些尝试**每一次都会被同一道边界拦下**。
 *
 * 这就是「沙箱是否生效」这个事实唯一真正的消费者：不加这一句的话，
 * 边界确实生效了，但代价是一轮无意义的重试。只在**失败**且**沙箱确实生效**时加，
 * 否则等于给每条成功命令的结果里塞一段与它无关的话。
 */
function sandboxHint(active: boolean, stderr: string): string {
  if (!active) return ''
  if (!/read-only file system|EROFS|permission denied|EACCES/i.test(stderr)) return ''
  return (
    '。注意：shell 命令跑在内核沙箱里——工作区（及显式配置的额外目录）之外只读，' +
    '凭证目录不可见。这不是文件权限问题，chmod / sudo 改不了它。' +
    '需要写工作区外的路径，请说明用途让用户把该目录加进 additionalDirectories。'
  )
}

/**
 * 默认放行的环境变量名。
 *
 * `SSH_AUTH_SOCK` 命中「名字像凭证」（含 `AUTH`）会被剥掉，而剥掉它
 * **`git push` 直接失败**——那是个太常见的操作，一坏用户就会去把整套关掉。
 *
 * 放行它在威胁模型上也站得住：它是一个**套接字路径**，不是可外泄的明文。
 * 把它打印出来发给别人没有任何用处，风险是本机滥用——而本机滥用的前提是
 * 命令能跑起来，那件事归裁决层管，不归脱敏层管。
 *
 * 脱敏层要防的是**跨出这台机器的泄露**，按这个口径 `SSH_AUTH_SOCK` 不在其内。
 */
const DEFAULT_ENV_ALLOW = ['SSH_AUTH_SOCK']

/** 让常见 CLI 不要输出进度条、不要开分页器、不要问问题。 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  CI: '1',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  TERM: 'dumb',
  npm_config_yes: 'true',
  DEBIAN_FRONTEND: 'noninteractive',
}

/**
 * 把两条流交给投递闸。
 *
 * 曾经这里是一个纯 `clamp()`：超过 60000 字符就把中间**永久丢掉**。
 * 命令输出不可重放——那条 `npm test` 这一次的失败详情丢了就是丢了，
 * 模型只能凭首尾猜，或者让用户再跑一遍。
 *
 * 现在超预算的部分落进正文库，模型拿到 resource id 后可以用 `read_resource`
 * 把中间那段读回来。stdout 和 stderr 分别落盘：把它们拼起来会丢掉
 * 「这行是错误还是正常输出」这个信息，而那正是排查时最要紧的区分。
 */
function deliverStreams(
  ctx: ToolContext,
  command: string,
  out: string,
  err: string,
): { data: Record<string, unknown>; resources: IntermediateResourceRef[] } {
  const encoder = new TextEncoder()
  const resources: IntermediateResourceRef[] = []
  const data: Record<string, unknown> = {}

  for (const [channel, text] of [
    ['stdout', out],
    ['stderr', err],
  ] as const) {
    if (!text) {
      data[channel] = ''
      continue
    }
    const landed = deliver(ctx.sink, {
      toolName: 'run_command',
      sourceType: `shell:${channel}`,
      body: encoder.encode(text),
      mimeType: 'text/plain',
      query: command,
    })
    data[channel] = landed.text
    // 覆盖事实必须进 data：模型读 message 和 data，读不到 coverage 就不知道自己看的是几分之几。
    if (landed.coverage.truncated) data[`${channel}Coverage`] = landed.coverage
    if (landed.resourceId) {
      resources.push({
        resourceId: landed.resourceId as never,
        status: landed.status,
        contentHash: null,
        sizeBytes: landed.coverage.totalBytes ?? 0,
        mimeType: 'text/plain',
        coverage: landed.coverage,
      })
    }
  }

  return { data, resources }
}
