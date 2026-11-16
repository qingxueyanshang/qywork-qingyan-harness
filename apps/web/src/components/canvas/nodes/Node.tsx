/** 画布上的一个节点：标题栏（名称、重命名、模型名）、按节点类型分派的内容区、连接点。 */

import {
  type CanvasGenerateNode,
  type CanvasNode,
  type CanvasTimelineNode,
  canvasFileKind,
  displayNameOf,
  type GenerateOutput,
} from '@qywork/core'
import { type Component, createMemo, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { composing } from '../../../lib/input/composing.ts'
import { modelCatalog } from '../../../lib/store/index.ts'
import { IconPlus } from '../../Icons.tsx'
import { useCanvas } from '../board/context.ts'
import { extendable } from '../input/create.ts'
import { startLink } from '../input/pointer.ts'
import { KindIcon } from '../kinds.tsx'
import { FileBody } from './FileBody.tsx'
import { currentOf, GenerateBody } from './GenerateBody.tsx'
import { TimelineBody } from './TimelineBody.tsx'

const catalogModel = (provider: string | undefined, id: string) =>
  (modelCatalog()?.media ?? []).find((m) => m.provider === provider && m.id === id)

/**
 * 标题栏的模型名：有结果时为正在显示的版本实际使用的模型（`made`），没有结果时为卡片选定的模型。
 * 不要改回优先取卡片选定的模型：同一张卡换过模型、切换到旧版本时，画面与模型名不对应。下次生成所用的模型见生成面板。
 */
const modelLabel = (n: CanvasGenerateNode): string => {
  const made = currentOf(n)?.made
  const provider = made ? made.provider : n.provider
  const id = made ? made.model : n.model
  if (!id) return ''
  const m = catalogModel(provider, id)
  return m ? `${m.label}${m.delisted ? '（已下架）' : ''}` : id
}

/**
 * 节点内容区按节点类型分派。键是 `CanvasNode['type']` 的全集，缺少一种时类型检查失败；
 * 组件收到该类型的节点与本节点是否选中。
 */
const NODE_BODIES: {
  [K in CanvasNode['type']]: Component<{
    node: Extract<CanvasNode, { type: K }>
    selected: boolean
  }>
} = {
  file: FileBody,
  generate: GenerateBody,
  timeline: TimelineBody,
}

/**
 * 按 id 取节点：每次写操作返回的文档都是新对象，按对象挂载时每修改一处都会重建全部节点、重新解码全部图片。
 * 删除节点的那次更新中，组件内的计算可能先于列表重新计算，此时沿用最后一次取得的节点。
 */
export function Node(p: { id: string }) {
  const canvas = useCanvas()
  let last!: CanvasNode
  // 按对象比较：内容未变的卡片沿用原对象（见 `shareUnchanged`），重新读取后本卡的各项计算不重新执行。
  const n = createMemo(() => {
    last = canvas.byId(p.id) ?? last
    return last
  })
  const at = () => canvas.pos(n())
  const isSelected = () => canvas.selected().has(n().id)
  const kind = (): GenerateOutput | 'text' | 'timeline' | null => {
    const node = n()
    if (node.type === 'generate') return node.output
    if (node.type === 'timeline') return 'timeline'
    return canvasFileKind(node.path)
  }
  const commitName = (value: string) => {
    canvas.setRenaming(null)
    const name = value.trim()
    if (name === displayNameOf(n())) return
    if (n().type !== 'file' && !name) return
    void canvas.apply([{ op: 'update', id: n().id, name: name || null }])
  }

  return (
    <div
      class="canvas-node"
      classList={{
        selected: isSelected(),
        audio: kind() === 'audio',
        'link-target': canvas.linkTarget() === n().id || canvas.clipTarget() === n().id,
      }}
      data-node={n().id}
      style={{
        left: `${at().x}px`,
        top: `${at().y}px`,
        width: `${n().w}px`,
        height: `${n().h}px`,
      }}
    >
      <div class="canvas-node-title">
        <KindIcon kind={kind()} />
        <Show when={canvas.renaming() === n().id} fallback={<span>{displayNameOf(n())}</span>}>
          <input
            value={displayNameOf(n())}
            ref={(el) => requestAnimationFrame(() => el.select())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !composing(e)) commitName(e.currentTarget.value)
              if (e.key === 'Escape') canvas.setRenaming(null)
            }}
            onBlur={(e) => commitName(e.currentTarget.value)}
          />
        </Show>
        <Show when={n().type === 'generate' && modelLabel(n() as CanvasGenerateNode)}>
          {(label) => <span class="model">{label()}</span>}
        </Show>
      </div>

      <Dynamic
        component={NODE_BODIES[n().type] as Component<{ node: CanvasNode; selected: boolean }>}
        node={n()}
        selected={isSelected()}
      />

      <Show when={n().type === 'generate' && (n() as CanvasGenerateNode).output !== 'audio'}>
        <button
          class="canvas-port in"
          type="button"
          aria-label="添加素材"
          onClick={() => canvas.setSelected(new Set([n().id]))}
        >
          <IconPlus stroke={1.8} />
        </button>
      </Show>
      <Show when={n().type === 'timeline'}>
        <button
          class="canvas-port in"
          type="button"
          aria-label="添加视频"
          onClick={(e) =>
            canvas.setMenu({
              kind: 'clip',
              anchor: e.currentTarget,
              nodeId: n().id,
              gap: (n() as CanvasTimelineNode).clips.length,
            })
          }
        >
          <IconPlus stroke={1.8} />
        </button>
      </Show>
      <Show when={extendable(canvas, n().id).length}>
        <button
          class="canvas-port out"
          type="button"
          aria-label="从此节点生成"
          onPointerDown={(e) => startLink(canvas, e, n().id)}
          onClick={(e) => {
            // 指针的按下与松开由 startLink 与 onPointerUp 处理；此处只处理键盘触发的点击。
            if (e.detail === 0)
              canvas.setMenu({ kind: 'out', anchor: e.currentTarget, nodeId: n().id })
          }}
        >
          <IconPlus stroke={1.8} />
        </button>
      </Show>
    </div>
  )
}
