#!/usr/bin/env bun
/**
 * 复现脚本使用的服务进程入口：在独立进程中运行 `serve`。
 *
 * 独立进程是「结束服务后重新启动、账本仍为同一个文件」路径的前提，
 * 在同一进程中启动的服务无法满足该前提。
 *
 * 令牌经 `QY_REPLAY_TOKEN` 环境变量传递，不经命令行参数：命令行在进程表中可读。
 * 就绪后向 stdout 输出一行 `port=<端口>`，调用方据此连接。
 */

import { loadConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import { Store } from '@qywork/store'

const [dbPath, workspaceRoot] = process.argv.slice(2)
if (!dbPath || !workspaceRoot) throw new Error('用法：replay-server.ts <账本路径> <工作区根>')

const token = process.env.QY_REPLAY_TOKEN
const handle = serve({
  store: new Store({ path: dbPath }),
  config: await loadConfig(),
  workspaceRoot,
  port: 0,
  host: '127.0.0.1',
  ...(token ? { token } : {}),
})

process.stdout.write(`port=${handle.port}\n`)
