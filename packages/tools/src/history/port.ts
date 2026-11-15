import { type DeclaredText, definePort } from '@qywork/agent'

/**
 * 一条执行记录的取回形态。
 *
 * `images` 与 `outcome` 分开：图像字节经由图像块传递，不序列化到 outcome 文本中。
 * 一张截图的 base64 可达数 MB，作为文本返回给模型既无法被理解，又会占满投递预算。
 */
export interface HistoryStep {
  tool: string
  status: string
  args: string
  outcome: string
  images?: { data: string; mime: string }[]
  /** 读取时交付的视频：以路径引用，见 `@qywork/agent` 的 `videosOf`。 */
  videos?: { path: string; mime: string }[]
  /** 附带文本块：标记与声明的特征计数，见 `@qywork/agent` 的 `textsOf`。不序列化到 outcome 文本中。 */
  texts?: DeclaredText[]
}

/**
 * 已折叠会话历史的读取通道。
 *
 * **为什么必须存在。** 压缩是投影而不是删除：manifest 只描述发送请求时如何折叠，`messages` /
 * `steps` 不改动任何字节。但折叠之后模型只持有摘要，**缺少此通道时，没有任何工具能按摘要中的 `[message:…]` /
 * `[action:…]` 标记取回原文**，数据保留在库中却没有消费者。有此通道，压缩的语义才是「将内容从常
 * 驻上下文移到按需读取」，而不是「丢弃」。
 *
 * 与 `SinkPort` 的分工：`SinkPort` 读取**工具产出的正文**（落盘的 `rs_xxx`），
 * 本端口读取**会话历史本身**（消息与执行记录）。两者不重叠，也不互为后备。
 *
 * 装配方持有账本时应注入。未注入是合法的：工具已注册而端口未注入时如实报告「无法读取历史」，**不要退化为
 * 「未找到」**：后者会使模型认为 id 写错，进而花费多轮推测一个无法取得的 id。
 */
export interface HistoryPort {
  /**
   * 按消息 id 取回原文。不存在时返回 null。
   *
   * **须同时识别两种 id**：`messages` 表的行 id，以及 run 内注入的用户消息的
   * `<runId>:<stepId>`；后者不在 `messages` 表中（它是一条 `kind='user'` 的 step）。
   * 摘要中两者均输出为 `[message:…]`，模型无法区分，也无需区分。
   */
  message(id: string): { role: 'user' | 'assistant'; content: string } | null
  /**
   * 按执行记录 id 取回原文。
   *
   * id 使用摘要中的 `<runId>:<stepId>` 复合形式：单独的 step id 在跨 run 的
   * 会话中不唯一，而摘要正文引用的是跨 run 的早期记录。
   */
  step(id: string): HistoryStep | null
  /**
   * 按工具调用 id 取回该次调用的执行记录。
   *
   * 收纳段将工具结果的正文替换为信封，信封中保留 `call_id`，**它即为取回地址**。
   * 已落盘的结果经由 `resources` + `read_resource` 读取，未落盘的中小结果只能经由此方法取回：
   * 缺少此方法时，收纳等同于删除。
   *
   * 因此不向信封添加新键：信封每增加一个字段，所有历史请求的字节都会变化，
   * 前缀缓存全部失配。
   */
  byCallId(callId: string): HistoryStep | null
  /**
   * 在本会话的全部历史中搜索子串，返回命中项及其定位符。
   *
   * 理由与 `read_resource` 的 `query` 相同：已知查找目标时，
   * 搜索比让模型推测 id 更快，开销也更小。
   */
  search(query: string, limit: number): { id: string; kind: 'message' | 'step'; line: string }[]
  /**
   * 本会话派发的某个子 agent 的历史，以相同的方法按该子 agent 的会话读取。
   * 不属于本会话的 id 返回 null：子 agent 的历史只对创建它的会话可见。
   */
  forSubagent(id: string): HistoryPort | null
}

export const HistoryPort = definePort<HistoryPort>('history')
