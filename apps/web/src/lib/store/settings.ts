/**
 * 设置面：模型配置、工作区、插件、定时任务、team.json。
 *
 * 全是「打开某个面板才会用到」的请求，与主链路无关，所以单独一块——
 * 它们加起来比会话链路还长，混在一起会让读 store 的人以为这些是热路径。
 */

import { client } from './connection.ts'
import type { WorkspaceInfo } from './ui.ts'

// ───────────────────────── 配置 ─────────────────────────

/** 档案的对外形状：明文 key 不出服务进程，只回「有没有」。 */
export interface RedactedProfile {
  kind: string
  model: string
  apiKeyEnv?: string
  baseUrl?: string
  maxOutputTokens?: number
  hasApiKey: boolean
  /** 保存时原样回传，避免把 `qy probe` 的实测结果洗掉。 */
  capabilities?: unknown
  headers?: Record<string, string>
}
export interface RedactedConfig {
  active: string
  profiles: Record<string, RedactedProfile>
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  mode?: 'auto' | 'full'
  additionalDirectories?: string[]
  envAllowList?: string[]
  classifierProfile?: string
}
export interface ConfigPayload {
  path: string
  config: RedactedConfig
  notices: string[]
  problems: string[]
}

export function loadServerConfig(): Promise<ConfigPayload> {
  return client.api<ConfigPayload>('/api/config')
}

/**
 * 把 `client.api` 抛出来的错误还原成人能读的一句话。
 *
 * `client.api` 的消息是 `<状态码> <路径>: <响应体前 200 字>`——响应体是 JSON。
 * 原样显示等于把接口细节甩给用户。这里只取其中真正说明原因的字段
 * （`problems` 数组或 `message`），取不到才回落到原文——**回落到原文而不是
 * 一句「操作失败」**：原文再难看也带着信息，泛化的失败提示一点都不带。
 */
export function explainApiError(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  const at = raw.indexOf('{')
  if (at >= 0) {
    try {
      const body = JSON.parse(raw.slice(at)) as { problems?: string[]; message?: string }
      if (body.problems?.length) return body.problems.join('；')
      if (body.message) return body.message
    } catch {
      // 响应体被 client.api 截断到 200 字时会解析失败，走回落。
    }
  }
  return raw || fallback
}

/**
 * 保存配置。
 *
 * 服务端会先 `diagnoseConfig` 再落盘，有致命问题回 422 且**不写**。
 *
 * 422 由 `client.api` 抛成 `Error`，消息形如
 * `422 /api/config: {"error":"invalid","problems":[...]}`——直接显示给用户
 * 是一串原始 JSON。这里把 `problems` 挖出来还原成人话：保存失败必须说清
 * **哪一条**不合格，「保存失败」和一坨 JSON 是同一个层次的不可用。
 */
export async function saveServerConfig(config: RedactedConfig): Promise<ConfigPayload> {
  try {
    await client.api<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    })
  } catch (e) {
    throw new Error(explainApiError(e, '保存失败'))
  }
  return loadServerConfig()
}

export function loadWorkspace(): Promise<WorkspaceInfo> {
  return client.api<WorkspaceInfo>('/api/workspace')
}

/**
 * 本机已知的工作区列表（账本里出现过的）。
 *
 * 用来做「最近打开」——不必每次都开目录选择器翻一遍。
 */
export interface KnownWorkspace {
  id: string
  rootPath: string
  name: string
  lastOpenedAt: number
}
export function loadKnownWorkspaces(): Promise<{ workspaces: KnownWorkspace[]; current: string }> {
  return client.api<{ workspaces: KnownWorkspace[]; current: string }>('/api/workspaces')
}

// ───────────────────────── 插件安装 ─────────────────────────

/**
 * 装一个插件 = 把一个**本机已存在的目录**复制进 `.qy/plugins/`。
 *
 * 没有 registry，所以没有「从市场安装」；也刻意不做 `git clone <任意 URL>`——
 * 那等于「从网上取一段代码，下次加载就跑它」。用户先自己 clone、看过内容，
 * 再把目录指给这里，中间那一步「你看到了自己装的是什么」值这条命令的成本。
 */
export function installPlugin(path: string): Promise<{ ok: boolean; id: string }> {
  return scheduleWrite('/api/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}
export function uninstallPlugin(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ───────────────────────── 桌面外壳 ─────────────────────────

/**
 * 切换工作区需要**换掉整个 sidecar**，而进程管理只有桌面外壳做得到。
 *
 * Web 端（浏览器 / 手机）连的是一个已经起好的服务，它没有、也不该有
 * 重启宿主进程的能力。所以这里如实返回 false，让界面把原因说出来，
 * 而不是给一个点了没反应的按钮——那正是这轮返工要消灭的东西。
 */
export function isDesktopShell(): boolean {
  return typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ === 'object'
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as
    | TauriInternals
    | undefined
  if (!internals) return Promise.reject(new Error('不在桌面端，无法切换工作区'))
  return internals.invoke(cmd, args) as Promise<T>
}

/** 打开系统目录选择器。用户取消时返回 null——取消不是错误。 */
export function pickWorkspace(): Promise<string | null> {
  return tauriInvoke<string | null>('pick_workspace')
}

/**
 * 切到另一个工作区。
 *
 * 成功之后**窗口会被重建**，所以这个 Promise 之后的代码不保证还在跑。
 * 界面上不要在它后面接「切换成功」的提示——那条提示大概率来不及显示。
 */
export function switchWorkspace(path: string): Promise<void> {
  return tauriInvoke<void>('switch_workspace', { path })
}

// ───────────────────────── 定时任务 ─────────────────────────

export interface ScheduleItem {
  id: string
  title: string
  prompt: string
  kind: 'interval' | 'daily'
  everyMinutes?: number
  atHour?: number
  atMinute?: number
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastRunConversationId?: string
  lastError?: string
  nextRunAt: number | null
  due: boolean
}
export interface SchedulesPayload {
  schedules: ScheduleItem[]
  /** 由服务端下发而不是每个客户端各写一遍：这是功能前提，不是补充说明。 */
  runtimeOnly: string
}

export function loadSchedules(): Promise<SchedulesPayload> {
  return client.api<SchedulesPayload>('/api/schedules')
}

async function scheduleWrite<T>(path: string, init: RequestInit): Promise<T> {
  try {
    return await client.api<T>(path, init)
  } catch (e) {
    throw new Error(explainApiError(e, '操作失败'))
  }
}

export function createSchedule(s: Partial<ScheduleItem>): Promise<{ schedule: ScheduleItem }> {
  return scheduleWrite('/api/schedules', { method: 'POST', body: JSON.stringify(s) })
}
export function updateSchedule(
  id: string,
  s: Partial<ScheduleItem>,
): Promise<{ schedule: ScheduleItem }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(s) })
}
export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'DELETE' })
}
/** 立刻跑一次。**不推进** lastRunAt——试跑不该顶掉当天的自动触发。 */
export function runScheduleNow(id: string): Promise<{ ok: boolean; conversationId: string }> {
  return scheduleWrite(`/api/schedules/${id}/run`, { method: 'POST' })
}

export interface TeamRaw {
  path: string
  exists: boolean
  raw: string
}
export function loadTeamRaw(): Promise<TeamRaw> {
  return client.api<TeamRaw>('/api/team/raw')
}
export async function saveTeamRaw(raw: string): Promise<{ ok: boolean }> {
  try {
    return await client.api<{ ok: boolean }>('/api/team/raw', {
      method: 'PUT',
      body: JSON.stringify({ raw }),
    })
  } catch (e) {
    throw new Error(explainApiError(e, '保存失败'))
  }
}
