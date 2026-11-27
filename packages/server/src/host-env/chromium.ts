/**
 * 运行环境中的「内置浏览器」（macOS 与 Linux）：下载 QyWork 专用的 Chromium，宿主以无头方式运行它，页面在面板中以画面显示。
 *
 * - 版本与各平台压缩包的大小、SHA-256 写在 `BUILDS`，随 QyWork 发版更新。压缩包是 Google 的 Chrome for Testing，
 *   下载自 npmmirror 的镜像（国内可访问）；完整性只由 SHA-256 判定，与镜像是否可信无关。QyWork 不托管这些文件：
 *   未查到 Chrome for Testing 允许第三方再分发的条款。
 * - 安装到全局数据目录的 `browser/chromium/<版本>/`，最后写入 `browser/chromium/installed.json`（`version`、`exe`），
 *   宿主据此查找（`chromium/launch.rs` 的 `dedicated`）。该文件在解压完成后才以改名方式写入：宿主读取到它时目录已完整。
 * - 进度与失败原因只在本进程内存中，运行环境接口据此显示；同一时刻只进行一次安装。
 * - macOS 用系统的 `ditto` 解压（保留 .app 中的符号链接与权限）；Linux 用 `unzip.ts`。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { configDir } from '@qywork/runtime'
import { unzip } from './unzip.ts'

export const CHROMIUM_VERSION = '158.0.8127.88'
const MIRROR = 'https://cdn.npmmirror.com/binaries/chrome-for-testing'

export interface Build {
  /** Chrome for Testing 的平台名，也是压缩包所在的目录。 */
  platform: string
  size: number
  sha256: string
  /** 可执行文件相对版本目录的路径。 */
  exe: string
}

const MAC_EXE = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

/** 按 `process.platform-process.arch` 索引。没有条目的平台不提供安装。 */
const BUILDS: Record<string, Build> = {
  'linux-x64': {
    platform: 'linux64',
    size: 208082347,
    sha256: '59e3b43f8b3aaa292238fbdcfb36a93127debd53e212510dcdc2cc8812b4b57e',
    exe: 'chrome-linux64/chrome',
  },
  'linux-arm64': {
    platform: 'linux-arm64',
    size: 205794810,
    sha256: '91669b5de79af808d498037dd974e4b09461776a1b5240b3bb656abd17e5d3ab',
    exe: 'chrome-linux-arm64/chrome',
  },
  'darwin-arm64': {
    platform: 'mac-arm64',
    size: 200337306,
    sha256: '6caf16b007aafaf6d4a4db252262be8ebbf0d91a2af005257e388996dbe463d6',
    exe: `chrome-mac-arm64/${MAC_EXE}`,
  },
  'darwin-x64': {
    platform: 'mac-x64',
    size: 213548436,
    sha256: '4529a2bdbea10cf69f79b8b0ff43a5a23e8dc8b033da85cbe873afb81855579a',
    exe: `chrome-mac-x64/${MAC_EXE}`,
  },
}

/** 本机平台的构建；没有时不提供安装。 */
export function chromiumBuild(
  platform: string = process.platform,
  arch: string = process.arch,
): Build | null {
  return BUILDS[`${platform}-${arch}`] ?? null
}

function root(): string {
  return join(configDir(), 'browser', 'chromium')
}

/** 已安装的专用 Chromium 的可执行文件；未安装或文件缺失时为 `null`。 */
export function installedChromium(): string | null {
  try {
    const installed = JSON.parse(readFileSync(join(root(), 'installed.json'), 'utf8')) as {
      exe?: unknown
    }
    return typeof installed.exe === 'string' && existsSync(installed.exe) ? installed.exe : null
  } catch {
    return null
  }
}

/** 安装的当前状态：进行中时为进度（0–1），失败时为原因，其余为 `null`。 */
let state: { progress: number } | { failed: string } | null = null

export function chromiumInstallState(): typeof state {
  return state
}

/**
 * 开始安装，返回安装结束（成功或失败）的 Promise，调用方不必等待；完成后调用 `ready`（请求宿主重新查找浏览器）。
 * 已在进行时不重复开始。本平台没有构建时抛出。`fetchImpl` 与 `build` 供测试替换。
 */
export function installChromium(
  ready: () => Promise<void>,
  fetchImpl: typeof fetch = fetch,
  build: Build | null = chromiumBuild(),
): Promise<void> {
  if (!build) throw new Error('该平台没有可安装的版本')
  if (state && 'progress' in state) return Promise.resolve()
  state = { progress: 0 }
  return run(build, fetchImpl)
    .then(ready)
    .then(
      () => {
        state = null
      },
      (err: unknown) => {
        state = { failed: err instanceof Error ? err.message : String(err) }
      },
    )
}

async function run(build: Build, fetchImpl: typeof fetch): Promise<void> {
  const dir = root()
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, `${CHROMIUM_VERSION}.zip`)
  const staging = join(dir, `${CHROMIUM_VERSION}.partial`)
  const target = join(dir, CHROMIUM_VERSION)
  rmSync(staging, { recursive: true, force: true })
  try {
    await download(build, zip, fetchImpl)
    if (process.platform === 'darwin') {
      const ditto = Bun.spawn(['ditto', '-x', '-k', zip, staging], { stderr: 'pipe' })
      if ((await ditto.exited) !== 0) {
        throw new Error(`解压失败：${(await new Response(ditto.stderr).text()).trim()}`)
      }
    } else {
      await unzip(zip, staging)
    }
    if (!existsSync(join(staging, build.exe))) throw new Error('压缩包中没有浏览器程序')
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    const manifest = join(dir, 'installed.json.partial')
    writeFileSync(
      manifest,
      JSON.stringify({ version: CHROMIUM_VERSION, exe: join(target, build.exe) }),
    )
    renameSync(manifest, join(dir, 'installed.json'))
    for (const name of readdirSync(dir)) {
      if (name !== CHROMIUM_VERSION && name !== 'installed.json') {
        rmSync(join(dir, name), { recursive: true, force: true })
      }
    }
  } finally {
    rmSync(zip, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

/** 下载压缩包并核对大小与 SHA-256；不一致时删除并抛出。 */
async function download(build: Build, path: string, fetchImpl: typeof fetch): Promise<void> {
  const name = build.exe.split('/')[0] ?? build.platform
  const url = `${MIRROR}/${CHROMIUM_VERSION}/${build.platform}/${name}.zip`
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
  const hasher = new Bun.CryptoHasher('sha256')
  const writer = Bun.file(path).writer()
  let received = 0
  try {
    for await (const chunk of res.body) {
      hasher.update(chunk)
      writer.write(chunk)
      received += chunk.length
      state = { progress: Math.min(0.99, received / build.size) }
    }
  } finally {
    await writer.end()
  }
  if (received !== build.size || hasher.digest('hex') !== build.sha256) {
    rmSync(path, { force: true })
    throw new Error('下载的文件校验不一致')
  }
}
