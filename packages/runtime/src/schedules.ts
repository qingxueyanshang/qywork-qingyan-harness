/**
 * 全机任务文件 `~/.qywork/schedules.json` 的一次性导入。
 *
 * 定时任务过去存在 `~/.qywork/schedules.json`，现在的唯一权威是主账本里的 `schedules` 表。
 * 这一步把旧文件读进表里，然后把它改名为 `schedules.json.imported`。
 *
 * **重入规则只有一条：文件不在就不导入。** 改名成功即代表这台机器已经导过。
 *
 * **读文件与改名都在导入事务里做。** 两个实例同时启动时，SQLite 的 IMMEDIATE 写事务把它们
 * 串起来：先拿到写权的那个读文件、插表、改名、提交；另一个进事务时文件已经不在，直接空转。
 * 在事务外读文件的话两个实例会各读到一份完整旧表，第二个插入撞主键。
 * 残留窗口：改名成功而提交失败时，旧数据留在改名后的文件里，不会被再次导入。
 *
 * **不合法就停，不当成空表继续跑。** 静默按空处理等于界面上定时任务全部消失，用户会再建一遍，
 * 而原文件仍在盘上。
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
 * 旧文件里的记录。**键名是历史事实，一律不改**（CLAUDE.md D2）——`lastRunConversationId`
 * 读进来落到 `Schedule.conversationId`。
 */
interface LegacyRecord extends Partial<Omit<Schedule, 'conversationId'>> {
  lastRunConversationId?: string
}

/**
 * 逐条校验旧记录。任何一条不合法就整份中止——半份导入比不导入坏得多。
 *
 * 旧文件里的 `lastError` 不带过来：执行结果的唯一权威是关联的 Run，
 * 而文件里的记录通常没有可核验的 Run，把它复制成一份新的运行状态就是伪造历史。
 *
 * 旧文件没有「每次触发另建会话」这一项，一律按 false 导入：绑定会话原样带过来，
 * 导入后接着发进同一条会话。
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
    // 关联会话已经被删掉时不带这个 id：外键会拒绝插入，而那条会话本来就没有执行记录可读。
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
 * 把旧任务文件导进主账本。返回导入的条数；文件不在时返回 null。
 *
 * 文件不合法时抛错并保留原字节，由调用方沿既有启动失败路径退出。
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
