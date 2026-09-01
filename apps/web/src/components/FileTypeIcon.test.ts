import { describe, expect, test } from 'bun:test'
import { fileIconSpec } from './FileTypeIcon.tsx'

describe('文件类型图标', () => {
  test('代码文件按语言归属，不再全部回落到通用文件', () => {
    expect(fileIconSpec('src/index.ts')).toEqual({ kind: 'typescript', label: 'TS' })
    expect(fileIconSpec('src/App.jsx')).toEqual({ kind: 'javascript', label: 'JS' })
    expect(fileIconSpec('main.rs')).toEqual({ kind: 'rust', label: 'RS' })
  })

  test('配置、文档与媒体使用各自的图标族', () => {
    expect(fileIconSpec('package.json')).toEqual({ kind: 'json', label: '{}' })
    expect(fileIconSpec('README.md')).toEqual({ kind: 'markdown', label: 'MD' })
    expect(fileIconSpec('assets/cover.webp')).toEqual({ kind: 'image', label: 'IMG' })
    expect(fileIconSpec('report.xlsx')).toEqual({ kind: 'table', label: 'XLS' })
  })

  test('锁文件与未知扩展分别归类，路径分隔符不影响识别', () => {
    expect(fileIconSpec('C:\\work\\bun.lock')).toEqual({ kind: 'lock', label: 'L' })
    expect(fileIconSpec('data.unknown-format')).toEqual({ kind: 'generic', label: '' })
  })
})
