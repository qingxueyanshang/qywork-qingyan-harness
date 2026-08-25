/**
 * 出网安全闸。
 *
 * **这不是「加固」，是 agent 出网工具的前置条件。** agent 会拿**模型生成的 URL** 去发请求。模型的 URL
 * 可能来自它读到的网页内容、用户贴的文本、或者纯粹的臆造。不挡内网就等于把 SSRF 的能力直接递给了模
 * 型：
 *
 * - `169.254.169.254` —— 云厂商的元数据端点。一次请求就能拿到实例凭证。
 * - `127.0.0.1` / `localhost` —— 本机上跑着的其他服务，包括 qy 自己的 API。
 * - `10.x` / `192.168.x` / `172.16-31.x` —— 内网其他机器。
 *
 * **三条容易漏掉的**：
 * 1. **重定向后必须重新校验。** 只查首个 URL 挡不住 `http://evil.com` 302 到
 *    `http://169.254.169.254`。所以 fetch 必须手动跟随重定向，每一跳都过闸。
 * 2. **要按解析后的 IP 判，不能只看主机名。** `metadata.evil.com` 可以 A 记录
 *    指向 169.254.169.254。DNS 是攻击者控制的。
 * 3. **IPv6 的等价写法**：`::1`、`::ffff:127.0.0.1`（IPv4 映射地址）、
 *    `fc00::/7`（唯一本地地址）都要挡。只挡 `127.0.0.1` 的字符串等于没挡。
 *
 * 默认拒绝：无法判定的一律拒。
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
  /** 给用户和模型看的说明。要具体到能判断为什么被挡。 */
  message?: string
  /** 解析到的地址，允许时用它连接以避免 DNS 重绑定。 */
  resolved?: string
}

/** 只允许 http/https。file:// 能读本地文件，ftp/gopher 是经典 SSRF 跳板。 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * 允许的端口。
 *
 * 不限制端口的话，`http://127.0.0.1:6379` 这类打内网 Redis 的请求也会放行——
 * 虽然主机检查已经挡住了回环，但多一层限制能挡住「内网某台机器的非 Web 服务」。
 */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443, 3000, 8000])

/** 云厂商元数据端点。命中即拒，且单独归类——这条是最危险的。 */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200', // 阿里云
  'fd00:ec2::254', // AWS IMDSv6
])

export interface SafetyOptions {
  /**
   * 允许访问私有网络。**默认 false。**
   * 只有用户在配置里显式打开才为 true（本地开发时抓自己起的服务）。
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
 * `dns.lookup()` 本身没有超时参数，走的是系统解析器——DNS 被劫持、
 * 上游不可达、或者查的是不存在的 TLD 时，它可能挂到系统级超时（几十秒）。
 * 那段时间里整个工具调用是卡住的，用户只看到一个转圈。
 *
 * 超时当作解析失败处理（默认拒绝），而不是放行。
 */
async function resolveWithTimeout(host: string, timeoutMs: number): Promise<string> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('dns timeout')), timeoutMs).unref?.(),
  )
  const res = await Promise.race([lookup(host), timer])
  return res.address
}

/**
 * 校验一个 URL 是否可以请求。
 *
 * 做 DNS 解析，所以是异步的。**返回的 `resolved` 应当被用来实际连接**——
 * 校验时解析一次、连接时再解析一次，中间那个窗口就是 DNS 重绑定攻击的入口。
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

  // 主机名本身就是 IP 时不必解析。
  const literal = isIP(host)
  let address = host
  if (!literal) {
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return { allowed: false, reason: 'loopback', message: '拒绝访问本机' }
    }
    try {
      address = await resolveWithTimeout(host, opts.dnsTimeoutMs ?? 3000)
    } catch {
      // 解析不了就拒。放行等于把判定推给 fetch，而那时已经在连接了。
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
 * 按解析出的 IP 分类。
 *
 * 返回 null = 是公网地址。
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
  // 169.254/16 是链路本地，云元数据端点就在这个段里。
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
 * 展开成 8 组 16 位数。`::` 补零，尾部的点分十进制段折成两组。
 *
 * 判 IPv6 **只能按展开后的数值判，不能按字面量匹配**：同一个地址有无数种写法，
 * `::ffff:127.0.0.1` 和 `::ffff:7f00:1` 是同一个回环地址，按写法枚举永远漏。
 *
 * 解析不出来返回 null，调用方按默认拒绝处理。
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

  // IPv4 映射（::ffff:x）与 IPv4 兼容（::x）：低 32 位就是一个 IPv4 地址，
  // 必须还原成 IPv4 再判，否则一个前缀就绕过了全部 IPv4 规则。
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

/** 单次请求最多跟随几跳重定向。 */
export const MAX_REDIRECTS = 5

export interface SafeFetchResult {
  ok: boolean
  status: number
  url: string
  contentType: string | null
  body: Uint8Array
  /** 被挡时的原因。 */
  blocked?: { reason: BlockReason; message: string; url: string }
  redirects: string[]
}

/**
 * 过安全闸的 fetch。
 *
 * **手动跟随重定向**，每一跳都重新校验。用 `redirect: 'follow'` 让运行时自己跟，
 * 中间那几跳就完全绕过了检查——这正是最常见的绕过方式。
 */
export async function safeFetch(
  raw: string,
  opts: SafetyOptions & {
    signal?: AbortSignal
    maxBytes?: number
    timeoutMs?: number
    /** 默认 GET。非 GET 只有插件的 net.fetch 会用到。 */
    method?: string
    /** 额外请求头。逐跳头和 host 会被剥掉。 */
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

    // **按校验时解析出的 IP 连接**，而不是把主机名再交给 fetch 解析一次。
    // 解析两次中间那个窗口就是 DNS 重绑定：第一次回公网 IP 过闸，
    // 第二次回 127.0.0.1 / 169.254.169.254。
    const pinned = pinToAddress(current, verdict.resolved)

    const res = await fetch(pinned.url, {
      method,
      redirect: 'manual',
      signal,
      headers: {
        // 明示身份。伪装成浏览器只会让站点的反爬策略更难被诊断。
        'user-agent': 'qywork-agent/0.1 (+https://github.com/qywork)',
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
        ...extraHeaders,
        // URL 里放的是 IP，得把原主机名带回去，虚拟主机才路由得对。
        ...(pinned.host ? { host: pinned.host } : {}),
      },
      // TLS 证书仍按**原主机名**校验：servername 给错名字连不上（已实测），
      // 所以钉 IP 不等于把证书校验降级。
      ...(pinned.servername ? { tls: { servername: pinned.servername } } : {}),
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
    } as RequestInit)

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) break
      redirects.push(current)
      const next = new URL(location, current).toString()

      // 跨源跳转必须丢掉 authorization。
      //
      // 不丢的话，任何能让 agent 打开一个 URL 的人都能把凭证钓走：请求
      // api.example.com（带 token）→ 对方回 302 到 evil.com → 凭证跟着过去。
      // 浏览器默认就这么做；这里是手动跟随重定向，因此要自己做。
      if (originOf(next) !== origin) extraHeaders = dropAuth(extraHeaders)

      // 303 一律转 GET；301/302 上的非 GET 也转 GET 并丢掉请求体——
      // 规范说该保留，但全世界的客户端都转，服务端也按转了写。跟规范不跟现实
      // 会在真实站点上表现为「重定向之后把整个请求体又发了一遍」。
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET')) {
        method = 'GET'
        body = undefined
      }
      current = next
      continue
    }

    const responseBody = await readBounded(res, opts.maxBytes ?? 4 * 1024 * 1024)
    return {
      ok: res.ok,
      status: res.status,
      url: current,
      contentType: res.headers.get('content-type'),
      body: responseBody,
      redirects,
    }
  }

  return {
    ok: false,
    status: 0,
    url: current,
    contentType: null,
    body: new Uint8Array(0),
    blocked: { reason: 'reserved', message: `重定向超过 ${MAX_REDIRECTS} 跳`, url: current },
    redirects,
  }
}

/**
 * 逐跳头（hop-by-hop）与 host 不允许调用方指定。
 *
 * 它们描述的是「这一跳连接怎么走」，由 fetch 自己算。让调用方覆盖 `host`
 * 更是直接绕过 SSRF 闸：闸按 URL 里的主机解析 IP，而请求到达时反代看的是 Host 头，
 * 两者不一致就能把校验过的 IP 和实际访问的服务掰开。
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
    // 头值里的 CR/LF 是响应拆分/请求走私的入口，直接剔掉整条。
    if (/[\r\n]/.test(String(v))) continue
    out[key] = String(v)
  }
  return out
}

/**
 * 把 URL 的主机换成已解析的 IP，并交出要带回去的原主机名。
 *
 * `resolved` 与原主机相同（主机名本来就是字面 IP，或走了 allowHosts）时原样返回，
 * 不做无谓改写。
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
 * 跨源跳转要丢掉的请求头。
 *
 * 不能只列 `authorization` / `cookie`：凭证同样常见于 `x-api-key` 这类自定义头，
 * 插件的 net.fetch 就是这么用的。所以用**正面白名单之外一律丢**的口径——
 * 逐条枚举「哪些头是凭证」永远列不全，而跨源之后本来也没有几个头值得带过去。
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
 * 有上限地读取响应体。
 *
 * 不能直接 `res.arrayBuffer()`：对方可以返回一个无限流，那会耗尽内存。
 * Content-Length 不可信（可以不发，也可以与实际不符），所以按实际读取的字节数计。
 */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    // 提前停止时要主动取消，否则连接会挂到超时。
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
  return out
}
