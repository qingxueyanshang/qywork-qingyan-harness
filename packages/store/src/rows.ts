/**
 * 数据库行的结构。
 *
 * **这些接口是全部迁移（`migrations/`）执行完毕后的镜像，不是第二份定义。** 增加列、修改列名或可空性时
 * 必须同时修改此处；遗漏时 `migrations.test.ts` 中按 `PRAGMA table_info` 逐表比对的
 * 测试会失败。若没有该测试，这些接口就是一份无人校验的第二本账。
 *
 * **只列出映射函数实际读取的表。** 写入在 INSERT 中逐列列出列名并绑定参数，不需要行类型。
 *
 * 两处以类型声明代替断言，集中写在此处，而不是分散在各个映射函数中：
 *
 * - **主键列声明为非空。** SQLite 的 `TEXT PRIMARY KEY` 不隐含 NOT NULL，`PRAGMA`
 *   因此报告其可空；但主键无法写入 NULL，读取时一定有值。
 * - **id 列声明为品牌化 id 类型。** 写入侧只会写入 `newRunId()` 这类值，
 *   因此列中的值确实是该类型。在此处断言一次，优于在六个映射函数中断言三十次。
 */

import type {
  ConversationId,
  Currency,
  MessageId,
  PermissionMode,
  ProviderKind,
  ProviderRequestContentKind,
  ProviderRequestId,
  ProviderRequestStatus,
  ResourceId,
  ResourceStatus,
  RunId,
  RunStatus,
  ScheduleKind,
  StepId,
  StepKind,
  StopReason,
  ToolActionStatus,
  WorkspaceId,
} from '@qywork/core'

export interface WorkspaceRow {
  id: WorkspaceId
  name: string
  root_path: string
  last_opened_at: number
  created_at: number
  removed_at: number | null
  pinned_at: number | null
}

export interface ConversationRow {
  id: ConversationId
  workspace_id: WorkspaceId
  title: string
  provider: string
  model: string
  compaction_manifest: string | null
  cache_generation: number
  /** 该列没有 CHECK 约束，但写入侧只写入 `role` / `temp` / `cli` 之一。 */
  source: 'role' | 'temp' | 'cli' | null
  source_ref: string | null
  external_session: string | null
  /** 派发任务创建的子会话指向它的父会话；顶层会话为 NULL。 */
  parent_conversation_id: ConversationId | null
  archived_at: number | null
  created_at: number
  updated_at: number
  permission_mode: PermissionMode
}

export interface MessageRow {
  id: MessageId
  conversation_id: ConversationId
  /** `CHECK (role = 'user')`：助手回复与工具记录在 `steps`。 */
  role: 'user'
  content: string
  attachments: string | null
  /** `CHECK (origin IN ('subagent','workflow','command'))`。NULL 表示用户本人发送的消息。 */
  origin: 'subagent' | 'workflow' | 'command' | null
  created_at: number
}

export interface RunRow {
  id: RunId
  conversation_id: ConversationId
  workspace_id: WorkspaceId
  user_message_id: MessageId | null
  message_id_upper_bound: MessageId | null
  /** 空串见 `Run.provider`。 */
  provider: string
  model: string
  client_request_id: string
  /** `CHECK (status IN ('queued','running','done','failed','interrupted'))`。 */
  status: RunStatus
  stop_reason: StopReason | null
  input_tokens: number
  output_tokens: number
  /** NULL 表示 provider 未回报，与实际命中为 0 含义不同。不要用 COALESCE 转为 0。 */
  cached_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number
  cost: number
  currency: Currency
  usage_turns: string
  step_count: number
  error_message: string | null
  error_code: string | null
  /** `RunInterruption` JSON。NULL = 未中断、普通失败或迁移前记录。 */
  interruption_detail: string | null
  /** NULL = 迁移前存量；新 run 写入 `RunContextSegment[]` JSON。 */
  context_snapshot: string | null
  owner_pid: number | null
  heartbeat_at: number | null
  /** `RunOwner`；NULL = 迁移前旧行或未声明进程类别。 */
  owner_kind: string | null
  /** 派发来源，见 `Run.dispatchStepId`。NULL = 并非派发产生。 */
  dispatch_step_id: StepId | null
  dispatch_node_id: string | null
  /** 本轮的生成花费，`MediaSpend[]` JSON。 */
  media_usage: string
  created_at: number
  finished_at: number | null
}

export interface StepRow {
  id: StepId
  run_id: RunId
  seq: number
  /** `CHECK (kind IN ('text','tool_action','compaction','thinking','user'))`。 */
  kind: StepKind
  tool_name: string | null
  tool_call_id: string | null
  provider_batch_id: string | null
  call_index: number | null
  execution_wave_index: number | null
  execution_started_at: number | null
  content: string | null
  payload: string | null
  status: ToolActionStatus | 'done'
  created_at: number
  /** 工具调用的执行时长。存量行与非工具行为 null。 */
  duration_ms: number | null
}

export interface ProviderRequestRow {
  id: ProviderRequestId
  run_id: RunId
  turn_index: number
  retry_index: number
  purpose: string
  provider_name: string | null
  provider_kind: ProviderKind | null
  model: string
  /** `CHECK (status IN ('pending','in_flight','received','uncertain','rejected'))`。 */
  status: ProviderRequestStatus
  measured_input_tokens: number
  /** 发出时的运行中读数；见 `ProviderRequest.occupancyTokens`。 */
  occupancy_tokens: number | null
  provider_input_tokens: number | null
  provider_output_tokens: number | null
  provider_cached_tokens: number | null
  provider_cache_write_tokens: number | null
  /** 其中按 1 小时档写入的部分；上游未回报分档为 NULL。 */
  provider_cache_write_1h_tokens: number | null
  sent_categories: string
  omitted_categories: string
  finish_reason: string
  error_code: string | null
  error_message: string | null
  /** `ProviderRequestDiagnostic` JSON。 */
  diagnostic: string | null
  configuration: string | null
  payload_hash: string
  request_bytes: number | null
  cache_route_fingerprint: string | null
  /** 已停止写入：媒体的保留与移除改为按字节预算换出后，不再记录批次送达凭证。存量行保留原值，不删除该列。 */
  input_image_batch_id: string | null
  sent_at: number | null
  headers_at: number | null
  /** 云端模型网关返回的请求号；不是经云端的请求为 NULL。 */
  cloud_request_id: string | null
  /** 补发第二份请求的时刻；未补发为 NULL。 */
  hedge_sent_at: number | null
  /** SQLite 没有布尔类型，使用 0/1。1 表示采用的是补发的一份；未补发为 NULL。 */
  hedge_won: number | null
  /** 0/1。1 表示该回执作为占用锚点（`agent` 的 `settleResponse` 判定）。 */
  anchored: number
  first_event_at: number | null
  first_content_at: number | null
  last_content_at: number | null
  last_content_kind: ProviderRequestContentKind | null
  last_visible_at: number | null
  completed_at: number | null
  created_at: number
}

export interface RequestEnvelopeRow {
  fingerprint: string
  /** `EnvelopeItem[]` JSON。 */
  items: string
  created_at: number
}

export interface IntermediateResourceRow {
  id: ResourceId
  run_id: RunId
  step_id: StepId | null
  tool_name: string
  source_type: string
  /** `CHECK (status IN ('complete','partial','failed'))`。 */
  status: ResourceStatus
  content_hash: string | null
  size_bytes: number
  mime_type: string | null
  coverage: string
  created_at: number
}

export interface ScheduleRow {
  id: string
  workspace_root: string
  title: string
  prompt: string
  /** `CHECK (kind IN ('interval','daily'))`。 */
  kind: ScheduleKind
  every_minutes: number | null
  at_hour: number | null
  at_minute: number | null
  /** SQLite 没有布尔类型，使用 0/1。 */
  enabled: number
  created_at: number
  last_run_at: number | null
  /** `ON DELETE SET NULL`：最近一次触发所进入的会话；会话被删除后置空，触发游标保留。 */
  conversation_id: string | null
  /** SQLite 没有布尔类型，使用 0/1。1 表示每次触发另建一个会话。 */
  new_conversation: number
}

/**
 * 表名 → 该表的列名。**供比对测试使用**：接口的键在运行时无法获取，因此列名单独列出一份；
 * 它与接口写在同一处、在同一次修改中更新，遗漏修改会被测试发现。
 */
export const ROW_COLUMNS: Record<string, readonly string[]> = {
  workspaces: [
    'id',
    'name',
    'root_path',
    'last_opened_at',
    'created_at',
    'removed_at',
    'pinned_at',
  ],
  conversations: [
    'id',
    'workspace_id',
    'title',
    'provider',
    'model',
    'compaction_manifest',
    'cache_generation',
    'source',
    'source_ref',
    'parent_conversation_id',
    'external_session',
    'archived_at',
    'created_at',
    'updated_at',
    'permission_mode',
  ],
  messages: ['id', 'conversation_id', 'role', 'content', 'attachments', 'origin', 'created_at'],
  runs: [
    'id',
    'conversation_id',
    'workspace_id',
    'user_message_id',
    'message_id_upper_bound',
    'model',
    'client_request_id',
    'status',
    'stop_reason',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'cost',
    'currency',
    'usage_turns',
    'step_count',
    'error_message',
    'error_code',
    'interruption_detail',
    'context_snapshot',
    'owner_pid',
    'owner_kind',
    'heartbeat_at',
    'created_at',
    'finished_at',
    'dispatch_step_id',
    'dispatch_node_id',
    'media_usage',
    'provider',
  ],
  steps: [
    'id',
    'run_id',
    'seq',
    'kind',
    'tool_name',
    'tool_call_id',
    'provider_batch_id',
    'call_index',
    'execution_wave_index',
    'execution_started_at',
    'content',
    'payload',
    'status',
    'created_at',
    'duration_ms',
  ],
  provider_requests: [
    'id',
    'run_id',
    'turn_index',
    'retry_index',
    'purpose',
    'provider_name',
    'provider_kind',
    'model',
    'status',
    'measured_input_tokens',
    'occupancy_tokens',
    'provider_input_tokens',
    'provider_output_tokens',
    'provider_cache_write_tokens',
    'provider_cache_write_1h_tokens',
    'provider_cached_tokens',
    'sent_categories',
    'omitted_categories',
    'finish_reason',
    'error_code',
    'error_message',
    'diagnostic',
    'configuration',
    'payload_hash',
    'request_bytes',
    'cache_route_fingerprint',
    'input_image_batch_id',
    'sent_at',
    'headers_at',
    'cloud_request_id',
    'hedge_sent_at',
    'hedge_won',
    'anchored',
    'first_event_at',
    'first_content_at',
    'last_content_at',
    'last_content_kind',
    'last_visible_at',
    'completed_at',
    'created_at',
  ],
  request_envelopes: ['fingerprint', 'items', 'created_at'],
  intermediate_resources: [
    'id',
    'run_id',
    'step_id',
    'tool_name',
    'source_type',
    'status',
    'content_hash',
    'size_bytes',
    'mime_type',
    'coverage',
    'created_at',
  ],
  schedules: [
    'id',
    'workspace_root',
    'title',
    'prompt',
    'kind',
    'every_minutes',
    'at_hour',
    'at_minute',
    'enabled',
    'created_at',
    'last_run_at',
    'conversation_id',
    'new_conversation',
  ],
}
