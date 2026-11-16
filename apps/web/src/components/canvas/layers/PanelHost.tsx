import { Show } from 'solid-js'
import { cancelCard } from '../../../lib/store/index.ts'
import { useCanvas } from '../board/context.ts'
import { GeneratePanel } from '../GeneratePanel.tsx'
import { placeInput } from '../input/upload.ts'

const PANEL_W = 480

/** 选中一张生成卡时显示在其下方的生成面板。 */
export function PanelHost() {
  const canvas = useCanvas()
  const panelAt = () => {
    const n = canvas.single()
    if (n?.type !== 'generate') return null
    const p = canvas.pos(n)
    // 画布区比面板窄时，面板宽度缩小到画布区宽度：更宽的面板无论放在何处都有一部分位于画布区外。
    const width = Math.min(PANEL_W, canvas.size().w - 16)
    // 只按节点定位，不按画布区边缘向内收回：收回后面板会遮挡节点本身与相邻节点，平移时也不随节点移动。
    return {
      node: n,
      width,
      left: canvas.px() + (p.x + n.w / 2) * canvas.z() - width / 2,
      top: canvas.py() + (p.y + n.h) * canvas.z() + 16,
    }
  }
  // 按卡片 id 重建：面板中的草稿与菜单只属于当前卡片，选中另一张卡片时不沿用。
  return (
    <Show when={panelAt()?.node.id} keyed>
      {(id) => {
        // 卸载时 `panelAt()` 已为 null，此处读取的仍是该卡片最后一次的位置与节点。
        let last = panelAt()!
        const at = () => {
          const now = panelAt()
          if (now?.node.id === id) last = now
          return last
        }
        return (
          <GeneratePanel
            view={canvas.view()!}
            node={at().node}
            state={canvas.view()?.states[id]}
            left={at().left}
            width={at().width}
            top={at().top}
            tall={canvas.tall()}
            onTall={canvas.setTall}
            apply={(ops) => canvas.apply(ops).then((r) => r !== null)}
            run={(ops) => canvas.run(id, ops)}
            cancel={() => cancelCard(canvas.props.path, id)}
            place={(source) => placeInput(canvas, at().node, source)}
          />
        )
      }}
    </Show>
  )
}
