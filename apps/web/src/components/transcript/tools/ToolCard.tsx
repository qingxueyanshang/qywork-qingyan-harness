import type { Component } from 'solid-js'
import type { TranscriptItem } from '../../../lib/store/index.ts'
import { DelegateCard } from './DelegateCard.tsx'
import { GenericToolCard } from './GenericToolCard.tsx'

/**
 * 有专用卡片的工具，按工具名查表；表中没有的工具使用 `GenericToolCard`。
 *
 * 派发任务的两个工具渲染为图，不使用折叠条目：它们各自是一条子会话的入口，
 * 产出的正文已在该子会话（或该 CLI 进程的输出流）中。
 *
 * 用 `Map` 而不是对象字面量：工具名来自插件与 MCP，对象字面量按名取值会取到
 * `Object.prototype` 上的同名成员（如 `constructor`）。
 */
const TOOL_CARDS: ReadonlyMap<string, Component<{ item: TranscriptItem }>> = new Map([
  ['workflow', DelegateCard],
  ['subagent', DelegateCard],
])

export function ToolCard(props: { item: TranscriptItem }) {
  const Card = TOOL_CARDS.get(props.item.toolName ?? '') ?? GenericToolCard
  return <Card item={props.item} />
}
