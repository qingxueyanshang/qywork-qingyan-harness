/**
 * 覆盖 `install-release.ts` 中不依赖本机状态的部分：卸载项输出的解析与 SHA256SUMS 的查找。
 * 下载、备份与静默安装依赖官网与本机安装，按发版流程实际执行一次核对。
 */

import { expect, test } from 'bun:test'
import { checksumOf, regValue } from './install-release.ts'

const REG = [
  '',
  'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qywork',
  '    DisplayName    REG_SZ    qywork',
  '    DisplayVersion    REG_SZ    0.3.30',
  '    InstallLocation    REG_SZ    "D:\\qywork"',
  '    UninstallString    REG_SZ    "D:\\qywork\\uninstall.exe"',
  '',
].join('\r\n')

test('卸载项的值去除两侧引号，没有该值时为 null', () => {
  expect(regValue(REG, 'InstallLocation')).toBe('D:\\qywork')
  expect(regValue(REG, 'DisplayVersion')).toBe('0.3.30')
  expect(regValue(REG, 'Publisher')).toBeNull()
})

test('按文件名查找校验和，两种分隔写法都识别', () => {
  const hex = 'ab'.repeat(32)
  const sums = `${'cd'.repeat(32)} *other.exe\n${hex} *qywork_0.3.30_x64-setup.exe\n`
  expect(checksumOf(sums, 'qywork_0.3.30_x64-setup.exe')).toBe(hex)
  expect(checksumOf(`${hex}  a.exe\n`, 'a.exe')).toBe(hex)
  expect(checksumOf(sums, 'missing.exe')).toBeNull()
})
