import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import {
  askInChat,
  deleteSchedule,
  loadSchedules,
  runScheduleNow,
  type ScheduleItem,
  updateSchedule,
} from '../lib/store/index.ts'
import { IconX } from './Icons.tsx'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 定时任务。
 *
 * **界面上必须写死一句话。** 「仅在应用运行时触发」。这不是提示，是这个功能的**前提**：sidecar 的生
 * 命周期挂在窗口上，关掉应用就不会触发，错过的也不补。一条界面上显示已排期、实际不会触发的定时任
 * 务，比没有这个功能坏得多（ROADMAP §34.2）。
 *
 * 这句话由服务端下发（`runtimeOnly`），不在前端各写一遍——措辞漂移会让
 * 手机端和桌面端对同一件事给出两种说法。
 *
 * **「立刻跑一次」是这里最重要的按钮。** 定时触发要等到点，而「配好了会不会跑」是用户第一个想知道
 * 的。没有这个按钮的话，验证一条每天 9 点的任务得等到明天早上。
 */
/** 「新增」递给模型的话头。不自动发送——用户可以改了再发。 */
const NEW_SCHEDULE =
  '我们一起来设一个定时任务吧。先说明定时任务在 qywork 里怎么工作、到点之后跑在哪；然后问我要它做什么、什么时候跑。'

export function SchedulesPanel() {
  const [data, { refetch }] = createResource(loadSchedules)
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
      {/* `loaded()` 而不是 `data()`：增删改之后要重取，重取期间留住上一份；
          出错时给 undefined，由 `LoadState` 说明原因并给一条重试的路——
          写成 `data()` 的话它会先抛，`fallback` 永远轮不到。 */}
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(d) => (
          <>
            {/* 前提写在最前面，不折叠、不淡化。「新增」并排在这一格右侧：
                这一页只有它一个动作，单独占一行等于把一颗按钮吊在空白里。 */}
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
                    <span class="schedule-title">{s.title}</span>
                    <button
                      class="icon-btn"
                      type="button"
                      aria-label={`删除 ${s.title}`}
                      disabled={busy() === s.id}
                      onClick={() => void act(s.id, () => deleteSchedule(s.id))}
                    >
                      <IconX size={13} />
                    </button>
                  </div>

                  <div class="field-hint">{describe(s)}</div>
                  <div class="schedule-prompt">{s.prompt}</div>

                  {/* 失败要贴在这条任务上。触发的时候没人开着界面，
                      只发事件等于没有接收者。 */}
                  <Show when={s.lastError}>
                    {(e) => <div class="field-hint bad">上次失败：{e()}</div>}
                  </Show>
                  <Show when={s.lastRunAt}>
                    {(t) => <div class="field-hint">上次触发 {fmt(t())}</div>}
                  </Show>
                  <Show when={s.enabled && s.nextRunAt}>
                    {(t) => <div class="field-hint">下次 {fmt(t())}</div>}
                  </Show>

                  <div class="schedule-actions">
                    <button
                      class="btn-ghost"
                      type="button"
                      disabled={busy() === s.id}
                      onClick={() =>
                        void act(s.id, () => updateSchedule(s.id, { enabled: !s.enabled }))
                      }
                    >
                      {s.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      class="btn-ghost"
                      type="button"
                      disabled={busy() === s.id}
                      onClick={() => void act(s.id, () => runScheduleNow(s.id))}
                    >
                      立刻跑一次
                    </button>
                  </div>
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

function describe(s: ScheduleItem): string {
  return s.kind === 'daily'
    ? `每天 ${pad(s.atHour ?? 0)}:${pad(s.atMinute ?? 0)}`
    : `每 ${s.everyMinutes} 分钟`
}

/** 用本机时区显示。定时任务的语义就是本地时间，显示成 UTC 会对不上用户设的那个点。 */
function fmt(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
