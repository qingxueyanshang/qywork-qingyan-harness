/**
 * 工作台：已安装插件提供的网页。列表取自 `/api/plugins`（服务端从磁盘读取，见 `server/src/plugin-ui.ts`）。
 */

import { createSignal } from 'solid-js'
import { client } from './connection.ts'

export interface Workbench {
  plugin: string
  id: string
  title: string
  /** 页面地址（相对服务端根），含每次启动生成的随机段。不要保存它。 */
  path: string
}

/** 插件工具的返回值，形状与模型调用插件工具时相同。 */
export interface WorkbenchOutcome {
  status: 'success' | 'failure'
  executed: boolean
  message: string
  data?: Record<string, unknown>
}

const [list, setList] = createSignal<readonly Workbench[]>([])
export const workbenches = list

export function workbenchKey(w: Pick<Workbench, 'plugin' | 'id'>): string {
  return `${w.plugin}/${w.id}`
}

export function workbenchUrl(w: Workbench): string {
  return `${client.base}${w.path}`
}

export async function refreshWorkbenches(): Promise<void> {
  const r = await client.api<{ workbenches?: Workbench[] }>('/api/plugins')
  setList(r.workbenches ?? [])
}

/** 调用工作台所属插件声明的工具。 */
export function callWorkbenchTool(
  plugin: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<WorkbenchOutcome> {
  return client.api<WorkbenchOutcome>(`/api/plugins/${encodeURIComponent(plugin)}/call`, {
    method: 'POST',
    body: JSON.stringify({ tool, args }),
  })
}
