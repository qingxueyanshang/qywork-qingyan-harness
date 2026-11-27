import { describe, expect, test } from 'bun:test'
import { Ports } from '@qywork/agent'
import { CloudSkillPort } from '@qywork/tools'
import { CLOUD_PROVIDER } from './cloud/account.ts'
import { builtinSkillPortOf } from './deps.ts'

const port: CloudSkillPort = {
  packages: [{ id: 'ppt', name: '演示文稿', description: '制作演示文稿' }],
  files: async () => ({ ok: true, value: [] }),
  read: async () => ({ ok: false, code: 'unavailable', message: '' }),
  search: async () => ({ ok: true, value: { matches: [], truncated: false } }),
}

describe('内置技能端口', () => {
  test('只在本轮经云端接口发送时提供：标记只由云端网关替换', () => {
    const deps = { builtinSkills: () => port }
    expect(new Ports(builtinSkillPortOf(deps, CLOUD_PROVIDER)).get(CloudSkillPort)).toBe(port)
    expect(builtinSkillPortOf(deps, 'mine')).toEqual([])
    expect(builtinSkillPortOf(deps, undefined)).toEqual([])
  })

  test('未登录、清单中没有内置技能或未配置云端时不提供', () => {
    expect(builtinSkillPortOf({ builtinSkills: () => null }, CLOUD_PROVIDER)).toEqual([])
    expect(builtinSkillPortOf({}, CLOUD_PROVIDER)).toEqual([])
  })
})
