/** 输入框顶部的等待队列：每条排队消息一行，提供档位切换、修改与删除。 */

import type { FollowUp } from '@qywork/core'
import { For, Show } from 'solid-js'
import { dropFollowUp, hasRun, state, steerFollowUp } from '../lib/store/index.ts'
import { AttachmentThumb } from './AttachmentThumb.tsx'
import { IconPencil, IconTrash } from './Icons.tsx'

/**
 * 排队中的后续消息，显示为输入框顶部的队列栏；它与正文、附件共用同一个输入框外壳。
 *
 * 卡片上有三个可点击对象：
 *
 * - **档位按钮**：按钮文字表示点击后执行的动作，而不是该条消息当前的档位。
 *   排队中的消息显示「调整方向」，点击后注入当前一轮，文字随之变为「加入队列」，
 *   再次点击退回队列。会话空闲时没有可注入的运行轮次，文字为「发送」，点击后立即
 *   启动一轮。三种状态采用同一种读法。不要改为显示当前档位：那样同一个按钮上「发送」是
 *   动作、另两个词是状态，同一位置出现两种读法。
 *   档位由服务端在同一个同步块中裁决，此处只负责显示。
 * - **修改**：从队列删除原条目，把正文和附件交回输入框；修改后使用原发送入口。
 * - **删除**：删除后既不注入也不发送。
 *
 * **单行，固定高度（B9）**：正文长短不一，若由内容撑高，删除按钮的位置会随之移动。
 * 不做悬停卡片：卡片承载的信息这一行已经显示。
 */
export function FollowUpCards(props: {
  onEdit: (followUp: FollowUp) => void
  thumbProps: (path: string) => { localUrl?: string }
}) {
  return (
    <Show when={state.followUps.length > 0}>
      <div class="followup-cards">
        <For each={state.followUps}>
          {(f) => (
            <div class="followup-card">
              <span class="followup-label">{f.steer ? '调整' : '队列'}</span>
              <Show when={(f.attachments?.length ?? 0) > 0}>
                <span class="followup-attachment-strip">
                  <For each={(f.attachments ?? []).slice(0, 3)}>
                    {(a) => (
                      <span class="followup-mini-attachment" data-tip={a.name}>
                        <AttachmentThumb
                          path={a.path}
                          name={a.name}
                          box={24}
                          {...props.thumbProps(a.path)}
                        />
                      </span>
                    )}
                  </For>
                  <Show when={(f.attachments?.length ?? 0) > 3}>
                    <span class="followup-attachment-more">
                      +{(f.attachments?.length ?? 0) - 3}
                    </span>
                  </Show>
                </span>
              </Show>
              <span
                class="followup-text truncate"
                data-tip={f.content || f.attachments?.map((a) => a.name).join('、')}
              >
                {f.content ||
                  (f.attachments?.length === 1
                    ? f.attachments[0]?.name
                    : `${f.attachments?.length ?? 0} 个附件`)}
              </span>
              <div class="followup-actions">
                <button
                  class="followup-act"
                  type="button"
                  onClick={() => steerFollowUp(f.id, !f.steer)}
                >
                  {!hasRun() ? '发送' : f.steer ? '加入队列' : '调整方向'}
                </button>
                <button
                  class="followup-act icon"
                  type="button"
                  aria-label="修改"
                  data-tip="修改"
                  onClick={() => props.onEdit(f)}
                >
                  <IconPencil size={16} />
                </button>
                <button
                  class="followup-act icon danger"
                  type="button"
                  aria-label="删除"
                  data-tip="删除"
                  onClick={() => dropFollowUp(f.id)}
                >
                  <IconTrash size={16} />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
