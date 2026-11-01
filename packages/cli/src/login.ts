/**
 * `qy login` / `qy logout`：登录与退出云端账号。与桌面端账号区块调用同一个账号对象（`CloudAccount`），
 * 登录状态与设备密钥都只保存在配置的云端接口中。登录只输出确认地址、不打开浏览器：命令行可能经 SSH 运行。
 */

import { loadConfig } from '@qywork/runtime'
import { CloudAccount, type CloudState, cloudOrigins } from '@qywork/server'

/** 登录过程中读取状态的间隔。 */
const POLL_MS = 2000

function failure(state: CloudState): string {
  if (state.state !== 'signed_out') return '登录失败'
  if (state.reason === 'expired') return '登录码已过期'
  if (state.reason === 'denied') return '已在浏览器中拒绝'
  if (state.reason === 'revoked') return '设备已被移除'
  return state.message ?? '登录失败'
}

async function account(): Promise<CloudAccount | null> {
  const origins = cloudOrigins()
  if (!origins) {
    process.stderr.write('未配置云端服务\n')
    return null
  }
  return new CloudAccount(await loadConfig(), origins)
}

export async function runLogin(opts: { pollMs?: number } = {}): Promise<number> {
  const a = await account()
  if (!a) return 1
  let state = await a.login()
  if (state.state === 'pending') {
    process.stderr.write(`在浏览器中确认登录码 ${state.userCode}\n  ${state.verificationUri}\n`)
    while (state.state === 'pending') {
      await Bun.sleep(opts.pollMs ?? POLL_MS)
      state = await a.state()
    }
  }
  if (state.state === 'signed_in') {
    process.stderr.write(`已登录 ${state.email}\n`)
    return 0
  }
  process.stderr.write(`${failure(state)}\n`)
  return 1
}

export async function runLogout(): Promise<number> {
  const a = await account()
  if (!a) return 1
  await a.logout()
  process.stderr.write('已退出\n')
  return 0
}
