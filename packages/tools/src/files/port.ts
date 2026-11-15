import { definePort } from '@qywork/agent'

/**
 * 会话读取文件时该文件的内容记录。写入前的新鲜度校验依赖它。
 *
 * **为什么必须是端口，不能放入 `state`。** `state` 是 **run 内的临时状态**（投递额度、计划快照均在其
 * 中，前者每次决策时重新建立），而读取记录的生命周期应为**整条会话**：模型上一轮读取、本轮直接修改是正常
 * 用法，记录绑定在 run 上意味着每轮首次修改文件必然先以「未读取过」失败一次。服务端**每条消息新建
 * 一个 Session**，进程中没有可绑定的会话级生命周期，因此生命周期由装配方管理（runtime 使用账本按会话
 * 存储），此处只约定形状。
 *
 * 可选：未注入时工具退化为 run 内记录，这是**更严格**的一侧（每轮要求重新读取一次），
 * 漏接不会放宽任何边界。
 */
export interface FileReadPort {
  /** 读取过时返回读取时的内容哈希，否则返回 null。 */
  seen(path: string): string | null
  /** 记录刚读取（或刚写入）的内容哈希。 */
  mark(path: string, hash: string): void
}

export const FileReadPort = definePort<FileReadPort>('reads')
