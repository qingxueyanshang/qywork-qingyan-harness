/** 提供给会话的画布端口，以及绑定到会话的设计稿渲染。 */

import {
  type CanvasDoc,
  type CanvasNode,
  type CanvasOp,
  cardIdOf,
  displayNameOf,
} from '@qywork/core'
import type { CanvasPort } from '@qywork/tools'
import type { BrowserCoordinator } from '../browser/coordinator.ts'
import type { ArtRender } from './assets.ts'
import type { CanvasWorkspace } from './docs.ts'
import type { CanvasService } from './service.ts'

/**
 * 一批操作前后的差异：新增或内容有变化的节点 id、只改变了位置或尺寸的节点 id、删除的节点名称，
 * 以及每条执行了的 `replace_text` 替换的处数。节点按序列化后的内容比较，不含框。
 * 位置与尺寸单独列出：排成网格或补上空位时移动的卡可达整列，按改动的卡列出全文时回执达数万字。
 */
function changesOf(
  before: CanvasDoc,
  after: CanvasDoc,
  ops: readonly CanvasOp[],
  skipped: readonly { at: number }[],
): {
  changed: string[]
  moved: string[]
  removed: string[]
  replaced: { at: number; count: number }[]
} {
  const content = ({ x: _x, y: _y, w: _w, h: _h, ...rest }: CanvasNode) => JSON.stringify(rest)
  const box = (n: CanvasNode) => JSON.stringify([n.x, n.y, n.w, n.h])
  const old = new Map(before.nodes.map((n) => [n.id, n]))
  const edges = (doc: CanvasDoc, id: string) =>
    JSON.stringify(doc.edges.filter((e) => e.to === id).map((e) => [e.from, e.role]))
  const changed = after.nodes
    .filter((n) => {
      const was = old.get(n.id)
      return !was || content(was) !== content(n) || edges(before, n.id) !== edges(after, n.id)
    })
    .map((n) => n.id)
  const moved = after.nodes
    .filter((n) => {
      const was = old.get(n.id)
      return was && !changed.includes(n.id) && box(was) !== box(n)
    })
    .map((n) => n.id)
  const kept = new Set(after.nodes.map((n) => n.id))
  const removed = before.nodes.filter((n) => !kept.has(n.id)).map(displayNameOf)
  const failed = new Set(skipped.map((s) => s.at))
  const replaced = ops.flatMap((op, at) => {
    if (op.op !== 'replace_text' || failed.has(at)) return []
    const target = cardIdOf(before, op.id)
    const node = target.ok ? before.nodes.find((n) => n.id === target.id) : undefined
    if (node?.type !== 'generate' || !op.old) return []
    return [{ at, count: node.prompt.split(op.old).length - 1 }]
  })
  return { changed, moved, removed, replaced }
}

/** 绑定到一条会话的设计稿渲染：渲染页归该会话所有（`BrowserCoordinator.renderArt`）。 */
export function artRenderOf(
  browser: BrowserCoordinator,
  conversationId: string,
  workspaceId: string,
  workspaceRoot: string,
): ArtRender {
  return (page) => browser.renderArt(conversationId, workspaceId, { ...page, workspaceRoot })
}

/**
 * 提供给会话的画布端口：使用同一个画布服务，绑定该会话所在的项目。
 * 运行与取回在工具中等待至结束；中止信号来自本轮，停止本轮只结束等待，生成照常进行并写回画布。
 * 取消与界面的取消按钮相同（`CanvasRuns.cancel` 与 `cancelTask`）。
 * 修改按大模型的规则核对（`prepareAgentOps`），读取的生成卡参数为实际发送的参数（`agentView`）。
 */
export function canvasPort(
  service: CanvasService,
  ws: CanvasWorkspace,
  render?: ArtRender,
): CanvasPort {
  return {
    create: (path) => service.docs.create(ws.root, { path }),
    list: () => service.docs.list(ws.root),
    textReferences: (path) => service.docs.textReferences(ws.root, path),
    ...(render
      ? {
          render: (path: string, nodes: string[]) =>
            service.assets.renderArt(ws.root, path, nodes, render),
        }
      : {}),
    read: (path) => service.docs.read(ws.root, path, true),
    edit: async (path, ops) => {
      const { before, doc, refs, skipped } = await service.docs.applyAgent(ws.root, path, ops)
      return {
        view: await service.docs.read(ws.root, path, true),
        refs,
        skipped,
        ...changesOf(before, doc, ops, skipped),
      }
    },
    run: async (path, nodeId, media, signal) =>
      (await service.runs.run(ws, path, nodeId, { media, signal, join: true })).done,
    exportTimeline: (path, nodeId, signal) =>
      service.exports.requestExport(ws, path, nodeId, signal),
    runBatch: (path, nodeIds, media, signal) =>
      service.runs.runBatch(ws, path, nodeIds, { media, signal }),
    retrieve: async (path, nodeId, version, media, signal) =>
      (await service.runs.retrieve(ws, path, nodeId, version, { media, signal })).done,
    cancel: (path, nodeId) => service.runs.cancel(ws.root, path, nodeId, service.runs.cancelTask),
    captureFrame: (path, nodeId, label, png) =>
      service.assets.captureFrame(ws.root, path, nodeId, label, png),
  }
}
