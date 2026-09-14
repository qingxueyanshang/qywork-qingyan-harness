/**
 * 插件清单校验。
 *
 * 覆盖范围：`manifest.ts`，外加 `extensions/browser-control/qywork.plugin.json`
 * ——那份清单装进插件目录之前必须先在这里过一遍，写错了装上才发现太晚。
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
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

  test('browser 效果要 browser:control，不认 process:exec 顶替', () => {
    const tool = {
      name: 'act',
      description: 'x',
      parameters: {},
      permissionEffect: 'browser',
    }
    expect(() =>
      parseManifest(
        { ...base, permissions: ['process:exec'], contributes: { tools: [tool] } },
        'p',
      ),
    ).toThrow(/需要权限 browser:control/)
    const ok = parseManifest(
      { ...base, permissions: ['browser:control'], contributes: { tools: [tool] } },
      'p',
    )
    expect(ok.permissions).toEqual(['browser:control'])
  })

  /**
   * 工具名不得以 id 的主题段开头。注册名是 `<id 消毒>__<工具名>`，主题段已经在前缀里，
   * 再带一遍就是 `qywork_browser__browser_tabs` 这种重复。命中报错并给去前缀的建议。
   */
  test('工具名以插件主题段开头被拒，并给出去前缀的建议', () => {
    const withThemePrefix = {
      ...base,
      id: 'qywork.browser',
      permissions: ['browser:control'],
      contributes: {
        tools: [
          { name: 'browser_tabs', description: 'x', parameters: {}, permissionEffect: 'browser' },
        ],
      },
    }
    expect(() => parseManifest(withThemePrefix, 'p')).toThrow(/主题段「browser」/)
    expect(() => parseManifest(withThemePrefix, 'p')).toThrow(/改成「tabs」/)

    // 与主题段同名（不带下划线后缀）也拒，且提示去掉前缀。
    const exact = {
      ...withThemePrefix,
      contributes: {
        tools: [{ name: 'browser', description: 'x', parameters: {}, permissionEffect: 'browser' }],
      },
    }
    expect(() => parseManifest(exact, 'p')).toThrow(/去掉这个前缀/)

    // 去掉前缀后通过。
    const fixed = {
      ...withThemePrefix,
      contributes: {
        tools: [{ name: 'tabs', description: 'x', parameters: {}, permissionEffect: 'browser' }],
      },
    }
    expect((parseManifest(fixed, 'p').contributes.tools ?? []).map((t) => t.name)).toEqual(['tabs'])

    // 只是恰好含主题段、但不在开头，不拦（`open_browser`）。
    const midword = {
      ...withThemePrefix,
      contributes: {
        tools: [
          { name: 'open_browser', description: 'x', parameters: {}, permissionEffect: 'browser' },
        ],
      },
    }
    expect((parseManifest(midword, 'p').contributes.tools ?? []).map((t) => t.name)).toEqual([
      'open_browser',
    ])
  })

  test('内置浏览器插件的清单是合法的', async () => {
    const raw = await Bun.file(
      join(import.meta.dir, '../../../extensions/browser-control/qywork.plugin.json'),
    ).json()
    const m = parseManifest(raw, 'extensions/browser-control')
    expect(m.permissions.sort()).toEqual(['browser:control', 'workspace:read', 'workspace:write'])
    expect((m.contributes.tools ?? []).map((t) => t.name).sort()).toEqual([
      'act',
      'download',
      'navigate',
      'observe',
      'tabs',
      'upload',
      'wait',
    ])
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
