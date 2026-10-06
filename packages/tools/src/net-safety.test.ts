import { describe, expect, test } from 'bun:test'
import { checkUrl, classifyAddress, safeFetch } from './net-safety.ts'

describe('地址分类', () => {
  test('公网地址放行', () => {
    expect(classifyAddress('93.184.216.34')).toBeNull()
    expect(classifyAddress('2606:2800:220:1:248:1893:25c8:1946')).toBeNull()
  })

  test('回环地址', () => {
    expect(classifyAddress('127.0.0.1')?.reason).toBe('loopback')
    expect(classifyAddress('127.255.255.254')?.reason).toBe('loopback')
    expect(classifyAddress('::1')?.reason).toBe('loopback')
  })

  test('云元数据所在的链路本地段', () => {
    // 该地址风险最高：一次请求即可取得实例凭证。
    expect(classifyAddress('169.254.169.254')?.reason).toBe('link_local')
    expect(classifyAddress('169.254.0.1')?.reason).toBe('link_local')
  })

  test('三个 IPv4 内网段', () => {
    expect(classifyAddress('10.0.0.1')?.reason).toBe('private_network')
    expect(classifyAddress('172.16.0.1')?.reason).toBe('private_network')
    expect(classifyAddress('172.31.255.255')?.reason).toBe('private_network')
    expect(classifyAddress('192.168.1.1')?.reason).toBe('private_network')
  })

  test('172.15 与 172.32 不在内网段内：网段边界不得扩大', () => {
    expect(classifyAddress('172.15.0.1')).toBeNull()
    expect(classifyAddress('172.32.0.1')).toBeNull()
  })

  test('CGNAT 与保留段', () => {
    expect(classifyAddress('100.64.0.1')?.reason).toBe('private_network')
    expect(classifyAddress('0.0.0.0')?.reason).toBe('reserved')
    expect(classifyAddress('224.0.0.1')?.reason).toBe('reserved')
  })

  test('IPv4 映射的 IPv6 地址展开为 IPv4 后判定，::ffff: 前缀无法绕过检查', () => {
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

  test('格式错误的 URL 被拒绝，不抛出异常', async () => {
    expect((await checkUrl('这不是 URL')).reason).toBe('malformed_url')
  })

  test('云元数据主机名直接命中，无需 DNS 解析', async () => {
    const v = await checkUrl('http://169.254.169.254/latest/meta-data/')
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('cloud_metadata')
  })

  test('metadata.google.internal 同样命中', async () => {
    expect((await checkUrl('http://metadata.google.internal/')).reason).toBe('cloud_metadata')
  })

  test('localhost 被拒绝，无需解析', async () => {
    expect((await checkUrl('http://localhost:3000/')).reason).toBe('loopback')
    expect((await checkUrl('http://app.localhost/')).reason).toBe('loopback')
  })

  test('IP 字面量直接判定，不经过 DNS', async () => {
    expect((await checkUrl('http://127.0.0.1/')).reason).toBe('loopback')
    expect((await checkUrl('http://10.1.2.3/')).reason).toBe('private_network')
    expect((await checkUrl('http://[::1]/')).reason).toBe('loopback')
  })

  test('端口白名单', async () => {
    expect((await checkUrl('http://93.184.216.34:6379/')).reason).toBe('port_not_allowed')
    expect((await checkUrl('http://93.184.216.34:22/')).reason).toBe('port_not_allowed')
    expect((await checkUrl('http://93.184.216.34:8080/')).allowed).toBe(true)
  })

  test('公网 IP 与允许的端口放行，并返回解析结果', async () => {
    const v = await checkUrl('https://93.184.216.34/x')
    expect(v.allowed).toBe(true)
    // resolved 必须用于实际连接，否则校验与连接之间存在 DNS 重绑定窗口。
    expect(v.resolved).toBe('93.184.216.34')
  })

  test('无法解析的域名默认拒绝，不交给 fetch 尝试连接', async () => {
    const v = await checkUrl('http://这个域名一定不存在.invalid/')
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('dns_failed')
  })

  test('显式放行的主机跳过检查，用于本地开发时访问自行启动的服务', async () => {
    const v = await checkUrl('http://127.0.0.1:3000/', { allowHosts: ['127.0.0.1'] })
    expect(v.allowed).toBe(true)
  })

  test('allowPrivate 只放行内网地址，不放行回环与元数据地址', async () => {
    expect((await checkUrl('http://10.0.0.5:8080/', { allowPrivate: true })).allowed).toBe(true)
    // 以下两个地址在开启 allowPrivate 时同样必须拒绝。
    expect((await checkUrl('http://127.0.0.1:8080/', { allowPrivate: true })).allowed).toBe(false)
    expect((await checkUrl('http://169.254.169.254/', { allowPrivate: true })).allowed).toBe(false)
  })
})

describe('IPv6 等价写法：按数值判定，不按字面量匹配', () => {
  /**
   * 复现原始失败形状：`::ffff:127.0.0.1` 被拒绝，`::ffff:7f00:1` 被放行。
   * 同一地址的两种合法写法得出两种结论；只识别点分十进制的正则无法完成判定。
   */
  test('IPv4 映射地址的十六进制写法同样被拦截', () => {
    expect(classifyAddress('::ffff:7f00:1')?.reason).toBe('loopback')
    expect(classifyAddress('::ffff:127.0.0.1')?.reason).toBe('loopback')
    // 云元数据端点：a9fe:a9fe 即 169.254.169.254，风险最高。
    expect(classifyAddress('::ffff:a9fe:a9fe')?.reason).toBe('link_local')
    expect(classifyAddress('::ffff:c0a8:1')?.reason).toBe('private_network')
  })

  test('大小写与零压缩的各种写法结论一致', () => {
    expect(classifyAddress('::FFFF:7F00:1')?.reason).toBe('loopback')
    expect(classifyAddress('0:0:0:0:0:ffff:7f00:1')?.reason).toBe('loopback')
    expect(classifyAddress('fe80::1')?.reason).toBe('link_local')
    expect(classifyAddress('FE80:0:0:0:0:0:0:1')?.reason).toBe('link_local')
    expect(classifyAddress('fd00::1')?.reason).toBe('private_network')
  })

  test('URL 中带方括号的十六进制映射地址被 checkUrl 拒绝', async () => {
    const v = await checkUrl('http://[::ffff:a9fe:a9fe]/')
    expect(v.allowed).toBe(false)
  })

  test('无法解析的 IPv6 地址默认拒绝，不视为公网地址放行', () => {
    expect(classifyAddress('::ffff:1.2.3')?.reason).toBe('reserved')
  })
})

/**
 * 响应超过读取上限时必须报告内容不完整，否则截断后的正文会被当作完整的远端内容保存与引用。
 */
describe('读取上限与截断标记', () => {
  const body = 'x'.repeat(100)
  const serve = () => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(body) })
  const fetchWith = async (maxBytes: number) => {
    const server = serve()
    try {
      return await safeFetch(`http://127.0.0.1:${server.port}/`, {
        allowHosts: ['127.0.0.1'],
        maxBytes,
      })
    } finally {
      await server.stop(true)
    }
  }

  test('超过上限：只保留上限内的字节，并标记截断', async () => {
    const r = await fetchWith(32)
    expect(r.ok).toBe(true)
    expect(r.body.byteLength).toBe(32)
    expect(r.truncated).toBe(true)
  })

  test('恰好等于上限：内容完整，不标记截断', async () => {
    const r = await fetchWith(100)
    expect(r.body.byteLength).toBe(100)
    expect(r.truncated).toBe(false)
  })

  test('小于上限：内容完整，不标记截断', async () => {
    const r = await fetchWith(1000)
    expect(r.truncated).toBe(false)
  })
})
