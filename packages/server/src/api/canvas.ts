/**
 * 画布：读、改、新建、运行、取回、取帧、发送前的花费。
 *
 * 写入与生成全部交给 `canvas.ts` 的画布服务，这里只做入参核对与出参形状。入参不合法回 422 且不落盘，
 * 在跑时的冲突回 409；运行与取回在校验通过、卡片已标成在跑之后立刻返回，不挂在请求上：
 * 关掉页签不中断已付费的调用，结果经 `canvas.run` 与 `file.changed` 事件送达。
 */

import { lookupMediaModel, MediaError, quoteMedia } from '@qywork/ai'
import {
  type CanvasOp,
  type CanvasView,
  MEDIA_OUTPUTS,
  type MediaOutput,
  parseCanvasOps,
} from '@qywork/core'
import { cancelMediaTask, makeMediaPort, resolveMediaModel } from '@qywork/runtime'
import { recordUsage } from '@qywork/store'
import { CanvasFailure, type CanvasStep } from '../canvas.ts'
import { type ApiHandler, type ApiRequestDeps, json } from './types.ts'

/** `POST /api/canvas/ops` 的回体：应用后的画布与批内名字对照。 */
export interface CanvasOpsResponse extends CanvasView {
  refs: Record<string, string>
  /** 这次写盘前后的文档指纹，撤销与重做用。 */
  step: CanvasStep
}

/** `POST /api/canvas/quote` 的回体。`null` = 推不出（按 token 计价等），界面不显示。 */
export interface CanvasQuoteResponse {
  quote: { cost: number; currency: string } | null
}

/** 取帧的名字：首帧、尾帧或时刻（`12.4s`）。名字进文件名，只收这三种形状。 */
const FRAME_LABEL = /^(首帧|尾帧|\d{1,5}(\.\d)?s)$/

/** 导出会话号：服务端 `randomUUID` 生成。 */
const EXPORT_ID = /^[0-9a-f-]{36}$/

function failed(err: unknown): Response {
  if (!(err instanceof CanvasFailure)) throw err
  const error = err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : 'invalid'
  return json({ error, message: err.message }, err.status)
}

function invalid(message: string): Response {
  return json({ error: 'invalid', message }, 422)
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const value = (await req.json().catch(() => null)) as unknown
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * 界面发起的生成用的端口：花费写成一行 `kind='media'`、无轮次无会话、带项目的账。
 * Agent 发起的不走这里，用它本轮的 `ctx.media`，花费进本轮。
 */
export function uiMediaPort(d: Pick<ApiRequestDeps, 'config' | 'store' | 'workspaceId'>) {
  return makeMediaPort(d.config, (spend) => {
    recordUsage(d.store, {
      kind: 'media',
      runId: null,
      conversationId: null,
      workspaceId: d.workspaceId,
      model: spend.model,
      provider: spend.kind,
      inputTokens: 0,
      outputTokens: 0,
      cost: spend.cost,
      currency: spend.currency,
      occurredAt: spend.at,
    })
  })
}

export const handleCanvasApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname
  if (p !== '/api/canvas' && !p.startsWith('/api/canvas/')) return null
  const ws = { id: d.workspaceId, root: d.workspaceRoot }

  try {
    if (p === '/api/canvas' && req.method === 'GET') {
      const path = url.searchParams.get('path')
      if (!path) return invalid('缺少画布路径')
      return json(await d.canvas.read(d.workspaceRoot, path))
    }

    if (req.method !== 'POST') return null

    // 取帧：请求体是浏览器导出的 PNG 字节，其余参数在查询串里。
    if (p === '/api/canvas/frame') {
      const q = url.searchParams
      const path = q.get('path')
      const nodeId = q.get('nodeId')
      const label = q.get('label') ?? ''
      if (!path || !nodeId) return invalid('缺少画布路径或节点 id')
      if (!FRAME_LABEL.test(label)) return invalid(`帧的名字不合法：${label}`)
      const bytes = new Uint8Array(await req.arrayBuffer())
      return json(await d.canvas.captureFrame(d.workspaceRoot, path, nodeId, label, bytes))
    }

    // 时间线导出：开始拿会话号，按位置写字节块，完成落盘，或放弃。写的请求体是字节，位置在查询串里。
    if (p === '/api/canvas/export/start') {
      const b = await body(req)
      const path = text(b?.path)
      const nodeId = text(b?.nodeId)
      if (!path || !nodeId) return invalid('缺少画布路径或节点 id')
      return json({ upload: await d.canvas.exportStart(d.workspaceRoot, path, nodeId) })
    }
    if (p === '/api/canvas/export/write') {
      const q = url.searchParams
      const upload = q.get('upload')
      const at = Number(q.get('at'))
      if (!upload || !EXPORT_ID.test(upload)) return invalid('缺少导出会话号')
      if (!Number.isSafeInteger(at) || at < 0) return invalid('写入位置不合法')
      await d.canvas.exportWrite(
        d.workspaceRoot,
        upload,
        at,
        new Uint8Array(await req.arrayBuffer()),
      )
      return json({ ok: true })
    }
    if (p === '/api/canvas/export/finish' || p === '/api/canvas/export/abort') {
      const upload = text((await body(req))?.upload)
      if (!upload || !EXPORT_ID.test(upload)) return invalid('缺少导出会话号')
      if (p.endsWith('/abort')) {
        await d.canvas.exportAbort(d.workspaceRoot, upload)
        return json({ ok: true })
      }
      return json(await d.canvas.exportFinish(d.workspaceRoot, upload))
    }

    if (p === '/api/canvas/upload') {
      const q = url.searchParams
      const path = q.get('path')
      const name = q.get('name')
      if (!path || !name) return invalid('缺少画布路径或文件名')
      const beside = q.get('beside')
      // 先判有没有：`Number(null)` 是 0，缺参数会被当成原点。
      const x = q.has('x') ? Number(q.get('x')) : Number.NaN
      const y = q.has('y') ? Number(q.get('y')) : Number.NaN
      if (!beside && !(Number.isFinite(x) && Number.isFinite(y))) return invalid('缺少位置')
      const bytes = new Uint8Array(await req.arrayBuffer())
      return json(
        await d.canvas.upload(
          d.workspaceRoot,
          path,
          name,
          bytes,
          beside ? { beside } : { near: { x, y } },
        ),
      )
    }

    const b = await body(req)
    if (!b) return invalid('请求体不是 JSON 对象')

    if (p === '/api/canvas/restore') {
      const path = text(b.path)
      const from = text(b.from)
      const to = text(b.to)
      if (!path || !from || !to) return invalid('缺少画布路径或指纹')
      const step = await d.canvas.restore(d.workspaceRoot, path, from, to)
      const res: CanvasOpsResponse = {
        ...(await d.canvas.read(d.workspaceRoot, path)),
        refs: {},
        step,
      }
      return json(res)
    }

    if (p === '/api/canvas/import') {
      const path = text(b.path)
      const files = Array.isArray(b.files)
        ? b.files.filter((f): f is string => typeof f === 'string')
        : []
      const near = b.near as { x?: unknown; y?: unknown } | undefined
      if (!path || !files.length) return invalid('缺少画布路径或文件')
      if (typeof near?.x !== 'number' || typeof near.y !== 'number') return invalid('缺少位置')
      return json({
        ids: await d.canvas.importPaths(d.workspaceRoot, path, files, { x: near.x, y: near.y }),
      })
    }

    if (p === '/api/canvas/new') {
      return json({ path: await d.canvas.create(d.workspaceRoot) })
    }

    if (p === '/api/canvas/quote') {
      const output = b.output as MediaOutput
      if (!MEDIA_OUTPUTS.includes(output)) return invalid('output 不合法')
      const provider = text(b.provider)
      const model = text(b.model)
      const target = resolveMediaModel(
        d.config,
        output,
        provider && model ? { provider, model } : undefined,
      )
      const params = b.params && typeof b.params === 'object' ? b.params : {}
      const inputs = b.inputs as { images?: unknown; videos?: unknown } | undefined
      const res: CanvasQuoteResponse = {
        quote: target
          ? quoteMedia(
              lookupMediaModel(target.model, target.kind),
              params as Record<string, unknown>,
              {
                images: Number(inputs?.images) || 0,
                videos: Number(inputs?.videos) || 0,
              },
            )
          : null,
      }
      return json(res)
    }

    const path = text(b.path)
    if (!path) return invalid('缺少画布路径')
    let ops: CanvasOp[] = []
    if (b.ops !== undefined) {
      const parsed = parseCanvasOps(b.ops)
      if (!parsed.ok) return invalid(parsed.error)
      ops = parsed.ops
    }

    if (p === '/api/canvas/ops') {
      if (ops.length === 0) return invalid('缺少操作')
      const { refs, step } = await d.canvas.apply(d.workspaceRoot, path, ops)
      const res: CanvasOpsResponse = {
        ...(await d.canvas.read(d.workspaceRoot, path)),
        refs,
        step,
      }
      return json(res)
    }

    const nodeId = text(b.nodeId)
    if (!nodeId) return invalid('缺少节点 id')

    // 停止：按接口能力撤销远端任务，回 `outcome`。撤不回时生成照常进行，由界面说明会照常计费。
    if (p === '/api/canvas/cancel') {
      try {
        const outcome = await d.canvas.cancel(d.workspaceRoot, path, nodeId, (task) =>
          cancelMediaTask(d.config, task, new AbortController().signal),
        )
        return json({ outcome })
      } catch (err) {
        if (!(err instanceof MediaError)) throw err
        return json({ error: 'upstream', message: `没有取消：${err.message}` }, 502)
      }
    }

    // 发送 = 先提交面板里的改动再运行，同一次请求：运行用的就是刚提交的那一份。
    if (p === '/api/canvas/run') {
      if (ops.length > 0) await d.canvas.apply(d.workspaceRoot, path, ops)
      await d.canvas.run(ws, path, nodeId, { media: uiMediaPort(d) })
      return json(await d.canvas.read(d.workspaceRoot, path))
    }

    if (p === '/api/canvas/retrieve') {
      await d.canvas.retrieve(ws, path, nodeId, text(b.version), { media: uiMediaPort(d) })
      return json(await d.canvas.read(d.workspaceRoot, path))
    }
  } catch (err) {
    return failed(err)
  }
  return null
}
