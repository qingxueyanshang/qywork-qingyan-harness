/**
 * 云端服务的地址：`app` 是网站与账号接口，`api` 是模型网关。
 *
 * 发布前在 `RELEASE` 中填写；为 null 时账号相关的入口不出现（`/api/cloud/state` 返回 unavailable）。
 * 本机开发时以环境变量 `QYWORK_CLOUD=<app>,<api>` 指向本机云端服务，例如
 * `QYWORK_CLOUD=http://localhost:8080,http://127.0.0.1:8080`。
 */

export interface CloudOrigins {
  app: string
  api: string
}

const RELEASE: CloudOrigins | null = null

export function cloudOrigins(
  env: Record<string, string | undefined> = process.env,
): CloudOrigins | null {
  const raw = env.QYWORK_CLOUD?.trim()
  if (!raw) return RELEASE
  const [app, api] = raw.split(',').map((s) => s.trim().replace(/\/+$/, ''))
  if (!app || !api) throw new Error('QYWORK_CLOUD 的格式为 <网站地址>,<接口地址>')
  return { app, api }
}
