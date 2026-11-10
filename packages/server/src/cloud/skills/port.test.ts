/**
 * 云端技能端口的 HTTP 实现：请求形状、标记校验与错误分类。
 *
 * 覆盖范围：`cloud/skills/port.ts`。云端由 `fake-cloud.test-helper.ts` 在本进程内提供。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { parseSkillMarker, textFeatures } from '@qywork/ai'
import type { QyConfig } from '@qywork/runtime'
import { CLOUD_PROVIDER } from '../account.ts'
import { type FakeCloud, startFakeCloud } from './fake-cloud.test-helper.ts'
import { cloudSkillPort } from './port.ts'

const GUIDE = '准备素材\n导出前运行 check_all.py\n检查字幕\n'

const clouds: FakeCloud[] = []
afterEach(() => {
  for (const c of clouds.splice(0)) c.stop()
})

function setup(apiKey = 'qyd_device') {
  const cloud = startFakeCloud({
    key: 'qyd_device',
    account: 'user-1',
    signingKey: new Uint8Array(32).fill(3),
    packages: { 'flow-demo': { 'SKILL.md': '# 流程\n', 'references/guide.md': GUIDE } },
  })
  clouds.push(cloud)
  const config: QyConfig = {
    providers: {
      [CLOUD_PROVIDER]: {
        kind: 'openai_chat_completions',
        baseUrl: cloud.origin,
        apiKey,
        models: {},
      },
    },
  }
  const port = cloudSkillPort({
    config,
    origin: cloud.origin,
    packages: [{ package: 'flow-demo', version: 3 }],
  })
  return { cloud, config, port }
}

describe('读取接口', () => {
  test('列举、读取与检索；读取的特征计数取标记中的计数，版本随请求发送', async () => {
    const { cloud, port } = setup()
    expect(port.packages).toEqual(['flow-demo'])
    expect(await port.files('flow-demo')).toEqual({
      ok: true,
      value: [
        { path: 'SKILL.md', size: Buffer.byteLength('# 流程\n') },
        { path: 'references/guide.md', size: Buffer.byteLength(GUIDE) },
      ],
    })
    const read = await port.read('flow-demo', 'references/guide.md', 2, 3)
    if (!read.ok) throw new Error(read.message)
    expect(read.value).toMatchObject({ path: 'references/guide.md', lines: 3, start: 2, end: 3 })
    expect(parseSkillMarker(read.value.marker)?.features).toEqual(read.value.features)
    expect(read.value.features).toEqual(textFeatures('导出前运行 check_all.py\n检查字幕'))
    expect(await port.search('flow-demo', 'check_all.py', 'references/')).toEqual({
      ok: true,
      value: { matches: [{ path: 'references/guide.md', lines: [2] }], truncated: false },
    })
    expect(cloud.skillCalls).toContain('read path=references%2Fguide.md&start=2&end=3&version=3')
  })

  test('读取接口的错误码原样作为失败类别', async () => {
    const { cloud, port } = setup()
    expect(await port.read('flow-demo', 'nope.md', 1)).toEqual({
      ok: false,
      code: 'skill_file_not_found',
      message: '文件不存在：nope.md',
    })
    expect(await port.read('flow-demo', 'references/guide.md', 2, 9)).toEqual({
      ok: false,
      code: 'skill_range_invalid',
      message: '行段超出文件范围：共 3 行',
    })
    cloud.granted.clear()
    expect(await port.files('flow-demo')).toEqual({
      ok: false,
      code: 'skill_not_granted',
      message: '未获得技能包的使用权益：flow-demo',
    })
  })

  test('未登录、密钥无效与连接失败归为 unavailable', async () => {
    const wrong = setup('qyd_other')
    expect(await wrong.port.files('flow-demo')).toEqual({
      ok: false,
      code: 'unavailable',
      message: '云端返回 401 未授权：设备密钥无效',
    })

    const signedOut = setup()
    delete signedOut.config.providers[CLOUD_PROVIDER]
    expect(await signedOut.port.files('flow-demo')).toEqual({
      ok: false,
      code: 'unavailable',
      message: '未登录云端账号',
    })

    const closed = setup()
    closed.cloud.stop()
    const r = await closed.port.files('flow-demo')
    expect(r.ok ? null : [r.code, r.message.startsWith('无法连接云端：')]).toEqual([
      'unavailable',
      true,
    ])
  })
})
