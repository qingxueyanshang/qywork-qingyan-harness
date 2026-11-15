/** 回执 message 中的读数行：控件、歧义候选、观察、输入框与窗口标题。 */

import { MAX_TITLE_CHARS } from '../../desktop-results.ts'
import type { DesktopElement, DesktopSnapshot } from '../port.ts'

/**
 * message 中控件值最多输出的字数。
 *
 * 取 200，与浏览器观察对名称、值的采集上限同一量级。超过时只输出字数：message 与控件表
 * 同时输出同一份长文本会使整条结果超出投递上限，而控件表中已包含该值。
 */
const MAX_LINE_VALUE_CHARS = 200

/**
 * message 中描述一个控件的行。动作回执的目标与歧义候选清单共用该格式。
 *
 * 长值只输出字数，原文不进入 message：原文在同一条结果的控件表中，视图经过裁剪时该控件带有
 * `valueOmittedChars`。回读核验按完整值判定，不读取该行。
 */
export function elementLine(e: DesktopElement): string {
  return (
    `${e.ref} ${e.role} ${e.name || '(无名称)'}` +
    (e.automationId ? ` #${e.automationId}` : '') +
    valueLabel(e.value) +
    selectedLabel(e) +
    (e.enabled ? '' : ' 已禁用')
  )
}

function valueLabel(value: string | undefined): string {
  if (value === undefined) return ''
  if (value.length <= MAX_LINE_VALUE_CHARS) return ` = ${JSON.stringify(value)}`
  return ` · 值 ${value.length} 字，见控件表`
}

/** 选择容器当前的选中项。没有选中项时不输出。 */
function selectedLabel(e: DesktopElement): string {
  const names = e.selection?.selected
  if (!names?.length) return ''
  const listed = names.map((n) => JSON.stringify(n)).join('、')
  return ` 选中 ${listed}${e.selection?.truncated === true ? ' 等' : ''}`
}

function shortLabel(e: DesktopElement): string {
  return e.name ? `${e.role}「${e.name}」` : e.role
}

/**
 * 一个控件的祖先路径，由外层向内层书写。
 *
 * 同名控件只能依靠祖先路径区分：两个都名为「保存」的按钮，一个在工具栏中、一个在对话框中。
 * 路径沿 `parentRef` 在同一张控件表中向上查找；父控件不在表中时停止，返回已找到的
 * 部分：观察只读取了一棵子树时，范围根以上的祖先不在表中。
 */
function ancestorPath(table: DesktopElement[], element: DesktopElement): string {
  const byRef = new Map(table.map((e) => [e.ref, e]))
  const parts: string[] = []
  const seen = new Set<string>([element.ref])
  let at = element.parentRef
  while (at !== undefined && !seen.has(at)) {
    seen.add(at)
    const parent = byRef.get(at)
    if (!parent) break
    parts.unshift(shortLabel(parent))
    at = parent.parentRef
  }
  return parts.join(' > ')
}

/**
 * 歧义回执中的一条候选：控件本身及其祖先路径。
 *
 * 身份不稳定的控件另加说明：应用未提供稳定标识，界面重排后该编号会被拒绝，需要重新观察。
 */
export function candidateLine(table: DesktopElement[], e: DesktopElement): string {
  const path = ancestorPath(table, e)
  const weak = e.weakIdentity === true ? ' 身份不稳定' : ''
  return path ? `${elementLine(e)}（位于 ${path}）${weak}` : `${elementLine(e)}${weak}`
}

/** 一份观察的单行读数：控件数、截断与筛选各说明一次。 */
export function snapshotLine(s: DesktopSnapshot): string {
  return (
    `${s.observationId} · ${s.elements.length} 个控件` +
    (s.windowEnabled ? '' : ' · 被模态窗口遮挡') +
    (s.windowCovered ? ' · 窗口被遮挡或已最小化' : '') +
    (s.truncated ? ` · 未读取完整 ${s.truncatedBy.join(' / ')}` : '') +
    (s.filteredBy.length ? ` · 已筛选 ${s.filteredBy.join(' / ')}` : '')
  )
}

/** 回执中一个输入框的值，与 `valueLabel` 使用同一长度规则：超长时只输出字数，原文在控件表中。 */
export function fieldValue(value: string | undefined): string {
  if (value === undefined) return '无法回读'
  if (value.length <= MAX_LINE_VALUE_CHARS) return JSON.stringify(value)
  return `${value.length} 字`
}

/** 输入框在输入前后的值：模型据此了解输入之前框中的内容。 */
export function fieldLine(
  ref: string,
  before: string | undefined,
  after: string | undefined,
): string {
  return ` · ${ref} 原值 ${fieldValue(before)} → 现值 ${fieldValue(after)}`
}

/** message 中的窗口标题。标题由应用自行报告，长度无上限，超过上限时输出前缀；`data` 中的标题按结果生成的规则处理。 */
export function windowTitle(title: string): string {
  if (!title) return '(无标题)'
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS)}…`
}
