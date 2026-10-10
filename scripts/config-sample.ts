/**
 * 发布版本的配置样本：覆盖全部配置字段与全部词表取值的配置，以及用该版本代码求出的含义摘要。
 *
 * `bun run scripts/config-sample.ts` 写入当前 `VERSION` 的样本（`scripts/config-samples/<版本>.json`），已存在时不覆盖；
 * 发布步骤 `bun run version:sync` 会执行它。`config-samples.test.ts` 用当前代码加载全部历史样本：
 * 删除词表取值、改名或删除配置字段而没有在 `loadConfig` 中写迁移时，旧样本的结构校验或含义比对失败。
 *
 * 样本中的字段由 `Required<…>` 约束：配置类型新增字段而样本未覆盖时类型检查失败。
 * 词表取值按各词表常量逐项生成，词表新增取值时样本自动包含。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_REASONING_PROTOCOLS, type TransportCapabilities } from '@qywork/ai'
import {
  CACHE_ROUTINGS,
  EFFORT_ORDER,
  MEDIA_KIND_OUTPUT,
  MEDIA_KINDS,
  MEDIA_OUTPUTS,
  PROVIDER_KINDS,
  REASONING_ECHOES,
  THINKING_MODES,
  TOOL_SCHEMA_MODES,
} from '@qywork/core'
import {
  listMediaModels,
  loadConfig,
  type QyConfig,
  resolveMediaModel,
  resolveModel,
  type StoredCatalogEntry,
  type StoredMediaModel,
  type StoredModel,
  type StoredProvider,
} from '@qywork/runtime'

const ROOT = join(import.meta.dir, '..')
export const SAMPLES_DIR = join(ROOT, 'scripts', 'config-samples')

/** 取第 `i` 项，超出长度时循环。 */
const pick = <T>(list: readonly T[], i: number): T => list[i % list.length]!

/** 覆盖全部字段与全部词表取值的配置。 */
export function sampleConfig(): QyConfig {
  const providers: Record<string, Required<StoredProvider>> = {}
  const catalog: Record<string, Required<StoredCatalogEntry>> = {}
  let n = 0
  for (const [p, kind] of PROVIDER_KINDS.entries()) {
    const models: Record<string, Required<StoredModel>> = {}
    for (const effort of EFFORT_ORDER) {
      const id = `chat-${kind}-${effort}`
      const transport: Required<TransportCapabilities> = {
        effort: n % 2 === 0,
        effortLevels: EFFORT_ORDER.slice(0, (n % EFFORT_ORDER.length) + 1),
        thinking: pick(THINKING_MODES, n),
        toolCalls: {
          kind,
          model: id,
          baseUrl: `https://sample-${p}.invalid/v1`,
          schema: pick(TOOL_SCHEMA_MODES, n),
          checkedAt: 1_790_000_000_000 + n,
          status: pick(['passed', 'failed', 'inconclusive'] as const, n),
        },
      }
      models[id] = { effort, transport }
      catalog[`${id}|${kind}`] = {
        displayName: `Sample ${n}`,
        vendor: 'sample',
        contextWindow: 128_000 + n,
        maxOutputTokens: 8_000 + n,
        vision: n % 2 === 1,
        input: 1 + n,
        output: 2 + n,
        cacheRead: 0.1,
        cacheWrite: 1.25,
        currency: pick(['USD', 'CNY'] as const, n),
        thinking: pick(THINKING_MODES, n),
        effortLevels: EFFORT_ORDER.slice(n % EFFORT_ORDER.length),
        thinksByDefault: n % 3 === 0,
        chatReasoningProtocol: pick(CHAT_REASONING_PROTOCOLS, n),
        reasoningEcho: pick(REASONING_ECHOES, n),
        cacheRouting: pick(CACHE_ROUTINGS, n),
      }
      n++
    }
    const media: Record<string, StoredMediaModel> = {}
    for (const [m, mediaKind] of MEDIA_KINDS.entries()) {
      if (m % PROVIDER_KINDS.length === p) media[`media-${mediaKind}`] = { kind: mediaKind }
    }
    providers[`sample-${kind}`] = {
      kind,
      apiKey: 'sk-sample',
      baseUrl: `https://sample-${p}.invalid/v1`,
      headers: { 'x-sample': String(p) },
      models,
      media,
    }
  }
  const mediaDefaults: QyConfig['mediaDefaults'] = {}
  for (const output of MEDIA_OUTPUTS) {
    const kind = MEDIA_KINDS.find((k) => MEDIA_KIND_OUTPUT[k] === output)!
    const provider = Object.keys(providers).find(
      (name) => `media-${kind}` in providers[name]!.media,
    )!
    mediaDefaults[output] = { provider, model: `media-${kind}` }
  }
  const first = PROVIDER_KINDS[0]
  const config = {
    updates: { autoCheck: false, autoDownload: false },
    active: { provider: `sample-${first}`, model: `chat-${first}-${EFFORT_ORDER[0]}` },
    providers,
    catalog,
    mediaDefaults,
    mode: 'auto',
    browserEnabled: false,
    desktopEnabled: false,
    desktopForeground: false,
    officeEnabled: false,
    mediaEnabled: false,
    officePython: '/usr/bin/python3',
    additionalDirectories: ['/srv/qywork-sample'],
    sandboxNetwork: 'deny',
    envAllowList: ['GITHUB_TOKEN'],
  } satisfies Required<QyConfig>
  return config
}

/** 解析结果中与配置含义有关的部分；密钥只记录是否存在。 */
function resolved(r: ReturnType<typeof resolveModel>) {
  if (!r) return null
  const { apiKey, ...rest } = r
  return { ...rest, hasApiKey: Boolean(apiKey) }
}

/** 各开关与设置字段。映射类型要求列出全部字段：配置类型新增字段时此处类型检查失败。 */
type Settings = {
  [K in Exclude<keyof QyConfig, 'providers' | 'catalog' | 'active' | 'mediaDefaults'>]-?:
    | QyConfig[K]
    | undefined
}

/**
 * 配置的含义摘要：经解析函数求出的结果与各设置字段的取值。比较含义而不是 JSON 原文：
 * 迁移改变写法而含义不变时应当通过。
 */
export function meaningOf(cfg: QyConfig) {
  const settings: Settings = {
    updates: cfg.updates,
    mode: cfg.mode,
    browserEnabled: cfg.browserEnabled,
    desktopEnabled: cfg.desktopEnabled,
    desktopForeground: cfg.desktopForeground,
    officeEnabled: cfg.officeEnabled,
    mediaEnabled: cfg.mediaEnabled,
    officePython: cfg.officePython,
    additionalDirectories: cfg.additionalDirectories,
    sandboxNetwork: cfg.sandboxNetwork,
    envAllowList: cfg.envAllowList,
  }
  const models: Record<string, ReturnType<typeof resolved>> = {}
  for (const [provider, p] of Object.entries(cfg.providers)) {
    for (const model of Object.keys(p.models ?? {}))
      models[`${provider}/${model}`] = resolved(resolveModel(cfg, { provider, model }))
  }
  return JSON.parse(
    JSON.stringify({
      active: resolved(resolveModel(cfg)),
      models,
      media: listMediaModels(cfg),
      mediaDefaults: Object.fromEntries(
        MEDIA_OUTPUTS.map((output) => {
          const r = resolveMediaModel(cfg, output)
          return [output, r ? { provider: r.provider, model: r.model, kind: r.kind } : null]
        }),
      ),
      settings,
    }),
  ) as Record<string, unknown>
}

/** 以当前代码加载一份配置：写入临时的全局目录后经 `loadConfig` 读取，与启动时执行相同的迁移。 */
export async function loadAsCurrent(config: unknown, scratch: string): Promise<QyConfig> {
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'home-'))
  const previous = process.env.QYWORK_HOME
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2))
    process.env.QYWORK_HOME = home
    return await loadConfig()
  } finally {
    if (previous === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/** 样本中记录的含义在当前结果中不成立的路径。当前结果多出的键不算差异：新版本新增的字段不影响旧配置。 */
export function meaningChanges(recorded: unknown, current: unknown, path = ''): string[] {
  if (recorded !== null && typeof recorded === 'object') {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(recorded) !== Array.isArray(current)
    )
      return [path || '（根）']
    if (Array.isArray(recorded) && recorded.length !== (current as unknown[]).length) return [path]
    return Object.entries(recorded).flatMap(([key, value]) =>
      meaningChanges(
        value,
        (current as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
      ),
    )
  }
  return recorded === current ? [] : [path]
}

if (import.meta.main) {
  const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim()
  const target = join(SAMPLES_DIR, `${version}.json`)
  try {
    readFileSync(target)
    console.log(`配置样本已存在，不覆盖：${target}`)
  } catch {
    const config = sampleConfig()
    const meaning = meaningOf(await loadAsCurrent(config, join(ROOT, '.tmp', 'config-sample')))
    mkdirSync(SAMPLES_DIR, { recursive: true })
    writeFileSync(target, `${JSON.stringify({ version, config, meaning }, null, 2)}\n`)
    console.log(`已写入配置样本：${target}`)
  }
}
