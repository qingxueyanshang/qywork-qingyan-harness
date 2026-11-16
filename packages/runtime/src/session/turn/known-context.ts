/** 模型在本轮已知的上下文，以及跟进消息注入时与之比较的变化。 */

import { MEDIA_TOOLS } from '@qywork/tools'
import { listMediaModels, type MediaModelEntry } from '../../config.ts'
import { mediaModelsNote, viewingLine } from '../../prompt.ts'
import type { SessionState } from '../types.ts'

/**
 * 模型在本轮已知的上下文：生成模型清单（以 `MEDIA_CHANGED_HEADING` 为标题的全文，便于直接比较）与面板文件。
 * 轮次开始时取自快照，跟进消息告知变化后随之更新。
 */
export interface KnownContext {
  media: string
  viewing?: string
}

export const MEDIA_CHANGED_HEADING = '可用的生成模型（本轮进行中配置已更改，以下为当前配置）'

/** 本会话可用的生成模型：只列出已注册生成工具的类别，与轮次快照使用同一判据。 */
export function registeredMediaModels(
  session: Pick<SessionState, 'opts' | 'registry'>,
): MediaModelEntry[] {
  return listMediaModels(session.opts.config).filter((m) =>
    session.registry.has(MEDIA_TOOLS[m.output].name),
  )
}

/**
 * 跟进消息注入时，与模型已知内容不同的上下文：生成模型清单（配置在本轮进行中被修改）与右侧面板打开的文件。
 * 有变化时返回要告知模型的文字并更新 `known`；没有变化时返回 null。
 * 模型只在轮次开始时得到快照；不告知时，它无法得知中途新增的型号，只能去界面中查找。
 */
export function changedContext(
  session: Pick<SessionState, 'opts' | 'registry'>,
  known: KnownContext,
  viewing: string | undefined,
): string | null {
  const out: string[] = []
  const media = mediaModelsNote(registeredMediaModels(session), MEDIA_CHANGED_HEADING)
  if (media !== known.media) {
    known.media = media
    out.push(media)
  }
  if (viewing && viewing !== known.viewing) {
    known.viewing = viewing
    out.push(viewingLine(viewing))
  }
  return out.length ? out.join('\n\n') : null
}
