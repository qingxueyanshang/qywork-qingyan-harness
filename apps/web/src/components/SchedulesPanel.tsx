import type { ScheduleView } from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import {
  askInChat,
  deleteSchedule,
  loadSchedules,
  runScheduleNow,
  state,
  updateSchedule,
  workspace,
} from '../lib/store/index.ts'
import { IconTrash } from './Icons.tsx'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 定时任务。
 *
 * **界面上必须固定显示一句边界声明：**「仅在应用运行时触发」。它是该功能的**前提**，不是提示：
 * sidecar 的生命周期绑定在窗口上，关闭应用后不会触发；重新打开后已到期的任务执行一次，关闭期间
 * 错过的次数不逐次补执行。界面显示已排期而实际不会触发的定时任务，比不提供该功能更容易误导用户。
 *
 * 这句话由服务端下发（`runtimeOnly`），不在各前端分别书写：分别书写时措辞会出现差异，
 * 手机端与桌面端对同一件事给出两种表述。
 *
 * **「立即运行」是本页最重要的按钮。** 定时触发要等到设定时刻，而用户首先需要确认配置后能否运行。
 * 没有该按钮时，验证每天 9 点执行的任务必须等到次日早上。
 */
/** 「新增」送入输入框的初始指令。不自动发送：用户可先修改再发送。 */
const NEW_SCHEDULE =
  '新建一个定时任务。请先说明定时任务在 qywork 中如何工作、触发后在何处运行；然后询问需要它做什么、何时运行。'

export function SchedulesPanel() {
  /*
   * 重取的判据基于两项已有状态：当前项目，以及运行中的会话集合。
   *
   * 后台触发不经过本面板，只有 `conversation.busy` 会把触发所建会话的进入与移出记录到状态中；
   * 以它作为失效信号，一轮执行完毕即可读取新的终态。不使用轮询定时器：本页可能长时间保持打开。
   */
  const [data, { refetch }] = createResource(
    () => `${workspace()?.id ?? ''}|${state.busyConversations.join(',')}`,
    loadSchedules,
  )
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div class="settings-form">
      {/* 使用 `loaded()` 而不是 `data()`：增删改之后需重取，重取期间保留上一次的结果；
          出错时返回 undefined，由 `LoadState` 显示原因并提供重试入口；
          写成 `data()` 时它会先抛出错误，`fallback` 永远不会渲染。 */}
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(d) => (
          <>
            {/* 前提显示在最前面，不折叠、不降低对比度。「新增」放在同一行右侧：
                本页只有这一个操作，单独占一行会使按钮孤立于空白区域。 */}
            <div class="schedule-caveat">
              <span>{d().runtimeOnly}</span>
              <button class="btn-ghost sm" type="button" onClick={() => askInChat(NEW_SCHEDULE)}>
                新增
              </button>
            </div>

            <Show when={error()}>{(e) => <div class="settings-notices bad">{e()}</div>}</Show>

            <For each={d().schedules}>
              {(s) => (
                <div class="schedule-card" classList={{ off: !s.enabled }}>
                  <div class="schedule-head">
                    <span class="schedule-title" data-tip={s.title}>
                      {s.title}
                    </span>
                    {/* 上次结果与任务名称同行；正文可能很长，结果不能排在正文之后。 */}
                    <Show when={outcome(s)}>
                      {(text) => (
                        <span class="schedule-outcome field-hint bad" data-tip={text()}>
                          {text()}
                        </span>
                      )}
                    </Show>
                    <button
                      class="icon-btn"
                      type="button"
                      aria-label={`删除 ${s.title}`}
                      disabled={busy() === s.id}
                      onClick={() => void act(s.id, () => deleteSchedule(s.id))}
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>

                  {/* 周期、下次时间与两个操作位于同一行：操作靠行尾，不单独占用卡片底部一行。 */}
                  <div class="schedule-meta">
                    <span class="field-hint">{describe(s)}</span>
                    <Show when={s.lastRunAt}>
                      {(t) => <span class="field-hint">上次 {fmt(t())}</span>}
                    </Show>
                    <Show when={s.enabled && s.nextRunAt}>
                      {(t) => <span class="field-hint">下次 {fmt(t())}</span>}
                    </Show>
                    <div class="schedule-actions">
                      <button
                        class="btn-ghost sm"
                        type="button"
                        disabled={busy() === s.id}
                        onClick={() =>
                          void act(s.id, () => updateSchedule(s.id, { enabled: !s.enabled }))
                        }
                      >
                        {s.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        class="btn-ghost sm"
                        type="button"
                        disabled={busy() === s.id}
                        onClick={() => void act(s.id, () => runScheduleNow(s.id))}
                      >
                        立即运行
                      </button>
                    </div>
                  </div>
                  <div class="schedule-prompt">{s.prompt}</div>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')

function describe(s: ScheduleView): string {
  return s.kind === 'daily'
    ? `每天 ${pad(s.atHour ?? 0)}:${pad(s.atMinute ?? 0)}`
    : `每 ${s.everyMinutes} 分钟`
}

/**
 * 上次触发的结果。正常执行完毕与从未触发都返回 null，只在需要说明时显示。
 *
 * 有触发时间却没有执行记录时如实显示：认领之后、启动轮次之前进程退出会留下该状态，
 * 显示为成功会使记录失实。
 */
function outcome(s: ScheduleView): string | null {
  if (s.lastRunAt === undefined) return null
  const run = s.lastRun
  if (run === null || run.runId === null) return '没有执行记录'
  if (run.status === 'failed') return `上次失败：${run.errorMessage ?? '没有报错正文'}`
  if (run.status === 'interrupted') return '上次被中断'
  return null
}

/** 用本机时区显示。定时任务按本地时间设定，显示为 UTC 会与用户设定的时间不一致。 */
function fmt(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
