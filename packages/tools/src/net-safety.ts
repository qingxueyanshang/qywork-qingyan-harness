/**
 * 网络访问的 SSRF 防护。
 *
 * **这是 agent 网络访问工具的前置条件，不是额外加固。** agent 会用模型生成的 URL 发出请求，
 * 这些 URL 可能来自模型读到的网页内容、用户粘贴的文本，或纯属臆造。不拦截内网地址，
 * 就等于把 SSRF 能力直接交给模型：
 *
 * - `169.254.169.254`：云厂商的元数据端点，一次请求即可取得实例凭证。
 * - `127.0.0.1` / `localhost`：本机上运行的其他服务，包括 qy 自身的 API。
 * - `10.x` / `192.168.x` / `172.16-31.x`：内网中的其他机器。
 *
 * **三个易遗漏的环节**：
 * 1. **重定向后必须重新校验。** 只检查首个 URL 无法拦截 `http://evil.com` 302 到
 *    `http://169.254.169.254`。因此 fetch 必须手动跟随重定向，每一跳都重新检查。
 * 2. **必须按解析后的 IP 判定，不能只看主机名。** `metadata.evil.com` 的 A 记录可以
 *    指向 169.254.169.254，DNS 由攻击者控制。
 * 3. **IPv6 的等价写法**：`::1`、`::ffff:127.0.0.1`（IPv4 映射地址）、
 *    `fc00::/7`（唯一本地地址）都必须拦截。只匹配 `127.0.0.1` 字符串的检查无效。
 *
 * 默认拒绝：无法判定的地址一律拒绝。
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type BlockReason =
  | 'scheme_not_allowed'
  | 'loopback'
  | 'private_network'
  | 'link_local'
  | 'cloud_metadata'
  | 'reserved'
  | 'dns_failed'
  | 'malformed_url'
  | 'port_not_allowed'

export interface SafetyVerdict {
  allowed: boolean
  reason?: BlockReason
  /** 展示给用户与模型的说明，必须具体到能据此判断拒绝原因。 */
  message?: string
  /** 解析得到的地址。放行时用它建立连接，以避免 DNS 重绑定。 */
  resolved?: string
}

/** 只允许 http/https。file:// 可读取本地文件，ftp/gopher 是常见的 SSRF 利用协议。 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * 允许的端口。
 *
 * 不限制端口时，`http://127.0.0.1:6379` 这类攻击内网 Redis 的请求也会被放行。
 * 主机检查已拦截回环地址，端口限制可以额外拦截内网机器上的非 Web 服务。
 */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443, 3000, 8000])

/** 云厂商元数据端点。命中即拒绝，并单独归类：这类端点风险最高。 */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200', // 阿里云
  'fd00:ec2::254', // AWS IMDSv6
])

export interface SafetyOptions {
  /**
   * 允许访问私有网络，默认 false。
   * 仅在用户于配置中显式开启时为 true，用于本地开发时访问自行启动的服务。
   */
  allowPrivate?: boolean
  /** 额外放行的主机名（用户显式配置的内网服务）。 */
  allowHosts?: string[]
  /** DNS 解析超时。默认 3 秒。 */
  dnsTimeoutMs?: number
}

/**
 * 带超时的 DNS 解析。
 *
 * `dns.lookup()` 没有超时参数，经由系统解析器执行。DNS 被劫持、上游不可达
 * 或查询不存在的 TLD 时，它可能等待到系统级超时（数十秒），期间整个工具调用处于阻塞状态。
 *
 * 超时按解析失败处理（默认拒绝），不放行。
 */
async function resolveWithTimeout(host: string, timeoutMs: number): Promise<string> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('dns timeout')), timeoutMs).unref?.(),
  )
  const res = await Promise.race([lookup(host), timer])
  return res.address
}

/**
 * 校验一个 URL 是否允许请求。
 *
 * 需要 DNS 解析，因此是异步函数。**返回的 `resolved` 应当用于实际连接**：
 * 校验时与连接时各解析一次，两次之间的间隔就是 DNS 重绑定攻击的入口。
 */
export async function checkUrl(raw: string, opts: SafetyOptions = {}): Promise<SafetyVerdict> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { allowed: false, reason: 'malformed_url', message: `URL 无法解析：${raw}` }
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      allowed: false,
      reason: 'scheme_not_allowed',
      message: `只允许 http/https，收到 ${url.protocol}`,
    }
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (opts.allowHosts?.includes(host)) {
    return { allowed: true, resolved: host }
  }

  if (METADATA_HOSTS.has(host)) {
    return {
      allowed: false,
      reason: 'cloud_metadata',
      message: `拒绝访问云元数据端点：${host}`,
    }
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!ALLOWED_PORTS.has(port)) {
    return { allowed: false, reason: 'port_not_allowed', message: `端口 ${port} 不在允许列表内` }
  }

  // 主机名本身是 IP 时无需解析。
  const literal = isIP(host)
  let address = host
  if (!literal) {
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return { allowed: false, reason: 'loopback', message: '拒绝访问本机' }
    }
    try {
      address = await resolveWithTimeout(host, opts.dnsTimeoutMs ?? 3000)
    } catch {
      // 无法解析即拒绝。放行会把判定交给 fetch，而 fetch 此时已在建立连接。
      return { allowed: false, reason: 'dns_failed', message: `域名解析失败：${host}` }
    }
  }

  const verdict = classifyAddress(address)
  if (verdict && !(opts.allowPrivate && verdict.reason === 'private_network')) {
    return { allowed: false, ...verdict }
  }

  return { allowed: true, resolved: address }
}

/**
 * 按解析得到的 IP 分类。
 *
 * 返回 null 表示公网地址。
 */
export function classifyAddress(address: string): { reason: BlockReason; message: string } | null {
  const v = isIP(address)
  if (v === 4) return classifyV4(address)
  if (v === 6) return classifyV6(address)
  return { reason: 'reserved', message: `无法识别的地址：${address}` }
}

function classifyV4(address: string): { reason: BlockReason; message: string } | null {
  const p = address.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { reason: 'reserved', message: `非法 IPv4：${address}` }
  }
  const [a, b] = p as [number, number, number, number]

  if (a === 127) return { reason: 'loopback', message: `拒绝访问回环地址 ${address}` }
  if (a === 0) return { reason: 'reserved', message: `拒绝访问保留地址 ${address}` }
  // 169.254/16 是链路本地段，云元数据端点位于该段内。
  if (a === 169 && b === 254) {
    return { reason: 'link_local', message: `拒绝访问链路本地地址 ${address}（含云元数据端点）` }
  }
  if (a === 10) return { reason: 'private_network', message: `拒绝访问内网地址 ${address}` }
  if (a === 172 && b >= 16 && b <= 31) {
    return { reason: 'private_network', message: `拒绝访问内网地址 ${address}` }
  }
  if (a === 192 && b === 168) {
    return { reason: 'private_network', message: `拒绝访问内网地址 ${address}` }
  }
  // 100.64/10 运营商级 NAT，198.18/15 基准测试段，224+ 组播与保留。
  if (a === 100 && b >= 64 && b <= 127) {
    return { reason: 'private_network', message: `拒绝访问 CGNAT 地址 ${address}` }
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return { reason: 'reserved', message: `拒绝访问保留地址 ${address}` }
  }
  if (a >= 224) return { reason: 'reserved', message: `拒绝访问组播/保留地址 ${address}` }

  return null
}

/**
 * 展开为 8 组 16 位数。`::` 补零，尾部的点分十进制段折算为两组。
 *
 * IPv6 **只能按展开后的数值判定，不能按字面量匹配**：同一地址有大量等价写法，
 * `::ffff:127.0.0.1` 与 `::ffff:7f00:1` 是同一个回环地址，按写法枚举必然遗漏。
 *
 * 无法解析时返回 null，调用方按默认拒绝处理。
 */
function expandV6(address: string): number[] | null {
  // 区域标识（fe80::1%eth0）不参与地址判定。
  const bare = (address.split('%')[0] ?? '').toLowerCase()
  const halves = bare.split('::')
  if (halves.length > 2) return null

  const parseSide = (side: string): number[] | null => {
    if (side === '') return []
    const parts = side.split(':')
    const out: number[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? ''
      // 尾部允许一个点分十进制段（::ffff:127.0.0.1），它占两组。
      if (part.includes('.')) {
        if (i !== parts.length - 1) return null
        const oct = part.split('.').map(Number)
        if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null
        }
        out.push(((oct[0] as number) << 8) | (oct[1] as number))
        out.push(((oct[2] as number) << 8) | (oct[3] as number))
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(Number.parseInt(part, 16))
    }
    return out
  }

  const head = parseSide(halves[0] ?? '')
  const tail = halves.length === 2 ? parseSide(halves[1] ?? '') : []
  if (head === null || tail === null) return null

  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

function classifyV6(address: string): { reason: BlockReason; message: string } | null {
  const g = expandV6(address)
  if (!g) return { reason: 'reserved', message: `无法识别的 IPv6 地址：${address}` }

  if (g.every((x) => x === 0)) return { reason: 'reserved', message: '拒绝访问未指定地址' }
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) {
    return { reason: 'loopback', message: `拒绝访问回环地址 ${address}` }
  }

  // IPv4 映射（::ffff:x）与 IPv4 兼容（::x）地址：低 32 位即 IPv4 地址，
  // 必须还原为 IPv4 后判定，否则加一个前缀即可绕过全部 IPv4 规则。
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const hi = g[6] as number
    const lo = g[7] as number
    return classifyV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'))
  }

  const first = g[0] as number
  // fc00::/7 唯一本地地址，相当于 IPv6 的内网段。
  if ((first & 0xfe00) === 0xfc00) {
    return { reason: 'private_network', message: `拒绝访问 IPv6 内网地址 ${address}` }
  }
  // fe80::/10 链路本地。
  if ((first & 0xffc0) === 0xfe80) {
    return { reason: 'link_local', message: `拒绝访问 IPv6 链路本地地址 ${address}` }
  }
  // ff00::/8 组播。
  if ((first & 0xff00) === 0xff00) {
    return { reason: 'reserved', message: `拒绝访问 IPv6 组播地址 ${address}` }
  }
  return null
}

/** 单次请求最多跟随的重定向次数。 */
export const MAX_REDIRECTS = 5

export interface SafeFetchResult {
  ok: boolean
  status: number
  url: string
  contentType: string | null
  body: Uint8Array
  /**
   * 响应超过读取上限，`body` 只含开头部分。调用方必须告知模型，
   * 否则截断后的正文会被当作完整的远端内容保存与引用。
   */
  truncated: boolean
  /** 被拒绝时的原因。 */
  blocked?: { reason: BlockReason; message: string; url: string }
  redirects: string[]
}

/**
 * 经过 SSRF 防护的 fetch。
 *
 * **手动跟随重定向**，每一跳都重新校验。使用 `redirect: 'follow'` 由运行时自动跟随时，
 * 中间各跳完全不经过检查，这是最常见的绕过方式。
 */
export async function safeFetch(
  raw: string,
  opts: SafetyOptions & {
    signal?: AbortSignal
    maxBytes?: number
    timeoutMs?: number
    /** 默认 GET。只有插件的 net.fetch 使用非 GET 方法。 */
    method?: string
    /** 额外请求头。逐跳头与 host 会被剥离。 */
    headers?: Record<string, string>
    body?: string
  } = {},
): Promise<SafeFetchResult> {
  const redirects: string[] = []
  let current = raw
  let method = (opts.method ?? 'GET').toUpperCase()
  let body = opts.body
  let extraHeaders = sanitizeHeaders(opts.headers)
  const origin = originOf(raw)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await checkUrl(current, opts)
    if (!verdict.allowed) {
      return {
        ok: false,
        status: 0,
        url: current,
        contentType: null,
        body: new Uint8Array(0),
        truncated: false,
        blocked: {
          reason: verdict.reason ?? 'reserved',
          message: verdict.message ?? '被安全策略阻止',
          url: current,
        },
        redirects,
      }
    }

    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

    // 按校验时解析得到的 IP 连接，不把主机名再交给 fetch 解析。
    // 两次解析之间存在 DNS 重绑定窗口：第一次返回公网 IP 并通过检查，
    // 第二次返回 127.0.0.1 / 169.254.169.254。
    const pinned = pinToAddress(current, verdict.resolved)

    const res = await fetch(pinned.url, {
      method,
      redirect: 'manual',
      signal,
      headers: {
        // 如实声明客户端身份。伪装成浏览器只会使站点的反爬策略更难诊断。
        'user-agent': 'qywork-agent/0.1 (+https://github.com/qywork)',
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
        ...extraHeaders,
        // URL 中是 IP，必须带上原主机名，虚拟主机才能正确路由。
        ...(pinned.host ? { host: pinned.host } : {}),
      },
      // TLS 证书仍按原主机名校验：servername 不正确时连接失败（已实测），
      // 因此固定 IP 不会降低证书校验强度。
      ...(pinned.servername ? { tls: { servername: pinned.servername } } : {}),
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
    } as RequestInit)

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) break
      redirects.push(current)
      const next = new URL(location, current).toString()

      // 跨源跳转必须丢弃 authorization。
      //
      // 否则任何能让 agent 打开 URL 的人都能窃取凭证：请求
      // api.example.com（带 token）→ 对方返回 302 到 evil.com → 凭证随之发出。
      // 浏览器默认执行此处理；这里手动跟随重定向，因此必须自行处理。
      if (originOf(next) !== origin) extraHeaders = dropAuth(extraHeaders)

      // 303 一律改为 GET；301/302 上的非 GET 请求也改为 GET 并丢弃请求体。
      // 规范要求保留方法，但主流客户端均改为 GET，服务端也按此实现；
      // 按规范保留会使真实站点在重定向后再次收到整个请求体。
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET')) {
        method = 'GET'
        body = undefined
      }
      current = next
      continue
    }

    const bounded = await readBounded(res, opts.maxBytes ?? 4 * 1024 * 1024)
    return {
      ok: res.ok,
      status: res.status,
      url: current,
      contentType: res.headers.get('content-type'),
      body: bounded.bytes,
      truncated: bounded.truncated,
      redirects,
    }
  }

  return {
    ok: false,
    status: 0,
    url: current,
    contentType: null,
    body: new Uint8Array(0),
    truncated: false,
    blocked: { reason: 'reserved', message: `重定向超过 ${MAX_REDIRECTS} 跳`, url: current },
    redirects,
  }
}

/**
 * 逐跳头（hop-by-hop）与 host 不允许调用方指定。
 *
 * 这些头描述当前一跳连接的传输方式，由 fetch 自行计算。允许调用方覆盖 `host`
 * 会直接绕过 SSRF 防护：防护按 URL 中的主机解析 IP，而反向代理按 Host 头路由，
 * 两者不一致时，校验过的 IP 与实际访问的服务不再对应。
 */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'content-length',
])

function sanitizeHeaders(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase().trim()
    if (!key || FORBIDDEN_HEADERS.has(key)) continue
    // 头值中的 CR/LF 可用于响应拆分与请求走私，含有时丢弃整个头。
    if (/[\r\n]/.test(String(v))) continue
    out[key] = String(v)
  }
  return out
}

/**
 * 把 URL 的主机替换为已解析的 IP，并返回需要随请求发送的原主机名。
 *
 * `resolved` 与原主机相同（主机名本身是 IP 字面量，或命中 allowHosts）时原样返回，
 * 不做多余改写。
 */
function pinToAddress(
  raw: string,
  resolved: string | undefined,
): { url: string; host?: string; servername?: string } {
  if (!resolved) return { url: raw }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { url: raw }
  }
  const original = u.hostname.replace(/^\[|\]$/g, '')
  if (original.toLowerCase() === resolved.toLowerCase()) return { url: raw }

  const host = u.host
  u.hostname = isIP(resolved) === 6 ? `[${resolved}]` : resolved
  return { url: u.toString(), host, servername: original }
}

/**
 * 跨源跳转时保留的请求头。
 *
 * 不能只删除 `authorization` / `cookie`：凭证同样常见于 `x-api-key` 等自定义头，
 * 插件的 net.fetch 即如此使用。因此采用白名单，名单之外的头一律丢弃：
 * 逐条枚举凭证头无法列全，而跨源之后值得保留的头本来就很少。
 */
const CROSS_ORIGIN_KEEP = new Set(['accept', 'accept-language', 'user-agent', 'content-type'])

function dropAuth(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (CROSS_ORIGIN_KEEP.has(k)) out[k] = v
  }
  return out
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * 按上限读取响应体。
 *
 * 不能直接调用 `res.arrayBuffer()`：对方可以返回无限流，导致内存耗尽。
 * Content-Length 不可信（可以不发送，也可以与实际不符），因此按实际读取的字节数计算。
 *
 * `truncated` 按实际读取的字节判定：读满上限后再读一次，流未结束即为截断。
 */
async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  const reader = res.body.getReader()
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    truncated = total > maxBytes || (total === maxBytes && !(await reader.read()).done)
  } finally {
    // 提前停止时必须主动取消，否则连接会保持到超时。
    await reader.cancel().catch(() => {})
  }

  const out = new Uint8Array(Math.min(total, maxBytes))
  let off = 0
  for (const c of chunks) {
    if (off >= out.byteLength) break
    const slice = c.subarray(0, out.byteLength - off)
    out.set(slice, off)
    off += slice.byteLength
  }
  return { bytes: out, truncated }
}
