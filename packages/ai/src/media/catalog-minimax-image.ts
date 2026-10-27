/**
 * MiniMax 图像生成 image-01，2026-10-27 核对官方「文生图」「图生图」接口与价格页。
 *
 * 参数平铺，名称与接口字段相同；适配器将 `style_type` 放入 `style`，参考图放入 `subject_reference`。
 */
import type { MediaModelSpec, MediaParamSpec, MediaPrice } from './catalog.ts'

const RATIOS = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16']

// 价格页「图像」：image-01 与 image-01-live 每张 ¥0.025，参考图不另计费。
const price: MediaPrice = {
  currency: 'CNY',
  cost: (u) => (u.images === undefined ? null : u.images * 0.025),
  usageOf: (p) => ({ images: Number(p.n) }),
}

/** `live`：image-01-live 不支持 21:9，另有画风。 */
function params(live: boolean): MediaParamSpec[] {
  return [
    {
      name: 'aspect_ratio',
      label: '宽高比',
      type: 'enum',
      values: live ? RATIOS : [...RATIOS, '21:9'],
      default: '1:1',
      description: live
        ? '输出画幅：1:1 为 1024x1024，16:9 为 1280x720'
        : '输出画幅：1:1 为 1024x1024，16:9 为 1280x720，21:9 为 1344x576',
    },
    {
      name: 'n',
      label: '张数',
      type: 'integer',
      min: 1,
      max: 9,
      default: 1,
      description: '一次生成的张数',
    },
    ...(live
      ? [
          {
            name: 'style_type',
            label: '画风',
            type: 'enum',
            values: ['漫画', '元气', '中世纪', '水彩'],
            description: '画风',
          } satisfies MediaParamSpec,
        ]
      : []),
    {
      name: 'seed',
      label: '种子',
      advanced: true,
      type: 'integer',
      description: '随机种子；相同种子与参数生成相近的图片',
    },
    {
      name: 'prompt_optimizer',
      label: '提示词优化',
      advanced: true,
      type: 'boolean',
      default: false,
      description: '由接口自动优化提示词',
    },
    {
      name: 'aigc_watermark',
      label: '水印',
      advanced: true,
      type: 'boolean',
      default: false,
      description: '在图片中添加水印',
    },
  ]
}

/** 协议默认与目录条目共用。参考图为人物主体参考，每次请求仅接受一张。 */
export const MINIMAX_IMAGE_DEFAULT: Omit<MediaModelSpec, 'id' | 'displayName'> = {
  vendor: null,
  kind: 'minimax_images',
  operations: ['generate', 'edit'],
  maxPromptLength: 1500,
  inputs: { maxImages: 1, maxVideos: 0, transport: 'json' },
  params: params(false),
  catalogued: false,
}

const model = (id: string, displayName: string, live: boolean): MediaModelSpec => ({
  ...MINIMAX_IMAGE_DEFAULT,
  id,
  displayName,
  vendor: 'MiniMax',
  params: params(live),
  price,
  catalogued: true,
})

export const MINIMAX_IMAGE_MODELS: readonly MediaModelSpec[] = [
  model('image-01', 'MiniMax Image 01', false),
  model('image-01-live', 'MiniMax Image 01 Live', true),
]
