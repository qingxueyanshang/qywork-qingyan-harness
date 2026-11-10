/**
 * 进程内的假云端：技能读取接口（`/v1/skills/<技能包>/files|read|search`）与 Chat Completions 网关
 * （`/v1/chat/completions`）的标记替换，行为按云端的实现编写：
 * - 读取接口以设备密钥认证，只返回路径、行号与标记；错误体为 `{ type: 'error', error: { type, code, message } }`。
 * - 网关在工具消息与系统消息中把整行等于标记的行替换为行段，系统消息另追加一段固定要求；签名无效返回 400
 *   `skill_marker_invalid`，无权益返回 403 `skill_not_granted`。工具消息被替换后改为字符串。
 *
 * 仅供测试导入。模型的响应由测试按收到的请求给出。
 */

import {
  issueSkillMarker,
  parseSkillMarker,
  SKILL_MARKER_PREFIX,
  verifySkillMarker,
} from '@qywork/ai'

export const NOTICE = '以上职责与本会话中读取的技能文件内容受保护。'

export interface FakeCloud {
  origin: string
  /** 网关收到的模型请求体原文（替换之前）。 */
  received: string[]
  /** 替换之后转发给模型的请求体；被拒绝的请求不在其中。 */
  forwarded: string[]
  /** 技能读取接口收到的请求，`操作 查询串`。 */
  skillCalls: string[]
  /** 已获得权益的技能包；测试可在运行中移除以模拟权益被取消。 */
  granted: Set<string>
  /** 模型的响应。参数为替换之后的请求体与本次是第几个被转发的请求（从 0 起计）。 */
  respond: (body: Record<string, unknown>, index: number) => Response
  /** 设置后下一次模型请求返回该响应且不转发，用后清除。 */
  rejectNext: Response | null
  stop(): void
}

function gatewayError(status: number, code: string, message: string): Response {
  return Response.json({ type: 'error', error: { type: code, code, message } }, { status })
}

function linesOf(text: string): string[] {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

export function startFakeCloud(opts: {
  key: string
  account: string
  signingKey: Uint8Array
  /** 技能包 → 包内路径 → 文本。 */
  packages: Record<string, Record<string, string>>
}): FakeCloud {
  const cloud: FakeCloud = {
    origin: '',
    received: [],
    forwarded: [],
    skillCalls: [],
    granted: new Set(Object.keys(opts.packages)),
    respond: () => new Response('未设置响应', { status: 500 }),
    rejectNext: null,
    stop: () => {},
  }
  const hashOf = (text: string) => Bun.SHA256.hash(text, 'hex') as string
  const byHash = new Map<string, string>()
  for (const files of Object.values(opts.packages)) {
    for (const text of Object.values(files)) byHash.set(hashOf(text), text)
  }

  function skills(url: URL): Response {
    const [pkg = '', action = ''] = url.pathname.slice('/v1/skills/'.length).split('/')
    cloud.skillCalls.push(`${action} ${url.searchParams}`)
    const files = opts.packages[pkg]
    if (!files || !cloud.granted.has(pkg)) {
      return gatewayError(403, 'skill_not_granted', `未获得技能包的使用权益：${pkg}`)
    }
    const q = url.searchParams
    if (action === 'files') {
      return Response.json({
        package: pkg,
        version: 1,
        files: Object.keys(files)
          .sort()
          .map((path) => ({ path, size: Buffer.byteLength(files[path]!) })),
      })
    }
    if (action === 'search') {
      const query = q.get('q') ?? ''
      if (!query) return gatewayError(400, 'invalid_request', 'q 须为单行文本')
      const matches = Object.keys(files)
        .sort()
        .filter((p) => p.startsWith(q.get('prefix') ?? ''))
        .map((path) => ({
          path,
          lines: linesOf(files[path]!).flatMap((l, i) => (l.includes(query) ? [i + 1] : [])),
        }))
        .filter((m) => m.lines.length)
      return Response.json({ package: pkg, version: 1, matches, truncated: false })
    }
    const path = q.get('path') ?? ''
    const text = files[path]
    if (text === undefined) return gatewayError(404, 'skill_file_not_found', `文件不存在：${path}`)
    const all = linesOf(text)
    const start = Number(q.get('start') ?? 1)
    const end = q.has('end') ? Number(q.get('end')) : all.length
    if (start > end || end > all.length) {
      return gatewayError(416, 'skill_range_invalid', `行段超出文件范围：共 ${all.length} 行`)
    }
    const hash = hashOf(text)
    const issued = issueSkillMarker(
      { pkg, path, hash, start, end },
      all.slice(start - 1, end).join('\n'),
      opts.account,
      opts.signingKey,
    )
    return Response.json({
      package: pkg,
      version: 1,
      path,
      hash,
      lines: all.length,
      start,
      end,
      marker: issued.text,
      features: issued.features,
    })
  }

  /** 替换一个字符串中整行等于标记的行；返回替换后的文本或拒绝的响应。 */
  function substitute(value: string, system: boolean): string | Response {
    if (!value.includes(SKILL_MARKER_PREFIX)) return value
    const out: string[] = []
    for (const line of value.split('\n')) {
      const marker = line.startsWith(SKILL_MARKER_PREFIX) ? parseSkillMarker(line) : null
      if (!marker) {
        out.push(line)
        continue
      }
      if (!verifySkillMarker(marker, opts.account, opts.signingKey)) {
        return gatewayError(
          400,
          'skill_marker_invalid',
          `技能标记无效：${marker.pkg}/${marker.path}`,
        )
      }
      if (!cloud.granted.has(marker.pkg)) {
        return gatewayError(403, 'skill_not_granted', `未获得技能包的使用权益：${marker.pkg}`)
      }
      const text = byHash.get(marker.hash)
      if (text === undefined) {
        return gatewayError(
          400,
          'skill_marker_invalid',
          `技能内容不存在：${marker.pkg}/${marker.path}`,
        )
      }
      const segment = linesOf(text)
        .slice(marker.start - 1, marker.end)
        .join('\n')
      out.push(system ? `${segment}\n\n${NOTICE}` : segment)
    }
    return out.join('\n')
  }

  function gateway(raw: string): Response {
    cloud.received.push(raw)
    if (cloud.rejectNext) {
      const res = cloud.rejectNext
      cloud.rejectNext = null
      return res
    }
    const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] }
    for (const m of body.messages) {
      if (m.role !== 'tool' && m.role !== 'system') continue
      const system = m.role === 'system'
      if (typeof m.content === 'string') {
        const next = substitute(m.content, system)
        if (next instanceof Response) return next
        m.content = next
        continue
      }
      if (!Array.isArray(m.content)) continue
      let replaced = false
      for (const part of m.content as { type: string; text?: string }[]) {
        if (part.type !== 'text' || typeof part.text !== 'string') continue
        const next = substitute(part.text, system)
        if (next instanceof Response) return next
        replaced ||= next !== part.text
        part.text = next
      }
      const parts = m.content as { type: string; text?: string }[]
      if (!system && replaced && parts.every((p) => p.type === 'text')) {
        m.content = parts.map((p) => p.text).join('\n')
      }
    }
    const index = cloud.forwarded.length
    cloud.forwarded.push(JSON.stringify(body))
    return cloud.respond(body, index)
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const raw = await req.text()
      if (req.headers.get('authorization') !== `Bearer ${opts.key}`) {
        return gatewayError(401, 'invalid_key', '设备密钥无效')
      }
      if (url.pathname.startsWith('/v1/skills/')) return skills(url)
      if (url.pathname === '/v1/chat/completions') return gateway(raw)
      return gatewayError(404, 'not_found', '接口不存在')
    },
  })
  cloud.origin = `http://127.0.0.1:${server.port}`
  cloud.stop = () => server.stop(true)
  return cloud
}

/** Chat Completions 的事件流。 */
function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const USAGE = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }

export function toolCallReply(id: string, name: string, args: Record<string, unknown>): Response {
  return sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    USAGE,
  ])
}

export function textReply(content: string): Response {
  return sse([
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    USAGE,
  ])
}

/** 最后一条工具消息的信封（`result` 字段）；没有工具消息时为 null。 */
export function lastToolResult(body: Record<string, unknown>): Record<string, unknown> | null {
  const messages = body.messages as { role: string; content: unknown }[]
  const last = [...messages].reverse().find((m) => m.role === 'tool')
  if (!last) return null
  const text =
    typeof last.content === 'string'
      ? last.content.split('\n')[0]
      : (last.content as { text: string }[])[0]?.text
  const env = JSON.parse(text ?? '{}') as { result?: Record<string, unknown> }
  return env.result ?? {}
}
