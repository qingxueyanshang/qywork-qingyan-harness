/**
 * `qy export`：把会话导出为 markdown 或 json。
 *
 *   qy export                      列出会话供选择
 *   qy export <会话 id>            以 markdown 格式输出到 stdout
 *   qy export <会话 id> --json     导出为 json（完整，不裁剪）
 *   qy export <会话 id> -o out.md  写入文件
 */

import { writeFile } from 'node:fs/promises'
import type { ConversationId } from '@qywork/core'
import { dataPath, exportConversation } from '@qywork/runtime'
import { listRecentConversations, Store } from '@qywork/store'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

export async function runExport(args: string[]): Promise<number> {
  const json = args.includes('--json')
  const thinking = args.includes('--thinking')
  const outFlag = args.findIndex((a) => a === '-o' || a === '--out')
  const out = outFlag >= 0 ? args[outFlag + 1] : undefined
  // 没有 -o 时 outFlag 为 -1，`outFlag + 1` 为 0；直接比较会把第一个位置参数
  // （即会话 id）误当作 -o 的值而排除。计算该下标前必须先确认 -o 存在。
  const outValueIndex = outFlag >= 0 ? outFlag + 1 : -1
  const id = args.find((a, i) => !a.startsWith('-') && i !== outValueIndex)

  const store = new Store({ path: dataPath() })
  try {
    if (!id) {
      // 不默认取最近的会话：导出结果用于存档或转发，导出了错误的会话在使用过程中不会被发现。
      const rows = listRecentConversations(store, 20)
      if (rows.length === 0) {
        process.stderr.write('尚无会话。\n')
        return 1
      }
      process.stderr.write('请选择一个会话 id：\n\n')
      for (const c of rows) {
        process.stderr.write(
          `  ${c.id}  ${DIM}${new Date(c.updatedAt).toISOString().slice(0, 16).replace('T', ' ')}${RESET}  ${c.title || '未命名'}\n`,
        )
      }
      process.stderr.write(`\n${DIM}用法：qy export <会话 id> [--json] [-o 文件]${RESET}\n`)
      return 1
    }

    let text: string
    try {
      text = exportConversation(store, id as ConversationId, json ? 'json' : 'markdown', {
        includeThinking: thinking,
      })
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    if (out) {
      await writeFile(out, text, 'utf8')
      process.stderr.write(`已写入 ${out}（${text.length} 字符）\n`)
    } else {
      process.stdout.write(text)
    }
    return 0
  } finally {
    store.close()
  }
}
