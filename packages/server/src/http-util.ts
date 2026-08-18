/**
 * HTTP 杂项：CORS、静态托管、主机名、git 状态广播。
 *
 * 这些都不属于任何一条业务链路，凑在主文件里只会让人以为它们和业务有关。
 *
 * **令牌校验不在这里**——它归 `pairing.ts` 的 `Pairing.verify()`，那里是唯一入口。
 */

import { join } from 'node:path'
import type { EventBus } from './bus.ts'
import * as git from './git.ts'

export async function publishGitState(
  root: string,
  workspaceId: string,
  bus: EventBus,
): Promise<void> {
  const branch = await git.currentBranch(root)
  if (branch) bus.publish({ type: 'git.state', workspaceId, branch })
}

/**
 * 跨源响应头。
 *
 * 桌面端的页面和这个服务**从来就不同源**：`tauri dev` 时页面来自 vite 的
 * `localhost:5180`，装机版来自 `tauri.localhost` 的 asset 协议，而 API 始终在
 * `127.0.0.1:<外壳分配的端口>`。鉴权走 Authorization 头，属于「非简单请求」，
 * 浏览器要先发一个**不带任何自定义头**的 OPTIONS 预检。
 *
 * 这条缺失的表现极具误导性：WebSocket 不受同源策略约束，照常握手成功，
 * 界面上显示「已连接」；而每一条 REST 都被预检挡在发出之前，于是工作区名是
 * 「未连接」、会话列表空、设置面板永远停在「读取配置…」——看起来像四个各自
 * 独立的功能坏了，实际是同一个原因。
 *
 * `*` 而不是回显 Origin：这里从不用 cookie，凭证是 Authorization 里的令牌。
 * 拿不到令牌的页面即使被允许发请求也只收得到 401，回显 Origin 需要多维护一份
 * 允许名单，而那份名单不带来任何额外保护。
 */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
  return res
}

export async function serveStatic(dir: string, pathname: string): Promise<Response | null> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  // 静态目录同样要挡穿越：`GET /../../etc/passwd` 不能生效。
  if (rel.includes('..')) return null
  const file = Bun.file(join(dir, rel))
  if (await file.exists()) return new Response(file)
  // SPA 回退：未知路径交给前端路由（/m 是移动端入口）。
  const index = Bun.file(join(dir, 'index.html'))
  if (await index.exists()) return new Response(index)
  return null
}

export function hostLabel(): string {
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'qywork'
}
