/** 覆盖 `channel-vendors.ts`：渠道商表按接口地址的主机名判定渠道商。 */

import { expect, test } from 'bun:test'
import { CHANNEL_VENDORS, channelVendorOf } from './channel-vendors.ts'

test('各渠道商的官方地址与第三方接口地址判定为对应渠道商', () => {
  const cases: [string, string][] = [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'alibaba'],
    ['https://ws-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'alibaba'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'volcengine'],
    ['https://ark.ap-southeast.bytepluses.com/api/v3', 'volcengine'],
    ['https://api-singapore.klingai.com', 'kling'],
    ['https://api-bj.minimaxi.com/v1', 'minimax'],
    ['https://api.xiaomimimo.com/v1', 'xiaomi'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'google'],
    ['https://API.X.AI/v1', 'xai'],
    ['https://opencode.ai/zen/v1', 'opencode'],
    ['https://providera.example.com', 'providera'],
    ['https://providerb.example.com/v1', 'providerb'],
    ['https://providerc.example.com/api/v1', 'providerc'],
    ['https://open.bigmodel.cn/api/paas/v4', 'zhipu'],
  ]
  for (const [url, vendor] of cases) expect([url, channelVendorOf(url)]).toEqual([url, vendor])
  expect(new Set(cases.map(([, v]) => v))).toEqual(new Set(CHANNEL_VENDORS))
})

test('未收录的第三方接口、相似主机名与无效地址不属于任何渠道商', () => {
  for (const url of [
    'https://relay.example.com/v1',
    'https://providerf.example.com/',
    'https://providera.example.com.example.com',
    'https://providerb.example.com/v1',
    'https://ark.cn-beijing.volces.com.evil.example',
    'not a url',
    undefined,
  ])
    expect(channelVendorOf(url)).toBeNull()
})
