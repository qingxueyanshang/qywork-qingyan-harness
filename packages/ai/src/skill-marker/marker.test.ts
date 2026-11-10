/**
 * 覆盖 `skill-marker/marker.ts`：签发、解析与签名校验，规范形式的唯一性，以及标记中的字符不被 `JSON.stringify` 转义。
 */
import { describe, expect, test } from 'bun:test'
import { textFeatures } from '../tokens.ts'
import {
  isSkillPackageId,
  issueSkillMarker,
  parseSkillMarker,
  SKILL_MARKER_PREFIX,
  type SkillSegmentRef,
  verifySkillMarker,
} from './marker.ts'

const KEY = new TextEncoder().encode('test-key-test-key-test-key-test-key')
const OTHER_KEY = new TextEncoder().encode('other-key-other-key-other-key-other')
const HASH = 'a'.repeat(64)
const REF: SkillSegmentRef = {
  pkg: 'flow-video-script',
  path: 'references/library/fights.md',
  hash: HASH,
  start: 1,
  end: 120,
}
const SEGMENT = '# 打斗\n\nfirstLine 第一行，含 ASCII 与中文。\n'

describe('签发与解析', () => {
  test('签发的标记可解析回同样的字段，特征计数取自替换内容', () => {
    const issued = issueSkillMarker(REF, SEGMENT, 'user_1', KEY)
    expect(issued.text.startsWith(SKILL_MARKER_PREFIX)).toBe(true)
    expect(issued.features).toEqual(textFeatures(SEGMENT))
    const parsed = parseSkillMarker(issued.text)
    expect(parsed).toEqual({ ...REF, features: textFeatures(SEGMENT), sig: expect.any(String) })
  })

  test('标记是一行文本，格式固定', () => {
    const { text } = issueSkillMarker(REF, SEGMENT, 'user_1', KEY)
    expect(text).not.toContain('\n')
    expect(text).toMatch(
      /^\[\[qyskill\/1 pkg=flow-video-script path=references\/library\/fights\.md sha256=a{64} lines=1-120 f=(\d+,){9}\d+ sig=[A-Za-z0-9_-]{43}\]\]$/,
    )
  })

  test('路径中的特殊字符经百分号编码后不被 JSON.stringify 转义，解析后还原', () => {
    const paths = [
      '资料/第 1 章.md',
      'a"b\\c]d%e.md',
      'tab\there\nnew.md',
      '全角　空格 分隔.md',
      'emoji/😀.md',
      'ctl/\u0001\u007f\u0085.md',
    ]
    for (const path of paths) {
      const { text } = issueSkillMarker({ ...REF, path }, SEGMENT, 'user_1', KEY)
      expect(JSON.stringify(text)).toBe(`"${text}"`)
      expect(text.split(' ').length).toBe(7)
      expect(parseSkillMarker(text)?.path).toBe(path)
    }
  })

  test('只接受规范形式：前导零、多余的编码、其他契约版本与改动格式的文本不是标记', () => {
    const { text } = issueSkillMarker(REF, SEGMENT, 'user_1', KEY)
    const variants = [
      text.replace('lines=1-120', 'lines=01-120'),
      text.replace('path=references', 'path=%72eferences'),
      text.replace('[[qyskill/1 ', '[[qyskill/2 '),
      text.replace(' path=', '  path='),
      ` ${text}`,
      `${text} `,
      text.replace('lines=1-120', 'lines=120-1'),
      text.replace('lines=1-120', 'lines=0-120'),
      text.replace('pkg=flow-video-script', 'pkg=Flow'),
      text.replace(`sha256=${HASH}`, 'sha256=abc'),
      text.slice(0, -2),
    ]
    for (const v of variants) expect(parseSkillMarker(v)).toBeNull()
  })

  test('字段不合法时签发抛出', () => {
    expect(() => issueSkillMarker({ ...REF, pkg: '../x' }, '', 'u', KEY)).toThrow()
    expect(() => issueSkillMarker({ ...REF, path: '' }, '', 'u', KEY)).toThrow()
    expect(() => issueSkillMarker({ ...REF, path: 'a\ud800b' }, '', 'u', KEY)).toThrow()
    expect(() => issueSkillMarker({ ...REF, hash: 'ABC' }, '', 'u', KEY)).toThrow()
    expect(() => issueSkillMarker({ ...REF, start: 3, end: 2 }, '', 'u', KEY)).toThrow()
    expect(() => issueSkillMarker({ ...REF, start: 0 }, '', 'u', KEY)).toThrow()
  })

  test('技能包标识只接受小写字母、数字与 . _ -', () => {
    expect(isSkillPackageId('flow-video-script')).toBe(true)
    expect(isSkillPackageId('ppt_v2.1')).toBe(true)
    for (const id of ['', '-x', 'A', 'a/b', '中文', 'a'.repeat(65)]) {
      expect(isSkillPackageId(id)).toBe(false)
    }
  })
})

describe('签名校验', () => {
  test('同一密钥、同一账号校验通过', () => {
    const marker = parseSkillMarker(issueSkillMarker(REF, SEGMENT, 'user_1', KEY).text)
    expect(marker && verifySkillMarker(marker, 'user_1', KEY)).toBe(true)
  })

  test('换账号、换密钥或改动任一字段后校验失败', () => {
    const { text } = issueSkillMarker(REF, SEGMENT, 'user_1', KEY)
    const marker = parseSkillMarker(text)
    if (!marker) throw new Error('标记无法解析')
    expect(verifySkillMarker(marker, 'user_2', KEY)).toBe(false)
    expect(verifySkillMarker(marker, 'user_1', OTHER_KEY)).toBe(false)
    const tampered = [
      { ...marker, pkg: 'other-pkg' },
      { ...marker, path: 'roles/team.md' },
      { ...marker, hash: 'b'.repeat(64) },
      { ...marker, end: 121 },
      { ...marker, features: { ...marker.features, cjk: marker.features.cjk + 1 } },
    ]
    for (const m of tampered) expect(verifySkillMarker(m, 'user_1', KEY)).toBe(false)
  })

  test('签名被截短或替换时校验失败，不抛出', () => {
    const marker = parseSkillMarker(issueSkillMarker(REF, SEGMENT, 'user_1', KEY).text)
    if (!marker) throw new Error('标记无法解析')
    expect(verifySkillMarker({ ...marker, sig: marker.sig.slice(0, 20) }, 'user_1', KEY)).toBe(
      false,
    )
    expect(verifySkillMarker({ ...marker, sig: 'A'.repeat(43) }, 'user_1', KEY)).toBe(false)
  })
})
