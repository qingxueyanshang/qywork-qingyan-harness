/**
 * `skin`：读取、新建、修改与切换 qywork 界面的皮肤。
 *
 * 读写经 `ctx.skins` 端口完成，皮肤库位于 `~/.qywork/skins/`，文件工具在 `auto` 下无法写入该目录。
 * `apply` 只核对皮肤存在并返回 id，切换由界面在当前会话收到成功结果后执行，与 `open_in_panel` 相同；
 * 当前屏幕选用哪套皮肤只由界面记录，服务端与本工具都不知道。
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ToolContext, ToolSpec } from '@qywork/agent'
import {
  DEFAULT_SKIN,
  isSkinImageName,
  mergeSkin,
  SKIN_IMAGE_EXTENSIONS,
  type Skin,
  type SkinEntry,
} from '@qywork/core'
import { resolveInWorkspace, rootsOf } from '../paths.ts'

/** `apply` 取消皮肤时使用的 id。 */
const NONE = 'none'

type Outcome = Awaited<ReturnType<ToolSpec['fn']>>

function failure(message: string): Outcome {
  return { status: 'failure', executed: false, message, errorKind: 'invalid_tool_arguments' }
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function summaryOf(entry: SkinEntry): string {
  return `「${entry.skin.name}」（${entry.id}）`
}

/** 解析 `skin_json`。缺省为空对象：只换背景图片时无需其他字段。 */
function patchOf(raw: unknown): Record<string, unknown> | string {
  const src = text(raw)
  if (!src) return {}
  try {
    const v = JSON.parse(src) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'skin_json 必须是 JSON 对象'
    return v as Record<string, unknown>
  } catch (e) {
    return `skin_json 无法解析：${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * 把工作区中的图片设为背景：读取字节，并把 `background` 改为引用该文件名的图片背景。
 * 填充方式、暗度与模糊依次取 `skin_json` 中给出的值、原图片背景的值、默认值。
 */
async function withImage(
  ctx: ToolContext,
  path: string,
  base: Skin,
  patch: Record<string, unknown>,
): Promise<
  { patch: Record<string, unknown>; image: { name: string; bytes: Uint8Array } } | string
> {
  const abs = await resolveInWorkspace(rootsOf(ctx), path, { mustExist: true })
  const name = basename(abs)
  if (!isSkinImageName(name))
    return `背景图片必须是 ${SKIN_IMAGE_EXTENSIONS.join('、')} 格式：${path}`
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

export const skinTool: ToolSpec = {
  name: 'skin',
  description:
    '读取、新建、修改与切换 qywork 界面的皮肤。皮肤由模式、背景、流动雾面、界面不透明度与强调色组成，' +
    '作用于界面外框、会话区与右侧面板；画布、终端、内置浏览器只跟随模式的明暗。' +
    'action=list 列出全部皮肤；read 读取一套皮肤的完整参数；' +
    'save 新建（省略 id）或修改（给出 id）皮肤，skin_json 只写要改的字段：同一参数组的 kind 不变时逐字段合并，kind 改变时整组替换；' +
    'image 给出工作区中的图片路径时把该图片设为背景；save 只保存，不切换。' +
    'apply 把用户当前的界面切换到 id 指定的皮肤，id 为 none 时取消皮肤、恢复普通主题。' +
    '用户要修改正在使用的皮肤而未指明哪一套时，优先取本会话中最近一次 apply 或 save 的 id；本会话中没有时先 list 再向用户确认。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'save', 'apply'] },
      id: {
        type: 'string',
        description: '皮肤 id。read、apply 必填；save 时省略表示新建；apply 时 none 表示取消皮肤',
      },
      skin_json: {
        type: 'string',
        description:
          '皮肤参数，JSON 对象，save 时使用。字段：name（名称）；base：light 或 dark；' +
          'background：{"kind":"color","color"} 或 {"kind":"gradient","angle":0–360,"stops":[2–5 个颜色]} ' +
          '或 {"kind":"image","fit":"cover"|"contain"|"tile","dim":0–0.9,"blur":0–40}（图片文件用 image 参数给出）；' +
          'effect：{"kind":"none"} 或 {"kind":"fog","color","density":0–1,"speed":0–1}；' +
          'surface：{"opacity":0.2–1}，界面底色的不透明度，小于 1 时透出背景；accent：强调色或 null。颜色写 #rrggbb',
      },
      image: {
        type: 'string',
        description: '工作区中的图片路径（png、jpg、webp、gif、avif），save 时设为背景',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  actionKind: (args) =>
    args.action === 'save' ? 'edit' : args.action === 'apply' ? 'call' : 'read',
  objectLabel: '皮肤',
  category: 'session',
  facet: '外观',
  summary: '读取、修改与切换界面皮肤',
  targetExtractor: (a) => text(a.id),
  permissionEffect: (args) => (args.action === 'save' ? 'write' : 'read'),
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.skins
    if (!port) return failure('本次执行没有皮肤库通道')
    const action = args.action
    const id = text(args.id)

    if (action === 'list') {
      const skins = await port.list()
      if (!skins.length) return { status: 'success', message: '皮肤库为空', data: { skins: [] } }
      const lines = skins.map((e) => `- ${e.id}：${e.skin.name}（${e.skin.base}）`)
      return {
        status: 'success',
        message: `共 ${skins.length} 套皮肤：\n${lines.join('\n')}`,
        data: { skins: skins.map((e) => ({ id: e.id, name: e.skin.name, base: e.skin.base })) },
      }
    }

    if (action === 'read') {
      if (!id) return failure('read 需要 id')
      const entry = await port.read(id)
      if (!entry) return failure(`皮肤不存在：${id}`)
      return {
        status: 'success',
        message: `皮肤${summaryOf(entry)}：\n${JSON.stringify(entry.skin, null, 2)}`,
        data: { id: entry.id, skin: entry.skin },
      }
    }

    if (action === 'apply') {
      if (!id) return failure('apply 需要 id；取消皮肤时传 none')
      if (id === NONE) {
        return {
          status: 'success',
          message: '已请求界面取消皮肤，恢复普通主题',
          data: { applied: null },
        }
      }
      const entry = await port.read(id)
      if (!entry) return failure(`皮肤不存在：${id}`)
      return {
        status: 'success',
        message: `已请求界面切换到皮肤${summaryOf(entry)}`,
        data: { applied: entry.id },
      }
    }

    if (action === 'save') {
      const patch = patchOf(args.skin_json)
      if (typeof patch === 'string') return failure(patch)
      const imagePath = text(args.image)
      if (!imagePath && Object.keys(patch).length === 0)
        return failure('save 需要 skin_json 或 image')
      let base: Skin = DEFAULT_SKIN
      if (id) {
        const existing = await port.read(id)
        if (!existing) return failure(`皮肤不存在：${id}`)
        base = existing.skin
      }
      let image: { name: string; bytes: Uint8Array } | undefined
      let finalPatch = patch
      if (imagePath) {
        const r = await withImage(ctx, imagePath, base, patch)
        if (typeof r === 'string') return failure(r)
        finalPatch = r.patch
        image = r.image
      }
      const merged = mergeSkin(base, finalPatch)
      if (!merged.ok) return failure(merged.error)
      const saved = await port.save(id, merged.value, image)
      if (!saved.ok) return failure(saved.error)
      return {
        status: 'success',
        message: `已${id ? '修改' : '新建'}皮肤${summaryOf(saved.entry)}${id ? '' : '；切换到它需再调用 apply'}`,
        data: { id: saved.entry.id, skin: saved.entry.skin },
      }
    }

    return failure('action 必须是 list、read、save 或 apply')
  },
}
