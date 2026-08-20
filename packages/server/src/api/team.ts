/**
 * Agent Team 配置读写。
 *
 * 原先 TeamPanel 明确按「只读不写」设计，理由是「配置有两个来源迟早分叉」。
 * 结论下错了：界面直接读写**同一个** .qy/team.json，来源仍然只有一个，
 * 界面只是它的编辑器。分叉风险来自「界面另存一份」，不来自「有界面」。
 *
 * 与「禁止写 .qy/」不冲突：那条硬边界拦的是 **agent 工具**
 * （tools.ts:resolveWritablePath、policy.ts 的命令裁决），
 * 拦的是 agent 改自己的配置，不是用户经 UI 的显式操作。见 docs/permissions.md。
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
      // 先解析再落盘：写进去一份坏 JSON，下次编排会在完全无关的地方失败。
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
    // 直接读工作区配置而不是返回启动时的缓存：用户可能刚改完 team.json，
    // 让他为了看到新配置去重启服务是不合理的。
    const { loadTeamConfig } = await import('@qywork/runtime')
    const team = await loadTeamConfig(d.workspaceRoot)
    return json({
      backends: Object.keys(team.backends),
      roles: team.roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        // 回的是**键名**不是展示串：界面要拿它回填下拉框、也要按它去
        // team.json 里找那一条。展示成什么样由界面自己算。
        backend: r.backendId,
      })),
      plan: team.plan,
      rules: team.rules,
      error: team.error,
    })
  }

  return null
}
