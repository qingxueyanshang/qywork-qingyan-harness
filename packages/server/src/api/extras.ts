/**
 * 会话级的「这一轮不用它」。
 *
 * ## 它和设置页的分工
 *
 * 设置页回答「我要改什么」——列出来、加、删、改，**不放开关**。
 * 这里回答「这一轮怎么跑」——逐条开关，只影响当前那一条会话。
 *
 * 两件事混在一处的话，用户在设置里关掉一个 MCP，会以为是全局关掉了；
 * 而实际上他多半只是不想在这一次任务里被它打扰。
 *
 * ## 列表由服务端合并，前端不自己拼
 *
 * 可开关的条目 = 三层解析之后、**用户看得见的那两层**（用户级 + 全局）。
 * 内置层不出现：用户看不到它，也就没有开关可言。这份清单必须和 agent 真正
 * 加载的那份来自同一个解析——前端自己扫一遍就会出现「面板上关掉了，模型还在用」。
 */

import { resolve } from 'node:path'
import type { ConversationId } from '@qywork/core'
import { loadScopedMcpConfig, PLUGINS_SUBDIR } from '@qywork/runtime'
import { getConversation, listDisabledExtras, setExtraEnabled } from '@qywork/store'
import { listScopedEntries, type Scope, scanSkills, scopePaths, scopeRoots } from '@qywork/tools'
import { type ApiHandler, json } from './types.ts'

export interface ExtraRow {
  /** `<类目>:<标识>`。前缀就是类目，前端按它分组。 */
  key: string
  label: string
  /** 一句话说明。技能和记忆有，MCP / 插件用条目数代替。 */
  detail: string
  scope: Scope
  enabled: boolean
}

export const handleExtrasApi: ApiHandler = async (url, req, d) => {
  const m = /^\/api\/conversations\/([^/]+)\/extras$/.exec(url.pathname)
  if (!m) return null
  const conversationId = m[1] as ConversationId
  if (!getConversation(d.store, conversationId)) return json({ error: 'not found' }, 404)

  if (req.method === 'PUT') {
    const body = (await req.json().catch(() => null)) as {
      key?: string
      enabled?: boolean
    } | null
    if (!body?.key || typeof body.enabled !== 'boolean') {
      return json({ error: 'bad request', message: '缺少 key 或 enabled' }, 400)
    }
    setExtraEnabled(d.store, conversationId, body.key, body.enabled)
    return json({ ok: true })
  }

  if (req.method !== 'GET') return null

  const disabled = listDisabledExtras(d.store, conversationId)
  const roots = scopeRoots(d.workspaceRoot)
  const rows: ExtraRow[] = []
  const push = (key: string, label: string, detail: string, scope: Scope) => {
    // 内置层不给开关：用户看不见它，画一个开关等于画一个解释不了的东西。
    if (scope === 'builtin') return
    rows.push({ key, label, detail, scope, enabled: !disabled.has(key) })
  }

  for (const s of await scanSkills(roots).catch(() => [])) {
    push(`skill:${s.name}`, s.name, s.description, s.scope)
  }
  for (const e of await listScopedEntries(roots).catch(() => [])) {
    push(`memory:${e.key}`, e.key, e.preview, e.scope)
  }

  const mcp = await loadScopedMcpConfig(d.workspaceRoot)
  for (const name of Object.keys(mcp.servers)) {
    push(`mcp:${name}`, name, '', mcp.scopeOf[name] ?? 'user')
  }

  const { loadExtensions } = await import('@qywork/runtime')
  const ext = await loadExtensions(d.workspaceRoot)
  const pluginDirs = scopePaths(roots, PLUGINS_SUBDIR)
  for (const pl of ext.plugins.plugins) {
    const scope =
      pluginDirs.find((x) => resolve(pl.dir).startsWith(resolve(x.dir)))?.scope ?? 'user'
    push(`plugin:${pl.manifest.id}`, pl.manifest.id, pl.manifest.name, scope)
  }

  return json({ extras: rows })
}
