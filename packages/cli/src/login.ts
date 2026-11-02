/**
 * `qy login` / `qy logout`：登录与退出云端账号。与桌面端账号界面调用同一个账号对象（`CloudAccount`），
 * 登录状态与设备密钥都只保存在配置的云端接口中。登录在终端中询问邮箱与密码，密码不回显。
 */

import { loadConfig } from '@qywork/runtime'
import { CloudAccount, CloudAccountError, cloudOrigin } from '@qywork/server'

/** 读取一行输入；`hidden` 为真时不回显。测试以固定答案代替终端。 */
export type Ask = (question: string, hidden: boolean) => Promise<string>

async function account(): Promise<CloudAccount | null> {
  const origin = cloudOrigin()
  if (!origin) {
    process.stderr.write('未配置云端服务\n')
    return null
  }
  return new CloudAccount(await loadConfig(), origin)
}

/**
 * 以原始模式逐字读取一行：退格删除一个字符，Ctrl-C 结束进程。
 * 以 `data` 事件读取，不用 `for await`：提前结束异步迭代会关闭 stdin，第二次询问随之无法读取。
 */
const askTerminal: Ask = (question, hidden) => {
  const stdin = process.stdin
  process.stderr.write(question)
  return new Promise((resolve) => {
    let value = ''
    const done = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
    }
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') {
          done()
          process.exit(130)
        }
        if (ch === '\r' || ch === '\n') {
          done()
          resolve(hidden ? value : value.trim())
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value && !hidden) process.stderr.write('\b \b')
          value = value.slice(0, -1)
        } else {
          value += ch
          if (!hidden) process.stderr.write(ch)
        }
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

export async function runLogin(ask: Ask = askTerminal): Promise<number> {
  const a = await account()
  if (!a) return 1
  const current = await a.state()
  if (current.state === 'signed_in') {
    process.stderr.write(`已登录 ${current.email}\n`)
    return 0
  }
  if (ask === askTerminal && !process.stdin.isTTY) {
    process.stderr.write('qy login 须在终端中运行\n')
    return 1
  }
  const email = await ask('邮箱：', false)
  const password = await ask('密码：', true)
  try {
    const state = await a.login(email, password)
    if (state.state !== 'signed_in') throw new CloudAccountError('登录失败')
    process.stderr.write(`已登录 ${state.email}\n`)
    return 0
  } catch (err) {
    if (!(err instanceof CloudAccountError)) throw err
    process.stderr.write(`${err.message}\n`)
    return 1
  }
}

export async function runLogout(): Promise<number> {
  const a = await account()
  if (!a) return 1
  await a.logout()
  process.stderr.write('已退出\n')
  return 0
}
