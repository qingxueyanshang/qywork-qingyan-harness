/**
 * 将 store / adapter / registry / loop 组装为一个可执行的 run。
 *
 * 这是唯一的装配点：TUI、`qy exec`、`qy serve` 都从此处启动 run，
 * 不各自重复组装：三套装配会产生三套逐渐偏离的行为。
 *
 * 会话级状态见 `session/types.ts` 的 `SessionState`；权限裁决、工具上下文、扩展装载、生成花费与持久化各在
 * `session/` 下一个文件中。一轮的各阶段在 `session/turn/` 中，`ask` 只做编排。
 */

import { basename } from 'node:path'
import { Ports, provide, ToolRegistry } from '@qywork/agent'
import type { AgentEvent, ConversationId } from '@qywork/core'
import { log } from '@qywork/core'
import { upsertWorkspace } from '@qywork/store'
import {
  BrowserPort,
  CanvasPort,
  DesktopPort,
  McpConfigPort,
  normalizeAdditionalDirectories,
  registerBuiltinTools,
} from '@qywork/tools'
import { listMediaModels } from './config.ts'
import { releaseExtensions } from './extensions.ts'
import { makeMcpConfigPort } from './mcp-config-store.ts'
import { driveLoop } from './session/turn/drive.ts'
import { buildRunHistory } from './session/turn/history.ts'
import { openRun } from './session/turn/open-run.ts'
import { prepareTurn } from './session/turn/prepare.ts'
import { closeRun, recordFailure } from './session/turn/settle.ts'
import type { AskOptions, SessionOptions, SessionState } from './session/types.ts'

export class Session {
  /** 会话级状态，各职责文件与本轮各阶段读写同一份。 */
  private readonly state: SessionState

  constructor(opts: SessionOptions) {
    const registry = new ToolRegistry()
    const extraDirs = normalizeAdditionalDirectories(opts.config.additionalDirectories).dirs
    const ports = (opts.ports ?? new Ports()).with([
      provide(McpConfigPort, makeMcpConfigPort(opts.workspaceRoot)),
    ])

    /*
     * 用户按下停止时立即撤销浏览器控制，不等待本轮收尾。
     *
     * 只在 `dispose()` 中释放时，中断信号须先经过 agent 循环、工具执行器和
     * 事件流才能到达此处，期间排队的动作仍会发送到网站。`release()` 是幂等的，
     * 收尾时再次调用为空操作，不构成第二条路径。
     */
    opts.signal.addEventListener(
      'abort',
      () => {
        void ports
          .get(BrowserPort)
          ?.release()
          .catch((err) => {
            log.warn(
              'browser',
              `停止时释放浏览器控制失败：${err instanceof Error ? err.message : String(err)}`,
            )
          })
        // 桌面动作同理，且更为紧迫：排队中的 invoke 一旦派发即作用于用户正在查看的应用。
        void ports
          .get(DesktopPort)
          ?.release()
          .catch((err) => {
            log.warn(
              'desktop',
              `停止时撤销电脑控制失败：${err instanceof Error ? err.message : String(err)}`,
            )
          })
      },
      { once: true },
    )

    // 画布与生成共用一个开关（`mediaEnabled`），缺省时按启用处理，与设置页显示值使用同一判据。
    const mediaOn = opts.config.mediaEnabled !== false
    const builtin = {
      // 画布端口只由服务端提供，与生成开关无关；成员会话的工具卡不显示在当前会话中。
      panel: ports.has(CanvasPort) && opts.member !== true,
      // 生成工具按已配置模型的类别注册；与其他内置工具规则相同，角色的 allowedTools 指定工具时按指定的工具过滤。
      media: mediaOn ? [...new Set(listMediaModels(opts.config).map((m) => m.output))] : null,
      member: opts.member === true,
    }
    if (opts.allowedTools === undefined) {
      registerBuiltinTools(registry, ports, builtin)
    } else {
      // 先注册到临时表再筛选：内置工具集合由 registerBuiltinTools 私有维护，
      // 在此处另行复制一份工具名列表必然与之不一致。
      const all = new ToolRegistry()
      registerBuiltinTools(all, ports, builtin)
      const allow = new Set(opts.allowedTools)
      for (const spec of all.list()) {
        if (allow.has(spec.name)) registry.register(spec)
      }
    }
    const ws = upsertWorkspace(opts.store, opts.workspaceRoot, basename(opts.workspaceRoot))
    this.state = {
      opts,
      registry,
      workspaceId: ws.id,
      seqCounter: new Map(),
      extensions: null,
      pendingTools: null,
      externalToolNames: new Set(),
      extraDirs,
      skillDirs: [],
      mediaSpends: new Map(),
      modelUsage: new Map(),
      ports,
    }
  }

  /** 新建或继续执行一个会话。返回事件流，由调用方决定如何渲染。 */
  async *ask(
    prompt: string,
    existing?: ConversationId,
    options?: AskOptions,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const session = this.state
    const plan = await prepareTurn(session, existing, options)
    const ask = openRun(session, plan, prompt, options)
    // 写入 run 行之后的每一步都在该 try 中：任何一步抛出或生成器被提前关闭，由下方的 catch 与 finally
    // 写入终态。不要把步骤移到 try 之前，否则该步抛出时 run 行停留在 running。
    try {
      const history = await buildRunHistory(session, ask)
      yield* driveLoop(session, ask, history)
    } catch (error) {
      // 生成器内抛出的异常记为失败并保留原文，再交给调用方报告。不要留给 `finally`：
      // 那里只能区分用户停止与消费方关闭，异常会被记为用户中断。
      recordFailure(session, ask, error)
      throw error
    } finally {
      closeRun(session, ask)
    }
  }

  /**
   * 释放本会话对扩展的引用。会话结束时必须调用。
   *
   * 不直接 stop：扩展按工作区共享，其他会话可能仍在使用。
   * 引用计数归零时才关闭子进程。
   *
   * 该方法必须有实际调用点。没有调用点时，server 为每条消息新建的 Session 各自
   * 启动一套插件子进程，且都不会关闭：公开方法有定义不等于有调用方。
   */
  async dispose(): Promise<void> {
    const session = this.state
    /*
     * 浏览器控制与会话绑定：本轮收尾时撤销控制归属与未消费的下载授权，页面保留
     * 供用户继续操作。不释放时下一轮启动会得到 busy，且没有任何入口能解除。
     *
     * 失败只记录一行日志：宿主可能已经断开，而断开路径本身也会撤销这两项。
     */
    session.ports
      .get(BrowserPort)
      ?.release()
      .catch((err) => {
        log.warn(
          'browser',
          `释放浏览器控制失败：${err instanceof Error ? err.message : String(err)}`,
        )
      })
    // 电脑控制与会话绑定：本轮收尾时撤销本执行者名下尚未派发的请求。
    // 已经交给操作系统的动作不回滚：那是执行事实，不是可撤销的占用。
    session.ports
      .get(DesktopPort)
      ?.release()
      .catch((err) => {
        log.warn('desktop', `撤销电脑控制失败：${err instanceof Error ? err.message : String(err)}`)
      })
    if (!session.extensions) return
    const ext = session.extensions
    session.extensions = null
    await releaseExtensions(ext)
  }
}
