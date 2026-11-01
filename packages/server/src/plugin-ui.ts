/**
 * 工作台：已安装插件提供的网页。负责列出已安装的工作台，并提供页面文件。
 *
 * 页面文件直接从已安装的插件目录（`~/.qywork/plugins/<插件 id>/`）读取，不经插件进程，
 * 也不依赖扩展缓存：插件安装后即可打开，不必等扩展重新加载。
 *
 * 地址前缀中带服务端启动时生成的随机段：iframe 无法携带令牌，随机段只经已鉴权的
 * `/api/plugins` 下发；它只用于读取这些页面文件，不授权任何 `/api/`。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { parseManifest } from '@qywork/plugins'
import { globalPluginsDir } from '@qywork/runtime'

export const PLUGIN_UI_PREFIX = '/plugin-ui/'

/** 插件 id 的形状，与清单校验一致。用于拒绝路径中的越界段。 */
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/

export interface Workbench {
  plugin: string
  id: string
  title: string
  /** 页面地址（相对服务端根）。随机段每次启动都不同，界面不要保存它。 */
  path: string
}

/**
 * 已安装的全部工作台，按插件目录名字典序。清单无法解析或入口文件缺失的插件跳过：
 * 它们的失败原因由插件页（`/api/plugins` 的 failures）报告，此处只列出能打开的页面。
 */
export async function listWorkbenches(key: string): Promise<Workbench[]> {
  const root = globalPluginsDir()
  const dirs = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  const out: Workbench[] = []
  for (const name of dirs) {
    const manifestPath = join(root, name, 'qywork.plugin.json')
    let manifest: ReturnType<typeof parseManifest>
    try {
      manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath)
    } catch {
      continue
    }
    // 安装目录即清单 id（`copyPluginDir`）。不一致说明是手动放入的目录，按目录名提供文件。
    if (manifest.id !== name) continue
    for (const panel of manifest.contributes.panels ?? []) {
      if (!(await stat(join(root, name, panel.entry)).catch(() => null))?.isFile()) continue
      out.push({
        plugin: manifest.id,
        id: panel.id,
        title: panel.title,
        path: `${PLUGIN_UI_PREFIX}${key}/${manifest.id}/${panel.entry}`,
      })
    }
  }
  return out
}

/**
 * 提供工作台页面文件：`/plugin-ui/<随机段>/<插件 id>/<路径>`。不属于该前缀时返回 null。
 *
 * 响应带 `access-control-allow-origin: *`：页面在不带 `allow-same-origin` 的沙箱 iframe 中运行，
 * 源是不透明源，模块脚本按跨源方式请求，缺少该头时页面的脚本全部加载失败。
 */
export async function servePluginUi(pathname: string, key: string): Promise<Response | null> {
  if (!pathname.startsWith(PLUGIN_UI_PREFIX)) return null
  const notFound = () => new Response('not found', { status: 404 })
  const [given, plugin, ...rest] = pathname.slice(PLUGIN_UI_PREFIX.length).split('/')
  if (given !== key || !plugin || !PLUGIN_ID.test(plugin) || rest.length === 0) return notFound()
  let segments: string[]
  try {
    segments = rest.map((s) => decodeURIComponent(s))
  } catch {
    return notFound()
  }
  if (segments.some((s) => !s || s === '.' || s === '..' || s.includes('\\'))) return notFound()
  const dir = resolve(globalPluginsDir(), plugin)
  const file = resolve(dir, ...segments)
  if (!file.startsWith(dir + sep)) return notFound()
  if (!(await stat(file).catch(() => null))?.isFile()) return notFound()
  return new Response(Bun.file(file), {
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
  })
}
