/**
 * 配对与鉴权。
 *
 * 无账号体系，但**不等于无鉴权**：`qy serve` 会绑定到局域网地址供手机
 * 连接，同一 Wi-Fi 下的任何设备都能访问该端口。没有令牌时，任何人都能对本机的
 * 工作区执行命令。
 *
 * 设计取舍：
 * - 令牌随进程生成，不落盘。桌面端从 spawn 时的环境变量取得，手机端通过扫码取得。
 * - **令牌的有效期即进程的生命周期，没有单独的 TTL。** 不要添加写入二维码
 *   却无人校验的 `expiresAt`；而实际加入校验会使桌面端也无法连接（其 sidecar
 *   连续运行一整天很常见）。实现有效期需要配套的重新配对流程，不在本模块范围内。
 * - 令牌放在 URL fragment（`#t=...`）而不是 query：fragment 不会进入服务端访问日志、
 *   不会进入 Referer 头、不会被中间代理记录。
 * - 比较使用定长时间算法，避免逐字符提前返回而泄露前缀。
 */

import { networkInterfaces } from 'node:os'
import { encodePairingUrl, type PairingPayload } from '@qywork/core'

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

  payload(port: number): PairingPayload {
    return {
      url: `http://${preferredLanAddress()}:${port}`,
      token: this.token,
      deviceName: this.deviceName,
    }
  }

  qrUrl(port: number): string {
    return encodePairingUrl(this.payload(port))
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

export interface LanCandidate {
  name: string
  address: string
  netmask: string
  mac: string
  score: number
}

/** 已知虚拟化厂商注册的 MAC OUI。 */
const VIRTUAL_OUI = [
  '00:15:5d', // Hyper-V
  '00:50:56', // VMware
  '00:0c:29', // VMware
  '00:05:69', // VMware
  '08:00:27', // VirtualBox
  '0a:00:27', // VirtualBox Host-Only
  '00:1c:42', // Parallels
  '02:42:', // Docker bridge
  '00:16:3e', // Xen
]

/**
 * 候选局域网地址，按「手机能够连接的可能性」排序。
 *
 * **不查询路由表的原因。** 常见做法是「查询内核哪块网卡能访问公网」（对 8.8.8.8 执行一次不发包的
 * UDP connect）。在本机实测**选择错误**：运行 singbox 时默认路由被 TUN 接管，公网出口是
 * `singbox_tun`；关闭后又变为 Hyper-V 的虚拟交换机。原因在于两者回答的问题不同：路由表回答的是
 * 「本机如何访问外部」，而此处需要的是「手机如何连入」，安装了 VPN/代理的机器上两者不是同一块网卡。
 *
 * **实际使用的信号。** 三个结构性信号叠加，任何一个都不单独决定结果：
 *
 * 1. **全零 MAC**：TUN/TAP 隧道设备的结构性特征，不依赖枚举（`singbox_tun`
 *    实测即为 `00:00:00:00:00:00`）。
 * 2. **虚拟化厂商 OUI**：这一条确实依赖枚举，但枚举的是虚拟化厂商注册的 MAC 前缀，
 *    集合小且长期不变，比枚举网卡名（singbox_tun / tailscale / ZeroTier / WireGuard…
 *    无法穷举）稳定得多；且它只是权重之一，不是唯一判据。
 * 3. **掩码 /24 + 私有网段**：家用与办公 LAN 绝大多数是 192.168.x.x/24；
 *    Hyper-V 默认交换机是 /20，TUN 常为 /30。
 *
 * **后备方案才是真正的保障。** 自动判断在安装了 VPN 的机器上没有可靠解，因此设计为：
 * **始终把完整候选列表交给用户**，二维码使用最优推测，无法连接时一键更换。二维码中写入
 * 无法连接的地址比不写入更糟：用户会反复扫码，且该现象与软件故障无法区分。
 */
export function lanCandidates(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): LanCandidate[] {
  const out: LanCandidate[] = []

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // 169.254 表示「DHCP 未取得地址」，必然无法连接。
      if (a.address.startsWith('169.254.')) continue

      const mac = (a.mac ?? '').toLowerCase()
      let score = 0

      if (a.address.startsWith('192.168.')) score += 3
      else if (a.address.startsWith('10.')) score += 2
      // 172.16/12 段被容器网络大量占用，只计一分。
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1

      if (a.netmask === '255.255.255.0') score += 2

      if (/^(00:00:00:00:00:00)?$/.test(mac)) score -= 4
      else if (VIRTUAL_OUI.some((p) => mac.startsWith(p))) score -= 4
      else score += 2

      out.push({
        name: repairMojibake(name),
        address: a.address,
        netmask: a.netmask,
        mac: a.mac ?? '',
        score,
      })
    }
  }

  // 同分时按地址字典序排序，保证结果稳定可复现（不依赖枚举顺序）。
  out.sort((x, y) => y.score - x.score || x.address.localeCompare(y.address))
  return out
}

/** 最优推测。真正的保障是 lanCandidates()：UI 必须允许用户更换。 */
export function preferredLanAddress(): string {
  return lanCandidates()[0]?.address ?? '127.0.0.1'
}

/**
 * 修复网卡名的乱码。
 *
 * Windows 上非英文网卡名（「以太网」「无线网络连接」）经 `os.networkInterfaces()`
 * 读取时，UTF-8 字节被按 Latin-1 逐字节解码，显示为 `ä»¥å¤ªç½` 这样的形式。
 * 用户依靠该名称辨认应选择的网卡，名称为乱码时该功能失效。
 *
 * 判据：字符串只含 U+0080–U+00FF 区间的字符，且按 Latin-1 还原后能被 UTF-8
 * 严格解码。严格模式是关键：它保证不会误改原本正常的西欧文字名（如带重音符号的
 * `Ethernet`）。无法解码时原样返回。
 */
export function repairMojibake(name: string): string {
  if (!/[-ÿ]/.test(name)) return name
  try {
    const bytes = Uint8Array.from(name, (ch) => {
      const code = ch.charCodeAt(0)
      if (code > 0xff) throw new Error('not latin1')
      return code
    })
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return name
  }
}

/** 从请求中读取令牌：Authorization 头优先，其次 query（用于 WebSocket 握手）。 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const url = new URL(req.url)
  return url.searchParams.get('token')
}
