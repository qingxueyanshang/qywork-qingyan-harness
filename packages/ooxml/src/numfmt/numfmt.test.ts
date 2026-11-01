/**
 * 覆盖：`format.ts`（分节、条件、颜色、数字占位、千分位与缩放、百分比、科学计数、分数、文本节、
 * 引号与转义、`_`/`*` 片段、日期时间、累计时间、区域代码、中文数字）、`general.ts`（常规格式与按宽度取舍）、
 * `decimal.ts`（十进制舍入）、`date.ts`（序列号换算与 ISO 日期）、`builtin.ts`（内置编号）。
 */

import { describe, expect, test } from 'bun:test'
import { builtinFormat } from './builtin.ts'
import { dateParts, serialFromIso } from './date.ts'
import { fixedParts } from './decimal.ts'
import { formatNumber, formatText, plainText } from './format.ts'
import { generalFit, generalNumber } from './general.ts'

const opts = { date1904: false, palette: ['#000000', '#ffffff'] }
const n = (v: number, code: string) => plainText(formatNumber(v, code, opts))

describe('十进制舍入', () => {
  test('按十进制逢 5 进位，不受二进制表示影响', () => {
    expect(fixedParts(1.005, 2)).toEqual({ int: '1', frac: '01' })
    expect(fixedParts(2.675, 2)).toEqual({ int: '2', frac: '68' })
    expect(fixedParts(0.5, 0)).toEqual({ int: '1', frac: '' })
    expect(fixedParts(999.996, 2)).toEqual({ int: '1000', frac: '00' })
    expect(fixedParts(0.0004, 3)).toEqual({ int: '', frac: '000' })
  })
  test('超过 15 位有效数字的部分补 0', () => {
    expect(n(12345678901234568, '0')).toBe('12345678901234600')
  })
})

describe('常规格式', () => {
  test('最多 11 个字符', () => {
    expect(generalNumber(0)).toBe('0')
    expect(generalNumber(123)).toBe('123')
    expect(generalNumber(-1.5)).toBe('-1.5')
    expect(generalNumber(0.1 + 0.2)).toBe('0.3')
    expect(generalNumber(1234567.891234)).toBe('1234567.891')
    expect(generalNumber(12345678901)).toBe('12345678901')
    expect(generalNumber(123456789012)).toBe('1.23457E+11')
    expect(generalNumber(0.0001)).toBe('0.0001')
    expect(generalNumber(0.00001)).toBe('1E-05')
    expect(generalNumber(0.000123456789)).toBe('0.000123457')
    expect(generalNumber(1e100)).toBe('1E+100')
  })
  test('宽度不足时先减少小数位，再改用科学计数，仍无法容纳时返回 null', () => {
    const width = (chars: number) => (s: string) => s.length <= chars
    expect(generalFit(Math.PI, width(4))).toBe('3.14')
    expect(generalFit(123456, width(5))).toBe('1E+05')
    expect(generalFit(123456, width(2))).toBeNull()
    expect(generalFit(-2.5, width(2))).toBe('-3')
  })
})

describe('数字节', () => {
  test('占位符', () => {
    expect(n(5, '000')).toBe('005')
    expect(n(5, '#.##')).toBe('5.')
    expect(n(5.5, '0.0#')).toBe('5.5')
    expect(n(5.25, '0.???')).toBe('5.25 ')
    expect(n(0, '#')).toBe('')
    expect(n(0.5, '#.00')).toBe('.50')
    expect(n(5.5, '.00')).toBe('5.50')
    expect(n(1234, '??0')).toBe('1234')
    expect(n(4, '??0')).toBe('  4')
  })
  test('千分位与按千缩放', () => {
    expect(n(1234567.891, '#,##0.00')).toBe('1,234,567.89')
    expect(n(0, '#,##0')).toBe('0')
    expect(n(1234567, '#,##0,')).toBe('1,235')
    expect(n(1234567, '0.0,,')).toBe('1.2')
  })
  test('百分比与科学计数', () => {
    expect(n(0.1234, '0.0%')).toBe('12.3%')
    expect(n(12345, '0.00E+00')).toBe('1.23E+04')
    expect(n(0.00012, '0.00E+00')).toBe('1.20E-04')
    expect(n(0.00012, '0.00E-00')).toBe('1.20E-04')
    expect(n(12345, '0.00E-00')).toBe('1.23E04')
    expect(n(9.996, '0.00E+00')).toBe('1.00E+01')
    expect(n(12345, '##0.0E+0')).toBe('12.3E+3')
    expect(n(0, '0.00E+00')).toBe('0.00E+00')
  })
  test('分数', () => {
    expect(n(1.25, '# ?/?')).toBe('1 1/4')
    expect(n(0.333, '?/?')).toBe('1/3')
    expect(n(Math.PI, '# ??/??')).toBe('3 14/99')
    expect(n(3.125, '# ??/??')).toBe('3  1/8 ')
    expect(n(2.5, '# ?/8')).toBe('2 4/8')
    expect(n(5, '# ?/?')).toBe('5    ')
    expect(n(1.5, '?/?')).toBe('3/2')
  })
  test('负号：一节时加在最前，多节时由负数节给出', () => {
    expect(n(-5, '"$"0')).toBe('-$5')
    expect(n(-5, '0;(0)')).toBe('(5)')
    expect(n(-1234.5, '#,##0.00_);[Red]\\(#,##0.00\\)')).toBe('(1,234.50)')
    expect(n(0, '0;-0;"零"')).toBe('零')
    expect(n(-0.4, '0')).toBe('-0')
  })
  test('条件节', () => {
    const code = '[>=100]"大";[<0]"负";"小"'
    expect(n(150, code)).toBe('大')
    expect(n(-3, code)).toBe('负')
    expect(n(50, code)).toBe('小')
    expect(n(-1234567, '[<=9999999]###-####;(###) ###-####')).toBe('-123-4567')
  })
  test('颜色', () => {
    expect(formatNumber(-1, '0;[Red]0', opts).color).toBe('#ff0000')
    expect(formatNumber(1, '0;[Red]0', opts).color).toBeNull()
    expect(
      formatNumber(1, '[Color2]0', { ...opts, palette: Array(10).fill('#123456') }).color,
    ).toBe('#123456')
  })
  test('引号、转义、留空与重复填充', () => {
    expect(n(3, '0"件"')).toBe('3件')
    expect(n(3, '0\\°')).toBe('3°')
    expect(n(3, '0.00元')).toBe('3.00元')
    const acc = '_ * #,##0.00_ ;_ * \\-#,##0.00_ ;_ * "-"??_ ;_ @_ '
    const parts = formatNumber(1234.5, acc, opts).parts
    expect(parts).toEqual([
      { kind: 'gap', text: ' ' },
      { kind: 'fill', text: ' ' },
      { kind: 'text', text: '1,234.50' },
      { kind: 'gap', text: ' ' },
    ])
    expect(n(-1234.5, acc)).toBe(' -1,234.50 ')
    expect(n(0, acc)).toBe(' -   ')
    expect(plainText(formatText('合计', acc, opts))).toBe(' 合计 ')
  })
  test('空节隐藏对应的值', () => {
    expect(n(5, ';;;')).toBe('')
    expect(n(0, '0;-0;;@')).toBe('')
  })
  test('嵌入常规', () => {
    expect(n(-2.5, 'General;[Red]-General')).toBe('-2.5')
    expect(n(7, '"共"General"项"')).toBe('共7项')
  })
})

describe('文本节', () => {
  test('有文本节时套用，没有时原样显示', () => {
    expect(plainText(formatText('abc', '0;0;0;"<"@">"', opts))).toBe('<abc>')
    expect(plainText(formatText('abc', '@"号"', opts))).toBe('abc号')
    expect(plainText(formatText('abc', '0.00', opts))).toBe('abc')
  })
  test('只有文本节的格式按常规显示数字', () => {
    expect(n(1.5, '@')).toBe('1.5')
  })
})

describe('日期时间', () => {
  const serial = 45583.5625 // 2024-10-18 13:30:00
  test('年月日与星期', () => {
    expect(n(serial, 'yyyy/m/d')).toBe('2024/10/18')
    expect(n(serial, 'yy-mm-dd')).toBe('24-10-18')
    expect(n(serial, 'yyyy"年"m"月"d"日"')).toBe('2024年10月18日')
    expect(n(serial, 'd-mmm-yy')).toBe('18-Oct-24')
    expect(n(serial, 'mmmm mmmmm')).toBe('October O')
    expect(n(serial, 'ddd dddd')).toBe('Fri Friday')
    expect(n(serial, '[$-804]aaaa')).toBe('星期五')
    expect(n(serial, '[$-804]aaa')).toBe('五')
    expect(n(serial, '[$-804]mmmm ddd')).toBe('十月 周五')
  })
  test('时间：分钟判定、十二小时制与舍入', () => {
    expect(n(serial, 'h:mm')).toBe('13:30')
    expect(n(serial, 'h:mm AM/PM')).toBe('1:30 PM')
    expect(n(serial, '上午/下午h"时"mm"分"')).toBe('下午1时30分')
    expect(n(serial, 'mm:ss')).toBe('30:00')
    expect(n(0.99999999, 'h:mm:ss')).toBe('0:00:00')
    expect(n(10.5 / 24 + 45.4 / 86400, 'h:mm')).toBe('10:30')
    expect(n(1.5 / 86400 + 0.25, 'h:mm:ss.0')).toBe('6:00:01.5')
  })
  test('累计时间', () => {
    expect(n(1.5, '[h]:mm:ss')).toBe('36:00:00')
    expect(n(1 / 24, '[mm]:ss')).toBe('60:00')
  })
  test('系统长日期与内置编号', () => {
    expect(n(serial, '[$-F800]dddd, mmmm dd, yyyy')).toBe('2024年10月18日')
    expect(builtinFormat(14)).toBe('yyyy/m/d')
    expect(builtinFormat(200)).toBeNull()
  })
  test('负数与超出范围的日期无法显示', () => {
    expect(formatNumber(-1, 'yyyy/m/d', opts).invalid).toBe(true)
    expect(formatNumber(3e6, 'yyyy/m/d', opts).invalid).toBe(true)
  })
  test('1900 年的序列号与 1904 日期系统', () => {
    expect(dateParts(60, false, 0)).toMatchObject({ year: 1900, month: 2, day: 29 })
    expect(dateParts(61, false, 0)).toMatchObject({ year: 1900, month: 3, day: 1, weekday: 4 })
    expect(dateParts(0, false, 0)).toMatchObject({ year: 1900, month: 1, day: 0 })
    expect(dateParts(0, true, 0)).toMatchObject({ year: 1904, month: 1, day: 1, weekday: 5 })
    expect(serialFromIso('2024-10-18T13:30:00', false)).toBe(serial)
    expect(serialFromIso('1900-01-01', false)).toBe(1)
  })
  test('中文数字', () => {
    expect(n(serial, '[DBNum1][$-804]yyyy"年"m"月"d"日"')).toBe('二〇二四年十月十八日')
    expect(n(123, '[DBNum1]0')).toBe('一百二十三')
    expect(n(1050, '[DBNum1]0')).toBe('一千〇五十')
    expect(n(123, '[DBNum2]0')).toBe('壹佰贰拾叁')
    expect(n(12.5, '[DBNum3]0.0')).toBe('１２.５')
  })
})
