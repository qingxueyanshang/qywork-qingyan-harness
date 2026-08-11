import { describe, expect, test } from 'bun:test'
import { checkUrl, classifyAddress } from './net-safety.ts'

describe('地址分类', () => {
  test('公网地址放行', () => {
    expect(classifyAddress('93.184.216.34')).toBeNull()
    expect(classifyAddress('2606:2800:220:1:248:1893:25c8:1946')).toBeNull()
  })

  test('回环', () => {
    expect(classifyAddress('127.0.0.1')?.reason).toBe('loopback')
    expect(classifyAddress('127.255.255.254')?.reason).toBe('loopback')
    expect(classifyAddress('::1')?.reason).toBe('loopback')
  })

  test('云元数据所在的链路本地段', () => {
    // 这条是最危险的：一次请求就能拿到实例凭证。
    expect(classifyAddress('169.254.169.254')?.reason).toBe('link_local')
    expect(classifyAddress('169.254.0.1')?.reason).toBe('link_local')
  })

  test('三个 IPv4 内网段', () => {
    expect(classifyAddress('10.0.0.1')?.reason).toBe('private_network')
    expect(classifyAddress('172.16.0.1')?.reason).toBe('private_network')
    expect(classifyAddress('172.31.255.255')?.reason).toBe('private_network')
    expect(classifyAddress('192.168.1.1')?.reason).toBe('private_network')
  })

  test('172.15 与 172.32 不在内网段内 —— 边界不能判宽', () => {
    expect(classifyAddress('172.15.0.1')).toBeNull()
    expect(classifyAddress('172.32.0.1')).toBeNull()
  })

  test('CGNAT 与保留段', () => {
    expect(classifyAddress('100.64.0.1')?.reason).toBe('private_network')
    expect(classifyAddress('0.0.0.0')?.reason).toBe('reserved')
    expect(classifyAddress('224.0.0.1')?.reason).toBe('reserved')
  })

  test('IPv4 映射的 IPv6 地址必须展开判 —— 否则 ::ffff: 前缀就是万能绕过', () => {
    expect(classifyAddress('::ffff:127.0.0.1')?.reason).toBe('loopback')
    expect(classifyAddress('::ffff:169.254.169.254')?.reason).toBe('link_local')
    expect(classifyAddress('::ffff:10.0.0.1')?.reason).toBe('private_network')
    // 映射的公网地址仍然放行。
    expect(classifyAddress('::ffff:93.184.216.34')).toBeNull()
  })

  test('IPv6 唯一本地与链路本地', () => {
    expect(classifyAddress('fc00::1')?.reason).toBe('private_network')
    expect(classifyAddress('fd12:3456::1')?.reason).toBe('private_network')
    expect(classifyAddress('fe80::1')?.reason).toBe('link_local')
    expect(classifyAddress('ff02::1')?.reason).toBe('reserved')
  })

  test('无法识别的地址默认拒绝', () => {
    expect(classifyAddress('不是地址')?.reason).toBe('reserved')
  })
})

describe('URL 校验', () => {
  test('只允许 http/https', async () => {
    expect((await checkUrl('file:///etc/passwd')).reason).toBe('scheme_not_allowed')
    expect((await checkUrl('ftp://example.com/x')).reason).toBe('scheme_not_allowed')
    expect((await checkUrl('gopher://example.com')).reason).toBe('scheme_not_allowed')
  })

  test('畸形 URL 被拒而不是抛异常', async () => {
    expect((await checkUrl('这不是 URL')).reason).toBe('malformed_url')
  })

  test('云元数据主机名直接命中，不必等 DNS', async () => {
    const v = await checkUrl('http://169.254.169.254/latest/meta-data/')
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('cloud_metadata')
  })

  test('metadata.google.internal 同样命中', async () => {
    expect((await checkUrl('http://metadata.google.internal/')).reason).toBe('cloud_metadata')
  })

  test('localhost 被拒，不必解析', async () => {
    expect((await checkUrl('http://localhost:3000/')).reason).toBe('loopback')
    expect((await checkUrl('http://app.localhost/')).reason).toBe('loopback')
  })

  test('IP 字面量直接判，不走 DNS', async () => {
    expect((await checkUrl('http://127.0.0.1/')).reason).toBe('loopback')
    expect((await checkUrl('http://10.1.2.3/')).reason).toBe('private_network')
    expect((await checkUrl('http://[::1]/')).reason).toBe('loopback')
  })

  test('端口白名单', async () => {
    expect((await checkUrl('http://93.184.216.34:6379/')).reason).toBe('port_not_allowed')
    expect((await checkUrl('http://93.184.216.34:22/')).reason).toBe('port_not_allowed')
    expect((await checkUrl('http://93.184.216.34:8080/')).allowed).toBe(true)
  })

  test('公网 IP + 允许端口放行，并回传解析结果', async () => {
    const v = await checkUrl('https://93.184.216.34/x')
    expect(v.allowed).toBe(true)
    // resolved 要用于实际连接，否则校验与连接之间有 DNS 重绑定窗口。
    expect(v.resolved).toBe('93.184.216.34')
  })

  test('解析不了的域名默认拒绝，不放行给 fetch 去撞', async () => {
    const v = await checkUrl('http://这个域名一定不存在.invalid/')
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('dns_failed')
  })

  test('显式放行的主机绕过检查 —— 本地开发时抓自己起的服务', async () => {
    const v = await checkUrl('http://127.0.0.1:3000/', { allowHosts: ['127.0.0.1'] })
    expect(v.allowed).toBe(true)
  })

  test('allowPrivate 只放开内网，不放开回环与元数据', async () => {
    expect((await checkUrl('http://10.0.0.5:8080/', { allowPrivate: true })).allowed).toBe(true)
    // 这两条即使开了 allowPrivate 也必须挡住。
    expect((await checkUrl('http://127.0.0.1:8080/', { allowPrivate: true })).allowed).toBe(false)
    expect((await checkUrl('http://169.254.169.254/', { allowPrivate: true })).allowed).toBe(false)
  })
})
