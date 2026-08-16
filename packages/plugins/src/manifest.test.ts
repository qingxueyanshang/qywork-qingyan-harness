import { describe, expect, test } from 'bun:test'
import { MANIFEST_VERSION, parseManifest } from './manifest.ts'

const base = {
  manifestVersion: MANIFEST_VERSION,
  id: 'dev.example.demo',
  name: 'Demo',
  version: '1.0.0',
  description: '示例插件',
  permissions: [],
  contributes: {},
}

describe('插件清单校验', () => {
  test('合法清单通过', () => {
    expect(parseManifest(base, 'p').id).toBe('dev.example.demo')
  })

  test('版本不匹配直接拒绝，不尝试兼容', () => {
    expect(() => parseManifest({ ...base, manifestVersion: 99 }, 'p')).toThrow(/版本不支持/)
  })

  test('非法 id 拒绝', () => {
    expect(() => parseManifest({ ...base, id: 'AB' }, 'p')).toThrow(/id/)
    expect(() => parseManifest({ ...base, id: 'has space' }, 'p')).toThrow(/id/)
  })

  test('未知权限拒绝', () => {
    expect(() => parseManifest({ ...base, permissions: ['root'] }, 'p')).toThrow(/未知权限/)
  })

  /**
   * 声明了写工具却没声明写权限，说明清单写错了。放行等于把权限模型架空——
   * 用户在安装提示里看到「不需要任何权限」，插件却能改文件。
   */
  test('工具权限与清单声明必须自洽', () => {
    const withTool = {
      ...base,
      permissions: ['workspace:read'],
      contributes: {
        tools: [
          {
            name: 'do_write',
            description: 'x',
            parameters: {},
            permissionEffect: 'write',
          },
        ],
      },
    }
    expect(() => parseManifest(withTool, 'p')).toThrow(/需要权限 workspace:write/)

    const fixed = { ...withTool, permissions: ['workspace:read', 'workspace:write'] }
    expect(parseManifest(fixed, 'p').contributes.tools).toHaveLength(1)
  })

  test('自定义渲染器必须给出 render 导出名', () => {
    const bad = {
      ...base,
      contributes: { previewers: [{ extensions: ['.foo'], renders: 'custom' }] },
    }
    expect(() => parseManifest(bad, 'p')).toThrow(/render/)
  })

  test('预览器必须声明扩展名', () => {
    const bad = { ...base, contributes: { previewers: [{ extensions: [], renders: 'text' }] } }
    expect(() => parseManifest(bad, 'p')).toThrow(/扩展名/)
  })
})
