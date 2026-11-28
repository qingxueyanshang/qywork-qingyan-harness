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

import { httpStatusName, parseSkillMarker } from '@qywork/ai'
import type { CloudSkill } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import type { CloudSkillErrorCode, CloudSkillPort, CloudSkillResult } from '@qywork/tools'
import { cloudProviderOf } from '../account.ts'

const SKILL_ERRORS: ReadonlySet<string> = new Set<CloudSkillErrorCode>([
  'skill_not_granted',
  'skill_version_not_found',
  'skill_file_not_found',
  'skill_file_binary',
  'skill_range_invalid',
  'skill_script_run_only',
  'invalid_request',
])

export interface CloudSkillPortOptions {
  config: QyConfig
  /** 云端服务的地址（`cloudOrigin`）。 */
  origin: string
  /** 本会话可用的技能包；`version` 缺省时读取最新版本。 */
  packages: readonly (CloudSkill & { version?: number })[]
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

  /** 以设备密钥请求云端技能接口；成功时返回响应，失败按错误码归类。 */
  async function request(
    pkg: string,
    action: 'files' | 'read' | 'search' | 'script',
    params: Record<string, string>,
  ): Promise<CloudSkillResult<Response>> {
    const key = cloudProviderOf(opts.config, opts.origin)?.apiKey
    if (!key) return unavailable('未登录云端账号')
    const version = opts.packages.find((p) => p.id === pkg)?.version
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
    if (res.ok) return { ok: true, value: res }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const error = (body?.error ?? null) as { code?: unknown; message?: unknown } | null
    const message = typeof error?.message === 'string' ? error.message : ''
    if (typeof error?.code === 'string' && SKILL_ERRORS.has(error.code)) {
      return { ok: false, code: error.code as CloudSkillErrorCode, message }
    }
    return unavailable(
      `云端返回 ${res.status} ${httpStatusName(res.status)}${message ? `：${message}` : ''}`,
    )
  }

  async function call(
    pkg: string,
    action: 'files' | 'read' | 'search' | 'script',
    params: Record<string, string>,
  ): Promise<CloudSkillResult<Record<string, unknown>>> {
    const r = await request(pkg, action, params)
    if (!r.ok) return r
    const body = (await r.value.json().catch(() => null)) as Record<string, unknown> | null
    return body ? { ok: true, value: body } : unavailable('云端技能接口的响应无法解析')
  }

  return {
    packages: opts.packages.map(({ id, name, description }) => ({ id, name, description })),

    async script(pkg, path) {
      const r = await call(pkg, 'script', { path })
      if (!r.ok) return r
      const { main, modules } = r.value
      const sources =
        modules && typeof modules === 'object' ? (modules as Record<string, unknown>) : {}
      const valid =
        typeof main === 'string' &&
        typeof sources[main] === 'string' &&
        Object.values(sources).every((text) => typeof text === 'string')
      return valid
        ? { ok: true, value: { main, modules: sources as Record<string, string> } }
        : unavailable('云端技能接口的响应无法解析')
    },

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
