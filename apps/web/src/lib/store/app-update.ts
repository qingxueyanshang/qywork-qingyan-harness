import type { UpdateAction, UpdateSnapshot } from '@qywork/core'
import { createSignal } from 'solid-js'
import { isDesktopShell, tauriInvoke } from './shell.ts'

declare const __QYWORK_UPDATE_ENDPOINT__: { base: string; token: string } | null

const [snapshot, setSnapshot] = createSignal<UpdateSnapshot | null>(null)
export const appUpdate = snapshot
export const hasAppUpdate = () =>
  Boolean(
    snapshot()?.version &&
      ['available', 'downloading', 'ready', 'waiting'].includes(snapshot()!.stage),
  )

function sourceEndpoint() {
  return typeof __QYWORK_UPDATE_ENDPOINT__ === 'undefined' ? null : __QYWORK_UPDATE_ENDPOINT__
}

async function request(action: UpdateAction): Promise<UpdateSnapshot | null> {
  const endpoint = sourceEndpoint()
  if (endpoint) {
    const response = await fetch(`${endpoint.base}/${action}`, {
      method: action === 'status' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`更新服务不可用（${response.status}）`)
    return (await response.json()) as UpdateSnapshot
  }
  if (isDesktopShell()) return tauriInvoke<UpdateSnapshot>('app_update', { action })
  return null
}

export async function actOnUpdate(action: UpdateAction): Promise<void> {
  try {
    setSnapshot(await request(action))
  } catch (error) {
    const previous = snapshot()
    if (previous)
      setSnapshot({
        ...previous,
        stage: 'error',
        error: error instanceof Error ? error.message : String(error),
        retry: 'check',
      })
  }
}

/** 下载状态属于启动所有者，界面卸载不取消下载。 */
export function observeAppUpdate(): () => void {
  if (!sourceEndpoint() && !isDesktopShell()) return () => {}
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    try {
      const next = await request('status')
      if (!stopped) setSnapshot(next)
    } catch {
      /* 重启期间保留最后一份状态，连接恢复后继续读取。 */
    }
    if (!stopped) timer = setTimeout(() => void poll(), 1000)
  }
  void poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

export function updatePresentation(value: UpdateSnapshot): {
  text: string
  action: UpdateAction
  label: string
  disabled: boolean
} {
  const ready = value.mode.startsWith('source') ? '更新源码并重启' : '重启并更新'
  const values: Record<UpdateSnapshot['stage'], [string, UpdateAction, string, boolean]> = {
    idle: ['尚未检查', 'check', '检查更新', false],
    checking: ['正在检查更新…', 'check', '检查中…', true],
    latest: ['已是最新版本', 'check', '检查更新', false],
    available: [`发现新版本 ${value.version}`, 'download', '下载更新', false],
    downloading: [
      value.progress === null ? '正在下载…' : `正在下载 · ${Math.floor(value.progress)}%`,
      'cancel',
      '取消下载',
      false,
    ],
    ready: [`${value.version} 已下载`, 'install', ready, false],
    waiting: ['等待任务结束', 'cancel', '取消等待', false],
    installing: ['正在更新…', 'install', '更新中…', true],
    error: [value.error ?? '更新失败', value.retry, '重试', false],
  }
  const [text, action, label, disabled] = values[value.stage]
  return { text, action, label, disabled }
}
