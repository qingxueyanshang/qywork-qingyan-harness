import { MEDIA_OUTPUTS, type MediaKind, type MediaOutput } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import {
  explainApiError,
  type LibraryVendor,
  type MediaLibraryModel,
  type MediaOperationName,
} from '../../lib/store/index.ts'

type Category = 'chat' | MediaOutput

const CATEGORY_LABEL: Record<Category, string> = {
  chat: '对话',
  image: '图像',
  video: '视频',
  audio: '音频',
}

/** 生成协议的显示名：用户认得的接口形状，不是内部枚举名。 */
const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  openai_images: 'OpenAI 兼容',
  dashscope_images: '百炼',
  openai_videos: '中转 /v1/videos',
  ark_videos: '火山方舟',
  dashscope_videos: '百炼',
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
 * 模型库 —— **一张模型参数表**。
 *
 * **它和接口没有关系。** 库回答「这个模型本身是什么样」：窗口多大、最大能输出多少、多少钱、吃哪几档
 * 思考。接口回答「用谁的端点、哪把 key」。两者唯一的接点是接口下那一行模型 id——参数照着 id 从这
 * 张表里查。所以这里没有「添加到接口」「新建接口」这类动作。
 *
 * **一个厂商一张卡，卡里一张自己的表。** 参数排成一行小标签时，两条模型的同一项不在同一个横坐标上，
 * 眼睛得逐条读，比不出来。所以每家的模型排成表：每项钉在一列上，扫一眼就是一列数字。各列统一
 * 左对齐，数字使用等宽字形（`tabular-nums`），标题和正文共享同一条起始线。
 *
 * **各家不合成一张大表。** 合起来之后厂商名只能做成一个跨列的行，那一行右边是
 * 一大片空白；而顶部那份表头离下面几家隔着几十行，滚下去就对不上列了。
 * 表头跟着各自的模块走，滚到哪一家，哪一家的列名就在眼前。
 *
 * **高度交给外层。** 这一节**不设自己的 max-height**。给列表加 `max-height: 60vh` 再配
 * flex 竖排，因此每个厂商块被 flex 压缩、内容被裁掉——界面上是「每家只剩一行，
 * 后面几家整个是空的」。设置面板本来就有一条滚动轴，这里再加一条就是两条。
 *
 * **只读。** 这些参数由源码里的目录维护，界面只显示。**不给编辑入口**：一条参数填错的
 * 后果是账单对不上或请求发不出去，而用户手里没有判据——窗口和上限要查厂商文档，
 * 价格要对当期价目表。目录里没有的模型同样不在这里加：加一条只影响它自己的
 * 计价显示，真正决定能不能用的是接口下挂的那个 id。
 *
 * 需要临时纠正某一条时，改 `config.json` 的 `catalog`；端点探测只校验当前接口
 * 是否透传控制字段，不会改这张官方规格表。
 *
 * **按类别分页签，不按厂商分。** 「对话」页签就是上面这张按厂商分卡的表；生成类每类只收各家最新一代，
 * 一类就几行，所以每类一张表、厂商作为一列，再按厂商拆卡，每张卡只有一两行。
 * 没有条目的类别不出页签。
 */
export function ModelLibrary(props: {
  vendors: LibraryVendor[]
  media: MediaLibraryModel[]
  loading: boolean
  /** 取不回来时的原因。不写的话这一节只是空着，看起来像「内置库里什么都没有」。 */
  error: unknown
}) {
  const [category, setCategory] = createSignal<Category>('chat')
  const categories = (): Category[] => [
    'chat',
    ...MEDIA_OUTPUTS.filter((o) => props.media.some((m) => m.output === o)),
  ]
  return (
    <Show
      when={!props.loading && !props.error}
      fallback={
        <div class="lib-state">
          {props.error ? explainApiError(props.error, '读不到内置模型库') : '读取中…'}
        </div>
      }
    >
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
        {/* 一个厂商一张卡，各自带表头。
          不合成一张大表：合起来之后厂商名只能做成一个跨列的行，那一行右边是
          一大片空白，而顶部那份表头离下面几家隔着几十行，滚下去就对不上列了。 */}
        <div class="lib">
          <For each={props.vendors}>
            {(v) => (
              <section class="lib-card">
                {/* 窄窗口下表格自己横向滚，不把整页撑宽。 */}
                <div class="lib-scroll">
                  <table class="lib-table">
                    {/* **只有一行标题。** 厂商名就坐在「模型」那一列的表头位置——
                      它标的正是这一列的内容，再单开一条灰色的厂商栏就是同一件事
                      写两遍，上下各占一行。 */}
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
                              {/* 只给 id：显示名与它是同一件事写两遍（`DeepSeek V4 Flash`
                                对 `deepseek-v4-flash`），而 id 才是配置里真正要填的那个词。 */}
                              <td>
                                <code class="lib-id">{m.id}</code>
                              </td>
                              <td class="num">{compact(m.contextWindow)}</td>
                              {/* 没测过就空着：编一个数填进去，用户会照它去判断能不能写长文。 */}
                              <td class="num">
                                {m.maxOutputTokens === null ? '—' : compact(m.maxOutputTokens)}
                              </td>
                              {/* 三态照实显示。`null` 是「厂商没写」，写成「不支持」就是
                                替厂商作保，而界面上分不出这两者的用户会照它做决定。 */}
                              <td class="lv">
                                {m.vision === null ? '—' : m.vision ? '支持' : '不支持'}
                              </td>
                              <td class="num">{price(m.input, m.currency)}</td>
                              <td class="num">{price(m.output, m.currency)}</td>
                              <td class="num">{price(m.cacheRead, m.currency)}</td>
                              <td class="num">{price(m.cacheWrite, m.currency)}</td>
                              {/* 这个模型支持哪几档。空的写「不支持」而不是留白——
                                留白读起来像「这一格没加载出来」。 */}
                              <td class="lv">
                                {m.effortLevels.length > 0
                                  ? m.effortLevels.join(' / ')
                                  : m.thinksByDefault
                                    ? '默认开启'
                                    : '不支持'}
                              </td>
                            </tr>

                            {/* 分时段折扣、长上下文换档：上面那个价是标准价，这句必须显示。
                              只画一个数字的话，用户对着账单会发现对不上，而差价是两倍。 */}
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
    </Show>
  )
}

/**
 * 一类生成模型一张表。参数表收在行末的展开里：每个模型的参数各不相同、条数也多，
 * 摊成列装不下；展开的文字与交给大模型的是同一份。
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
              <th>参考上限</th>
              <th>参数</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.models}>
              {(m) => (
                <tr>
                  <td>
                    <code class="lib-id">{m.id}</code>
                  </td>
                  <td>{m.vendor ?? '—'}</td>
                  <td class="lv">{MEDIA_KIND_LABEL[m.kind]}</td>
                  <td class="lv">{m.operations.map((o) => OPERATION_LABEL[o]).join(' / ')}</td>
                  <td class="lv">{inputLimits(m)}</td>
                  <td>
                    <details class="lib-params">
                      <summary>{m.params.length} 项</summary>
                      <ul>
                        <For each={m.params}>{(line) => <li>{line}</li>}</For>
                      </ul>
                    </details>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** 参考图与参考视频的上限，如「图 10 · 视频 5」。首尾帧不计入。 */
function inputLimits(m: MediaLibraryModel): string {
  const parts = [m.maxImages ? `图 ${m.maxImages}` : '', m.maxVideos ? `视频 ${m.maxVideos}` : '']
  return parts.filter(Boolean).join(' · ') || '—'
}

/** 100 万 → 1M。窗口和上限都是量级信息，完整数字反而要人数零。 */
function compact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** 每百万 token 的单价。币种是数据的一部分——¥6 当成 $6 差七倍。 */
function price(n: number, currency: 'USD' | 'CNY'): string {
  return `${currency === 'CNY' ? '¥' : '$'}${n}`
}
