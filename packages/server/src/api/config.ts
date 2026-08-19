/**
 * 配置读写。
 *
 * 在此之前改配置只有两条路：手编 JSON，或跑 `qy init` 覆盖重来。
 *
 * **明文 key 永远不出这个进程**：GET 只回 `hasApiKey` 布尔，PUT 时若某档案
 * 没带 apiKey 但标了 hasApiKey，就沿用库里那一份。否则「打开设置页看一眼再保存」
 * 会静默清掉用户的 key——这类破坏是不可见的，直到下一次调用才报错。
 */

import {
  configNotices,
  configPath,
  diagnoseConfig,
  type QyConfig,
  type StoredProvider,
  saveConfig,
} from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

/** 接口的对外形状：`apiKey` 换成一个布尔。 */
export type RedactedProvider = Omit<StoredProvider, 'apiKey'> & { hasApiKey: boolean }
export type RedactedConfig = Omit<QyConfig, 'providers'> & {
  providers: Record<string, RedactedProvider>
}

/**
 * 明文 key 不出进程。只脱 `apiKey`，换成一个「有没有」的布尔。
 */
export function redactConfig(cfg: QyConfig): RedactedConfig {
  const providers: Record<string, RedactedProvider> = {}
  for (const [name, p] of Object.entries(cfg.providers)) {
    const { apiKey, ...rest } = p
    providers[name] = { ...rest, hasApiKey: Boolean(apiKey) }
  }
  return { ...cfg, providers }
}

/**
 * 把前端交回来的脱敏配置合回真实配置。
 *
 * 关键的一条：**接口带 `hasApiKey: true` 但没带 `apiKey` 时，沿用旧的那份**。
 * 不这样做的话，「打开设置页，改个 baseUrl，保存」会把 key 清成 undefined——
 * 而这件事在保存的那一刻完全没有反馈，要等到下一次调用模型才炸，
 * 那时候人已经不会把它和「我刚才改了 baseUrl」联系起来了。
 *
 * 显式传空串是「清掉」，与「没带」区分开：前者是意图，后者是脱敏的副作用。
 *
 * `apiKey` **必须从 `rest` 里解构出去**。原先它留在 `rest` 里，末尾那个
 * `...(apiKey ? { apiKey } : {})` 守卫就永远不起作用——想清掉 key 时传空串，
 * 空串照样跟着 `rest` 落进 config.json。功能上没坏（下游把空串当没配），
 * 但那行守卫写了等于没写，而一个不起作用的守卫比没有守卫更容易骗人。
 * 拆出来之后补的单测顶出的。
 */
export function mergeConfig(current: QyConfig, incoming: RedactedConfig): QyConfig {
  const providers: Record<string, StoredProvider> = {}
  for (const [name, p] of Object.entries(incoming.providers ?? {})) {
    const { hasApiKey, apiKey: explicit, ...rest } = p as RedactedProvider & { apiKey?: string }
    const prior = current.providers[name]?.apiKey
    const apiKey = explicit !== undefined ? explicit : hasApiKey ? prior : undefined
    providers[name] = {
      ...(rest as StoredProvider),
      ...(apiKey ? { apiKey } : {}),
    }
  }
  return { ...current, ...incoming, providers }
}

export const handleConfigApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/config' && req.method === 'GET') {
    return json({
      path: configPath(),
      config: redactConfig(d.config),
      notices: configNotices(d.config),
      problems: diagnoseConfig(d.config),
    })
  }

  if (p === '/api/config' && req.method === 'PUT') {
    const body = (await req.json().catch(() => null)) as { config?: RedactedConfig } | null
    if (!body?.config) return json({ error: 'bad request', message: '缺少 config' }, 400)
    const merged = mergeConfig(d.config, body.config)
    const problems = diagnoseConfig(merged)
    // 有致命问题就不落盘。写进去再让 CLI 起不来，比拒绝保存糟得多。
    if (problems.length) return json({ error: 'invalid', problems }, 422)
    await saveConfig(merged)
    // 就地更新运行中的这份：不更新的话，保存成功但本进程仍用旧配置，
    // 用户下一轮对话还是老模型——又一个「看起来生效了」。
    Object.assign(d.config, merged)
    for (const k of Object.keys(d.config.providers)) {
      if (!(k in merged.providers)) delete d.config.providers[k]
    }
    return json({ ok: true, config: redactConfig(d.config), notices: configNotices(d.config) })
  }

  return null
}
