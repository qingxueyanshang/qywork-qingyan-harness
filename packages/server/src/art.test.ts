/** 覆盖范围：`art.ts` 的引导页与库文件路由。 */

import { describe, expect, test } from 'bun:test'
import { ART_ADDONS } from '@qywork/runtime'
import { ART_HOST_PATH, ART_LIBRARY, serveArt } from './art.ts'

describe('Art 宿主', () => {
  test('引导页只接受父窗口的 qywork-art-load，加载后报告 qywork-art-host', async () => {
    const res = serveArt(ART_HOST_PATH)!
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('e.source !== parent')
    expect(html).toContain("'qywork-art-load'")
    expect(html).toContain("type: 'qywork-art-host'")
  })

  test('库文件按发布路径返回内嵌文件，带跨源许可；未知路径 404；其他路径不处理', async () => {
    const res = serveArt('/art/lib/three.module.js')!
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('content-type')).toContain('text/javascript')
    // three.module.js 以相对路径引用 three.core.js，两者必须位于同一目录。
    expect(await res.text()).toContain("from './three.core.js'")
    expect(serveArt('/art/lib/three.core.js')!.status).toBe(200)
    expect(serveArt('/art/lib/../package.json')!.status).toBe(404)
    expect(serveArt('/api/health')).toBeNull()
  })

  test('附加模块与系统提示词中列出的清单一一对应，且只从 three 引用', async () => {
    const addons = Object.keys(ART_LIBRARY)
      .filter((k) => k.startsWith('addons/'))
      .map((k) => k.slice('addons/'.length))
    expect(addons.sort()).toEqual([...ART_ADDONS].sort())
    for (const name of ART_ADDONS) {
      const text = await serveArt(`/art/lib/addons/${name}`)!.text()
      // 路径与内容对应：文件导出与文件名同名的类。
      const cls = name.split('/').pop()!.replace('.js', '')
      expect(text).toContain(`class ${cls} `)
      // 只看语句：注释中的用法示例同样含有 `from '...'`。
      const specifiers = [...text.matchAll(/^(?:import|export|\})[^\n]*from\s+'([^']+)'/gm)].map(
        (m) => m[1],
      )
      expect(specifiers.length).toBeGreaterThan(0)
      expect(specifiers.every((s) => s === 'three')).toBe(true)
    }
  })
})
