import { createResource, createSignal, For, Show } from 'solid-js'
import {
  createSchedule,
  deleteSchedule,
  loadSchedules,
  runScheduleNow,
  type ScheduleItem,
  updateSchedule,
} from '../lib/store.ts'
import { IconX } from './Icons.tsx'

/**
 * 定时任务。
 *
 * ## 界面上必须写死一句话
 *
 * 「仅在应用运行时触发」。这不是提示，是这个功能的**前提**：sidecar 的生命周期
 * 挂在窗口上，关掉应用就不会触发，错过的也不补。一个用户以为在后台跑、
 * 实际不跑的定时任务，比没有这个功能坏得多（ROADMAP §34.2）。
 *
 * 这句话由服务端下发（`runtimeOnly`），不在前端各写一遍——措辞漂移会让
 * 手机端和桌面端对同一件事给出两种说法。
 *
 * ## 「立刻跑一次」是这里最重要的按钮
 *
 * 定时触发要等到点，而「我配好了到底会不会跑」是用户第一个想知道的。
 * 没有这个按钮的话，验证一条每天 9 点的任务得等到明天早上。
 */
export function SchedulesPanel() {
  const [data, { refetch }] = createResource(loadSchedules)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal<Partial<ScheduleItem> | null>(null)

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
      <Show when={data()} fallback={<div class="settings-loading">读取定时任务…</div>}>
        {(d) => (
          <>
            {/* 前提写在最前面，不折叠、不淡化。 */}
            <div class="schedule-caveat">{d().runtimeOnly}</div>

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

            <Show
              when={draft()}
              fallback={
                <button
                  class="btn-ghost"
                  type="button"
                  onClick={() =>
                    setDraft({ title: '', prompt: '', kind: 'interval', everyMinutes: 60 })
                  }
                >
                  新建定时任务
                </button>
              }
            >
              {(dr) => (
                <div class="schedule-card">
                  <label class="field">
                    <span class="field-label">标题</span>
                    <input
                      type="text"
                      value={dr().title ?? ''}
                      onInput={(e) => setDraft({ ...dr(), title: e.currentTarget.value })}
                    />
                  </label>

                  <label class="field">
                    <span class="field-label">任务内容</span>
                    <textarea
                      rows={3}
                      placeholder="到点后作为一条消息发出去，跑在一个新建的会话里"
                      value={dr().prompt ?? ''}
                      onInput={(e) => setDraft({ ...dr(), prompt: e.currentTarget.value })}
                    />
                  </label>

                  <label class="field">
                    <span class="field-label">触发方式</span>
                    <select
                      value={dr().kind ?? 'interval'}
                      onChange={(e) =>
                        setDraft({
                          ...dr(),
                          kind: e.currentTarget.value as 'interval' | 'daily',
                          ...(e.currentTarget.value === 'daily'
                            ? { atHour: 9, atMinute: 0 }
                            : { everyMinutes: 60 }),
                        })
                      }
                    >
                      <option value="interval">每隔一段时间</option>
                      <option value="daily">每天固定时刻</option>
                    </select>
                  </label>

                  <Show when={(dr().kind ?? 'interval') === 'interval'}>
                    <label class="field">
                      <span class="field-label">间隔（分钟）</span>
                      <input
                        type="number"
                        min={1}
                        value={dr().everyMinutes ?? 60}
                        onInput={(e) =>
                          setDraft({ ...dr(), everyMinutes: Number(e.currentTarget.value) })
                        }
                      />
                    </label>
                  </Show>

                  <Show when={dr().kind === 'daily'}>
                    <label class="field">
                      <span class="field-label">时刻（本机时区）</span>
                      <input
                        type="time"
                        value={`${pad(dr().atHour ?? 9)}:${pad(dr().atMinute ?? 0)}`}
                        onInput={(e) => {
                          const [h, m] = e.currentTarget.value.split(':')
                          setDraft({ ...dr(), atHour: Number(h), atMinute: Number(m) })
                        }}
                      />
                    </label>
                  </Show>

                  <div class="schedule-actions">
                    <button
                      class="btn-primary"
                      type="button"
                      disabled={busy() === 'new'}
                      onClick={() =>
                        void act('new', async () => {
                          await createSchedule(dr())
                          setDraft(null)
                        })
                      }
                    >
                      创建
                    </button>
                    <button class="btn-ghost" type="button" onClick={() => setDraft(null)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </Show>
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
