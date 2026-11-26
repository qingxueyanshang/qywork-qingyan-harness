import { renameConversationModel, type Store } from '@qywork/store'
import type { EventBus } from '../bus.ts'
import { CLOUD_PROVIDER } from './account.ts'

/**
 * 记录旧型号 id 的云端会话改为对外编号并逐一广播（`CloudAccountOptions.onModelsRenamed`）。
 * 会话按记录的型号 id 发送，不改时下一轮被云端以「模型不可用」拒绝。
 */
export function renameCloudConversations(
  store: Store,
  bus: Pick<EventBus, 'publish'>,
  renamed: ReadonlyMap<string, string>,
): void {
  for (const [from, to] of renamed) {
    for (const conv of renameConversationModel(store, CLOUD_PROVIDER, from, to)) {
      bus.publish(
        {
          type: 'conversation.updated',
          conversationId: conv.id,
          provider: conv.provider,
          model: conv.model,
          title: conv.title,
          mode: conv.mode,
          updatedAt: conv.updatedAt,
        },
        conv.id,
      )
    }
  }
}
