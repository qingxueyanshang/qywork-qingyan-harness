/**
 * 配置读写。
 *
 * 没有该接口时，修改配置只有两种方式：手动编辑 JSON，或运行 `qy init` 重新覆盖。
 *
 * 明文 key 不离开本进程：GET 只返回 `hasApiKey` 布尔值，PUT 时若某档案
 * 未携带 apiKey 但标记了 hasApiKey，则沿用已存储的值。否则「打开设置页、不做修改直接保存」
 * 会静默清除用户的 key，直到下一次调用模型才报错。
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

/** 接口对外的数据结构：`apiKey` 替换为布尔值 `hasApiKey`。 */
export type RedactedProvider = Omit<StoredProvider, 'apiKey'> & { hasApiKey: boolean }
export type RedactedConfig = Omit<QyConfig, 'providers'> & {
  providers: Record<string, RedactedProvider>
}

/**
 * 明文 key 不离开本进程。仅移除 `apiKey`，替换为表示是否已配置的布尔值。
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
 * 将前端提交的脱敏配置合并回真实配置。
 *
 * 接口带 `hasApiKey: true` 但未带 `apiKey` 时，沿用已存储的值。
 * 否则「打开设置页，修改 baseUrl，保存」会把 key 清除为 undefined；保存时没有任何反馈，
 * 下一次调用模型时才失败，此时难以将失败与此前修改的 baseUrl 关联。
 *
 * 显式传入空串表示清除，与未携带区分：前者是用户意图，后者是脱敏的副作用。
 *
 * `apiKey` 必须从 `rest` 中解构出去。若留在 `rest` 中，末尾的
 * `...(apiKey ? { apiKey } : {})` 守卫永远不起作用：清除 key 时传入的空串
 * 仍会随 `rest` 写入 config.json。功能上没有错误（下游把空串视为未配置），
 * 但该守卫失效，而失效的守卫比没有守卫更容易造成误判。
 * `config.test.ts` 锁定该行为。
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
   * active 与 mediaDefaults 不脱敏，以前端提交的值为准：未携带即表示没有默认模型（最后一个模型已删除）。
   * 不要用 `{ ...current, ...incoming }` 保留旧的默认值：删除全部模型后，保存会被 422 拒绝
   * （默认值指向已删除的接口或模型）。
   */
  if (incoming.active) merged.active = incoming.active
  else delete merged.active
  if (incoming.mediaDefaults) merged.mediaDefaults = incoming.mediaDefaults
  else delete merged.mediaDefaults
  return merged
}

/**
 * 将进程内的配置就地替换为 `next`。必须就地替换而不是替换引用：`d.config` 被 run、权限、模型解析各处按引用持有。
 *
 * 不要只用 `Object.assign`：它不删除 `next` 中没有的键。已删除的默认模型（`active`、`mediaDefaults`）会留在内存中，
 * 由下一次 GET 返回设置页、随下一次保存提交，被校验以「默认模型不在配置中」拒绝。
 */
function adoptConfig(target: QyConfig, next: QyConfig): void {
  for (const key of Object.keys(target)) {
    if (!(key in next)) Reflect.deleteProperty(target, key)
  }
  Object.assign(target, next)
}

export const handleConfigApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/config' && req.method === 'GET') {
    /*
     * 每次都从磁盘读取，不返回进程启动时的配置。
     *
     * 保存流程是「读取完整配置 → 修改一项 → 整体写回」，此处返回的内容会被下一次 PUT
     * 写入文件。若返回启动时的配置，进程运行期间由其他来源写入文件的改动
     * （`qy probe` 写入的校准结果、手动编辑的 JSON、另一个 qywork 实例）会在用户下一次
     * 修改任意设置项时被整体覆盖，且没有提示。
     *
     * 进程内不存在仅在内存中、磁盘上没有的配置状态：除本文件的 PUT 分支外，
     * 全仓没有第二处写入 `d.config`，因此整体替换不会丢失字段。
     */
    adoptConfig(d.config, await loadConfig())
    return json({
      path: configPath(),
      config: redactConfig(d.config),
      // 客户端保存时回传该值，服务端据此检测读取与写入之间配置是否被其他位置修改（见 PUT）。
      version: configVersion(d.config),
      notices: configNotices(d.config),
      // 保存时拒绝结构不合法的配置（`diagnoseConfig`）；未配置 key 只显示、不阻止保存（`diagnoseRunnable`）。
      // 设置页将两者合并为一列显示；PUT 只依据前者返回 422，见下。
      problems: [...diagnoseConfig(d.config), ...diagnoseRunnable(d.config)],
      // `envAllowList` 留空时实际生效的名单。设置页将其作为占位符显示；
      // 不下发时界面只能显示「留空使用默认名单」，无法得知名单内容。
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
     *
     * 比较基准是磁盘上的当前内容，先读取磁盘再比较。不要只与进程内的配置比较：它只在 GET 时刷新，
     * 两次请求之间其他进程（`qy probe`、另一个 qywork 实例）写入文件的改动会被整体覆盖。
     */
    adoptConfig(d.config, await loadConfig())
    if (typeof body.baseVersion === 'string' && body.baseVersion !== configVersion(d.config)) {
      return json({ error: 'conflict', message: '配置已在其他位置修改，已基于最新内容重试' }, 409)
    }
    const merged = mergeConfig(d.config, body.config)
    // 只依据 `diagnoseConfig`（结构不合法）返回 422。不要加入 `diagnoseRunnable`：未配置 key 是配置
    // 中间态，阻止保存将使「新增接口 → 新增模型 → 再填写 key」这一流程无法完成（active 切换到新接口后即无法保存）。
    const problems = diagnoseConfig(merged)
    // 配置结构不合法时不落盘：写入后 CLI 将无法启动，后果比拒绝保存严重。
    if (problems.length) return json({ error: 'invalid', problems }, 422)
    await saveConfig(merged)
    // 就地更新运行中的配置：否则保存成功后本进程仍使用旧配置，
    // 下一轮对话仍使用旧模型。
    adoptConfig(d.config, merged)
    return json({ ok: true, config: redactConfig(d.config), notices: configNotices(d.config) })
  }

  return null
}
