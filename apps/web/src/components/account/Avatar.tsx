import { Show } from 'solid-js'

/** 账号头像：已设置时显示图片，否则显示 `label`（用户名，未设置时为邮箱）的首字符。账号弹窗与侧栏入口共用。 */
export function AccountAvatar(props: { label: string; avatar: string | null; small?: boolean }) {
  return (
    <span class="account-avatar" classList={{ sm: props.small === true }} aria-hidden="true">
      <Show when={props.avatar} fallback={([...props.label][0] ?? '?').toUpperCase()}>
        {(src) => <img src={src()} alt="" />}
      </Show>
    </span>
  )
}

/** 头像边长（像素）。按显示尺寸的 3 倍取值，高分屏上不模糊；编码后约 10–30 KB。 */
const SIZE = 128

/**
 * 把选中的图片按中心裁剪为正方形，缩放到 `SIZE` 并编码为 data URL。
 * 编码为 WebP；运行环境不支持 WebP 编码时 `toDataURL` 返回 PNG，此时改用 JPEG，避免体积过大。
 */
export async function squareAvatar(file: Blob): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('无法读取该图片')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法处理该图片')
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  )
  bitmap.close()
  const webp = canvas.toDataURL('image/webp', 0.85)
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85)
}
