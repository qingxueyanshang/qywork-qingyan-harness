import { definePort } from '@qywork/agent'
import type { TextFeatureCounts } from '@qywork/ai'
import type { CloudSkill } from '@qywork/core'

/**
 * 云端技能端口：本会话可用的云端技能包，以及技能包内文件的列举、按行段读取与字面检索。
 *
 * 本机不持有技能原文。读取返回标记（`@qywork/ai` 的 `parseSkillMarker` 可解析的一行文本）与该行段的文本特征计数，
 * 标记在请求经过云端网关时被替换为该行段；工具把它放在 `outcome.data.texts` 中（`@qywork/agent` 的 `textsOf`）。
 * 实现由 server 注入：设备密钥与云端地址只在该层。只在本轮经云端接口发送时注入：标记只由云端网关替换，
 * 发往其他接口时模型取得的只是标记。未注入时读取工具不识别云端技能的路径；工具的说明与参数不随它变化。
 * 技能包以内置层列入技能索引（`skills.ts` 的 `scanAllSkills`），`read_skill` 与文件工具按虚拟路径读取。
 *
 * 失败以结果返回，不抛出：每种失败都须以一句说明结束本次工具调用。
 */
export interface CloudSkillPort {
  /** 本会话可用的技能包。其余技能包的路径被读取工具拒绝。 */
  readonly packages: readonly CloudSkill[]
  /** 技能包的全部文件，按路径排序。 */
  files(pkg: string): Promise<CloudSkillResult<CloudSkillFile[]>>
  /** 签发第 `start` 至 `end` 行（从 1 起计，含两端）的标记；`end` 缺省为最后一行。 */
  read(
    pkg: string,
    path: string,
    start: number,
    end?: number,
  ): Promise<CloudSkillResult<CloudSkillSegment>>
  /** 按字面文本检索；`prefix` 限定路径前缀，空串为整个技能包。 */
  search(pkg: string, query: string, prefix: string): Promise<CloudSkillResult<CloudSkillMatches>>
}

export const CloudSkillPort = definePort<CloudSkillPort>('cloudSkills')

export interface CloudSkillFile {
  /** 技能包内的相对路径，以 `/` 分隔。 */
  path: string
  /** 字节数。 */
  size: number
}

export interface CloudSkillSegment {
  path: string
  /** 文件的总行数。 */
  lines: number
  start: number
  end: number
  /** 标记原文。 */
  marker: string
  /** 该行段的文本特征计数，与标记中的计数相同。 */
  features: TextFeatureCounts
}

export interface CloudSkillMatches {
  /** 含检索文本的行号（从 1 起计），按文件分组。 */
  matches: { path: string; lines: number[] }[]
  /** 命中行数超过云端的单次上限，其余未返回。 */
  truncated: boolean
}

/**
 * 读取失败的类别。前六项是云端读取接口的错误码；`unavailable` 是其余失败：未登录、设备密钥无效、连接失败、
 * 云端故障与无法解析的响应。
 */
export type CloudSkillErrorCode =
  | 'skill_not_granted'
  | 'skill_version_not_found'
  | 'skill_file_not_found'
  | 'skill_file_binary'
  | 'skill_range_invalid'
  | 'invalid_request'
  | 'unavailable'

export type CloudSkillResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CloudSkillErrorCode; message: string }
