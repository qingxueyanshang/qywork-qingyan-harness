/**
 * Office 预览的字体：经 `/api/fonts` 取得主机上的字体文件并以 `FontFace` 注册；文件中的嵌入字体也经此注册。
 *
 * - 排版度量与绘制必须来自同一份字节：调用方从 `HostFace.bytes` 读取度量，绘制按 `family` 引用已注册的 `FontFace`。
 * - 主机上没有的字体（404）与字体名不合法（422）按缺失处理，结果中该字体名没有字形；其他失败抛出。
 * - 主机字体在页面中只下载、注册一次：按字体名缓存家族，按内容哈希缓存单个字体。文档以另一个名称引用已注册的字体
 *   （如 `SimSun` 与 `宋体`）时不重复下载，`family` 为首次注册时的族名。
 */

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

/** 字体名到该家族各字体的内容哈希。 */
const families = new Map<string, Promise<readonly FaceInfo[]>>()
/** 内容哈希到已注册的字体。 */
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

function faceOf(name: string, info: FaceInfo): Promise<HostFace> {
  let pending = faces.get(info.id)
  if (!pending) {
    pending = (async () => {
      const url = `/api/fonts/file?name=${encodeURIComponent(name)}&id=${encodeURIComponent(info.id)}`
      const res = await client.raw(url)
      if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ''))
      const bytes = new Uint8Array(await res.arrayBuffer())
      await registerFace(name, bytes, info.bold, info.italic)
      return { family: name, bold: info.bold, italic: info.italic, bytes }
    })()
    remember(faces, info.id, pending)
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

/** 取得 `names` 中各字体名在主机上的字体；主机上没有的字体名对应空数组。 */
export async function loadHostFaces(
  names: readonly string[],
): Promise<Map<string, readonly HostFace[]>> {
  const unique = [...new Set(names)]
  const results = await Promise.all(
    unique.map(async (name) => {
      const infos = await familyOf(name)
      return [name, await Promise.all(infos.map((info) => faceOf(name, info)))] as const
    }),
  )
  return new Map(results)
}
