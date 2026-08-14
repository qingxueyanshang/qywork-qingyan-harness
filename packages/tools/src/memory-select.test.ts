/**
 * 记忆注入的挑选。
 *
 * 覆盖范围：`memory.ts` 的 `selectMemories` / `MEMORY_BUDGET_TOKENS`。
 *
 * 这一组锁的是**目录制的那个静默失效模式不再存在**：目录制下模型得自己判断
 * 哪条记忆相关，判断错了那条这一轮就等于不存在——而且不报错、界面上看不出来。
 * 「记忆没生效」和「记忆不存在」从外面看一模一样，出了问题查不出来。
 */

import { describe, expect, test } from 'bun:test'
import { MEMORY_BUDGET_TOKENS, selectMemories } from './memory.ts'

const m = (key: string, body: string) => ({ key, body, scope: 'user' as const })

describe('记忆挑选', () => {
  test('装得下就全发——条数少时等价于全部常驻', () => {
    const all = [m('a', '用 bun 不用 npm'), m('b', '端口固定 5173')]
    const { selected, deferred } = selectMemories(all, '随便问点什么')
    expect(selected).toHaveLength(2)
    expect(deferred).toHaveLength(0)
  })

  /** 发的是正文，不是「key：首行摘要」——否则模型还是得自己判断。 */
  test('发的是正文', () => {
    const { selected } = selectMemories([m('style', '缩进两空格，不用分号')], '格式')
    expect(selected[0]?.body).toBe('缩进两空格，不用分号')
  })

  test('相关的排在前面：中文二元组能召回', () => {
    const all = [
      m('deploy', '部署走 GitHub Actions，产物推到 release 分支'),
      m('style', '缩进两空格，不用分号'),
      m('db', '本地数据库用 sqlite，文件在 .qy 下'),
    ]
    // 预算压到只装得下一条，看谁被选中。
    const { selected } = selectMemories(all, '帮我看看数据库连接', 20)
    expect(selected[0]?.key).toBe('db')
  })

  /**
   * 超预算**转按需，不是丢失**。降级路径必须存在，否则记忆一多就变成随机丢几条，
   * 而那正是目录制那个失效模式换个地方复发。
   */
  test('超预算的转按需并如实报出来', () => {
    const all = Array.from({ length: 40 }, (_, i) => m(`k${i}`, 'x'.repeat(400)))
    const { selected, deferred } = selectMemories(all, '查询')
    expect(selected.length).toBeGreaterThan(0)
    expect(deferred.length).toBeGreaterThan(0)
    expect(selected.length + deferred.length).toBe(40)
  })

  test('至少发一条：单条超预算也不能一条都不发', () => {
    const { selected } = selectMemories([m('huge', 'y'.repeat(100_000))], '问题', 10)
    expect(selected).toHaveLength(1)
  })

  /**
   * 注入顺序按 key 定序，**不按相关性**。
   *
   * 相关性每轮都变，而尾区字节每变一次就是一次全价重付。
   * 哪些进来由相关性决定，进来之后怎么排由 key 决定。
   */
  test('同一批记忆的注入顺序稳定，与查询无关', () => {
    const all = [m('b', '乙'), m('a', '甲'), m('c', '丙')]
    const one = selectMemories(all, '甲').selected.map((x) => x.key)
    const two = selectMemories(all, '丙').selected.map((x) => x.key)
    expect(one).toEqual(['a', 'b', 'c'])
    expect(two).toEqual(one)
  })

  test('没有记忆时不产出任何东西', () => {
    expect(selectMemories([], '问题')).toEqual({ selected: [], deferred: [] })
  })

  test('预算是个真数字，不是无限', () => {
    expect(MEMORY_BUDGET_TOKENS).toBeGreaterThan(0)
    expect(MEMORY_BUDGET_TOKENS).toBeLessThan(10_000)
  })
})
