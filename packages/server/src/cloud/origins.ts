/**
 * 云端服务的地址：`site` 是官网（account、cloud 等网页主机为它加子域名前缀），`api` 是模型网关与桌面端接口。
 * 桌面端的请求只发往 `api`；`site` 只用于生成给用户打开的链接。
 *
 * 发布前在 `RELEASE` 中填写；为 null 时账号相关的入口不出现（`/api/cloud/state` 返回 unavailable）。
 * 本机开发时以环境变量 `QYWORK_CLOUD=<site>,<api>` 指向本机云端服务，例如
 * `QYWORK_CLOUD=http://localhost:8080,http://127.0.0.1:8080`。
 */

export interface CloudOrigins {
  site: string
  api: string
}

const RELEASE: CloudOrigins | null = null

export function cloudOrigins(
  env: Record<string, string | undefined> = process.env,
): CloudOrigins | null {
  const raw = env.QYWORK_CLOUD?.trim()
  if (!raw) return RELEASE
  const [site, api] = raw.split(',').map((s) => s.trim().replace(/\/+$/, ''))
  if (!site || !api) throw new Error('QYWORK_CLOUD 的格式为 <官网地址>,<接口地址>')
  return { site, api }
}
