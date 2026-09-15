/**
 * 配置读写。
 *
 * 没有这条接口时，改配置只有两条路：手编 JSON，或跑 `qy init` 覆盖重来。
 *
 * **明文 key 永远不出这个进程**：GET 只回 `hasApiKey` 布尔，PUT 时若某档案
 * 没带 apiKey 但标了 hasApiKey，就沿用库里那一份。否则「打开设置页看一眼再保存」
 * 会静默清掉用户的 key——这类破坏是不可见的，直到下一次调用才报错。
 */

import { createHash } from 'node:crypto'
import {
  configNotices,
  configPath,
  diagnoseConfig,
  diagnoseRunnable,
  loadConfig,
  type QyConfig,
  type StoredProvider,
  saveConfig,
} from '@qywork/runtime'
import { DEFAULT_ENV_ALLOW } from '@qywork/tools'
import { type ApiHandler, json } from './types.ts'

/**
 * 配置内容的版本指纹，用于保存时的乐观并发校验（见 PUT 分支）。采用内容哈希而非自增
 * 计数：自增计数需额外持久化并跨重启维护，哈希仅由当前配置内容决定。哈希基于完整配置
 * （含明文 key），故 key 变更亦改变版本。
 */
function configVersion(cfg: QyConfig): string {
  return createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 16)
}

/** 接口的对外形状：`apiKey` 换成一个布尔。 */
export type RedactedProvider = Omit<StoredProvider, 'apiKey'> & { hasApiKey: boolean }
export type RedactedConfig = Omit<QyConfig, 'providers'> & {
  providers: Record<string, RedactedProvider>
}

/**
 * 明文 key 不出进程。仅脱去 `apiKey`，替换为一个表示「是否已配置」的布尔值。
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
 * 而这件事在保存的那一刻完全没有反馈，要等到下一次调用模型才失败，
 * 那时已经很难把它和刚才改过的 baseUrl 联系起来。
 *
 * 显式传空串是「清掉」，与「没带」区分开：前者是意图，后者是脱敏的副作用。
 *
 * `apiKey` **必须从 `rest` 里解构出去**。留在 `rest` 里的话，末尾那个
 * `...(apiKey ? { apiKey } : {})` 守卫永远不起作用——想清掉 key 时传空串，
 * 空串照样跟着 `rest` 落进 config.json。功能上没坏（下游把空串当没配），
 * 但那行守卫写了等于没写，而一个不起作用的守卫比没有守卫更容易骗人。
 * `config.test.ts` 钉着这一条。
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
  const merged: QyConfig = { ...current, ...incoming, providers }
  /*
   * active 不脱敏，前端来的那份是权威：它没带就是真的没有默认模型（删光了最后一个），
   * 不能靠 `{ ...current, ...incoming }` 把旧的默认留下来——那样删光模型后会保存被 422 挡住
   * （active 指向已删的接口）。
   */
  if (incoming.active) merged.active = incoming.active
  else delete merged.active
  return merged
}

export const handleConfigApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/config' && req.method === 'GET') {
    /*
     * **每次都从盘读，不回进程启动时那份。**
     *
     * 保存走的是「读回整份 → 改一格 → 整份写回」，所以这里回什么，下一次 PUT
     * 就把什么写进文件。回启动时那份的话，进程运行期间由别处写进文件的改动
     * （`qy probe` 落校准结果、手编 JSON、另一个 qywork 实例）会在用户下一次
     * 改任何一格设置时被整份盖掉，全程没有提示。
     *
     * 就地改而不是换引用：`d.config` 被 run、权限、模型解析各处按引用持有。
     * 进程内没有「只在内存里、盘上没有」的配置状态——除了这个文件的 PUT 分支，
     * 全仓没有第二处写 `d.config`，所以整份换掉不会丢字段。
     */
    Object.assign(d.config, await loadConfig())
    return json({
      path: configPath(),
      config: redactConfig(d.config),
      // 客户端保存时带回来，服务端据此发现读到写之间配置被别处改过（见 PUT）。
      version: configVersion(d.config),
      notices: configNotices(d.config),
      // 保存拦不成形的配置（`diagnoseConfig`），没配 key 只显示不拦保存（`diagnoseRunnable`）。
      // 设置页把两者并成一列显示；PUT 只据前者回 422，见下。
      problems: [...diagnoseConfig(d.config), ...diagnoseRunnable(d.config)],
      // `envAllowList` 留空时真正生效的那一份。设置页拿它当占位符显示——
      // 不下发的话界面只能写一句「留空用默认名单」，而那份名单里有什么无从得知。
      defaultEnvAllowList: DEFAULT_ENV_ALLOW,
    })
  }

  if (p === '/api/config' && req.method === 'PUT') {
    const body = (await req.json().catch(() => null)) as {
      config?: RedactedConfig
      baseVersion?: string
    } | null
    if (!body?.config) return json({ error: 'bad request', message: '缺少 config' }, 400)
    /*
     * 乐观并发校验：多个客户端同时修改时，后发起的写入基于修改前的完整配置，整体回写
     * 会覆盖前一次已保存的字段（典型为 API Key）。基线版本不一致时拒绝，由客户端重新
     * 读取并重放本次修改。未携带 baseVersion 的旧客户端不受此校验限制。
     */
    if (typeof body.baseVersion === 'string' && body.baseVersion !== configVersion(d.config)) {
      return json({ error: 'conflict', message: '配置在别处被改动，已基于最新内容重试' }, 409)
    }
    const merged = mergeConfig(d.config, body.config)
    // 只据 `diagnoseConfig`（不成形）回 422。不要加 `diagnoseRunnable`：没配 key 是配置
    // 中间态，阻止保存将使「新增接口 → 新增模型 → 再填写 key」这一流程无法完成（active 一切到新接口就再存不下）。
    const problems = diagnoseConfig(merged)
    // 不成形就不落盘。写进去再让 CLI 起不来，比拒绝保存糟得多。
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
