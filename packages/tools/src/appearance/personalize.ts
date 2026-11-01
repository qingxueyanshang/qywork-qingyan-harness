/**
 * `personalize`：读取与修改 qywork 界面的个性化（只有一套）。
 *
 * 读写经 `ctx.personalization` 端口完成，个性化位于 `~/.qywork/personalization/`，文件工具在 `auto` 下
 * 无法写入该目录。保存即由服务端广播，所有屏幕重新读取，没有单独的切换动作。
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ToolContext, ToolSpec } from '@qywork/agent'
import {
  isPersonalImageName,
  mergePersonalization,
  PERSONAL_IMAGE_EXTENSIONS,
  type Personalization,
} from '@qywork/core'
import { resolveInWorkspace, rootsOf } from '../paths.ts'

type Outcome = Awaited<ReturnType<ToolSpec['fn']>>

function failure(message: string): Outcome {
  return { status: 'failure', executed: false, message, errorKind: 'invalid_tool_arguments' }
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 解析 `json`。缺省为空对象：只换背景图片时无需其他字段。 */
function patchOf(raw: unknown): Record<string, unknown> | string {
  const src = text(raw)
  if (!src) return {}
  try {
    const v = JSON.parse(src) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'json 必须是 JSON 对象'
    return v as Record<string, unknown>
  } catch (e) {
    return `json 无法解析：${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * 把工作区中的图片设为背景：读取字节，并把 `background` 改为引用该文件名的图片背景。
 * 填充方式、暗度与模糊依次取 `json` 中给出的值、原图片背景的值、默认值。
 */
async function withImage(
  ctx: ToolContext,
  path: string,
  base: Personalization,
  patch: Record<string, unknown>,
): Promise<
  { patch: Record<string, unknown>; image: { name: string; bytes: Uint8Array } } | string
> {
  const abs = await resolveInWorkspace(rootsOf(ctx), path, { mustExist: true })
  const name = basename(abs)
  if (!isPersonalImageName(name))
    return `背景图片必须是 ${PERSONAL_IMAGE_EXTENSIONS.join('、')} 格式：${path}`
  const bytes = new Uint8Array(await readFile(abs))
  const prev =
    base.background.kind === 'image' ? base.background : { fit: 'cover', dim: 0.2, blur: 0 }
  const given =
    typeof patch.background === 'object' && patch.background !== null
      ? (patch.background as Record<string, unknown>)
      : {}
  const { kind: _kind, file: _file, ...rest } = given
  return {
    patch: {
      ...patch,
      background: {
        kind: 'image',
        fit: prev.fit,
        dim: prev.dim,
        blur: prev.blur,
        ...rest,
        file: name,
      },
    },
    image: { name, bytes },
  }
}

export const personalizeTool: ToolSpec = {
  name: 'personalize',
  description:
    '读取与修改 qywork 界面的个性化。个性化由背景、流动雾面、界面不透明度与强调色组成，' +
    '作用于界面外框、会话区与右侧面板；浅色或深色由用户的主题设置决定，不属于个性化。' +
    '只有一套个性化，保存后所有屏幕立即生效。' +
    'action=read 读取当前参数；save 只写要改的字段：background 的 kind 不变时逐字段合并，kind 改变时整组替换，' +
    '已有雾面时 fog 逐字段合并；image 给出工作区中的图片路径时把该图片设为背景；reset 恢复默认。' +
    '背景与雾面位于界面之下，opacity 小于 1 时才能透过界面看到。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'save', 'reset'] },
      json: {
        type: 'string',
        description:
          '要修改的字段，JSON 对象，save 时使用。字段：' +
          'background：{"kind":"color","color":颜色或 null（null 为主题底色）} ' +
          '或 {"kind":"gradient","from":颜色,"to":颜色,"direction":"horizontal"|"vertical"|"diagonal-down"|"diagonal-up"} ' +
          '或 {"kind":"image","fit":"cover"|"contain"|"tile","dim":0–0.9,"blur":0–40}（图片文件用 image 参数给出）；' +
          'fog：null（无雾面）或 {"color","density":0–1,"speed":0–1}；' +
          'opacity：0.2–1，界面底色的不透明度；accent：强调色或 null（主题的强调色）。颜色写 #rrggbb',
      },
      image: {
        type: 'string',
        description: '工作区中的图片路径（png、jpg、webp、gif、avif），save 时设为背景',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  actionKind: (args) => (args.action === 'read' ? 'read' : 'edit'),
  objectLabel: '个性化',
  category: 'session',
  facet: '外观',
  summary: '读取与修改界面的个性化',
  targetExtractor: () => null,
  permissionEffect: (args) => (args.action === 'read' ? 'read' : 'write'),
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.personalization
    if (!port) return failure('本次执行没有个性化通道')
    const action = args.action

    if (action === 'reset') {
      await port.reset()
      return { status: 'success', message: '已恢复默认个性化', data: { reset: true } }
    }

    const current = await port.read()
    if (!current.ok) return failure(current.error)
    const base = current.entry.personalization

    if (action === 'read') {
      return {
        status: 'success',
        message: `当前个性化：\n${JSON.stringify(base, null, 2)}`,
        data: { personalization: base },
      }
    }

    if (action === 'save') {
      const patch = patchOf(args.json)
      if (typeof patch === 'string') return failure(patch)
      const imagePath = text(args.image)
      if (!imagePath && Object.keys(patch).length === 0) return failure('save 需要 json 或 image')
      let image: { name: string; bytes: Uint8Array } | undefined
      let finalPatch = patch
      if (imagePath) {
        const r = await withImage(ctx, imagePath, base, patch)
        if (typeof r === 'string') return failure(r)
        finalPatch = r.patch
        image = r.image
      }
      const merged = mergePersonalization(base, finalPatch)
      if (!merged.ok) return failure(merged.error)
      const saved = await port.save(merged.value, image)
      if (!saved.ok) return failure(saved.error)
      return {
        status: 'success',
        message: `已保存个性化：\n${JSON.stringify(saved.entry.personalization, null, 2)}`,
        data: { personalization: saved.entry.personalization },
      }
    }

    return failure('action 必须是 read、save 或 reset')
  },
}
