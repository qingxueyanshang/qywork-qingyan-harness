/**
 * 端口：由上层装配方注入、只被少数工具使用的能力接口。
 *
 * 工具经 `ctx.port(键)` 取用，`null` 表示本次执行没有该能力，工具须降级或如实报告；
 * 没有降级形态的工具把端口写入 `ToolSpec.requires`，未提供时不注册。
 * 接口与键定义在使用它的包中，实现由更高层的装配方提供：反向引用会使包依赖成环。
 *
 * 键按对象身份比较，名称只用于报错。
 */

export interface PortKey<T> {
  readonly name: string
  /** 只承载类型参数，运行时不存在。 */
  readonly type?: T
}

export function definePort<T>(name: string): PortKey<T> {
  return Object.freeze({ name })
}

/** 一项端口：键与实现。由 `provide` 构造，实现的类型受键约束。 */
export interface PortEntry {
  readonly key: PortKey<unknown>
  readonly value: unknown
}

export function provide<T>(key: PortKey<T>, value: NoInfer<T>): PortEntry {
  return { key, value }
}

/**
 * 端口集合。装配方构造一次，内置工具的注册与工具上下文的取用读取同一份。
 *
 * 同一个键提供两次即装配错误，直接抛出，不覆盖：覆盖会使两处装配中的一处静默失效。
 */
export class Ports {
  private readonly entries: readonly PortEntry[]
  private readonly values = new Map<PortKey<unknown>, unknown>()

  constructor(entries: readonly PortEntry[] = []) {
    this.entries = entries
    for (const { key, value } of entries) {
      if (this.values.has(key)) throw new Error(`[QyWork] 端口重复提供，拒绝覆盖：${key.name}`)
      this.values.set(key, value)
    }
  }

  /** 取用一个端口，未提供时为 null。以属性定义，可直接作为 `ToolContext.port` 传递。 */
  readonly get = <T>(key: PortKey<T>): T | null =>
    this.values.has(key) ? (this.values.get(key) as T) : null

  has(key: PortKey<unknown>): boolean {
    return this.values.has(key)
  }

  /** 在本集合之上再提供若干端口，返回新集合，本集合不变。 */
  with(entries: readonly PortEntry[]): Ports {
    return new Ports([...this.entries, ...entries])
  }
}
