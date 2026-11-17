/**
 * 正在接收事件的会话：当前会话，以及右侧打开的子会话页。
 *
 * 视图表（`state.views`）的键与报告给服务端的订阅集是同一份派生值，不在两处分别记录：已报告但未建表的
 * 会话，事件到达时会被整帧丢弃（`applyEvent` 的归属判定）；已建表但未报告的会话，
 * 不会收到任何事件。两者都由此处生成。
 */

import { createEffect, createRoot } from 'solid-js'
import { client } from '../client.ts'
import { dropView, openView, state } from '../state.ts'
import { panelTabs, tabConversationId } from '../ui.ts'
import { abortHistoryLoad } from './history.ts'

let reported = ''

/**
 * 先建表后撤表：中间状态下两条会话都在表中，优于先撤后建时两条都不在表中的状态，
 * 后者在该时刻到达的帧会被丢弃。
 */
export function syncViews(): void {
  const want = new Set<string>()
  if (state.activeConversation) want.add(state.activeConversation)
  for (const t of panelTabs()) {
    if (t.kind === 'conversation') want.add(tabConversationId(t.id))
  }
  for (const id of want) openView(id)
  for (const id of Object.keys(state.views)) {
    if (want.has(id)) continue
    abortHistoryLoad(id)
    dropView(id)
  }
  // 未变化时不报告：本函数既由下方的 effect 触发，也在切换会话的路径上被显式调用一次，
  // 同一组会话报告两次只会产生两条无效指令。
  const line = [...want].sort().join(',')
  if (line === reported) return
  reported = line
  client.subscribe([...want])
}

/*
 * 打开的页面由 `ui.ts` 中的信号描述，因此订阅集在此处跟随该信号更新。
 * 不能反过来由 `ui.ts` 调用此处：本模块已引用它（`panelTabs`），两个模块会互相 import。
 * 切换会话的路径另有一次显式调用，原因见 `selectConversation`。
 */
createRoot(() => createEffect(syncViews))
