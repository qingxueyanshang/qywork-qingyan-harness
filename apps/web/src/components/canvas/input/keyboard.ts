/**
 * 画布的键盘快捷键与剪贴板。右键菜单中的复制、剪切、粘贴、创建副本、删除与断开调用这里的同一函数。
 * 窗口上的监听由 `CanvasPanel` 注册与注销。
 */

import { type CanvasDoc, copyOps } from '@qywork/core'
import { type CanvasController, CLIP_LINK } from '../board/controller.ts'
import { mediaOf } from '../GeneratePanel.tsx'
import { sessionOf, withoutClip } from '../timeline.ts'
import { uploadFiles } from './upload.ts'

/** 各画布共用的剪贴板：复制时的完整文档与选中的节点。仅在本应用内有效，跨画布粘贴要求文件位于同一工作区。 */
export let clipboard: { source: CanvasDoc; ids: string[] } | null = null

/**
 * 画布的快捷键。按顺序逐条判定，命中的各条依次执行；带 `last` 的一条执行后不再判定其后各条。
 * `mod` 为 Ctrl 或 ⌘ 是否按下，`key` 为小写的按键名。
 */
const SHORTCUTS: {
  when: (e: KeyboardEvent, mod: boolean, key: string) => boolean
  run: (canvas: CanvasController, e: KeyboardEvent) => void
  last?: true
}[] = [
  {
    when: (e) => e.code === 'Space',
    last: true,
    run: (canvas, e) => {
      // 焦点可能仍在窗口或面板按钮上；长按产生的重复事件也必须拦截，否则松开按键会触发按钮。
      e.preventDefault()
      canvas.space = true
      canvas.stage.classList.add('panning')
    },
  },
  {
    when: (e) => e.key === 'Delete' || e.key === 'Backspace',
    last: true,
    run: (canvas, e) => {
      const edge = canvas.edgeSelected()
      if (edge) {
        e.preventDefault()
        void cutLink(canvas, edge).then((ok) => ok && canvas.setEdgeSelected(null))
        return
      }
      if (!canvas.selected().size) return
      e.preventDefault()
      if (removeSelectedClip(canvas)) return
      removeSelected(canvas)
    },
  },
  {
    when: (e) => e.key === 'Escape',
    run: (canvas) => {
      canvas.setSelected(new Set<string>())
      canvas.setEdgeSelected(null)
    },
  },
  {
    when: (_e, mod, key) => mod && key === 'z',
    run: (canvas, e) => {
      e.preventDefault()
      void canvas.travel(!e.shiftKey)
    },
  },
  {
    when: (_e, mod, key) => mod && key === 'y',
    run: (canvas, e) => {
      e.preventDefault()
      void canvas.travel(false)
    },
  },
  {
    when: (_e, mod, key) => mod && key === 'c',
    run: (canvas, e) => {
      if (copySelection(canvas)) e.preventDefault()
    },
  },
  {
    when: (_e, mod, key) => mod && key === 'x',
    run: (canvas, e) => {
      if (copySelection(canvas)) {
        e.preventDefault()
        removeSelected(canvas)
      }
    },
  },
  {
    when: (_e, mod, key) => mod && key === 'd',
    run: (canvas, e) => {
      e.preventDefault()
      const v = canvas.view()
      const ids = [...canvas.selected()]
      if (v && ids.length) void pasteNodes(canvas, v.doc, ids, null, true)
    },
  },
  {
    // 粘贴本身在 paste 事件中处理：只有在该事件中才能取得系统剪贴板中的图片。
    when: (_e, mod, key) => mod && key === 'v',
    run: (canvas, e) => {
      canvas.pasteWithInputs = e.shiftKey
    },
  },
  {
    when: (e, mod) => mod && e.key.toLowerCase() === 'a',
    run: (canvas, e) => {
      e.preventDefault()
      canvas.setEdgeSelected(null)
      canvas.setSelected(new Set(canvas.nodes().map((n) => n.id)))
    },
  },
  {
    when: (e) => e.shiftKey && e.code === 'Digit1',
    run: (canvas) => {
      canvas.fit(true)
    },
  },
  {
    when: (e, mod) => (e.shiftKey && e.code === 'Digit2') || (!mod && e.key === '.'),
    run: (canvas) => {
      const list = canvas.nodes().filter((n) => canvas.selected().has(n.id))
      if (list.length) canvas.fit(true, list)
    },
  },
  {
    when: (e, mod) => mod && e.key === '0',
    run: (canvas, e) => {
      e.preventDefault()
      canvas.zoomAt(1)
    },
  },
  {
    when: (e, mod) => mod && (e.key === '=' || e.key === '+' || e.key === '-'),
    run: (canvas, e) => {
      e.preventDefault()
      canvas.zoomAt(canvas.z() * (e.key === '-' ? 1 / 1.25 : 1.25))
    },
  },
]

/**
 * 画布的按键处理。监听挂在窗口上，只在本页可见且按键不在输入框或编辑框中时生效：
 * 画布本身不获取焦点，点击画布之后焦点仍可能在其他元素上。
 */
export const onKeyDown = (canvas: CanvasController, e: KeyboardEvent) => {
  if (!canvas.props.active) return
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
    return
  if (canvas.fullscreen()) {
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && (key === 'z' || key === 'y')) {
      e.preventDefault()
      void canvas.travel(key === 'z' && !e.shiftKey)
    }
    return
  }
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  for (const s of SHORTCUTS) {
    if (!s.when(e, mod, key)) continue
    s.run(canvas, e)
    if (s.last) return
  }
}

/** 选中的是一条时间线且其轨道上选中了片段时，删除该片段。已删除时返回 true。 */
const removeSelectedClip = (canvas: CanvasController): boolean => {
  const n = canvas.single()
  const index = n?.type === 'timeline' ? sessionOf(n.id)?.selected() : null
  if (n?.type !== 'timeline' || index === null || index === undefined) return false
  sessionOf(n.id)?.select(null)
  void canvas.apply([{ op: 'update', id: n.id, clips: withoutClip(n.clips, index) }])
  return true
}

/** 断开一条连线。对于从片段推导出的连线，删除时间线中引用该视频文件的全部片段。成功时返回 true。 */
export const cutLink = async (canvas: CanvasController, id: string): Promise<boolean> => {
  if (!id.startsWith(CLIP_LINK)) return (await canvas.apply([{ op: 'remove', id }])) !== null
  const [timeline, source] = id.slice(CLIP_LINK.length).split(':')
  const n = canvas.byId(timeline!)
  const path = canvas.view() ? mediaOf(canvas.view()!, source!).path : null
  if (n?.type !== 'timeline' || !path) return false
  sessionOf(n.id)?.select(null)
  const r = await canvas.apply([
    { op: 'update', id: n.id, clips: n.clips.filter((c) => c.path !== path) },
  ])
  return r !== null
}

export const removeSelected = (canvas: CanvasController) => {
  const ids = [...canvas.selected()]
  if (!ids.length) return
  void canvas
    .apply(ids.map((id) => ({ op: 'remove', id })))
    .then((r) => r && canvas.setSelected(new Set<string>()))
}

export const copySelection = (canvas: CanvasController): boolean => {
  const v = canvas.view()
  const ids = [...canvas.selected()]
  if (!v || !ids.length) return false
  clipboard = { source: structuredClone(v.doc), ids }
  return true
}

/**
 * 把 `source` 中的一组节点复制到当前画布：整组中心位于 `at`；`at` 为 `null` 时放在原位置右下方稍作偏移（创建副本）。
 * 粘贴后选中副本。
 */
export const pasteNodes = async (
  canvas: CanvasController,
  source: CanvasDoc,
  ids: string[],
  at: { x: number; y: number } | null,
  withInputs: boolean,
) => {
  const v = canvas.view()
  const picked = source.nodes.filter((n) => ids.includes(n.id))
  if (!v || !picked.length) return
  const minX = Math.min(...picked.map((n) => n.x))
  const minY = Math.min(...picked.map((n) => n.y))
  const maxX = Math.max(...picked.map((n) => n.x + n.w))
  const maxY = Math.max(...picked.map((n) => n.y + n.h))
  const offset = at
    ? { dx: Math.round(at.x - (minX + maxX) / 2), dy: Math.round(at.y - (minY + maxY) / 2) }
    : { dx: 40, dy: 40 }
  const r = await canvas.apply(copyOps(source, ids, v.doc, offset, withInputs))
  if (r) {
    canvas.setEdgeSelected(null)
    canvas.setSelected(new Set(picked.flatMap((_, i) => r.refs[`$copy${i + 1}`] ?? [])))
  }
}

/** 粘贴：系统剪贴板中有文件（截图、复制的图片）时上传，否则粘贴本应用剪贴板中的节点。 */
export const onPaste = (canvas: CanvasController, e: ClipboardEvent) => {
  if (!canvas.props.active) return
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) return
  const withInputs = canvas.pasteWithInputs
  canvas.pasteWithInputs = false
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) {
    e.preventDefault()
    void uploadFiles(canvas, files, canvas.pointerAt ?? canvas.center())
    return
  }
  if (!clipboard) return
  e.preventDefault()
  void pasteNodes(
    canvas,
    clipboard.source,
    clipboard.ids,
    canvas.pointerAt ?? canvas.center(),
    withInputs,
  )
}

export const releaseSpace = (canvas: CanvasController) => {
  canvas.space = false
  canvas.stage.classList.remove('panning')
}

export const onKeyUp = (canvas: CanvasController, e: KeyboardEvent) => {
  if (e.code !== 'Space' || !canvas.space) return
  e.preventDefault()
  releaseSpace(canvas)
}
