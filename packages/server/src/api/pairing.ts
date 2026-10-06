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
    // 二维码必须指向局域网监听的端口，而不是主端口：主端口只绑定 127.0.0.1，
    // 手机无法连接。未开启局域网时先给出主端口，界面会提示先打开开关。
    const reachablePort = d.lanEnabled() ? d.lanPort() : d.port
    return json({
      ...d.pairing.payload(reachablePort),
      qr: d.pairing.qrUrl(reachablePort),
      lanEnabled: d.lanEnabled(),
      // 同时返回全部候选地址：自动判断在 VPN 或虚拟网卡环境下不可靠，
      // 界面必须允许用户换一个地址重新生成二维码。
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
