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

  /**
   * 干净 runner 上没有 sidecar，而 `bun run gate` 末尾的 `cargo check` 会跑 tauri 的
   * 构建脚本，`tauri.conf.json` 把 `bin/qy` 声明成 `externalBin`：文件不在就以 101 退出。
   * 两个工作流都从同一个 action 拿这个前置，所以顺序在那一份里判。
   */
  test('每条工作流都在门禁前准备 sidecar', () => {
    const setup = readFileSync(
      new URL('../.github/actions/setup-build/action.yml', import.meta.url),
      'utf8',
    )
    expect(setup).toContain('bun run build:agent')

    for (const name of ['ci.yml', 'release-windows.yml']) {
      const workflow = readFileSync(
        new URL(`../.github/workflows/${name}`, import.meta.url),
        'utf8',
      )
      const prepared = workflow.indexOf('uses: ./.github/actions/setup-build')
      const gate = workflow.indexOf('run: bun run gate')

      expect(prepared).toBeGreaterThan(-1)
      expect(gate).toBeGreaterThan(prepared)
    }
  })

  /**
   * CI 不许持有写权限，也不许放过一部分门禁：它是提交与 PR 的唯一自动证据，
   * 降一格就等于没有。
   */
  test('CI 只读、跑全量门禁、按分支取消旧的那次', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('contents: read')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).toContain('run: bun run gate')
    expect(workflow).toContain('run: bun run build:web')
    expect(workflow).not.toContain('continue-on-error')
    expect(workflow).toContain('cancel-in-progress: true')
    // 与发布工作流的 group 重名会让一次 push 取消正在出安装包的那次发布。
    expect(workflow).not.toContain('group: windows-release')
  })

  test('Windows 发布必须携带当前版本的更新说明', () => {
    const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim()
    const notes = readFileSync(
      new URL(`../.github/release-notes/v${version}.md`, import.meta.url),
      'utf8',
    )
    const workflow = readFileSync(
      new URL('../.github/workflows/release-windows.yml', import.meta.url),
      'utf8',
    )

    expect(notes).toContain('## 本次更新')
    expect(workflow).toContain('.github/release-notes/v$version.md')
    expect(workflow).toContain('releaseBody: $' + '{{ steps.release_notes.outputs.body }}')
  })
})
