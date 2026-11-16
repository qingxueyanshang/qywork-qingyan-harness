/** 画布的右键菜单：确定右键点击的对象、在指针处打开菜单、按对象生成菜单项。 */

import { type CanvasTimelineNode, type CanvasView, GENERATE_OUTPUTS } from '@qywork/core'
import { absPath, explainApiError, isDesktopShell, revealFile } from '../../../lib/store/index.ts'
import type { CanvasController, ContextTarget } from '../board/controller.ts'
import { mediaOf } from '../GeneratePanel.tsx'
import { OUTPUT_LABEL } from '../kinds.tsx'
import { insertClips, sessionOf, splitAt, withoutClip } from '../timeline.ts'
import { addGenerate, addTimeline } from './create.ts'
import { clipboard, copySelection, cutLink, pasteNodes, removeSelected } from './keyboard.ts'

/** 右键按下处的对象：节点、连线或空白。确定弹出菜单（松开时未拖动）后再修改选区，右键拖动平移不改变选区。 */
export const contextOf = (target: HTMLElement): ContextTarget => {
  const node = target.closest<HTMLElement>('[data-node]')?.dataset.node
  if (node) return { kind: 'node', id: node }
  const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge
  if (edge) return { kind: 'edge', id: edge }
  return { kind: 'blank' }
}

export const openContext = (
  canvas: CanvasController,
  target: ContextTarget,
  clientX: number,
  clientY: number,
) => {
  if (target.kind === 'node' && !canvas.selected().has(target.id)) {
    canvas.setSelected(new Set([target.id]))
    canvas.setEdgeSelected(null)
  }
  if (target.kind === 'edge') {
    canvas.setSelected(new Set<string>())
    canvas.setEdgeSelected(target.id)
  }
  const r = canvas.stage.getBoundingClientRect()
  canvas.dropAnchor.style.left = `${clientX - r.left}px`
  canvas.dropAnchor.style.top = `${clientY - r.top}px`
  canvas.setMenu({
    kind: 'context',
    anchor: canvas.dropAnchor,
    nodeId: '',
    target,
    at: canvas.toWorld(clientX, clientY),
  })
}

/** 时间线片段的右键菜单：锚点位于指针处，全屏编辑中使用同一菜单。 */
export const openClipMenu = (
  canvas: CanvasController,
  id: string,
  index: number,
  t: number,
  clientX: number,
  clientY: number,
) => {
  const r = canvas.stage.getBoundingClientRect()
  canvas.dropAnchor.style.left = `${clientX - r.left}px`
  canvas.dropAnchor.style.top = `${clientY - r.top}px`
  canvas.setMenu({
    kind: 'context',
    anchor: canvas.dropAnchor,
    nodeId: '',
    target: { kind: 'clip', id, index, t },
  })
}

/** 快捷键的显示形式：macOS 使用 ⌘，其他系统使用 Ctrl+。 */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** 右键菜单的一项，`null` 表示分隔线。 */
type ContextItem = { label: string; keys?: string; run: () => void } | null

/** 各类对象共用的取值：右键点击处（画布坐标）、打开菜单时的画布、可粘贴时的「粘贴」项。 */
type ContextScope = {
  at: { x: number; y: number }
  v: CanvasView | null
  paste: ContextItem[]
}

/**
 * 各类右键对象的菜单项。键是 `ContextTarget['kind']` 的全集，缺少一种时类型检查失败。
 * 节点的菜单作用于选区（右键点击的节点此时已在选区中）。
 */
const CONTEXT_ITEMS: {
  [K in ContextTarget['kind']]: (
    canvas: CanvasController,
    target: Extract<ContextTarget, { kind: K }>,
    scope: ContextScope,
  ) => ContextItem[]
} = {
  edge: (canvas, target) => [
    {
      label: '断开',
      keys: 'Delete',
      run: () => void cutLink(canvas, target.id).then((ok) => ok && canvas.setEdgeSelected(null)),
    },
  ],
  clip: (canvas, target) => {
    const n = canvas.byId(target.id)
    const clip = n?.type === 'timeline' ? n.clips[target.index] : undefined
    if (n?.type !== 'timeline' || !clip) return []
    const set = (clips: CanvasTimelineNode['clips']) => () =>
      void canvas.apply([{ op: 'update', id: n.id, clips }])
    const split = splitAt(n.clips, target.t)
    return [
      ...(split ? [{ label: '在此处分割', run: set(split) }] : []),
      { label: '创建副本', run: set(insertClips(n.clips, target.index + 1, [clip])) },
      null,
      {
        label: '删除',
        keys: 'Delete',
        run: () => {
          sessionOf(n.id)?.select(null)
          set(withoutClip(n.clips, target.index))()
        },
      },
    ]
  },
  blank: (canvas, _target, { at, paste }) => [
    ...paste,
    ...(paste.length ? [null] : []),
    ...GENERATE_OUTPUTS.map((o) => ({
      label: OUTPUT_LABEL[o],
      run: () => void addGenerate(canvas, o, at),
    })),
    { label: '时间线', run: () => void addTimeline(canvas, at) },
    {
      label: '从设备上传',
      run: () => {
        canvas.uploadAt = at
        canvas.contextUpload.click()
      },
    },
    null,
    {
      label: '全选',
      keys: `${MOD}A`,
      run: () => canvas.setSelected(new Set(canvas.nodes().map((n) => n.id))),
    },
  ],
  node: (canvas, _target, { v, paste }) => {
    const ids = [...canvas.selected()]
    const single = ids.length === 1 ? canvas.byId(ids[0]!) : undefined
    const file = single && v ? mediaOf(v, single.id).path : null
    const task =
      single?.type === 'generate' && single.current
        ? canvas.taskInfo(single.id, single.current)
        : null
    return [
      { label: '复制', keys: `${MOD}C`, run: () => void copySelection(canvas) },
      {
        label: '剪切',
        keys: `${MOD}X`,
        run: () => {
          if (copySelection(canvas)) removeSelected(canvas)
        },
      },
      ...paste,
      {
        label: '创建副本',
        keys: `${MOD}D`,
        run: () => v && void pasteNodes(canvas, v.doc, ids, null, true),
      },
      null,
      ...(file && isDesktopShell()
        ? [
            {
              label: '在资源管理器中显示',
              run: () => {
                canvas.setFault(null)
                void revealFile(absPath(file)).catch((err: unknown) =>
                  canvas.setFault(explainApiError(err, '无法定位文件')),
                )
              },
            },
          ]
        : []),
      ...(task?.taskId
        ? [
            {
              label: '复制任务号',
              run: () => {
                void navigator.clipboard
                  .writeText(task.taskId!)
                  .catch((err: unknown) => canvas.setFault(explainApiError(err, '复制失败')))
              },
            },
          ]
        : []),
      ...(single ? [{ label: '重命名', run: () => canvas.setRenaming(single.id) }] : []),
      { label: '删除', keys: 'Delete', run: () => removeSelected(canvas) },
    ]
  },
}

/** 右键菜单的菜单项，`null` 表示分隔线。菜单项执行的是对应快捷键调用的同一函数。 */
export const contextItems = (
  canvas: CanvasController,
  target: ContextTarget,
  at: { x: number; y: number },
): ContextItem[] => {
  const v = canvas.view()
  const paste = clipboard
    ? [
        {
          label: '粘贴',
          keys: `${MOD}V`,
          run: () =>
            clipboard && void pasteNodes(canvas, clipboard.source, clipboard.ids, at, false),
        },
      ]
    : []
  const items = CONTEXT_ITEMS[target.kind] as (
    canvas: CanvasController,
    target: ContextTarget,
    scope: ContextScope,
  ) => ContextItem[]
  return items(canvas, target, { at, v, paste })
}
