/**
 * 测试中等待异步结果的共用写法：轮询条件，期限内未成立时以条件说明失败。各包的测试经
 * `@qywork/core/until.test-helper` 导入，不由包入口导出。
 *
 * 不要改为「固定时长后断言」：机器负载高时固定时长不足，条件成立之前即断言而失败。
 * 期限默认小于单条用例的 5 秒上限，超时报出的是所等待的条件，而不是用例整体超时。
 * 期限按 `performance.now()` 计算：部分用例替换了 `Date.now`，按它计算的期限不会到达。
 * 启用假计时器的用例不能使用本函数：轮询间隔由计时器实现，假计时器下不会推进。
 */
export async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (performance.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
