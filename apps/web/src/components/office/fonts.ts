/**
 * Office 预览的字体：经 `/api/fonts` 取得主机上的字体文件并以 `FontFace` 注册；文件中的嵌入字体也经此注册。
 * 主机显示器的 ClearType 设置与主机字体的族名也经此接口取得（`loadClearType`、`loadHostFamilies`）。
 *
 * - 排版度量与绘制必须来自同一份字节：调用方从 `HostFace.bytes` 读取度量，绘制按 `family` 引用已注册的 `FontFace`。
 * - 主机上没有的字体（404）与字体名不合法（422）按缺失处理，结果中该字体名没有字形；其他失败抛出。
 * - 字体按预览中的文档用到的字裁剪（`FontDocument`，服务端 `font-subset.ts`），字形编号与度量不变。
 * - 按字体名缓存家族，按「内容哈希 + 文档 + 版本」缓存单个字体：同一文档以另一个名称引用同一字体（如 `SimSun` 与 `宋体`）
 *   时不重复下载。每份裁剪结果以带序号的族名注册（`family`）：同一字体对不同文档的裁剪包含的字形不同，同名注册时
 *   浏览器只采用其中一份。
 */

import { ALL_STYLES, facesForStyles, type HostFamilies } from '@qywork/ooxml/text'
import { ApiError } from '../../lib/client.ts'
import { client } from '../../lib/store/index.ts'

/** 已注册为 `FontFace` 的单个字体。 */
export interface HostFace {
  /** CSS 族名，与注册的 `FontFace` 相同。 */
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
  /** 字体文件字节，供读取排版度量。 */
  readonly bytes: Uint8Array<ArrayBuffer>
}

interface FaceInfo {
  readonly id: string
  readonly bold: boolean
  readonly italic: boolean
}

/** 预览中的文档：工作区路径与修改时间。 */
export interface FontDocument {
  readonly path: string
  readonly mtime: number
}

/** 注册族名的序号，使每份裁剪结果的族名不同。 */
let faceSerial = 0

/** 字体名到该家族各字体的内容哈希。 */
const families = new Map<string, Promise<readonly FaceInfo[]>>()
/** 「内容哈希 + 文档 + 版本」到已注册的字体。 */
const faces = new Map<string, Promise<HostFace>>()

function familyOf(name: string): Promise<readonly FaceInfo[]> {
  let pending = families.get(name)
  if (!pending) {
    pending = client.api<{ faces: FaceInfo[] }>(`/api/fonts?name=${encodeURIComponent(name)}`).then(
      (r) => r.faces,
      (e: unknown) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 422)) return []
        throw e
      },
    )
    remember(families, name, pending)
  }
  return pending
}

function faceOf(name: string, info: FaceInfo, doc: FontDocument): Promise<HostFace> {
  const key = `${info.id}\u0000${doc.path}\u0000${doc.mtime}`
  let pending = faces.get(key)
  if (!pending) {
    pending = (async () => {
      const url = `/api/fonts/file?name=${encodeURIComponent(name)}&id=${encodeURIComponent(info.id)}&doc=${encodeURIComponent(doc.path)}&v=${encodeURIComponent(doc.mtime)}`
      const res = await client.raw(url)
      if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ''))
      const bytes = new Uint8Array(await res.arrayBuffer())
      const family = `${name} ${++faceSerial}`
      await registerFace(family, bytes, info.bold, info.italic)
      return { family, bold: info.bold, italic: info.italic, bytes }
    })()
    remember(faces, key, pending)
  }
  return pending
}

/** 失败的请求不留在缓存中：网络恢复后再次打开文档时重新获取。 */
function remember<T>(cache: Map<string, Promise<T>>, key: string, pending: Promise<T>): void {
  cache.set(key, pending)
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key)
  })
}

/** 以 `family` 注册字体字节并等待加载完成。不再使用时由调用方从 `document.fonts` 删除返回的 `FontFace`。 */
export async function registerFace(
  family: string,
  bytes: Uint8Array<ArrayBuffer>,
  bold: boolean,
  italic: boolean,
): Promise<FontFace> {
  const face = new FontFace(family, bytes, {
    weight: bold ? '700' : '400',
    style: italic ? 'italic' : 'normal',
  })
  await face.load()
  document.fonts.add(face)
  return face
}

/**
 * 主机显示器的 ClearType 设置（`/api/fonts/smoothing`）；主机不使用 ClearType 时为 `null`。每次调用都重新取得：
 * 系统设置可在页面打开期间改变，重新打开文档即按新值绘制。请求失败时抛出。
 */
export async function loadClearType(): Promise<{ readonly contrast: number } | null> {
  const r = await client.api<{ clearType: { contrast: number } | null }>('/api/fonts/smoothing')
  return r.clearType
}

/**
 * 主机字体的族名（`/api/fonts/families`），供排版对主机没有的字体名做前缀匹配。每次调用都重新取得：字体可在页面打开期间安装，
 * 重新打开文档即按新清单排版。请求失败时抛出。
 */
export function loadHostFamilies(): Promise<HostFamilies> {
  return client.api<HostFamilies>('/api/fonts/families')
}

/**
 * 取得 `names` 中各字体名在主机上的字体，按 `doc` 用到的字裁剪；主机上没有的字体名对应空数组。
 * 给出 `styles` 时每个字体名只取得所列样式会选用的字体（`facesForStyles`），未列出的字体名取得全部样式。
 */
export async function loadHostFaces(
  names: readonly string[],
  doc: FontDocument,
  styles?: ReadonlyMap<string, number>,
): Promise<Map<string, readonly HostFace[]>> {
  const unique = [...new Set(names)]
  const results = await Promise.all(
    unique.map(async (name) => {
      const infos = await familyOf(name)
      const wanted = facesForStyles(infos, styles?.get(name) ?? ALL_STYLES)
      return [name, await Promise.all(wanted.map((info) => faceOf(name, info, doc)))] as const
    }),
  )
  return new Map(results)
}
