/**
 * 配对与鉴权。
 *
 * 云端账号只决定谁能取得令牌，**不替代令牌**：经隧道转发的请求与本机请求一样由 `verify` 校验。
 * 没有令牌时，任何知道设备页面地址的人都能对本机的工作区执行命令。
 *
 * 设计取舍：
 * - 令牌随进程生成，不落盘。桌面端从 spawn 时的环境变量取得，手机端经 console 打开设备时由隧道取得（`pair.request`）。
 * - **令牌的有效期即进程的生命周期，没有单独的 TTL。** 不要添加写入二维码
 *   却无人校验的 `expiresAt`；而实际加入校验会使桌面端也无法连接（其 sidecar
 *   连续运行一整天很常见）。实现有效期需要配套的重新配对流程，不在本模块范围内。
 * - 令牌放在 URL fragment（`#t=...`）而不是 query：fragment 不会进入服务端访问日志、
 *   不会进入 Referer 头、不会被中间代理记录。
 * - 比较使用定长时间算法，避免逐字符提前返回而泄露前缀。
 */

export class Pairing {
  readonly token: string
  readonly deviceName: string

  /** `token` 由外部提供（桌面端 spawn 时的环境变量），未提供时随进程生成。 */
  constructor(opts: { token?: string; deviceName?: string } = {}) {
    this.token = opts.token || generateToken()
    this.deviceName = opts.deviceName ?? 'qywork'
  }

  /**
   * 校验令牌。**这是唯一的鉴权入口**，不要在其他位置另写一份：存在两份实现时，实际被
   * `/stream` 与 `/api` 调用的只有其中一份，另一份的判断条件全部不生效。
   */
  verify(candidate: string | null | undefined): boolean {
    if (!candidate) return false
    return timingSafeEqual(candidate, this.token)
  }
}

function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 定长比较。长度不同时可以直接返回 false（长度本身不是秘密），
 * 但内容比较必须完整执行，不能在遇到第一个不同字符时返回。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** 从请求中读取令牌：Authorization 头优先，其次 query（用于 WebSocket 握手）。 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const url = new URL(req.url)
  return url.searchParams.get('token')
}
