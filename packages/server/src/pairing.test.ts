import { describe, expect, test } from 'bun:test'
import { decodePairingUrl, encodePairingUrl } from '@qywork/core'
import { Pairing } from './pairing.ts'

describe('配对令牌', () => {
  test('令牌可自行校验，错误令牌被拒绝', () => {
    const p = new Pairing()
    expect(p.verify(p.token)).toBe(true)
    expect(p.verify('0'.repeat(p.token.length))).toBe(false)
    expect(p.verify('')).toBe(false)
    expect(p.verify(null)).toBe(false)
  })

  test('外部注入的令牌被原样采用：鉴权只接受这一个持有者', () => {
    const p = new Pairing({ token: 'injected-by-desktop' })
    expect(p.token).toBe('injected-by-desktop')
    expect(p.verify('injected-by-desktop')).toBe(true)
    expect(p.verify('injected-by-deskto')).toBe(false)
  })

  test('设备页面地址的入口为 `/`，令牌放在 fragment 中，不放入 query（不会被日志与 Referer 捕获）', () => {
    const p = new Pairing({ deviceName: 'testbox' })
    const url = encodePairingUrl({
      url: 'https://abc.example.com',
      token: p.token,
      deviceName: p.deviceName,
    })
    const [beforeHash] = url.split('#')
    expect(beforeHash).toBe('https://abc.example.com/')
    expect(url).toContain('#')

    const decoded = decodePairingUrl(url)
    expect(decoded?.token).toBe(p.token)
    expect(decoded?.deviceName).toBe('testbox')
  })
})
