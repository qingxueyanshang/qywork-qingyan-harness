/** 生成卡的内容区：生成中、待取回、失败、缺失与结果各状态，以及切换版本的角标。 */

import { type CanvasGenerateNode, canvasRunLabel, retryCauseText } from '@qywork/core'
import { Match, Show, Switch } from 'solid-js'
import { IconChevron } from '../../Icons.tsx'
import { useCanvas } from '../board/context.ts'
import { KindIcon } from '../kinds.tsx'
import { clock } from '../Player.tsx'
import { Media } from './Media.tsx'

export const currentOf = (n: CanvasGenerateNode) => n.versions.find((v) => v.id === n.current)

function TaskNotice(p: { nodeId: string; version?: string | undefined; retrieving?: boolean }) {
  const canvas = useCanvas()
  const message = () => p.version && canvas.taskInfo(p.nodeId, p.version).message
  return (
    <output class="canvas-task-notice" onPointerDown={(e) => e.stopPropagation()}>
      <strong>
        {p.retrieving ? '上次等待结束原因' : message() ? '本次等待已结束' : '原任务待取回'}
      </strong>
      <span>{message() || '已保留原任务，取回会继续查询结果。'}</span>
    </output>
  )
}

export function GenerateBody(p: { node: CanvasGenerateNode; selected: boolean }) {
  const canvas = useCanvas()
  const st = () => canvas.view()?.states[p.node.id]
  const running = () => {
    const s = st()
    return s?.state === 'running' && (!s.version || s.version === p.node.current) ? s : null
  }
  const pending = () => {
    const s = st()
    if (s?.state === 'pending') return s
    const v = currentOf(p.node)
    return v?.path.endsWith('.task.json') ? { version: v.id } : null
  }
  const failed = () => {
    const s = st()
    return (s?.state === 'failed' || s?.state === 'unknown') && !p.node.versions.length ? s : null
  }
  const current = () => currentOf(p.node)
  const retrievalMessage = () => {
    const s = running()
    const version = s?.version ?? p.node.current
    return s?.action === 'retrieve' && version
      ? canvas.taskInfo(p.node.id, version).message
      : undefined
  }
  const notice = () => {
    const s = st()
    if (s?.state === 'unknown')
      return { failed: false, title: '本次结果未确认，已保留原结果', message: s.message }
    if (s?.state === 'failed')
      return { failed: true, title: '本次生成失败，已保留原结果', message: s.message }
    const warning = current()?.warning
    return warning ? { failed: false, title: '生成结果与设置不符', message: warning } : null
  }
  const index = () => p.node.versions.findIndex((v) => v.id === p.node.current) + 1
  return (
    <div class="canvas-generate-body">
      <Switch
        fallback={
          <div class="canvas-media canvas-slot empty">
            <KindIcon kind={p.node.output} size={22} stroke={1.6} />
          </div>
        }
      >
        <Match when={running()}>
          {(s) => (
            <div
              class="canvas-media canvas-slot"
              classList={{ 'with-task-notice': !!retrievalMessage() }}
            >
              <div class="canvas-task-progress">
                <div class="canvas-live">
                  <span class="canvas-snake">
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                  </span>
                  <span
                    class="phase"
                    data-tip={
                      s().retry
                        ? retryCauseText(s().retry!.reason)
                        : s().taskId
                          ? `任务号：${s().taskId}`
                          : undefined
                    }
                  >
                    {canvasRunLabel(p.node.output, s())}
                  </span>
                  <span class="time" data-tip="本次等待用时">
                    {clock(canvas.now() - s().startedAt)}
                  </span>
                </div>
              </div>
              <Show when={retrievalMessage()}>
                <TaskNotice nodeId={p.node.id} version={s().version ?? p.node.current} retrieving />
              </Show>
            </div>
          )}
        </Match>
        <Match when={pending()}>
          {(s) => (
            <div class="canvas-media canvas-slot with-task-notice">
              <div class="canvas-task-progress">
                {/* 提示设在外层：禁用的按钮不派发指针事件，设在按钮上时禁用期间的原因不显示。 */}
                <span
                  data-tip={
                    st()?.state === 'running'
                      ? '请先暂停当前等待，再取回此任务'
                      : canvas.taskInfo(p.node.id, s().version).details
                  }
                >
                  <button
                    class="canvas-ghost"
                    type="button"
                    disabled={st()?.state === 'running'}
                    onClick={() => canvas.retrieve(p.node.id, s().version)}
                  >
                    取回
                  </button>
                </span>
              </div>
              <TaskNotice nodeId={p.node.id} version={s().version} />
            </div>
          )}
        </Match>
        <Match when={failed()}>
          {(s) => (
            <div class="canvas-media canvas-slot">
              <KindIcon kind={p.node.output} size={22} />
              <span
                class="error"
                classList={{ unknown: s().state === 'unknown' }}
                role={s().state === 'unknown' ? 'status' : 'alert'}
              >
                {s().message}
              </span>
            </div>
          )}
        </Match>
        <Match when={st()?.state === 'missing'}>
          <div class="canvas-missing">
            <span class="label">缺失</span>
          </div>
        </Match>
        <Match when={current()}>
          {(v) => (
            <div class="canvas-media" style={{ overflow: 'hidden' }}>
              <Media
                nodeId={p.node.id}
                path={v().path}
                kind={p.node.output}
                w={p.node.w}
                h={p.node.h}
                controls={p.selected}
              />
              <Show when={notice()}>
                {(n) => (
                  <div
                    class="canvas-media-notice"
                    classList={{ failed: n().failed }}
                    role={n().failed ? 'alert' : 'status'}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <strong>{n().title}</strong>
                    <span>{n().message}</span>
                  </div>
                )}
              </Show>
            </div>
          )}
        </Match>
      </Switch>
      <Show when={p.node.versions.length > 1}>
        <button
          class="canvas-badge version"
          type="button"
          aria-label={`切换版本（${index()} / ${p.node.versions.length}）`}
          onClick={(e) =>
            canvas.setMenu({ kind: 'version', anchor: e.currentTarget, nodeId: p.node.id })
          }
        >
          {index()} / {p.node.versions.length}
          <IconChevron size={10} />
        </button>
      </Show>
    </div>
  )
}
