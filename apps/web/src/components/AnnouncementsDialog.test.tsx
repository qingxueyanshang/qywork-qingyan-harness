/**
 * 覆盖 `AnnouncementsDialog.tsx` 的 `publishedDate`：公告的发布日期按北京时间显示。
 * 列表渲染与关闭由 `announcements.test.tsx` 覆盖。
 *
 * 原始失败形状：截取 UTC 时刻的前 10 位作为日期，北京时间 11-12 07:30 发布的公告显示为 11-11。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('发布日期按北京时间：北京时间 0 点到 8 点发布的公告不显示为前一天', async () => {
  const { publishedDate } = await import('./AnnouncementsDialog.tsx')
  expect(publishedDate('2026-11-11T23:30:00.000Z')).toBe('2026-11-12')
  expect(publishedDate('2026-11-11T15:59:59.999Z')).toBe('2026-11-11')
  expect(publishedDate('2026-11-11T16:00:00.000Z')).toBe('2026-11-12')
})
