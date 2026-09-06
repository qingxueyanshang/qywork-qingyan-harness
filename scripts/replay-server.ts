#!/usr/bin/env bun
/**
 * 复刻脚本用的服务进程入口：把 `serve` 单独放进一个进程。
 *
 * 单独一个进程是「杀掉服务再起一份、账本仍是同一份文件」那条路径的前提，
 * 同进程起的服务做不到。
 *
 * 令牌走 `QY_REPLAY_TOKEN` 环境变量，不走命令行参数：命令行在进程表里可读。
 * 就绪后往 stdout 打一行 `port=<端口>`，调用方按它连。
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
