/**
 * 界面偏好：主题、字体大小与跟进处理方式的格式与校验。
 *
 * 不变量：
 * - 只有一份，保存在电脑上；本机窗口、远程打开的界面与手机读写同一份，一端修改后其余各端随之变化。
 * - 校验严格拒绝：未知字段、越界数值、词表之外的取值一律返回错误，不做修正。
 * - 修改按字段合并（`mergeUiPreferences`）：各端只提交改动的字段，两端同时修改不同字段时互不覆盖。
 */

/** 主题。`system` 是独立的一档：用深色开关代替时，系统切换为深色后应用是否跟随无法区分。 */
export type ThemePref = 'system' | 'light' | 'dark'

/**
 * 会话运行期间发送消息的默认方式。`queue` 等当前一轮执行完毕后作为下一轮发起；`steer` 注入当前一轮，
 * 模型在下一次请求中即可看到。界面上对应「加入队列」与「调整方向」。
 */
export type FollowUpMode = 'queue' | 'steer'

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']

export const FOLLOW_UP_MODES: readonly FollowUpMode[] = ['queue', 'steer']

/** 字体大小相对默认字号的比例范围。上限受固定高度的控件限制：行内按钮与分段控件的高度不随文字变化。 */
export const FONT_SCALE_RANGE = [0.9, 1.3] as const

export interface UiPreferences {
  theme: ThemePref
  fontScale: number
  followUpMode: FollowUpMode
}

/** 已保存的界面偏好。`updatedAt` 为 0 表示从未保存，内容即默认值。 */
export interface UiPreferencesEntry {
  preferences: UiPreferences
  updatedAt: number
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: 'system',
  fontScale: 1,
  followUpMode: 'queue',
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const FIELDS = ['theme', 'fontScale', 'followUpMode'] as const

/** 校验一份完整的界面偏好。 */
export function parseUiPreferences(raw: unknown): Parsed<UiPreferences> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '界面偏好必须是对象' }
  }
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).find((key) => !(FIELDS as readonly string[]).includes(key))
  if (unknown !== undefined) return { ok: false, error: `界面偏好中有无法识别的字段：${unknown}` }
  if (!THEME_PREFS.includes(o.theme as ThemePref)) {
    return { ok: false, error: `theme 必须是 ${THEME_PREFS.join('、')} 之一` }
  }
  const [min, max] = FONT_SCALE_RANGE
  const scale = o.fontScale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < min || scale > max) {
    return { ok: false, error: `fontScale 必须是 ${min} 到 ${max} 之间的数值` }
  }
  if (!FOLLOW_UP_MODES.includes(o.followUpMode as FollowUpMode)) {
    return { ok: false, error: `followUpMode 必须是 ${FOLLOW_UP_MODES.join('、')} 之一` }
  }
  return {
    ok: true,
    value: {
      theme: o.theme as ThemePref,
      fontScale: scale,
      followUpMode: o.followUpMode as FollowUpMode,
    },
  }
}

/** 把部分修改合并到已有界面偏好上，再整体校验。 */
export function mergeUiPreferences(base: UiPreferences, patch: unknown): Parsed<UiPreferences> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: '修改内容必须是对象' }
  }
  return parseUiPreferences({ ...base, ...patch })
}
