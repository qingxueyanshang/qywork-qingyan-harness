import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

export interface SourceHandoff {
  root: string
  target: string
  head: string
  mode: 'desktop' | 'web'
  parentPid: number
}

/** 子进程确认加载了更新程序后，启动所有者才可以退出。 */
export async function handoffSourceUpdate(
  request: SourceHandoff,
  environment: Record<string, string>,
): Promise<void> {
  const dir = join(request.root, '.tmp', 'update')
  mkdirSync(dir, { recursive: true })
  const log = openSync(join(dir, 'apply.log'), 'w')
  try {
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, 'apply.ts'), Buffer.from(JSON.stringify(request)).toString('base64')],
      {
        cwd: request.root,
        detached: true,
        windowsHide: true,
        env: { ...process.env, ...environment },
        stdio: ['ignore', log, log, 'ipc'],
      },
    )
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('更新程序启动超时'))
      }, 10_000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timeout)
        reject(new Error('更新程序提前退出'))
      })
      child.once('message', (message) => {
        if (message !== 'ready') {
          clearTimeout(timeout)
          child.kill()
          reject(new Error('更新程序握手失败'))
          return
        }
        clearTimeout(timeout)
        child.unref()
        resolve()
      })
    })
  } finally {
    closeSync(log)
  }
}
