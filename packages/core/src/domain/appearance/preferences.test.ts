/** 覆盖 `preferences.ts`：界面偏好的整体校验与按字段合并。 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_UI_PREFERENCES,
  mergeUiPreferences,
  parseUiPreferences,
  type UiPreferences,
} from './preferences.ts'

describe('parseUiPreferences', () => {
  test('合法内容原样通过', () => {
    const value: UiPreferences = { theme: 'dark', fontScale: 1.15, followUpMode: 'steer' }
    expect(parseUiPreferences(value)).toEqual({ ok: true, value })
  })

  test('未知字段、词表之外的取值、越界或非数值的比例、缺少字段一律拒绝', () => {
    for (const raw of [
      { ...DEFAULT_UI_PREFERENCES, extra: 1 },
      { ...DEFAULT_UI_PREFERENCES, theme: 'blue' },
      { ...DEFAULT_UI_PREFERENCES, fontScale: 0.5 },
      { ...DEFAULT_UI_PREFERENCES, fontScale: 1.31 },
      { ...DEFAULT_UI_PREFERENCES, fontScale: '1' },
      { ...DEFAULT_UI_PREFERENCES, fontScale: Number.NaN },
      { ...DEFAULT_UI_PREFERENCES, followUpMode: 'later' },
      { theme: 'dark', fontScale: 1 },
      null,
      [],
    ]) {
      expect(parseUiPreferences(raw).ok).toBe(false)
    }
  })
})

describe('mergeUiPreferences', () => {
  test('只覆盖提交的字段，合并后整体校验', () => {
    expect(mergeUiPreferences(DEFAULT_UI_PREFERENCES, { theme: 'light' })).toEqual({
      ok: true,
      value: { ...DEFAULT_UI_PREFERENCES, theme: 'light' },
    })
    expect(mergeUiPreferences(DEFAULT_UI_PREFERENCES, { fontScale: 9 }).ok).toBe(false)
    expect(mergeUiPreferences(DEFAULT_UI_PREFERENCES, 'dark').ok).toBe(false)
  })
})
