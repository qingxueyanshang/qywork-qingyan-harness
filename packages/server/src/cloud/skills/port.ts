/**
 * 云端技能端口（`@qywork/agent` 的 `CloudSkillPort`）的实现：以设备密钥调用云端的技能读取接口
 * `GET /v1/skills/<技能包>/files|read|search`。
 *
 * 不变量：
 * - 设备密钥在每次调用时从配置的云端接口读取（`cloudProviderOf`），没有第二份；退出登录后下一次调用即失败。
 * - 云端只返回路径、行号与标记，本实现不请求也不持有正文。标记按 `parseSkillMarker` 解析，与请求的技能包、路径、
 *   行段不一致时按失败处理；特征计数取标记中的计数，不另取响应中的同名字段。
 * - 云端读取接口的六个错误码原样作为失败类别，其余失败（未登录、设备密钥无效、连接失败、云端故障、响应无法解析）
 *   归为 `unavailable`，说明取云端的错误说明或本地的一句话。
 */

import type { CloudSkillErrorCode, CloudSkillPort, CloudSkillResult } from '@qywork/agent'
import { httpStatusName, parseSkillMarker } from '@qywork/ai'
import type { QyConfig } from '@qywork/runtime'
import { cloudProviderOf } from '../account.ts'

const SKILL_ERRORS: ReadonlySet<string> = new Set<CloudSkillErrorCode>([
  'skill_not_granted',
  'skill_version_not_found',
  'skill_file_not_found',
  'skill_file_binary',
  'skill_range_invalid',
  'invalid_request',
])

export interface CloudSkillPortOptions {
  config: QyConfig
  /** 云端服务的地址（`cloudOrigin`）。 */
  origin: string
  /** 本会话可用的技能包；`version` 缺省时读取最新版本。 */
  packages: readonly { package: string; version?: number }[]
  /** 每次请求的超时，默认 20 秒。 */
  timeoutMs?: number
}

const unavailable = (message: string) => ({
  ok: false as const,
  code: 'unavailable' as const,
  message,
})

export function cloudSkillPort(opts: CloudSkillPortOptions): CloudSkillPort {
  const timeoutMs = opts.timeoutMs ?? 20_000

  async function call(
    pkg: string,
    action: 'files' | 'read' | 'search',
    params: Record<string, string>,
  ): Promise<CloudSkillResult<Record<string, unknown>>> {
    const key = cloudProviderOf(opts.config, opts.origin)?.apiKey
    if (!key) return unavailable('未登录云端账号')
    const version = opts.packages.find((p) => p.package === pkg)?.version
    const query = new URLSearchParams({
      ...params,
      ...(version === undefined ? {} : { version: String(version) }),
    })
    let res: Response
    try {
      res = await fetch(`${opts.origin}/v1/skills/${encodeURIComponent(pkg)}/${action}?${query}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      return unavailable(`无法连接云端：${err instanceof Error ? err.message : String(err)}`)
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok) return body ? { ok: true, value: body } : unavailable('云端技能接口的响应无法解析')
    const error = (body?.error ?? null) as { code?: unknown; message?: unknown } | null
    const message = typeof error?.message === 'string' ? error.message : ''
    if (typeof error?.code === 'string' && SKILL_ERRORS.has(error.code)) {
      return { ok: false, code: error.code as CloudSkillErrorCode, message }
    }
    return unavailable(
      `云端返回 ${res.status} ${httpStatusName(res.status)}${message ? `：${message}` : ''}`,
    )
  }

  return {
    packages: opts.packages.map((p) => p.package),

    async files(pkg) {
      const r = await call(pkg, 'files', {})
      if (!r.ok) return r
      const files = r.value.files
      if (
        !Array.isArray(files) ||
        !files.every((f) => typeof f?.path === 'string' && typeof f?.size === 'number')
      ) {
        return unavailable('云端技能接口的响应无法解析')
      }
      return {
        ok: true,
        value: files.map((f: { path: string; size: number }) => ({ path: f.path, size: f.size })),
      }
    },

    async read(pkg, path, start, end) {
      const r = await call(pkg, 'read', {
        path,
        start: String(start),
        ...(end === undefined ? {} : { end: String(end) }),
      })
      if (!r.ok) return r
      const { lines, marker } = r.value
      const parsed = typeof marker === 'string' ? parseSkillMarker(marker) : null
      if (
        !parsed ||
        typeof lines !== 'number' ||
        parsed.pkg !== pkg ||
        parsed.path !== path ||
        parsed.start !== start ||
        (end !== undefined && parsed.end !== end) ||
        parsed.end > lines
      ) {
        return unavailable('云端返回的标记与请求的行段不一致')
      }
      return {
        ok: true,
        value: {
          path,
          lines,
          start: parsed.start,
          end: parsed.end,
          marker: marker as string,
          features: parsed.features,
        },
      }
    },

    async search(pkg, query, prefix) {
      const r = await call(pkg, 'search', { q: query, prefix })
      if (!r.ok) return r
      const { matches, truncated } = r.value
      if (
        !Array.isArray(matches) ||
        !matches.every(
          (m) =>
            typeof m?.path === 'string' &&
            Array.isArray(m.lines) &&
            m.lines.every((n: unknown) => Number.isSafeInteger(n)),
        )
      ) {
        return unavailable('云端技能接口的响应无法解析')
      }
      return {
        ok: true,
        value: {
          matches: matches.map((m: { path: string; lines: number[] }) => ({
            path: m.path,
            lines: m.lines,
          })),
          truncated: truncated === true,
        },
      }
    },
  }
}
