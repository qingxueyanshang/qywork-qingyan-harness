/** 配对与局域网开关。 */

import { encodePairingUrl } from '@qywork/core'
import { lanCandidates } from '../pairing.ts'
import { type ApiHandler, json } from './types.ts'

export const handlePairingApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/pairing/lan' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { enabled?: boolean }
    if (body.enabled) d.enableLan()
    else d.disableLan()
    return json({ enabled: d.lanEnabled() })
  }

  if (p === '/api/pairing') {
    // 二维码必须指向**局域网监听的那个端口**，不是主端口——主端口只绑 127.0.0.1，
    // 手机连不上。没开局域网时先给主端口，UI 会提示要先开开关。
    const reachablePort = d.lanEnabled() ? d.lanPort() : d.port
    return json({
      ...d.pairing.payload(reachablePort),
      qr: d.pairing.qrUrl(reachablePort),
      lanEnabled: d.lanEnabled(),
      // 一并回全部候选：自动判断在 VPN / 虚拟网卡环境下不可靠，
      // UI 必须能让用户换一个地址重新出码。
      candidates: lanCandidates().map((c) => ({
        name: c.name,
        address: c.address,
        url: `http://${c.address}:${reachablePort}`,
        qr: encodePairingUrl({
          url: `http://${c.address}:${reachablePort}`,
          token: d.token,
          deviceName: d.pairing.deviceName,
        }),
      })),
    })
  }

  return null
}
