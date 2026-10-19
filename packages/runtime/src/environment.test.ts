/**
 * 覆盖 `environment.ts`：运行环境一节的内容，与工作区 Python 环境的创建。
 *
 * 原始失败形状：模型按 `import faster_whisper` 与 `ffmpeg -version` 失败断定没有能力，而 faster-whisper
 * 已由此前的会话装在 `.tmp/asr`、ffmpeg 由 imageio-ffmpeg 提供；同一个包在三个目录各装一次，
 * 同一个模型下载四次。说明中必须出现这些已有的包、ffmpeg 路径与模型位置。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from './config.ts'
import { describeEnvironment, ensureWorkspacePython } from './environment.ts'
import { findPython } from './office.ts'

const WIN = process.platform === 'win32'
const saved = {
  PATH: process.env.PATH,
  HF_HUB_CACHE: process.env.HF_HUB_CACHE,
  APPDATA: process.env.APPDATA,
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** 在 `dir` 中放一个 dist-info 目录；`requested` 为真时带 REQUESTED 标记。 */
async function distInfo(dir: string, name: string, requested: boolean) {
  await mkdir(join(dir, `${name}.dist-info`), { recursive: true })
  if (requested) await writeFile(join(dir, `${name}.dist-info`, 'REQUESTED'), '')
}

/** 假的基础解释器与工作区：基础解释器装了 numpy（主动）、six（依赖）与 imageio-ffmpeg 自带的 ffmpeg。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qy-env-'))
  const prefix = join(root, 'py')
  const site = WIN
    ? join(prefix, 'Lib', 'site-packages')
    : join(prefix, 'lib', 'python3.12', 'site-packages')
  await distInfo(site, 'numpy-2.1.0', true)
  await distInfo(site, 'six-1.16.0', false)
  await mkdir(join(site, 'imageio_ffmpeg', 'binaries'), { recursive: true })
  await writeFile(join(site, 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v7.1.exe'), '')
  await writeFile(join(site, 'imageio_ffmpeg', 'binaries', 'README.md'), '')
  const bin = WIN ? prefix : join(prefix, 'bin')
  await mkdir(bin, { recursive: true })
  const python = join(bin, WIN ? 'python.exe' : 'python3')
  await writeFile(python, '')

  const ws = join(root, 'ws')
  const tmp = join(ws, '.tmp')
  await distInfo(join(tmp, 'asr'), 'faster_whisper-1.2.1', true)
  await distInfo(join(tmp, 'asr'), 'ctranslate2-4.8.2', false)
  await mkdir(join(tmp, 'asr-models', 'models--Systran--faster-whisper-base'), { recursive: true })
  await mkdir(join(tmp, 'asr-models', '.locks', 'models--Systran--faster-whisper-base'), {
    recursive: true,
  })
  await mkdir(join(tmp, 'asr-cache', 'hub', 'models--Systran--faster-whisper-small'), {
    recursive: true,
  })
  await mkdir(join(tmp, 'models', 'whisper', 'models--Systran--faster-whisper-small'), {
    recursive: true,
  })
  const hub = join(root, 'hf-hub')
  await mkdir(join(hub, 'models--Systran--faster-whisper-medium'), { recursive: true })

  process.env.PATH = join(root, 'empty-bin')
  process.env.HF_HUB_CACHE = hub
  process.env.APPDATA = join(root, 'appdata')
  return { root, prefix, python, ws, hub }
}

describe('运行环境', () => {
  test('列出主动安装的包、工作区其他目录中的包、imageio-ffmpeg 自带的 ffmpeg 与各处已下载的模型', async () => {
    const f = await fixture()
    await mkdir(join(f.ws, '.tmp', 'python'), { recursive: true })
    await writeFile(
      join(f.ws, '.tmp', 'python', 'pyvenv.cfg'),
      `home = ${WIN ? f.prefix : join(f.prefix, 'bin')}\ninclude-system-site-packages = true\nversion_info = 3.12.10\n`,
    )
    const venvSite = WIN
      ? join(f.ws, '.tmp', 'python', 'Lib', 'site-packages')
      : join(f.ws, '.tmp', 'python', 'lib', 'python3.12', 'site-packages')
    await distInfo(venvSite, 'pyjokes-0.8.3', true)

    const text = await describeEnvironment(f.ws, f.python, null)
    const lines = text.split('\n')
    expect(lines[0]).toBe('## 运行环境（本轮开始时读取本机目录）')
    expect(lines[1]).toStartWith('- Python 3.12.10：命令中的 python 为工作区环境 .tmp/python')
    expect(lines[1]).toContain('安装包优先用 python -m pip install <包>')
    expect(text).toContain('- 已安装的包（主动安装的 1 个，不含依赖）：numpy\n')
    expect(text).toContain('- 工作区环境中的包：pyjokes\n')
    expect(text).toContain(
      '- 工作区其他目录中的包（不在导入路径上，需加入 PYTHONPATH）：.tmp/asr：faster_whisper\n',
    )
    expect(text).toContain('imageio-ffmpeg 提供')
    expect(text).toContain('ffmpeg-win-x86_64-v7.1.exe，直接以该路径调用。')
    expect(text).toContain('Systran/faster-whisper-base（.tmp/asr-models）')
    expect(text).toContain('Systran/faster-whisper-small（.tmp/asr-cache、.tmp/models/whisper）')
    expect(text).toContain(`Systran/faster-whisper-medium（${f.hub}）`)
    expect(text).toEndWith('新下载的模型放在 .tmp/models 下。')
    expect(text).not.toContain('six')
    expect(text).not.toContain('ctranslate2')
  })

  test('没有 Python 时写明未找到；工作区环境创建失败时写明原因，命令中的 python 为基础解释器', async () => {
    const f = await fixture()
    expect(await describeEnvironment(f.ws, null, null)).toContain('- Python：未找到。')
    const failed = await describeEnvironment(f.ws, f.python, 'Error: [WinError 5] 拒绝访问')
    expect(failed).toContain(
      `- Python：${f.python}。工作区环境 .tmp/python 创建失败（Error: [WinError 5] 拒绝访问），命令中的 python 为该解释器。`,
    )
  })

  const python = findPython({ providers: {} } as unknown as QyConfig)
  test.skipIf(!python)(
    '首次创建工作区 Python 环境并继承基础解释器的包；已存在时不改动；基础解释器目录不存在时原地升级',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'qy-venv-'))
      expect(await ensureWorkspacePython(root, python!)).toBeNull()
      const dir = join(root, '.tmp', 'python')
      const exe = join(dir, WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python')
      const proc = Bun.spawn(
        [
          exe,
          '-c',
          'import sys, site; print(sys.prefix != sys.base_prefix, site.ENABLE_USER_SITE)',
        ],
        { stdout: 'pipe' },
      )
      expect((await new Response(proc.stdout).text()).trim()).toBe('True True')

      const cfg = join(dir, 'pyvenv.cfg')
      const written = await readFile(cfg, 'utf8')
      const mtime = statSync(cfg).mtimeMs
      expect(await ensureWorkspacePython(root, python!)).toBeNull()
      expect(statSync(cfg).mtimeMs).toBe(mtime)

      await writeFile(cfg, written.replace(/^home = .*$/m, `home = ${join(root, '已卸载')}`))
      expect(await ensureWorkspacePython(root, python!)).toBeNull()
      expect(await readFile(cfg, 'utf8')).toContain(written.match(/^home = .*$/m)![0])
    },
  )
})
