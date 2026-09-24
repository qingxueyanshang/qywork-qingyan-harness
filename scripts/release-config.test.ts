/**
 * 发布链路的回归。**覆盖范围**：`apps/desktop/src-tauri/tauri.conf.json`、`.github/` 下的
 * 工作流与两个共用 composite action、`package.json` 的门禁与资产入口，以及
 * `scripts/collect-installer.ts` 的收集与清理。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeBash } from '../packages/tools/src/sandbox.ts'
import { collect } from './collect-installer.ts'

const ROOT = join(import.meta.dir, '..')

/** 三条发行工作流。每加一个出包平台就加一行，下面的结构断言随即覆盖它。 */
const RELEASE_WORKFLOWS = ['release-windows.yml', 'release-macos.yml', 'release-linux.yml']

function workflowText(name: string): string {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
}

function actionText(name: string): string {
  return readFileSync(new URL(`../.github/actions/${name}/action.yml`, import.meta.url), 'utf8')
}

describe('桌面发布清单', () => {
  test('发布准备把同一公钥写入打包配置和客户端编译环境', () => {
    const action = Bun.YAML.parse(actionText('release-prepare')) as {
      runs: { steps: { name: string; run?: string }[] }
    }
    const script = action.runs.steps.find((step) => step.name === 'Configure signed updates')?.run
    expect(script).toBeDefined()
    const bash = probeBash().path
    expect(bash).not.toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'release-key-'))
    const publicKey = 'dXBkYXRlci10ZXN0LWtleQ=='
    try {
      const result = Bun.spawnSync([bash!, '-c', script!], {
        cwd: dir,
        env: {
          ...process.env,
          UPDATER_PUBLIC_KEY: ` ${publicKey}\n`,
          UPDATER_PRIVATE_KEY: 'test-private-key',
          GITHUB_ENV: 'github-env',
        },
      })
      expect(result.exitCode).toBe(0)
      const config = JSON.parse(readFileSync(join(dir, '.tmp/updater-config.json'), 'utf8'))
      expect(config.plugins.updater.pubkey).toBe(publicKey)
      const environment = readFileSync(join(dir, 'github-env'), 'utf8')
      expect(environment.trim()).toBe(`QYWORK_UPDATER_PUBLIC_KEY=${publicKey}`)
      expect(environment).not.toContain('test-private-key')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('正式更新必须打包签名并上传清单', () => {
    const prepare = actionText('release-prepare')
    const config = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    )
    // 平时的构建不出更新产物，只有发行工作流临时覆盖这一项。
    expect(config.bundle.createUpdaterArtifacts).toBe(false)
    expect(prepare).toContain('"createUpdaterArtifacts":true')

    for (const name of RELEASE_WORKFLOWS) {
      const workflow = workflowText(name)
      expect(workflow).toContain('includeUpdaterJson: true')
      expect(workflow).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY')
      expect(workflow).toContain('vars.QYWORK_UPDATER_PUBLIC_KEY')
      expect(workflow).toContain('--config ../../.tmp/updater-config.json')
      // 缺签名密钥要在门禁与编译之前停，不是跑完一小时再停。
      expect(workflow.indexOf('uses: ./.github/actions/release-prepare')).toBeGreaterThan(-1)
      expect(workflow.indexOf('uses: ./.github/actions/release-prepare')).toBeLessThan(
        workflow.indexOf('run: bun run gate'),
      )
    }
  })

  /**
   * 三条发行工作流往同一个 tag 的草稿 Release 上传。校验和文件同名的话，后一条的
   * `gh release upload --clobber` 会把前一条的那份覆盖掉，而两条都是绿的。
   */
  test('每个平台的校验和文件名互不相同', () => {
    const prefixes = {
      'release-windows.yml': 'SHA256SUMS-windows-',
      'release-macos.yml': 'SHA256SUMS-macos-',
      'release-linux.yml': 'SHA256SUMS-linux-',
    }

    for (const [name, prefix] of Object.entries(prefixes)) {
      const workflow = workflowText(name)
      expect(workflow).toContain(prefix)
      // 不带平台的那个名字三条都会写，最后一条 upload 会盖掉前两条。
      expect(workflow).not.toContain('SHA256SUMS.txt')
      for (const other of Object.values(prefixes)) {
        if (other !== prefix) expect(workflow).not.toContain(other)
      }
    }
  })

  /**
   * macOS 的 Apple 签名与公证要账号，缺了仍然出包——但产物得自己说清楚它没签过，
   * 否则拿到的人按「能装」的预期去装，撞的是 Gatekeeper。
   */
  test('缺 Apple 证书时产出未签名包并在校验和文件名上标明', () => {
    const workflow = workflowText('release-macos.yml')

    expect(workflow).toContain('secrets.APPLE_CERTIFICATE')
    expect(workflow).toContain('secrets.APPLE_ID')
    expect(workflow).toContain('secrets.APPLE_TEAM_ID')
    expect(workflow).toContain('suffix=-unsigned')
    expect(workflow).toContain('steps.apple.outputs.suffix')
    expect(workflow).toContain('::warning')
    expect(workflow).not.toContain('continue-on-error')
  })

  /** 两种架构各用匹配架构的 runner：外部二进制按 `rustc -vV` 的宿主三元组命名。 */
  test('macOS 发布覆盖 x86_64 与 arm64 两种目标', () => {
    const workflow = workflowText('release-macos.yml')

    expect(workflow).toContain('x86_64-apple-darwin')
    expect(workflow).toContain('aarch64-apple-darwin')
    expect(workflow).toContain('macos-15-intel')
    expect(workflow).toContain('macos-latest')
  })
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
   * 干净 runner 上没有这些外部二进制，而 `bun run gate` 里的 `cargo check` 会跑 tauri 的
   * 构建脚本：`tauri.conf.json` 的 `externalBin` 声明过的文件不在就以 101 退出。
   *
   * 两个条目的来源不同：`bin/qy` 由共用 action 在门禁前编，顺序在那一份里判；
   * `bin/qy-computer-host` 由外壳自己的构建脚本在同一次编译里出，工作流里再编一遍
   * 就是第二个入口，外壳旁边放的 worker 因此可能来自另一次编译。
   */
  test('externalBin 的每个条目都只有一处准备它', () => {
    const setup = actionText('setup-build')
    const buildScript = readFileSync(join(ROOT, 'apps/desktop/src-tauri/build.rs'), 'utf8')
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const config = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { bundle: { externalBin: string[] } }

    expect(config.bundle.externalBin).toEqual(['bin/qy', 'bin/qy-computer-host'])
    expect(setup).toContain('bun run build:agent')
    expect(buildScript).toContain('qy-computer-host')
    expect(setup).not.toContain('build:computer-host')
    expect(Object.values(pkg.scripts).join('\n')).not.toContain('build:computer-host')

    for (const name of ['ci.yml', ...RELEASE_WORKFLOWS]) {
      const workflow = workflowText(name)
      const prepared = workflow.indexOf('uses: ./.github/actions/setup-build')
      const gate = workflow.indexOf('run: bun run gate')

      expect(prepared).toBeGreaterThan(-1)
      expect(gate).toBeGreaterThan(prepared)
    }
  })

  /**
   * Linux 上 tauri 链接的是系统 WebKitGTK，runner 镜像不预装。缺哪一个都不是链接错误，
   * 而是对应 `*-sys` 的 build script 以 101 退出，报 pkg-config 找不到该库。
   */
  test('setup-build 在 Linux runner 上装齐 tauri 的系统依赖', () => {
    const setup = actionText('setup-build')

    expect(setup).toContain("runner.os == 'Linux'")
    for (const pkg of [
      'libwebkit2gtk-4.1-dev',
      'build-essential',
      'libxdo-dev',
      'libssl-dev',
      'libayatana-appindicator3-dev',
      'librsvg2-dev',
    ]) {
      expect(setup).toContain(pkg)
    }
  })

  /**
   * CI 不许持有写权限，也不许放过一部分门禁：它是提交与 PR 的唯一自动证据，
   * 降一格就等于没有。
   */
  test('CI 只读、只接分支 push、跑全量门禁、按分支取消旧的那次', () => {
    const workflow = workflowText('ci.yml')

    expect(workflow).toContain('contents: read')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).toContain('branches:\n      - "**"')
    expect(workflow).toContain('run: bun run gate')
    expect(workflow).toContain('run: bun run build:web')
    expect(workflow).not.toContain('continue-on-error')
    expect(workflow).toContain('cancel-in-progress: true')
    // 与发布工作流的 group 重名会让一次 push 取消正在出安装包的那次发布。
    for (const group of ['windows-release', 'macos-release', 'linux-release']) {
      expect(workflow).not.toContain(`group: ${group}`)
    }
  })

  /**
   * 桌面包要出三种，而 gate 里的 cargo check 按运行平台选分支、两个 externalBin 按运行
   * 平台的三元组编译。少一端，那一端的编译错误要到发布当天才暴露。
   */
  test('CI 三端都跑门禁', () => {
    const workflow = workflowText('ci.yml')

    for (const runner of ['windows-latest', 'macos-latest', 'ubuntu-latest']) {
      expect(workflow).toContain(runner)
    }
    expect(workflow).toContain('runs-on: $' + '{{ matrix.os }}')
  })

  /**
   * worker 是独立 crate：src-tauri 的 `cargo check` 不覆盖它，Bun 测试也不执行它的 Rust
   * 单测。不在 gate 里显式列出，它的编译错误和失败测试不会让任何一条流水线变红。
   *
   * 两个 Cargo.lock 都受跟踪，所以每条 cargo 命令都要 `--locked`：不带它的那条会在
   * 清单版本已改、lock 待写回时改写这个受跟踪文件，而门禁只读。
   */
  test('门禁的每条 cargo 命令都点名 manifest 并带 --locked', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const manifests = {
      'typecheck:rust': 'apps/desktop/src-tauri/Cargo.toml',
      'test:rust': 'apps/desktop/src-tauri/Cargo.toml',
      'typecheck:computer-host': 'apps/desktop/native/computer-host/Cargo.toml',
      'test:computer-host': 'apps/desktop/native/computer-host/Cargo.toml',
    }

    for (const [name, manifest] of Object.entries(manifests)) {
      expect(pkg.scripts.gate).toContain(`bun run ${name}`)
      expect(pkg.scripts[name]).toContain('--locked')
      expect(pkg.scripts[name]).toContain(`--manifest-path ${manifest}`)
    }
  })

  /**
   * 外壳的构建脚本会删除并重新复制 `<target-dir>/debug/qy-computer-host.exe`。开发实例正从
   * `.cargo/config.toml` 那个目录运行这个文件，Windows 上文件被占用，删除报拒绝访问、
   * 门禁以 101 退出。门禁的外壳两步因此用独立的产物目录。
   */
  test('门禁的外壳 cargo 步骤不与开发实例共用产物目录', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const name of ['typecheck:rust', 'test:rust']) {
      expect(pkg.scripts[name]).toContain('--target-dir .tmp/cargo-gate')
    }
  })

  test('发布必须携带当前版本的更新说明', () => {
    const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim()
    const notes = readFileSync(
      new URL(`../.github/release-notes/v${version}.md`, import.meta.url),
      'utf8',
    )

    expect(notes).toContain('## 本次更新')
    expect(actionText('release-prepare')).toContain('.github/release-notes/v$version.md')
    for (const name of RELEASE_WORKFLOWS) {
      expect(workflowText(name)).toContain('releaseBody: $' + '{{ steps.prepare.outputs.notes }}')
    }
  })

  /** 发布只从 master 出，判定写在共用 action 里，三条工作流不各判一遍。 */
  test('发布来源与更新说明只有共用 action 一处判定', () => {
    const prepare = actionText('release-prepare')

    expect(prepare).toContain('refs/heads/master')
    for (const name of RELEASE_WORKFLOWS) {
      const workflow = workflowText(name)
      expect(workflow).not.toContain('refs/heads/master')
      expect(workflow).not.toContain('release-notes')
    }
  })
})

describe('本地安装包收集', () => {
  test('只删收过的安装包，release 下的编译产物留在原处', async () => {
    const base = mkdtempSync(join(tmpdir(), 'collect-'))
    const target = join(base, 'cargo-target')
    const bundle = join(target, 'release', 'bundle', 'nsis')
    const deps = join(target, 'release', 'deps')
    mkdirSync(bundle, { recursive: true })
    mkdirSync(deps, { recursive: true })
    writeFileSync(join(bundle, 'qywork_9.9.9_x64-setup.exe'), 'setup')
    writeFileSync(join(bundle, 'qywork_9.9.9_x64-setup.exe.sig'), 'signature')
    writeFileSync(join(deps, 'qywork.rlib'), 'rlib')
    const out = join(base, 'installer')

    try {
      expect(await collect(target, out)).toBe(0)

      expect(existsSync(join(out, 'qywork_9.9.9_x64-setup.exe'))).toBe(true)
      expect(readFileSync(join(out, 'qywork_9.9.9_x64-setup.exe.sig'), 'utf8')).toBe('signature')
      expect(readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8')).toContain(
        'qywork_9.9.9_x64-setup.exe',
      )
      expect(existsSync(join(bundle, 'qywork_9.9.9_x64-setup.exe'))).toBe(false)
      // 冷编译三分钟就是从这里来的：往上溯到 release/ 会把它一起删掉。
      expect(existsSync(join(deps, 'qywork.rlib'))).toBe(true)
      expect(existsSync(join(target, 'release'))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('没有安装包时以 1 退出，不建输出目录', async () => {
    const base = mkdtempSync(join(tmpdir(), 'collect-empty-'))
    const out = join(base, 'installer')
    try {
      expect(await collect(join(base, 'cargo-target'), out)).toBe(1)
      expect(existsSync(out)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
