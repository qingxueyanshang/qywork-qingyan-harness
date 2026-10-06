/**
 * 全机任务文件 `~/.qywork/schedules.json` 的一次性导入。
 *
 * 定时任务的唯一权威是主账本中的 `schedules` 表；`~/.qywork/schedules.json` 是迁移前的存储位置。
 * 此步骤将旧文件读入该表，然后将其重命名为 `schedules.json.imported`。
 *
 * 重入规则只有一条：文件不存在时不导入。重命名成功即表示本机已完成导入。
 *
 * 读取文件与重命名都在导入事务中执行。两个实例同时启动时，SQLite 的 IMMEDIATE 写事务将它们
 * 串行化：先取得写锁的实例读取文件、插入表、重命名、提交；另一个实例进入事务时文件已不存在，直接返回。
 * 在事务外读取文件时，两个实例会各自读取一份完整的旧数据，第二次插入触发主键冲突。
 * 残留风险：重命名成功而提交失败时，旧数据保留在重命名后的文件中，不会被再次导入。
 *
 * 内容不合法时停止，不视为空表继续执行：静默按空表处理会使界面上的定时任务全部消失，
 * 而原文件仍在磁盘上。
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationId, Schedule } from '@qywork/core'
import { diagnoseSchedule } from '@qywork/core'
import { getConversation, insertSchedules, type Store } from '@qywork/store'
import { configDir } from './config.ts'

/** 已落盘的文件名是历史事实，不改（CLAUDE.md D2）。 */
const LEGACY_NAME = 'schedules.json'
const IMPORTED_NAME = 'schedules.json.imported'

function legacyPath(): string {
  return join(configDir(), LEGACY_NAME)
}

/**
 * 旧文件中的记录。键名是历史事实，一律不改（CLAUDE.md D2）：`lastRunConversationId`
 * 读入后写入 `Schedule.conversationId`。
 */
interface LegacyRecord extends Partial<Omit<Schedule, 'conversationId'>> {
  lastRunConversationId?: string
}

/**
 * 逐条校验旧记录。任何一条不合法即中止整份导入：部分导入比不导入危害更大。
 *
 * 旧文件中的 `lastError` 不导入：执行结果的唯一权威是关联的 Run，
 * 而文件中的记录通常没有可核验的 Run，将其复制为新的运行状态等于伪造历史。
 *
 * 旧文件没有「每次触发另建会话」这一项，一律按 false 导入：绑定会话原样导入，
 * 导入后继续发送到同一会话。
 */
function parseLegacy(store: Store, raw: string, path: string): Schedule[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`定时任务文件不是合法 JSON，导入中止：${path}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`定时任务文件不是数组，导入中止：${path}`)

  const seen = new Set<string>()
  const out: Schedule[] = []
  for (const item of parsed as LegacyRecord[]) {
    const problems = diagnoseSchedule(item)
    if (typeof item.id !== 'string' || item.id === '') problems.push('id 缺失')
    else if (seen.has(item.id)) problems.push('id 重复')
    if (typeof item.workspaceRoot !== 'string' || item.workspaceRoot === '') {
      problems.push('workspaceRoot 缺失')
    }
    if (typeof item.enabled !== 'boolean') problems.push('enabled 缺失')
    if (typeof item.createdAt !== 'number') problems.push('createdAt 缺失')
    if (problems.length > 0) {
      throw new Error(
        `定时任务「${item.id ?? '未命名'}」不合法，导入中止：${problems.join('；')}（${path}）`,
      )
    }
    const id = item.id as string
    seen.add(id)
    // 关联会话已被删除时不导入该 id：外键会拒绝插入，且该会话已没有可读取的执行记录。
    const conversationId =
      item.lastRunConversationId !== undefined &&
      getConversation(store, item.lastRunConversationId as ConversationId) !== null
        ? item.lastRunConversationId
        : undefined
    out.push({
      id,
      workspaceRoot: item.workspaceRoot as string,
      title: item.title as string,
      prompt: item.prompt as string,
      kind: item.kind as Schedule['kind'],
      ...(item.everyMinutes === undefined ? {} : { everyMinutes: item.everyMinutes }),
      ...(item.atHour === undefined ? {} : { atHour: item.atHour }),
      ...(item.atMinute === undefined ? {} : { atMinute: item.atMinute }),
      enabled: item.enabled as boolean,
      createdAt: item.createdAt as number,
      ...(item.lastRunAt === undefined ? {} : { lastRunAt: item.lastRunAt }),
      ...(conversationId === undefined ? {} : { conversationId }),
      newConversation: false,
    })
  }
  return out
}

/**
 * 将旧任务文件导入主账本。返回导入的条数；文件不存在时返回 null。
 *
 * 文件不合法时抛出错误并保留原字节，由调用方经既有的启动失败路径退出。
 */
export function importLegacySchedules(store: Store): number | null {
  const path = legacyPath()
  if (!existsSync(path)) return null
  return store.tx(() => {
    if (!existsSync(path)) return null
    const list = parseLegacy(store, readFileSync(path, 'utf8'), path)
    insertSchedules(store, list)
    renameSync(path, join(configDir(), IMPORTED_NAME))
    return list.length
  })
}
