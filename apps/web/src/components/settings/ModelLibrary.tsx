import { MEDIA_OUTPUTS, type MediaKind, type MediaOutput } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import { sessionSignal } from '../../lib/session.ts'
import {
  explainApiError,
  type LibraryVendor,
  type MediaLibraryModel,
  type MediaOperationName,
} from '../../lib/store/index.ts'
import { IconChevron } from '../Icons.tsx'

type Category = 'chat' | MediaOutput

const CATEGORY_LABEL: Record<Category, string> = {
  chat: '对话',
  image: '图像',
  video: '视频',
  audio: '音频',
}

/** 生成协议的显示名称：用户熟悉的接口名称，而不是内部枚举名。 */
export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  openai_images: 'OpenAI 兼容',
  dashscope_images: '百炼',
  gemini_images: 'Gemini',
  xai_images: 'xAI',
  openai_videos: 'OpenAI 兼容视频',
  ark_videos: '火山方舟',
  dashscope_videos: '百炼',
  kling_videos: '可灵',
  gemini_videos: 'Gemini',
  veo_videos: 'Veo',
  xai_videos: 'xAI',
  binguo_videos: '集梦',
  openai_speech: 'OpenAI 兼容',
  dashscope_speech: '百炼',
}

const OPERATION_LABEL: Record<MediaOperationName, string> = {
  generate: '生成',
  edit: '修改',
  text_to_video: '文生',
  image_to_video: '首帧',
  first_last_frame: '首尾帧',
  reference_to_video: '参考图',
  video_to_video: '参考视频',
  speech: '语音合成',
}

/**
 * 模型库：模型参数表。
 *
 * 模型库与接口无关。模型库描述模型本身的规格：上下文窗口、最大输出、价格、支持的思考
 * 档位。接口描述使用哪个端点与哪个 key。两者唯一的关联是接口下的模型 id：参数按 id 从本
 * 表中查询。因此本页没有「添加到接口」「新建接口」等操作。
 *
 * 每个厂商一张卡片，卡片内是该厂商的表格。参数排成一行小标签时，两个模型的同一项不在同一横坐标上，
 * 只能逐条阅读，无法比较。因此每家的模型排成表格：每项固定在一列，浏览时即可对比一列数字。各列统一
 * 左对齐，数字使用等宽字形（`tabular-nums`），标题和正文共享同一条起始线。
 *
 * 各厂商不合并为一张大表。合并后厂商名只能做成一个跨列的行，该行右侧是
 * 大片空白；而顶部的表头与下方各厂商相隔数十行，向下滚动后无法对照列名。
 * 表头随各自的卡片排列，滚动到任一厂商时，其列名都在视野内。
 *
 * 高度由外层决定，本节不设置自身的 max-height。给列表加 `max-height: 60vh` 并配合
 * flex 纵向排列时，每个厂商块被 flex 压缩、内容被裁剪，界面上每个厂商只剩一行，
 * 后续厂商完全空白。设置面板已有一条滚动轴，此处再加一条会形成两条滚动轴。
 *
 * 只读。这些参数由源码中的目录维护，界面只负责显示，不提供编辑入口：参数填错的
 * 后果是账单不一致或请求无法发出，而用户没有判据——窗口和上限需查厂商文档，
 * 价格需核对当期价目表。目录中没有的模型同样不在本页添加：添加一条只影响该模型自身的
 * 计价显示，决定能否使用的是接口下配置的模型 id。
 *
 * 需要临时纠正某一条时，修改 `config.json` 的 `catalog`；端点探测只校验当前接口
 * 是否透传控制字段，不修改官方规格表。
 *
 * 按类别划分页签，不按厂商划分。「对话」页签即上述按厂商分卡片的表格；生成类每类只收录各厂商最新一代模型，
 * 每类只有几行，因此每类一张表、厂商作为一列；若再按厂商拆分卡片，每张卡片只有一两行。
 * 没有条目的类别不显示页签。
 */
export function ModelLibrary(props: {
  vendors: LibraryVendor[]
  media: MediaLibraryModel[]
  loading: boolean
  /** 获取失败时的原因。不显示原因时本节为空白，看起来像内置库中没有任何模型。 */
  error: unknown
}) {
  const [category, setCategory] = sessionSignal<Category>(
    'qywork.settings.library.category',
    'chat',
  )
  const categories = (): Category[] => [
    'chat',
    ...MEDIA_OUTPUTS.filter((o) => props.media.some((m) => m.output === o)),
  ]
  return (
    <Show
      when={!props.loading && !props.error}
      fallback={
        <div class="lib-state">
          {props.error ? explainApiError(props.error, '无法读取内置模型库') : '读取中…'}
        </div>
      }
    >
      <section class="settings-block">
        <div class="lib-tabs">
          <For each={categories()}>
            {(c) => (
              <button
                class="lib-tab"
                classList={{ active: category() === c }}
                type="button"
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABEL[c]}
              </button>
            )}
          </For>
        </div>
        <Show
          when={category() === 'chat'}
          fallback={<MediaTable models={props.media.filter((m) => m.output === category())} />}
        >
          {/* 每个厂商一张卡片，各自带表头。
          不合并为一张大表：合并后厂商名只能做成一个跨列的行，该行右侧是
          大片空白，而顶部的表头与下方各厂商相隔数十行，向下滚动后无法对照列名。 */}
          <div class="lib">
            <For each={props.vendors}>
              {(v) => (
                <section class="lib-card">
                  {/* 窄窗口下表格在自身容器内横向滚动，不撑宽整个页面。 */}
                  <div class="lib-scroll">
                    <table class="lib-table">
                      {/* 只有一行标题。厂商名位于模型列的表头位置：
                      它标注的正是该列的内容，再单独增加一条灰色的厂商栏属于重复显示，
                      且上下各占一行。 */}
                      <thead>
                        <tr>
                          <th class="vendor">{v.displayName}</th>
                          <th class="num">上下文窗口</th>
                          <th class="num">最大输出</th>
                          <th>图片输入</th>
                          <th class="num">输入</th>
                          <th class="num">输出</th>
                          <th class="num">缓存读取</th>
                          <th class="num">缓存写入</th>
                          <th>思考强度</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={v.models}>
                          {(m) => (
                            <>
                              <tr>
                                {/* 只显示 id：显示名与 id 内容重复（`DeepSeek V4 Flash`
                                与 `deepseek-v4-flash`），而 id 是配置中实际需要填写的值。 */}
                                <td>
                                  <code class="lib-id">{m.id}</code>
                                </td>
                                <td class="num">{compact(m.contextWindow)}</td>
                                {/* 未经测量时留空：填入编造的数值，用户会据此判断能否生成长文本。 */}
                                <td class="num">
                                  {m.maxOutputTokens === null ? '—' : compact(m.maxOutputTokens)}
                                </td>
                                {/* 三态按实际显示。`null` 表示厂商未注明，显示为「不支持」等于
                                替厂商作出保证，而无法在界面上区分两者的用户会据此做决定。 */}
                                <td class="lv">
                                  {m.vision === null ? '—' : m.vision ? '支持' : '不支持'}
                                </td>
                                <td class="num">{price(m.input, m.currency)}</td>
                                <td class="num">{price(m.output, m.currency)}</td>
                                <td class="num">{price(m.cacheRead, m.currency)}</td>
                                <td class="num">{price(m.cacheWrite, m.currency)}</td>
                                {/* 该模型支持的档位。为空时显示「不支持」而不是留白：
                                留白看起来像该单元格未加载完成。 */}
                                <td class="lv">
                                  {m.effortLevels.length > 0
                                    ? m.effortLevels.join(' / ')
                                    : m.thinksByDefault
                                      ? '默认开启'
                                      : '不支持'}
                                </td>
                              </tr>

                              {/* 分时段折扣、长上下文分档计价：上方的价格是标准价，此说明必须显示。
                              只显示一个数字时，用户核对账单会发现金额不一致，差价可达两倍。 */}
                              <Show when={m.priceNotes?.length}>
                                <tr class="lib-note">
                                  <td colSpan={9}>{m.priceNotes?.join('；')}</td>
                                </tr>
                              </Show>
                            </>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  )
}

/**
 * 每类生成模型一张表。参数表由行末的按钮展开到下一整行：每个模型的参数各不相同且条数较多，
 * 展开为列无法容纳，放在最后一列中又只有很窄的宽度；展开的文字与交给模型的内容相同。
 */
function MediaTable(props: { models: MediaLibraryModel[] }) {
  return (
    <section class="lib-card">
      <div class="lib-scroll">
        <table class="lib-table media">
          <thead>
            <tr>
              <th>模型</th>
              <th>厂商</th>
              <th>协议</th>
              <th>操作</th>
              <th>参数</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.models}>
              {(m) => {
                const [open, setOpen] = createSignal(false)
                return (
                  <>
                    <tr>
                      <td>
                        <code class="lib-id">{m.id}</code>
                      </td>
                      <td>{m.vendor ?? '—'}</td>
                      <td>{MEDIA_KIND_LABEL[m.kind]}</td>
                      <td>
                        {m.operations.map((o) => OPERATION_LABEL[o] + inputLimit(m, o)).join(' / ')}
                      </td>
                      <td>
                        <button
                          class="lib-params-toggle"
                          type="button"
                          aria-expanded={open()}
                          onClick={() => setOpen(!open())}
                        >
                          {m.params.length} 项
                          <IconChevron dir={open() ? 'up' : 'down'} size={12} />
                        </button>
                      </td>
                    </tr>
                    <Show when={open()}>
                      <tr class="lib-params">
                        <td colSpan={5}>
                          <ul>
                            <For each={m.params}>{(line) => <li>{line}</li>}</For>
                          </ul>
                        </td>
                      </tr>
                    </Show>
                  </>
                )
              }}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * 接受参考素材的操作后附加数量上限，如「参考图 ≤30」。上限写在其约束的操作旁边，不单独成列：
 * 单列时视频页的表宽超出设置页，且语音页整列都是空值。首尾帧不计入。
 */
function inputLimit(m: MediaLibraryModel, op: MediaOperationName): string {
  const n =
    op === 'edit' || op === 'reference_to_video'
      ? m.maxImages
      : op === 'video_to_video'
        ? m.maxVideos
        : 0
  return n ? ` ≤${n}` : ''
}

/** 100 万 → 1M。窗口和上限都是量级信息，显示完整数字时需要逐位数零。 */
function compact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** 每百万 token 的单价。币种是数据的一部分：把 ¥6 误作 $6 会相差约七倍。 */
function price(n: number | null, currency: 'USD' | 'CNY'): string {
  if (n === null) return '—'
  return `${currency === 'CNY' ? '¥' : '$'}${n}`
}
