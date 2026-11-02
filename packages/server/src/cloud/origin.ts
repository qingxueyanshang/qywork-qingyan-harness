/**
 * 云端服务的地址：网站、模型网关、桌面端接口与隧道都在这一个来源上，例如 `https://example.com`。
 *
 * 发布前在 `RELEASE` 中填写；为 null 时账号相关的入口不出现（`/api/cloud/state` 返回 unavailable）。
 * 本机开发时以环境变量 `QYWORK_CLOUD` 指向本机云端服务，例如 `QYWORK_CLOUD=http://localhost:8080`。
 */

const RELEASE: string | null = null

export function cloudOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.QYWORK_CLOUD?.trim().replace(/\/+$/, '')
  if (!raw) return RELEASE
  if (URL.parse(raw)?.origin !== raw) {
    throw new Error(`QYWORK_CLOUD 须为云端服务的地址，例如 http://localhost:8080：${raw}`)
  }
  return raw
}
