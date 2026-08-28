import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

describe('桌面发布清单', () => {
  test('安装包携带项目与第三方许可证', () => {
    const config = JSON.parse(
      readFileSync(join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as {
      bundle: {
        license?: string
        licenseFile?: string
        resources?: Record<string, string>
      }
    }

    expect(config.bundle.license).toBe('Apache-2.0')
    expect(config.bundle.licenseFile).toBe('../../../LICENSE')
    expect(config.bundle.resources).toEqual({
      '../../../LICENSE': 'licenses/LICENSE',
      '../../../NOTICE': 'licenses/NOTICE',
      '../../../THIRD_PARTY_NOTICES.md': 'licenses/THIRD_PARTY_NOTICES.md',
    })
  })

  test('Windows 发布在 Rust 门禁前准备 sidecar', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/release-windows.yml', import.meta.url),
      'utf8',
    )
    const sidecar = workflow.indexOf('- name: Build sidecar')
    const gate = workflow.indexOf('- name: Run release gate')

    expect(sidecar).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(sidecar)
  })
})
