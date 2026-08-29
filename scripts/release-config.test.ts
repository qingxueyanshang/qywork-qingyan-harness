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

  test('macOS 与 Linux 发布覆盖原生目标并上传产物', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/release-macos-linux.yml', import.meta.url),
      'utf8',
    )

    expect(workflow).toContain('aarch64-apple-darwin')
    expect(workflow).toContain('x86_64-apple-darwin')
    expect(workflow).toContain('x86_64-unknown-linux-gnu')
    expect(workflow).toContain('tauri build --bundles app')
    expect(workflow).toContain('tauri build --bundles deb,appimage')
    expect(workflow).toContain('actions/upload-artifact@v4')
  })
})
