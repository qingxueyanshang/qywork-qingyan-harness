/**
 * 插件清单校验。
 *
 * 覆盖范围：`manifest.ts`。
 */

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
   * 声明了写工具却未声明写权限，说明清单有误。放行会使权限模型失效：
   * 用户在安装提示中看到「不需要任何权限」，插件却能修改文件。
   */
  test('工具权限必须与清单声明一致', () => {
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

  /**
   * 工具名不得以 id 的末段开头。注册名是 `<规范化的 id>__<工具名>`，末段已包含在前缀中，
   * 再次出现会形成 `qywork_browser__browser_tabs` 这样的重复。命中时报错，并建议去掉前缀。
   */
  test('工具名以插件 id 末段开头时被拒绝，并建议去掉前缀', () => {
    const withThemePrefix = {
      ...base,
      id: 'qywork.browser',
      permissions: ['workspace:read'],
      contributes: {
        tools: [
          { name: 'browser_tabs', description: 'x', parameters: {}, permissionEffect: 'read' },
        ],
      },
    }
    expect(() => parseManifest(withThemePrefix, 'p')).toThrow(/末段「browser」/)
    expect(() => parseManifest(withThemePrefix, 'p')).toThrow(/改为「tabs」/)

    // 与末段同名（不带下划线后缀）同样被拒绝，并提示去掉前缀。
    const exact = {
      ...withThemePrefix,
      contributes: {
        tools: [{ name: 'browser', description: 'x', parameters: {}, permissionEffect: 'read' }],
      },
    }
    expect(() => parseManifest(exact, 'p')).toThrow(/去掉该前缀/)

    // 去掉前缀后通过。
    const fixed = {
      ...withThemePrefix,
      contributes: {
        tools: [{ name: 'tabs', description: 'x', parameters: {}, permissionEffect: 'read' }],
      },
    }
    expect((parseManifest(fixed, 'p').contributes.tools ?? []).map((t) => t.name)).toEqual(['tabs'])

    // 包含末段但不在开头时不拦截（`open_browser`）。
    const midword = {
      ...withThemePrefix,
      contributes: {
        tools: [
          { name: 'open_browser', description: 'x', parameters: {}, permissionEffect: 'read' },
        ],
      },
    }
    expect((parseManifest(midword, 'p').contributes.tools ?? []).map((t) => t.name)).toEqual([
      'open_browser',
    ])
  })

  test('自定义渲染器必须提供 render 导出名', () => {
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
