import { For, Show } from 'solid-js'
import { explainApiError, type LibraryVendor } from '../../lib/store/index.ts'

/**
 * 模型库 —— **一张模型参数表**。
 *
 * ## 它和接口没有关系
 *
 * 库回答「这个模型本身是什么样」：窗口多大、最大能输出多少、多少钱、吃哪几档思考。
 * 接口回答「用谁的端点、哪把 key」。两者唯一的接点是接口下那一行模型 id——
 * 参数照着 id 从这张表里查。所以这里没有「添加到接口」「新建接口」这类动作。
 *
 * ## 一个厂商一张卡，卡里一张自己的表
 *
 * 参数排成一行小标签时，两条模型的同一项不在同一个横坐标上，眼睛得逐条读，
 * 比不出来。所以每家的模型排成表：每项钉在一列上，扫一眼就是一列数字。
 * 数字列右对齐并用等宽数字（`tabular-nums`）——不对齐的话 `$0.2` 和 `$12.5`
 * 的小数点错位，量级差看着像不差。
 *
 * **各家不合成一张大表。** 合起来之后厂商名只能做成一个跨列的行，那一行右边是
 * 一大片空白；而顶部那份表头离下面几家隔着几十行，滚下去就对不上列了。
 * 表头跟着各自的模块走，滚到哪一家，哪一家的列名就在眼前。
 *
 * ## 高度交给外层
 *
 * 这一节**不设自己的 max-height**。上一版给列表加了 `max-height: 60vh` 又用
 * flex 竖排，于是每个厂商块被 flex 压缩、内容被裁掉——界面上是「每家只剩一行，
 * 后面几家整个是空的」。设置面板本来就有一条滚动轴，这里再加一条就是两条。
 *
 * ## 只读
 *
 * 这些参数由源码里的目录维护，界面只显示。**不给编辑入口**：一条参数填错的
 * 后果是账单对不上或请求发不出去，而用户手里没有判据——窗口和上限要查厂商文档，
 * 价格要对当期价目表。目录里没有的模型同样不在这里加：加一条只影响它自己的
 * 计价显示，真正决定能不能用的是接口下挂的那个 id。
 *
 * 需要临时纠正某一条时，改 `config.json` 的 `catalog`，或跑 `qy probe --save`。
 */
export function ModelLibrary(props: {
  vendors: LibraryVendor[]
  loading: boolean
  /** 取不回来时的原因。不写的话这一节只是空着，看起来像「内置库里什么都没有」。 */
  error: unknown
}) {
  return (
    <Show
      when={!props.loading && !props.error}
      fallback={
        <div class="lib-state">
          {props.error ? explainApiError(props.error, '读不到内置模型库') : '读取中…'}
        </div>
      }
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
                            <td class="num">{compact(m.maxOutputTokens)}</td>
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
                              <td colSpan={8}>{m.priceNotes?.join('；')}</td>
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
  )
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
