/**
 * Agent Team 配置读写。
 *
 * 界面直接读写同一个 .qy/team.json，配置来源只有一个，界面只是它的编辑器。
 * 来源分叉的风险来自界面另存一份配置，而不是来自提供编辑界面。
 *
 * 与「禁止写 .qy/」不冲突：该边界由文件工具执行（`tools/src/paths.ts` 的 `PROTECTED_DIRS`），
 * 约束的是 agent 修改自身配置，不约束用户经界面的显式操作。见 docs/permissions.md。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ApiHandler, json } from './types.ts'

export const handleTeamApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/team/raw') {
    const file = join(d.workspaceRoot, '.qy', 'team.json')
    if (req.method === 'GET') {
      const raw = await readFile(file, 'utf8').catch(() => null)
      return json({ path: file, exists: raw !== null, raw: raw ?? '' })
    }
    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => null)) as { raw?: string } | null
      if (typeof body?.raw !== 'string') return json({ error: 'bad request' }, 400)
      // 先解析再落盘：写入损坏的 JSON 后，下次编排会在完全无关的位置失败。
      try {
        JSON.parse(body.raw)
      } catch (e) {
        return json({ error: 'invalid json', message: (e as Error).message }, 422)
      }
      await mkdir(join(d.workspaceRoot, '.qy'), { recursive: true })
      await writeFile(file, body.raw.endsWith('\n') ? body.raw : `${body.raw}\n`, 'utf8')
      return json({ ok: true })
    }
  }

  if (p === '/api/team') {
    // 直接读取工作区配置而不是返回启动时的缓存：用户可能刚修改完 team.json，
    // 要求用户重启服务才能看到新配置是不合理的。
    const { loadTeamConfig } = await import('@qywork/runtime')
    const team = await loadTeamConfig(d.workspaceRoot)
    return json({
      roles: team.roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        ...(r.model ? { model: r.model } : {}),
      })),
      rules: team.rules,
      error: team.error,
    })
  }

  // 本机安装了哪些外部 agent CLI。只读：该清单来自探测，不写入任何文件，
  // 因此没有对应的写接口；设置页只负责显示。
  if (p === '/api/team/cli' && req.method === 'GET') {
    const { detectClis } = await import('@qywork/team')
    const found = await detectClis()
    return json({
      agents: found.map((c) => ({
        id: c.id,
        vendor: c.vendor,
        path: c.path,
        connected: c.connected,
      })),
    })
  }

  return null
}
