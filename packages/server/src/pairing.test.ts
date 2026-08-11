import { describe, expect, test } from 'bun:test'
import type { networkInterfaces } from 'node:os'
import { decodePairingUrl } from '@qywork/core'
import { lanCandidates, Pairing, repairMojibake } from './pairing.ts'

type Ifaces = ReturnType<typeof networkInterfaces>

function iface(address: string, netmask: string, mac: string): NonNullable<Ifaces[string]>[number] {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac,
    internal: false,
    cidr: `${address}/24`,
  } as NonNullable<Ifaces[string]>[number]
}

describe('局域网地址选择', () => {
  /**
   * 回归用例：取自实测机器。
   *
   * 这台机器同时存在真实网卡、Hyper-V 虚拟交换机和 singbox 的 TUN 隧道。
   * 早期两版实现都选错了——一版按网卡名黑名单（打成平手后靠枚举顺序决定），
   * 一版问默认路由（VPN 下默认路由指向 TUN）。
   */
  test('在 VPN + Hyper-V 环境下选中真实网卡', () => {
    const ifaces: Ifaces = {
      singbox_tun: [iface('172.18.0.1', '255.255.255.252', '00:00:00:00:00:00')],
      'vEthernet (Default Switch)': [iface('192.168.176.1', '255.255.240.0', '00:15:5d:90:fd:7e')],
      以太网: [iface('192.168.1.26', '255.255.255.0', '10:ff:e0:d5:64:b6')],
    }
    const ranked = lanCandidates(ifaces)
    expect(ranked[0]?.address).toBe('192.168.1.26')
    // 虚拟网卡仍然出现在候选里——自动判断不可靠时用户要能手选。
    expect(ranked).toHaveLength(3)
  })

  test('排除 169.254 自动配置地址', () => {
    const ifaces: Ifaces = {
      WLAN: [iface('169.254.128.140', '255.255.0.0', 'aa:bb:cc:dd:ee:ff')],
      eth0: [iface('192.168.1.5', '255.255.255.0', '10:ff:e0:00:00:01')],
    }
    const ranked = lanCandidates(ifaces)
    expect(ranked.map((c) => c.address)).toEqual(['192.168.1.5'])
  })

  test('同分时按地址排序，结果稳定', () => {
    const ifaces: Ifaces = {
      b: [iface('192.168.1.9', '255.255.255.0', '10:ff:e0:00:00:02')],
      a: [iface('192.168.1.3', '255.255.255.0', '10:ff:e0:00:00:01')],
    }
    expect(lanCandidates(ifaces).map((c) => c.address)).toEqual(['192.168.1.3', '192.168.1.9'])
    // 换个枚举顺序，结果必须一样。
    const reversed: Ifaces = { a: ifaces.a, b: ifaces.b }
    expect(lanCandidates(reversed).map((c) => c.address)).toEqual(['192.168.1.3', '192.168.1.9'])
  })

  test('Docker 网桥被压到真实网卡之后', () => {
    const ifaces: Ifaces = {
      docker0: [iface('172.17.0.1', '255.255.0.0', '02:42:ac:11:00:01')],
      eth0: [iface('10.0.0.7', '255.255.255.0', '3c:22:fb:00:00:01')],
    }
    expect(lanCandidates(ifaces)[0]?.address).toBe('10.0.0.7')
  })
})

describe('网卡名乱码修复', () => {
  /**
   * Windows 上「以太网」经 os.networkInterfaces() 取出来会变成 Latin-1 误解码的
   * `ä»¥å¤ªç½`。用户要靠这个名字辨认选哪块网卡，乱码等于功能作废。
   */
  test('还原被 Latin-1 误解码的中文网卡名', () => {
    const broken = Buffer.from('以太网', 'utf8').toString('latin1')
    expect(repairMojibake(broken)).toBe('以太网')
  })

  test('纯 ASCII 名原样返回', () => {
    expect(repairMojibake('vEthernet (Default Switch)')).toBe('vEthernet (Default Switch)')
    expect(repairMojibake('singbox_tun')).toBe('singbox_tun')
  })

  test('本来就正确的中文名不被改坏', () => {
    expect(repairMojibake('以太网')).toBe('以太网')
  })

  test('解不出 UTF-8 时原样返回，不吞掉内容', () => {
    // 单个 Latin-1 重音字符不是合法 UTF-8 序列，必须原样保留。
    expect(repairMojibake('Café')).toBe('Café')
  })
})

describe('配对令牌', () => {
  test('令牌可自验，错误令牌被拒', () => {
    const p = new Pairing()
    expect(p.verify(p.token)).toBe(true)
    expect(p.verify('0'.repeat(p.token.length))).toBe(false)
    expect(p.verify('')).toBe(false)
    expect(p.verify(null)).toBe(false)
  })

  test('过期令牌被拒', () => {
    const p = new Pairing({ ttlMs: -1 })
    expect(p.verify(p.token)).toBe(false)
  })

  test('令牌走 fragment，不进 query（不会被日志与 Referer 捕获）', () => {
    const p = new Pairing({ deviceName: 'testbox' })
    const url = p.qrUrl(7717)
    const [beforeHash] = url.split('#')
    expect(beforeHash).not.toContain(p.token)
    expect(url).toContain('#')

    const decoded = decodePairingUrl(url)
    expect(decoded?.token).toBe(p.token)
    expect(decoded?.deviceName).toBe('testbox')
  })
})
