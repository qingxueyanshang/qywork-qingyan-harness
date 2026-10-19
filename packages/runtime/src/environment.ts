/**
 * 运行环境说明：本机 Python、已安装的包、ffmpeg、工作区中的包目录与已下载的模型。每轮开始前读取目录生成，
 * 写入运行上下文。只读取目录，不启动进程；唯一的例外是工作区 Python 环境缺失时创建它（`ensureWorkspacePython`）。
 *
 * 包名取自 `*.dist-info` 目录，只列出带 `REQUESTED` 标记的包（主动安装，不含作为依赖装入的包）。
 * 模型取自 Hugging Face 缓存的 `models--组织--名称` 目录。
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { displayPath, workspacePythonBin, workspacePythonDir } from '@qywork/tools'

/** 列出的包目录与模型的上限：超出部分只写数量，避免运行上下文随工作区的历史产物增长。 */
const MAX_DIRS = 20
const MAX_MODELS = 20

/** 读取目录项；目录不存在或无权读取时为空。 */
async function entries(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[])
}

/** `pyvenv.cfg` 的键值。 */
async function venvConfig(dir: string): Promise<Record<string, string> | null> {
  const text = await readFile(join(dir, 'pyvenv.cfg'), 'utf8').catch(() => null)
  if (text === null) return null
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

/**
 * 确保工作区 Python 环境存在，基于 `python` 创建，继承其全部包（`--system-site-packages`），不另装 pip
 * （`python -m pip` 使用基础解释器的 pip，装入本环境）。环境的基础解释器目录已不存在时原地升级。
 * 返回失败原因；成功或无需处理时为 null。
 */
export async function ensureWorkspacePython(
  workspaceRoot: string,
  python: string,
): Promise<string | null> {
  const dir = workspacePythonDir(workspaceRoot)
  const cfg = await venvConfig(dir)
  if (cfg?.home && existsSync(cfg.home)) return null
  const proc = Bun.spawn(
    [
      python,
      '-m',
      'venv',
      '--system-site-packages',
      '--without-pip',
      ...(cfg ? ['--upgrade'] : []),
      dir,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return code === 0 ? null : err.trim().split(/\r?\n/).at(-1) || `退出码 ${code}`
}

/** `*.dist-info` 目录中主动安装的包名。 */
async function requestedIn(dir: string): Promise<string[]> {
  const names: string[] = []
  for (const name of await entries(dir)) {
    const m = /^(.+?)-\d[^-]*\.dist-info$/.exec(name)
    if (m && existsSync(join(dir, name, 'REQUESTED'))) names.push(m[1]!)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

/** 解释器前缀下的 site-packages：Windows 为 `Lib/site-packages`，其他平台为 `lib/python3.X/site-packages`。 */
function sitePackages(prefix: string, version: string | undefined): string {
  if (process.platform === 'win32') return join(prefix, 'Lib', 'site-packages')
  const short = version?.split('.').slice(0, 2).join('.') ?? '3'
  return join(prefix, 'lib', `python${short}`, 'site-packages')
}

/** 用户目录中的 site-packages（`pip install --user` 的位置）。 */
function userSitePackages(version: string | undefined): string | null {
  const [major, minor] = version?.split('.') ?? []
  if (!major || !minor) return null
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData ? join(appData, 'Python', `Python${major}${minor}`, 'site-packages') : null
  }
  return join(homedir(), '.local', 'lib', `python${major}.${minor}`, 'site-packages')
}

/** imageio-ffmpeg 自带的 ffmpeg 可执行文件。 */
async function bundledFfmpeg(sites: string[]): Promise<string | null> {
  for (const site of sites) {
    const dir = join(site, 'imageio_ffmpeg', 'binaries')
    const exe = (await entries(dir)).find((n) => /^ffmpeg/i.test(n) && !/\.md$/i.test(n))
    if (exe) return join(dir, exe)
  }
  return null
}

/** Hugging Face 缓存目录中的模型，`组织/名称` → 所在的缓存目录。 */
async function hubModels(dir: string, into: Map<string, string[]>, label: string): Promise<void> {
  for (const name of await entries(dir)) {
    const m = /^models--(.+?)--(.+)$/.exec(name)
    if (!m) continue
    const repo = `${m[1]}/${m[2]}`
    into.set(repo, [...(into.get(repo) ?? []), label])
  }
}

function capped(items: string[], max: number): string {
  return items.length > max
    ? `${items.slice(0, max).join('；')}；另有 ${items.length - max} 项`
    : items.join('；')
}

/**
 * 运行上下文中的「运行环境」一节。`python` 为基础解释器（office 的 `findPython`），未找到时为 null；
 * `venvError` 为创建工作区 Python 环境的失败原因。
 */
export async function describeEnvironment(
  workspaceRoot: string,
  python: string | null,
  venvError: string | null,
): Promise<string> {
  const lines: string[] = ['## 运行环境（本轮开始时读取本机目录）']
  const shown = (p: string) => displayPath(workspaceRoot, p)
  const tmp = join(workspaceRoot, '.tmp')
  const venvDir = workspacePythonDir(workspaceRoot)
  const venv = python && !venvError ? await venvConfig(venvDir) : null
  const version = venv?.version_info ?? venv?.version
  const sites: string[] = []

  if (!python) {
    lines.push('- Python：未找到。')
  } else {
    const prefix = venv?.home ?? dirname(python)
    const base = sitePackages(existsSync(join(prefix, 'Lib')) ? prefix : dirname(prefix), version)
    const user = userSitePackages(version)
    const venvSite = sitePackages(venvDir, version)
    sites.push(...(venv ? [venvSite] : []), base, ...(user ? [user] : []))
    lines.push(
      venv
        ? `- Python ${version ?? ''}：命令中的 python 为工作区环境 ${shown(venvDir)}，继承 ${prefix} 的全部包。` +
            `安装包优先用 python -m pip install <包>：装入该环境，之后的命令与会话可直接导入；` +
            `命令行工具装在 ${shown(workspacePythonBin(workspaceRoot))}，已在 PATH 最前。`
        : `- Python：${python}。工作区环境 ${shown(venvDir)} 创建失败（${venvError ?? '未知原因'}），命令中的 python 为该解释器。`,
    )
    const global = [
      ...new Set([...(await requestedIn(base)), ...(user ? await requestedIn(user) : [])]),
    ]
    if (global.length)
      lines.push(`- 已安装的包（主动安装的 ${global.length} 个，不含依赖）：${global.join('、')}`)
    if (venv) {
      const own = await requestedIn(venvSite)
      if (own.length) lines.push(`- 工作区环境中的包：${own.join('、')}`)
    }
  }

  // 工作区中以 --target 装入的包目录：不在导入路径上，加入 PYTHONPATH 后可导入。
  const children = (await entries(tmp)).filter((n) => !n.startsWith('.') && n !== 'python')
  const targets: string[] = []
  const models = new Map<string, string[]>()
  for (const name of children) {
    const dir = join(tmp, name)
    const inner = await entries(dir)
    if (inner.some((n) => n.endsWith('.dist-info'))) {
      const pkgs = await requestedIn(dir)
      if (pkgs.length) targets.push(`${shown(dir)}：${pkgs.join('、')}`)
      sites.push(dir)
    }
    await hubModels(dir, models, shown(dir))
    if (inner.includes('hub')) await hubModels(join(dir, 'hub'), models, shown(dir))
    if (name === 'models') {
      for (const sub of inner) {
        const subDir = join(dir, sub)
        await hubModels(subDir, models, shown(subDir))
        await hubModels(join(subDir, 'hub'), models, shown(subDir))
      }
    }
  }
  if (targets.length)
    lines.push(
      `- 工作区其他目录中的包（不在导入路径上，需加入 PYTHONPATH）：${capped(targets, MAX_DIRS)}`,
    )

  const onPath = Bun.which('ffmpeg')
  const bundled = onPath ? null : await bundledFfmpeg(sites)
  lines.push(
    onPath
      ? `- ffmpeg：${onPath}`
      : bundled
        ? `- ffmpeg：不在 PATH 中；imageio-ffmpeg 提供 ${shown(bundled)}，直接以该路径调用。`
        : '- ffmpeg：未找到。',
  )

  const hfHome = process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface')
  const globalHub = process.env.HF_HUB_CACHE ?? join(hfHome, 'hub')
  await hubModels(globalHub, models, globalHub)
  const listed = [...models].map(([repo, at]) => `${repo}（${at.join('、')}）`)
  lines.push(
    `- 已下载的模型：${listed.length ? capped(listed, MAX_MODELS) : '无'}。新下载的模型放在 ${shown(join(tmp, 'models'))} 下。`,
  )
  return lines.join('\n')
}
