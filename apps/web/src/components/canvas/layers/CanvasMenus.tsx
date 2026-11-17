import type { CanvasGenerateNode } from '@qywork/core'
import { For, Match, Show, Switch } from 'solid-js'
import { AnchoredMenu } from '../../AnchoredMenu.tsx'
import { IconCheck } from '../../Icons.tsx'
import { useCanvas } from '../board/context.ts'
import { mediaOf } from '../GeneratePanel.tsx'
import { addClips } from '../input/clips.ts'
import { contextItems } from '../input/context-menu.ts'
import { extend, extendable, recordNode } from '../input/create.ts'
import { uploadClips } from '../input/upload.ts'
import { KindIcon, OUTPUT_LABEL } from '../kinds.tsx'
import { SourcePicker } from '../SourcePicker.tsx'

/** Art 录制的时长选项（秒）。 */
const RECORD_SECONDS = [5, 10] as const

/** 版本的生成时间：当天只显示时分，非当天加上月日。 */
function madeAt(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 画布的菜单：右键菜单、时间线添加视频、后续生成、版本与录制时长。由 `CanvasPanel` 挂载在文档根节点。 */
export function CanvasMenus() {
  const canvas = useCanvas()
  return (
    <Show when={canvas.props.active ? canvas.menu() : null}>
      {(m) => (
        <Switch>
          <Match when={m().kind === 'context' && m().target}>
            {(target) => (
              <AnchoredMenu class="canvas-context-menu" anchor={m().anchor} placement="below-start">
                <For each={contextItems(canvas, target(), m().at ?? canvas.center())}>
                  {(item) => (
                    <Show when={item} fallback={<hr />}>
                      {(it) => (
                        <button
                          type="button"
                          onClick={() => {
                            const act = it().run
                            canvas.setMenu(null)
                            act()
                          }}
                        >
                          <span>{it().label}</span>
                          <Show when={it().keys}>{(k) => <kbd>{k()}</kbd>}</Show>
                        </button>
                      )}
                    </Show>
                  )}
                </For>
              </AnchoredMenu>
            )}
          </Match>
          <Match when={m().kind === 'clip'}>
            <AnchoredMenu class="canvas-pick" anchor={m().anchor} placement="below-start">
              <SourcePicker
                nodes={canvas
                  .nodes()
                  .filter(
                    (n) =>
                      mediaOf(canvas.view()!, n.id).kind === 'video' &&
                      mediaOf(canvas.view()!, n.id).path,
                  )}
                files={true}
                kinds={['video']}
                accept="video/*"
                thumb={(id) => <KindIcon kind={mediaOf(canvas.view()!, id).kind} size={14} />}
                onNode={(id) => {
                  const { nodeId, gap } = m()
                  const path = mediaOf(canvas.view()!, id).path
                  canvas.setMenu(null)
                  if (path) void addClips(canvas, nodeId, [path], gap)
                }}
                onFile={(path) => {
                  const { nodeId, gap } = m()
                  canvas.setMenu(null)
                  void addClips(canvas, nodeId, [path], gap)
                }}
                onUpload={(files) => {
                  const { nodeId, gap } = m()
                  canvas.setMenu(null)
                  void uploadClips(canvas, nodeId, files, gap)
                }}
              />
            </AnchoredMenu>
          </Match>
          <Match when={m().kind === 'out' || m().kind === 'version' || m().kind === 'record'}>
            {/* 后续生成菜单从锚点向右展开：连线从左侧进入锚点，新卡片也位于锚点右侧。 */}
            <AnchoredMenu
              class="canvas-menu"
              anchor={m().anchor}
              placement={m().kind === 'out' ? 'below-start' : 'below-end'}
            >
              <Switch>
                <Match when={m().kind === 'record'}>
                  <For each={RECORD_SECONDS}>
                    {(seconds) => (
                      <button type="button" onClick={() => recordNode(canvas, m().nodeId, seconds)}>
                        {seconds} 秒
                      </button>
                    )}
                  </For>
                </Match>
                <Match when={m().kind === 'out'}>
                  <For each={extendable(canvas, (m() as { nodeId: string }).nodeId)}>
                    {(o) => (
                      <button
                        type="button"
                        onClick={() => void extend(canvas, m().nodeId, o, m().at)}
                      >
                        <KindIcon kind={o} size={14} />
                        {OUTPUT_LABEL[o]}
                      </button>
                    )}
                  </For>
                </Match>
                <Match when={m().kind === 'version'}>
                  <For
                    each={(() => {
                      const n = canvas.byId((m() as { nodeId: string }).nodeId)
                      return n?.type === 'generate' ? n.versions : []
                    })()}
                  >
                    {(v, i) => {
                      const current = () =>
                        v.id ===
                        (
                          canvas.byId((m() as { nodeId: string }).nodeId) as
                            | CanvasGenerateNode
                            | undefined
                        )?.current
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={current()}
                          data-tip={
                            v.path.endsWith('.task.json')
                              ? canvas.taskInfo(m().nodeId, v.id).details
                              : v.path
                          }
                          onClick={() => {
                            // 先取得节点 id 再关闭菜单：关闭之后 `m()` 已失效。
                            const id = (m() as { nodeId: string }).nodeId
                            canvas.setMenu(null)
                            void canvas.apply([{ op: 'update', id, current: v.id }])
                          }}
                        >
                          <span>
                            {i() + 1} · {madeAt(v.made.at)}
                            {v.path.endsWith('.task.json')
                              ? (() => {
                                  // 每次生成在提交之前登记引用任务记录的版本：正在生成或取回的版本不标为待取回。
                                  const s =
                                    canvas.view()?.states[(m() as { nodeId: string }).nodeId]
                                  if (s?.state !== 'running' || s.version !== v.id)
                                    return ' · 待取回'
                                  return s.action === 'retrieve' ? ' · 取回中' : ' · 生成中'
                                })()
                              : ''}
                          </span>
                          <Show when={current()}>
                            <IconCheck size={14} />
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </Match>
              </Switch>
            </AnchoredMenu>
          </Match>
        </Switch>
      )}
    </Show>
  )
}
