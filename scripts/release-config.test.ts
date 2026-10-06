/**
 * 发布链路的回归测试。覆盖范围：`apps/desktop/src-tauri/tauri.conf.json`、`.github/` 下的
 * 工作流与两个共用 composite action、`package.json` 的门禁与资产入口，以及
 * `scripts/collect-installer.ts` 的收集与清理。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { findPython } from '@qywork/runtime'
import { probeBash } from '../packages/tools/src/sandbox.ts'
import { collect } from './collect-installer.ts'

const ROOT = join(import.meta.dir, '..')

/** 三条发行工作流。每新增一个打包平台即增加一行，下方的结构断言随即覆盖该平台。 */
const RELEASE_WORKFLOWS = ['release-windows.yml', 'release-macos.yml', 'release-linux.yml']

function workflowText(name: string): string {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
}

function actionText(name: string): string {
  return readFileSync(new URL(`../.github/actions/${name}/action.yml`, import.meta.url), 'utf8')
}

describe('桌面发布清单', () => {
  test('Office 门禁解释器导出宿主原生路径，可由 Bun 直接启动', () => {
    const setup = Bun.YAML.parse(actionText('setup-build')) as {
      runs: { steps: { name: string; run?: string }[] }
    }
    const script = setup.runs.steps.find((step) => step.name === 'Prepare Office worker Python')!
      .run!
    const exportAt = script.indexOf('PY="$("$PY" -c')
    expect(exportAt).toBeGreaterThan(-1)
    const python = process.env.QYWORK_TEST_PYTHON || findPython({ providers: {} })
    expect(python).not.toBeNull()
    const bash = probeBash().path
    expect(bash).not.toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'release-python-'))
    try {
      const result = Bun.spawnSync(
        [
          bash!,
          '-c',
          `${process.platform === 'win32' ? 'PY="$(cygpath -u "$PY")"\n' : ''}${script.slice(exportAt)}`,
        ],
        { cwd: dir, env: { ...process.env, PY: python!, GITHUB_ENV: 'github-env' } },
      )
      expect(result.exitCode).toBe(0)
      const exported = readFileSync(join(dir, 'github-env'), 'utf8').trim()
      expect(exported).toStartWith('QYWORK_TEST_PYTHON=')
      const executable = exported.slice('QYWORK_TEST_PYTHON='.length)
      expect(isAbsolute(executable)).toBe(true)
      expect(existsSync(executable)).toBe(true)
      expect(Bun.spawnSync([executable, '-c', 'print("ready")']).stdout.toString().trim()).toBe(
        'ready',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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

  /**
   * 文件预览的 PDF 以 blob URL 载入 iframe（`FileView` 的 `PdfFrame`）。CSP 只在打包版生效，
   * `tauri dev` 的页面由 vite 提供、不带该 CSP，遗漏该项时只有打包版显示为空白。
   */
  test('打包版 CSP 放行 blob 地址的 iframe', () => {
    const config = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    )
    expect(config.app.security.csp['frame-src'].split(/\s+/)).toContain('blob:')
  })

  test('正式更新必须打包签名并上传清单', () => {
    const prepare = actionText('release-prepare')
    const config = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    )
    // 常规构建不生成更新产物，只有发行工作流临时覆盖该项。
    expect(config.bundle.createUpdaterArtifacts).toBe(false)
    expect(prepare).toContain('"createUpdaterArtifacts":true')

    for (const name of RELEASE_WORKFLOWS) {
      const workflow = workflowText(name)
      expect(workflow).toContain('includeUpdaterJson: true')
      expect(workflow).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY')
      expect(workflow).toContain('vars.QYWORK_UPDATER_PUBLIC_KEY')
      expect(workflow).toContain('--config ../../.tmp/updater-config.json')
      // 缺少签名密钥时必须在门禁与编译之前停止，而不是执行一小时后再停止。
      expect(workflow.indexOf('uses: ./.github/actions/release-prepare')).toBeGreaterThan(-1)
      expect(workflow.indexOf('uses: ./.github/actions/release-prepare')).toBeLessThan(
        workflow.indexOf('run: bun run gate'),
      )
    }
  })

  /**
   * 三条发行工作流向同一个 tag 的草稿 Release 上传。校验和文件同名时，后一条的
   * `gh release upload --clobber` 会覆盖前一条上传的文件，而两条工作流均显示成功。
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
      // 不含平台的文件名三条工作流都会写入，最后一次 upload 会覆盖前两次。
      expect(workflow).not.toContain('SHA256SUMS.txt')
      for (const other of Object.values(prefixes)) {
        if (other !== prefix) expect(workflow).not.toContain(other)
      }
    }
  })

  /**
   * macOS 的 Apple 签名与公证需要账号，缺少时仍然生成安装包，但产物必须标明未签名，
   * 否则用户按可直接安装的预期安装时，会被 Gatekeeper 拦截。
   */
  test('缺少 Apple 证书时生成未签名包并在校验和文件名中标明', () => {
    const workflow = workflowText('release-macos.yml')

    expect(workflow).toContain('secrets.APPLE_CERTIFICATE')
    expect(workflow).toContain('secrets.APPLE_ID')
    expect(workflow).toContain('secrets.APPLE_TEAM_ID')
    expect(workflow).toContain('suffix=-unsigned')
    expect(workflow).toContain('steps.apple.outputs.suffix')
    expect(workflow).toContain('::warning')
    expect(workflow).not.toContain('continue-on-error')
  })

  test('Apple 签名配置完整时才传给打包器，空值与缺项不导入证书', () => {
    const workflow = Bun.YAML.parse(workflowText('release-macos.yml')) as {
      jobs: { release: { steps: { id?: string; run?: string; env?: Record<string, string> }[] } }
    }
    const steps = workflow.jobs.release.steps
    const apple = steps.find((step) => step.id === 'apple')!
    const tauri = steps.find((step) => step.id === 'tauri')!
    const credentials = {
      APPLE_CERTIFICATE: 'test-certificate',
      APPLE_CERTIFICATE_PASSWORD: '',
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test',
      APPLE_ID: 'test@example.invalid',
      APPLE_PASSWORD: 'test-app-password',
      APPLE_TEAM_ID: 'TESTTEAM',
    }
    expect(Object.keys(tauri.env ?? {}).filter((key) => key.startsWith('APPLE_'))).toEqual([])
    const bash = probeBash().path
    expect(bash).not.toBeNull()
    for (const mode of ['empty', 'partial', 'complete']) {
      const dir = mkdtempSync(join(tmpdir(), 'release-apple-'))
      try {
        const values = Object.fromEntries(
          Object.entries(credentials).map(([key, value]) => [
            key,
            mode === 'empty' || (mode === 'partial' && key === 'APPLE_PASSWORD') ? '' : value,
          ]),
        )
        const result = Bun.spawnSync([bash!, '-c', apple.run!], {
          cwd: dir,
          env: {
            ...process.env,
            ...values,
            GITHUB_ENV: 'github-env',
            GITHUB_OUTPUT: 'github-output',
          },
        })
        expect(result.exitCode).toBe(0)
        const environment = existsSync(join(dir, 'github-env'))
          ? readFileSync(join(dir, 'github-env'), 'utf8')
          : ''
        const output = readFileSync(join(dir, 'github-output'), 'utf8').trim()
        if (mode === 'complete') {
          expect(output).toBe('suffix=')
          for (const [key, value] of Object.entries(credentials)) {
            expect(apple.env?.[key]).toBe('$' + `{{ secrets.${key} }}`)
            expect(environment.split('\n')).toContain(`${key}=${value}`)
          }
        } else {
          expect(output).toBe('suffix=-unsigned')
          expect(environment).toBe('')
        }
        expect(result.stdout.toString()).not.toContain('test-certificate')
        expect(result.stdout.toString()).not.toContain('test-app-password')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
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
      // Office 执行程序：worker、依赖清单与三份操作指南；单元测试目录不进入安装包。
      '../../../packages/runtime/office/*.py': 'office/',
      '../../../packages/runtime/office/requirements.txt': 'office/requirements.txt',
      '../../../packages/runtime/office/guides/*.md': 'office/guides/',
    })
  })

  /**
   * 全新的 runner 上没有这些外部二进制，而 `bun run gate` 中的 `cargo check` 会运行 tauri 的
   * 构建脚本：`tauri.conf.json` 的 `externalBin` 声明的文件不存在时以 101 退出。
   *
   * 两个条目的来源不同：`bin/qy` 由共用 action 在门禁前编译，顺序在该 action 中判定；
   * `bin/qy-computer-host` 由外壳自身的构建脚本在同一次编译中产出，工作流中再编译一次
   * 即构成第二个入口，外壳旁的 worker 因此可能来自另一次编译。
   */
  test('externalBin 的每个条目只由一处准备', () => {
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
   * Linux 上 tauri 链接系统的 WebKitGTK，runner 镜像不预装。缺少任何一个依赖时都不表现为链接错误，
   * 而是对应 `*-sys` 的 build script 以 101 退出，报 pkg-config 未找到该库。
   */
  test('setup-build 在 Linux runner 上安装 tauri 的全部系统依赖', () => {
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
   * Linux 上电脑控制经会话总线激活 `org.a11y.Bus`，提供它的是 at-spi2-core（总线启动器与
   * `org.a11y.Bus.service`）。WebKitGTK 的依赖链只包含 `libatspi2.0-0t64`，后者对 at-spi2-core
   * 只是 Recommends：不安装推荐包时 worker 报告 `accessibility_bus` 缺失，电脑控制不可用。
   * worker 与外壳的 X11、D-Bus 客户端是纯 Rust，只链接 libc 与 libgcc_s，不另需系统库。
   */
  test('deb 声明 at-spi2-core 为运行依赖', () => {
    const config = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { bundle: { linux?: { deb?: { depends?: string[] } } } }

    expect(config.bundle.linux?.deb?.depends).toEqual(['at-spi2-core'])
  })

  /**
   * Wayland 下原生窗口的采图与前台键盘与指针输入经由 `org.freedesktop.portal.Desktop`，由 xdg-desktop-portal
   * 提供；worker 在运行时 dlopen `libpipewire-0.3.so.0`，dpkg-shlibdeps 无法检测到该依赖。
   * 缺少时只有 Wayland 下的这两项不可用，X11 与语义路径不受影响，因此声明为 Recommends 而不是 Depends。
   * resolute 的库包是 `libpipewire-0.3-0t64`，Provides `libpipewire-0.3-0`；写成二选一，包名
   * 不带 t64 的发行版按后一项解析。
   *
   * 不推荐 portal 后端（`xdg-desktop-portal-gnome | xdg-desktop-portal-kde`）：GNOME 与 KDE 桌面
   * 自带各自的后端；其他桌面上 apt 按缺省设置安装推荐包时会安装第一项，连同 gnome-shell、nautilus 共
   * 579 个包（2026-09-26，resolute，以空 dpkg 状态模拟）。
   */
  test('deb 推荐 Wayland 采图与输入所需的 portal 与 libpipewire', () => {
    const config = JSON.parse(
      readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { bundle: { linux?: { deb?: { recommends?: string[] } } } }

    expect(config.bundle.linux?.deb?.recommends).toEqual([
      'libpipewire-0.3-0t64 | libpipewire-0.3-0',
      'xdg-desktop-portal',
    ])
  })

  /**
   * linuxdeploy 为 AppDir 中的每个 ELF 添加 RUNPATH。经其自带的 patchelf 修改后，bun 单文件程序 `qy`
   * 启动即段错误，打包也在 gtk 插件对其调用 ldd 时中止；经系统的 patchelf 修改后可正常运行。
   * `PATCHELF` 指向 setup-build 用 apt 安装的版本。
   */
  test('Linux 打包时 linuxdeploy 使用 apt 安装的 patchelf', () => {
    const workflow = Bun.YAML.parse(workflowText('release-linux.yml')) as {
      jobs: { release: { steps: { id?: string; env?: Record<string, string> }[] } }
    }
    const setup = Bun.YAML.parse(actionText('setup-build')) as {
      runs: { steps: { name: string; run?: string }[] }
    }
    const tauri = workflow.jobs.release.steps.find((step) => step.id === 'tauri')
    const apt = setup.runs.steps.find((step) => step.name === 'Install Linux system libraries')

    expect(tauri?.env?.PATCHELF).toBe('/usr/bin/patchelf')
    expect(apt?.run?.split(/\s+/)).toContain('patchelf')
  })

  /**
   * CI 不得持有写权限，也不得跳过部分门禁：它是提交与 PR 的唯一自动证据，
   * 降低任何一项即失去证据作用。
   */
  test('CI 只读、只响应分支 push、运行全量门禁、按分支取消较早的运行', () => {
    const workflow = workflowText('ci.yml')

    expect(workflow).toContain('contents: read')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).toContain('branches:\n      - "**"')
    expect(workflow).toContain('run: bun run gate')
    expect(workflow).toContain('run: bun run build:web')
    expect(workflow).not.toContain('continue-on-error')
    expect(workflow).toContain('cancel-in-progress: true')
    // 与发布工作流的 group 重名时，一次 push 会取消正在生成安装包的发布。
    for (const group of ['windows-release', 'macos-release', 'linux-release']) {
      expect(workflow).not.toContain(`group: ${group}`)
    }
  })

  /**
   * 桌面安装包覆盖三个平台，而 gate 中的 cargo check 按运行平台选择分支、两个 externalBin 按运行
   * 平台的三元组编译。缺少任一平台时，该平台的编译错误要到发布当天才暴露。
   */
  test('CI 三端都运行门禁', () => {
    const workflow = workflowText('ci.yml')

    for (const runner of ['windows-latest', 'macos-latest', 'ubuntu-latest']) {
      expect(workflow).toContain(runner)
    }
    expect(workflow).toContain('runs-on: $' + '{{ matrix.os }}')
  })

  /**
   * worker 是独立 crate：src-tauri 的 `cargo check` 不覆盖它，Bun 测试也不执行它的 Rust
   * 单元测试。不在 gate 中显式列出时，它的编译错误和失败测试不会使任何一条流水线失败。
   *
   * 两个 Cargo.lock 都受版本跟踪，因此每条 cargo 命令都必须带 `--locked`：不带该参数的命令会在
   * 清单版本已修改、lock 尚未写回时改写该受跟踪文件，而门禁只读。
   */
  test('门禁的每条 cargo 命令都指定 manifest 并带 --locked', () => {
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
   * `.cargo/config.toml` 指定的目录运行该文件，Windows 上文件被占用，删除时报拒绝访问、
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

  /** 发布只从 master 进行，判定写在共用 action 中，三条工作流不各自重复判定。 */
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
  test('只删除已收集的安装包，release 下的编译产物保留在原处', async () => {
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
      // 清理范围向上扩展到 release/ 时会一并删除编译产物，下次构建需要约三分钟的冷编译。
      expect(existsSync(join(deps, 'qywork.rlib'))).toBe(true)
      expect(existsSync(join(target, 'release'))).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('没有安装包时以 1 退出，不创建输出目录', async () => {
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
