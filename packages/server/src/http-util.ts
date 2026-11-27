/**
 * HTTP 杂项：CORS、静态托管、主机名、git 状态广播。
 *
 * 这些内容不属于任何一条业务链路，放在主文件中会被误读为业务代码。
 *
 * **令牌校验不在这里**：它属于 `pairing.ts` 的 `Pairing.verify()`，那是唯一入口。
 */

import { hostname } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'
import type { EventBus } from './bus.ts'
import * as git from './git.ts'

export async function publishGitState(
  root: string,
  workspaceId: string,
  bus: EventBus,
  config: QyConfig,
): Promise<void> {
  const branch = await git.currentBranch(root, config)
  if (branch) bus.publish({ type: 'git.state', workspaceId, branch })
}

/**
 * 跨源响应头。
 *
 * 桌面端的页面与本服务**始终不同源**：`tauri dev` 时页面来自 vite 的
 * `localhost:5180`，安装版来自 `tauri.localhost` 的 asset 协议，而 API 始终位于
 * `127.0.0.1:<外壳分配的端口>`。鉴权使用 Authorization 头，属于「非简单请求」，
 * 浏览器要先发送一个**不带任何自定义头**的 OPTIONS 预检。
 *
 * 缺少这些响应头时，WebSocket 不受同源策略约束，仍能握手成功并显示「已连接」；
 * 而所有 REST 请求都在发出前被预检拦截，工作区名、会话列表与设置面板同时无法加载，
 * 原因相同。
 *
 * 使用 `*` 而不是回显 Origin：这里从不使用 cookie，凭证是 Authorization 中的令牌。
 * 无法取得令牌的页面即使被允许发送请求也只会收到 401，回显 Origin 需要另外维护一份
 * 允许列表，而该列表不带来任何额外保护。
 */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  /*
   * 附件上传带 `x-attachment-name`（文件名可能含中文与空格，只能编码后放入请求头）。
   * **它不在 CORS 安全列表内，遗漏该头名会使整条上传链路全部失败**：
   * 预检不通过，实际的 POST 不会发出，前端收到的只是
   * `TypeError: Failed to fetch`，不带任何状态码，无法判断是否由浏览器拦截。
   *
   * 不要改为 `*`：它在带凭证的请求中不生效，且会使「该接口接受哪些请求头」
   * 无法从代码中判断。
   */
  'access-control-allow-headers': 'authorization, content-type, x-attachment-name',
  'access-control-max-age': '86400',
}

/**
 * 内存中的字节按请求的 Range 答复：单段的 `bytes=a-b`、`bytes=a-`、`bytes=-n` 答复 206，起点越界答复 416，
 * 其余写法答复完整内容。Bun 只对文件正文自行处理 Range；媒体以 200 答复时 Chromium 不允许定位，设置 `currentTime` 后回到 0。
 */
export function bytesResponse(
  req: Request,
  bytes: Uint8Array,
  headers: Record<string, string>,
): Response {
  const all = { ...headers, 'accept-ranges': 'bytes' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
  if (!m || (!m[1] && !m[2])) return new Response(bytes, { headers: all })
  const size = bytes.length
  const from = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
  const to = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (from >= size || from > to) {
    return new Response(null, {
      status: 416,
      headers: { ...all, 'content-range': `bytes */${size}` },
    })
  }
  return new Response(bytes.subarray(from, to + 1), {
    status: 206,
    headers: { ...all, 'content-range': `bytes ${from}-${to}/${size}` },
  })
}

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
  return res
}

/**
 * 网页构建产物的来源：按相对路径（`index.html`、`assets/x.js`）取得文件，不存在时返回 null。
 * 返回的文件必须带 MIME 类型：模块脚本的响应缺少 Content-Type 时，浏览器拒绝执行。
 */
export type WebAssets = (rel: string) => Promise<Blob | null>

/** 磁盘目录中的构建产物（`qy serve --static <目录>`）。类型由 `Bun.file` 按扩展名推断。 */
export function directoryAssets(dir: string): WebAssets {
  return async (rel) => {
    const file = Bun.file(join(dir, rel))
    return (await file.exists()) ? file : null
  }
}

/**
 * 随 sidecar 脚本分发的构建产物，键为相对路径，值为文件的绝对路径。
 *
 * 类型按键的扩展名显式给出：`Bun.file(rel).type` 只依据扩展名，文件不必存在。
 */
export function embeddedAssets(files: Readonly<Record<string, string>>): WebAssets {
  return async (rel) => {
    const path = files[rel]
    return path ? Bun.file(path, { type: Bun.file(rel).type }) : null
  }
}

/**
 * 网页的来源：按请求的地址返回页面或资源，不处理时返回 null。每个进程只有一种来源，由启动参数决定：
 * 嵌入的网页或 `--static` 目录。
 */
export type WebSource = (url: URL) => Promise<Response | null>

/** 构建产物：按路径取文件，未知路径回退到 `index.html`，`assets/` 下的未知文件返回 404。 */
export function fileSource(web: WebAssets): WebSource {
  return (url) => serveStatic(web, url.pathname)
}

export async function serveStatic(web: WebAssets, pathname: string): Promise<Response | null> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  // 拦截路径穿越：`GET /../../etc/passwd` 不能生效。
  if (rel.includes('..')) return null
  const file = await web(rel)
  if (file) return new Response(file)
  /*
   * `assets/` 下是带内容哈希的构建产物，缺失时返回 404，不要回退到 index.html：
   * 云端界面缓存与浏览器按文件名长期缓存 200 响应，回退的 HTML 会以该文件名留存，
   * 此后每次加载该模块都因类型不符而失败，重新加载页面也无法恢复。
   */
  if (rel.startsWith('assets/')) return new Response('文件不存在', { status: 404 })
  // SPA 回退：其余未知路径返回 index.html。
  const index = await web('index.html')
  return index ? new Response(index) : null
}

/**
 * 本机名称，用于云端的电脑列表与配对握手。
 * 不要改为读取 `COMPUTERNAME` / `HOSTNAME` 环境变量：`HOSTNAME` 是 shell 变量且不导出，
 * macOS 与 Linux 上从图形界面启动的进程中没有它。
 */
export function hostLabel(): string {
  return hostname() || 'QyWork'
}
