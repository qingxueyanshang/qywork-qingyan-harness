/**
 * SQLite 账本表结构：按执行顺序列出全部迁移，并派生 schema 版本。
 *
 * 每条迁移一个文件，文件名为三位 id 加 `name`（下划线替换为连字符）。新增迁移时新建下一个 id 的文件，
 * 在此处导入并追加到数组末尾。已有的迁移不得修改：已落盘的库按 `_migrations` 中登记的 id 跳过已执行的迁移，
 * 修改后的内容不会在这些库上执行。
 *
 * 三条结构约束：
 *
 * - **主键使用带前缀的字符串 ID，不使用自增整数。** 这些表都有删除路径，普通
 *   INTEGER PRIMARY KEY 会复用已删除的最大 id，使不带外键的跨表引用（如
 *   `usage_ledger.run_id`）指向另一行且不报错。字符串 ID 在结构上排除这一问题。
 * - **外键引用列一律建索引。** PRAGMA foreign_keys=ON 时，每删除一条父行，SQLite 都要
 *   在子表中查找引用行，无索引即退化为全表扫描；删除一个长会话会耗时十余秒并触发
 *   busy_timeout。
 * - **cached_tokens 可空。** null 表示 provider 未回报，与实际命中为 0 含义不同。
 */

import { migration001 } from './001-initial.ts'
import { migration002 } from './002-intermediate-resources.ts'
import { migration003 } from './003-usage-ledger.ts'
import { migration004 } from './004-usage-kind-classifier.ts'
import { migration005 } from './005-drop-unwritten-columns.ts'
import { migration006 } from './006-conversation-effort.ts'
import { migration007 } from './007-multi-currency-cost.ts'
import { migration008 } from './008-conversation-extras.ts'
import { migration009 } from './009-workspace-removed-at.ts'
import { migration010 } from './010-workspace-pinned-at.ts'
import { migration011 } from './011-conversation-archived-at.ts'
import { migration012 } from './012-drop-conversation-effort.ts'
import { migration013 } from './013-provider-request-ledger.ts'
import { migration014 } from './014-run-lease.ts'
import { migration015 } from './015-file-reads.ts'
import { migration016 } from './016-action-kind-six.ts'
import { migration017 } from './017-tool-renamed-write-todos.ts'
import { migration018 } from './018-todos-message-wording-again.ts'
import { migration019 } from './019-external-tools-action-call.ts'
import { migration020 } from './020-external-tools-object-label.ts'
import { migration021 } from './021-memory-tool-split.ts'
import { migration022 } from './022-goals.ts'
import { migration023 } from './023-conversation-loaded-tools.ts'
import { migration024 } from './024-conversation-provider.ts'
import { migration025 } from './025-provider-finish-reason.ts'
import { migration026 } from './026-thinking-step-kind.ts'
import { migration027 } from './027-tool-image-bytes-array.ts'
import { migration028 } from './028-step-duration.ts'
import { migration029 } from './029-user-step-kind.ts'
import { migration030 } from './030-drop-manual-retry.ts'
import { migration031 } from './031-provider-error-message.ts'
import { migration032 } from './032-run-context-snapshot.ts'
import { migration033 } from './033-provider-request-transport-metrics.ts'
import { migration034 } from './034-execution-failure-diagnostics.ts'
import { migration035 } from './035-ensure-execution-failure-diagnostics.ts'
import { migration036 } from './036-normalize-run-failure-messages.ts'
import { migration037 } from './037-canonical-runtime-records.ts'
import { migration038 } from './038-conversation-parent.ts'
import { migration039 } from './039-subagent-kind.ts'
import { migration040 } from './040-step-nodes.ts'
import { migration041 } from './041-delegation-kind-args.ts'
import { migration042 } from './042-temp-subagent-names.ts'
import { migration043 } from './043-subagent-names.ts'
import { migration044 } from './044-temp-cells-by-model.ts'
import { migration045 } from './045-single-cell-duration.ts'
import { migration046 } from './046-temp-cells-by-name.ts'
import { migration047 } from './047-usage-summary-keeps-run-id.ts'
import { migration048 } from './048-usage-summary-backfill-run-id.ts'
import { migration049 } from './049-provider-requests-purpose.ts'
import { migration050 } from './050-message-origin.ts'
import { migration051 } from './051-run-dispatch.ts'
import { migration052 } from './052-watcher-hidden-dirs.ts'
import { migration053 } from './053-watcher-dot-paths.ts'
import { migration054 } from './054-schedules.ts'
import { migration055 } from './055-workspace-root-separator.ts'
import { migration056 } from './056-control-object-labels.ts'
import { migration057 } from './057-schedule-conversation.ts'
import { migration058 } from './058-provider-request-headers-at.ts'
import { migration059 } from './059-provider-request-input-image-batch-id.ts'
import { migration060 } from './060-provider-request-last-content-at.ts'
import { migration061 } from './061-provider-request-visible-progress.ts'
import { migration062 } from './062-drop-permission-rules-and-audit.ts'
import { migration063 } from './063-drop-conversation-extras.ts'
import { migration064 } from './064-media-spend.ts'
import { migration065 } from './065-user-only-messages.ts'
import { migration066 } from './066-provider-request-occupancy-tokens.ts'
import { migration067 } from './067-provider-request-configuration.ts'
import { migration068 } from './068-run-owner-kind.ts'
import { migration069 } from './069-provider-request-hedge.ts'
import { migration070 } from './070-tool-images-to-content-store.ts'
import { migration071 } from './071-conversation-permission-mode.ts'
import { migration072 } from './072-tool-image-sizes.ts'
import { migration073 } from './073-provider-request-anchored.ts'
import { migration074 } from './074-message-origin-command.ts'
import { migration075 } from './075-provider-request-cloud-request-id.ts'
import { migration076 } from './076-provider-request-cache-write-1h-tokens.ts'
import { migration077 } from './077-request-envelopes.ts'
import { migration078 } from './078-compaction-summary-blocks.ts'
import { migration079 } from './079-run-provider.ts'
import { migration080 } from './080-workspace-panel.ts'
import { migration081 } from './081-tool-action-heads.ts'
import { migration082 } from './082-interrupted-steps.ts'
import { migration083 } from './083-canvas-tool-head.ts'
import type { Migration } from './shared.ts'

export const MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
  migration030,
  migration031,
  migration032,
  migration033,
  migration034,
  migration035,
  migration036,
  migration037,
  migration038,
  migration039,
  migration040,
  migration041,
  migration042,
  migration043,
  migration044,
  migration045,
  migration046,
  migration047,
  migration048,
  migration049,
  migration050,
  migration051,
  migration052,
  migration053,
  migration054,
  migration055,
  migration056,
  migration057,
  migration058,
  migration059,
  migration060,
  migration061,
  migration062,
  migration063,
  migration064,
  migration065,
  migration066,
  migration067,
  migration068,
  migration069,
  migration070,
  migration071,
  migration072,
  migration073,
  migration074,
  migration075,
  migration076,
  migration077,
  migration078,
  migration079,
  migration080,
  migration081,
  migration082,
  migration083,
]

/**
 * 当前 schema 版本 = 最后一条迁移的 id。
 *
 * **由迁移表派生，不手写。** 手写的值与迁移表之间没有任何约束：新增迁移时遗漏修改，
 * 它就与迁移表不一致且无法察觉，因为实际决定迁移的是 `_migrations` 表，
 * 没有任何消费者校验该常量。派生后两者必然一致。
 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id
