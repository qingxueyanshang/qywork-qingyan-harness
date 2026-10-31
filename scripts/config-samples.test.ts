/**
 * 旧版本写入的配置在当前版本中仍然有效。覆盖范围：`scripts/config-sample.ts` 与
 * `scripts/config-samples/` 下的全部样本，经 `packages/runtime/src/config.ts` 的 `loadConfig` 与 `diagnoseConfig`。
 *
 * 每个发布版本冻结一份样本。删除词表取值、改名或删除配置字段时，必须在 `loadConfig` 中加入迁移，
 * 使旧样本的结构校验为空、含义与样本记录一致。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseConfig } from '@qywork/runtime'
import {
  loadAsCurrent,
  meaningChanges,
  meaningOf,
  SAMPLES_DIR,
  sampleConfig,
} from './config-sample.ts'

const ROOT = join(import.meta.dir, '..')
const SCRATCH = join(tmpdir(), 'config-samples')

interface Sample {
  version: string
  config: unknown
  meaning: Record<string, unknown>
}

const samples = readdirSync(SAMPLES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(SAMPLES_DIR, f), 'utf8')) as Sample)

/** 当前代码对一份样本的检查结果：结构问题与含义改变的路径。 */
async function check(sample: Pick<Sample, 'config' | 'meaning'>) {
  const cfg = await loadAsCurrent(sample.config, SCRATCH)
  return { problems: diagnoseConfig(cfg), changes: meaningChanges(sample.meaning, meaningOf(cfg)) }
}

test('当前版本已有配置样本', () => {
  const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim()
  expect(
    samples.some((s) => s.version === version),
    `缺少 ${version} 的配置样本：运行 bun run version:sync，或 bun run scripts/config-sample.ts`,
  ).toBe(true)
})

describe('历史版本的配置在当前版本中有效', () => {
  for (const sample of samples) {
    test(`${sample.version} 的配置样本`, async () => {
      const { problems, changes } = await check(sample)
      const hint = '删除词表取值、改名或删除配置字段时，在 loadConfig 中加入迁移'
      expect(problems, `${sample.version} 的配置被判为结构不合法，${hint}`).toEqual([])
      expect(changes, `${sample.version} 的配置含义改变，${hint}`).toEqual([])
    })
  }
})

/**
 * 原始失败形状：新版本改名或删除配置字段、删除词表取值而没有写迁移，旧配置在升级后被静默忽略或保存被拒绝。
 * 以当前样本模拟旧版本写入的配置，检查必须报告这两种情形。
 */
describe('检查能发现未迁移的改动', () => {
  test('字段改名后旧写法的含义丢失', async () => {
    const config = sampleConfig()
    const meaning = meaningOf(await loadAsCurrent(config, SCRATCH))
    const { mediaDefaults, ...rest } = config
    const { changes } = await check({ config: { ...rest, mediaDefault: mediaDefaults }, meaning })
    expect(changes).toContain('mediaDefaults.image')
  })

  test('词表取值被删除后结构校验失败', async () => {
    const config = sampleConfig()
    const meaning = meaningOf(await loadAsCurrent(config, SCRATCH))
    const [name, provider] = Object.entries(config.providers)[0]!
    const model = Object.keys(provider.models)[0]!
    const removed = structuredClone(config)
    ;(removed.providers[name]!.models[model] as { effort: string }).effort = 'retired-level'
    const { problems, changes } = await check({ config: removed, meaning })
    expect(problems.some((p) => p.includes('retired-level'))).toBe(true)
    expect(changes).toContain(`models.${name}/${model}.effort`)
  })
})
