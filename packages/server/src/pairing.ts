/**
 * 配对与鉴权。
 *
 * 无账号体系（需求 11），但**不等于无鉴权**：`qy serve` 会绑到局域网地址上让手机
 * 连过来，同一个 Wi-Fi 下的任何设备都能触达这个端口。没有令牌 = 任何人都能对你的
 * 工作区执行命令。
 *
 * 设计取舍：
 * - 令牌随进程生成，不落盘。桌面端从 spawn 时的环境变量拿，手机端扫码拿。
 * - **令牌的有效期就是进程的生命周期，没有单独的 TTL。** 别加一个写进二维码
 *   却没人校验的 `expiresAt`；而真加上校验会把桌面端一起锁在门外（它的 sidecar
 *   开一整天很正常）。要做限期得配一套重新配对的流程，那是另一件事。
 * - 令牌放在 URL fragment（`#t=...`）而不是 query：fragment 不会进服务端访问日志、
 *   不会进 Referer 头、不会被中间代理记录。
 * - 比较用定长时间算法，避免按字符早退泄露前缀。
 */

import { networkInterfaces } from 'node:os'
import { encodePairingUrl, type PairingPayload } from '@qywork/core'

export class Pairing {
  readonly token: string
  readonly deviceName: string

  /** `token` 由外部给（桌面端 spawn 时的环境变量），不给就随进程生成一个。 */
  constructor(opts: { token?: string; deviceName?: string } = {}) {
    this.token = opts.token || generateToken()
    this.deviceName = opts.deviceName ?? 'qywork'
  }

  /**
   * 校验令牌。**这是唯一的鉴权入口**，别在别处再写一份——两份实现时真正被
   * `/stream` 与 `/api` 调用的只会是其中一份，另一份的判断条件全都不生效。
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
 * 定长比较。长度不同直接返回 false 是可以的（长度本身不是秘密），
 * 但内容比较必须走完全程，不能命中第一个不同字符就返回。
 */
function timingSafeEqual(a: string, b: string): boolean {
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
 * 候选局域网地址，按「手机能连上的可能性」排序。
 *
 * ## 为什么不问路由表
 *
 * 直觉做法是「问内核哪块网卡能到公网」（对 8.8.8.8 做一次不发包的 UDP connect）。
 * 在这台机器上实测**选错了**：跑着 singbox 时默认路由被 TUN 接管，公网出口是
 * `singbox_tun`；关掉后又变成 Hyper-V 的虚拟交换机。原因是这个问题问错了——
 * 路由表回答的是「我怎么出去」，而我们要的是「手机怎么进来」，装了 VPN/代理
 * 的机器上这两者根本不是同一块网卡。
 *
 * ## 实际用的信号
 *
 * 三个结构性信号叠加，任何一个都不单独决定结果：
 *
 * 1. **全零 MAC** —— TUN/TAP 隧道设备的结构性特征，不是枚举来的（`singbox_tun`
 *    实测就是 `00:00:00:00:00:00`）。
 * 2. **虚拟化厂商 OUI** —— 这一条确实是枚举，但枚举的是虚拟化厂商注册的 MAC 前缀，
 *    集合小且十年不变，比枚举网卡名（singbox_tun / tailscale / ZeroTier / WireGuard…
 *    永远列不完）稳得多；而且它只是权重之一，不是唯一闸门。
 * 3. **掩码 /24 + 私有网段** —— 家用和办公 LAN 压倒性是 192.168.x.x/24；
 *    Hyper-V 默认交换机是 /20，TUN 常是 /30。
 *
 * ## 兜底才是真正的保障
 *
 * 自动判断在装了 VPN 的机器上没有可靠解。所以真正的设计是：**永远把完整候选
 * 列表交给用户**，二维码用最优猜测，连不上时一键换一个。二维码里印一个连不上的
 * 地址比不印更糟——用户会反复扫，以为是软件坏了。
 */
export function lanCandidates(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): LanCandidate[] {
  const out: LanCandidate[] = []

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // 169.254 是「DHCP 没拿到地址」的症状，必然连不上。
      if (a.address.startsWith('169.254.')) continue

      const mac = (a.mac ?? '').toLowerCase()
      let score = 0

      if (a.address.startsWith('192.168.')) score += 3
      else if (a.address.startsWith('10.')) score += 2
      // 172.16/12 段被容器网络大量占用，只给一分。
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

  // 同分时按地址字典序，保证结果稳定可复现（不再靠枚举顺序决定胜负）。
  out.sort((x, y) => y.score - x.score || x.address.localeCompare(y.address))
  return out
}

/** 最优猜测。真正的保障是 lanCandidates() —— UI 必须让用户能换。 */
export function preferredLanAddress(): string {
  return lanCandidates()[0]?.address ?? '127.0.0.1'
}

/**
 * 修复网卡名的乱码。
 *
 * Windows 上非英文网卡名（「以太网」「无线网络连接」）经 `os.networkInterfaces()`
 * 取出来时，UTF-8 字节被按 Latin-1 逐字节解码，显示成 `ä»¥å¤ªç½` 这种。
 * 用户要靠这个名字辨认该选哪个网卡，乱码等于这个功能作废。
 *
 * 判据：字符串只含 U+0080–U+00FF 区间的字符，且按 Latin-1 还原后能被 UTF-8
 * 严格解码——严格模式很关键，它保证不会把本来就正常的西欧文字名（如 `Ethernet`
 * 加重音符号）误改。解不出来就原样返回。
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

/** 从请求里取令牌：Authorization 头优先，其次 query（WebSocket 握手用）。 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  const url = new URL(req.url)
  return url.searchParams.get('token')
}
