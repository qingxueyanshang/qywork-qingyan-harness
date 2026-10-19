/**
 * 在一个页会话中按指定视口渲染设计稿页面并截图。页面经 Art 引导页（`/art/host`）写入，与画布显示使用同一个引导页。
 *
 * 视口由 `Emulation.setDeviceMetricsOverride` 设定，不改变原生视图的尺寸。调用方以 hidden 方式创建该页
 * （`BrowserCoordinator.renderArt`），它不出现在界面的页签条上，面板中显示的页不受影响。
 */

import type { CdpEvent } from './cdp.ts'
import type { PageHandle } from './page.ts'

export interface ArtRenderInput {
  /** 引导页地址。 */
  hostUrl: string
  /** 已注入 importmap、图片已内嵌的页面（`server/art.ts` 的 `prepareArtForRender`）。 */
  html: string
  width: number
  height: number
  /** 页面加载完成后再等待的毫秒数：入场动画在此之前已有画面。 */
  settleMs: number
  /** 整次渲染的截止时刻（`Date.now()` 毫秒）。 */
  deadline: number
}

export interface ArtRenderResult {
  /** PNG 的 base64。 */
  png: string
  /** 页面脚本抛出的异常，每条取首行，按发生顺序。 */
  errors: string[]
}

/** 轮询间隔：引导页写入页面与模块脚本加载都在百毫秒量级内完成。 */
const POLL_MS = 50

export async function renderArtPage(
  page: PageHandle,
  input: ArtRenderInput,
): Promise<ArtRenderResult> {
  const { client, sessionId } = page
  const errors: string[] = []
  const off = client.onSessionEvent(sessionId, (event: CdpEvent) => {
    if (event.method !== 'Runtime.exceptionThrown') return
    const detail = event.params.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined
    errors.push((detail?.exception?.description ?? detail?.text ?? '页面脚本报错').split('\n')[0]!)
  })
  const left = () => Math.max(1, input.deadline - Date.now())
  try {
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: false },
      { sessionId, timeoutMs: left() },
    )
    await client.send('Page.navigate', { url: input.hostUrl }, { sessionId, timeoutMs: left() })
    await until(page, "document.readyState === 'complete'", input.deadline, '引导页')
    // 引导页的根元素带标记；页面写入后根元素被替换，标记消失即写入完成。
    // 在顶层页中 `parent` 即窗口自身，引导页只接受来自 `parent` 的消息，因此由页面向自身发送。
    await evaluate(
      page,
      `document.documentElement.setAttribute('data-qywork-host', '');` +
        `postMessage({ type: 'qywork-art-load', html: ${JSON.stringify(input.html)} }, '*')`,
      left(),
    )
    await until(
      page,
      "!document.documentElement.hasAttribute('data-qywork-host') && document.readyState === 'complete'",
      input.deadline,
      '设计稿页面',
    )
    await Bun.sleep(Math.min(input.settleMs, left()))
    const shot = await client.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png' },
      { sessionId, timeoutMs: left() },
    )
    return { png: shot.data, errors }
  } finally {
    off()
  }
}

async function evaluate(page: PageHandle, expression: string, timeoutMs: number): Promise<unknown> {
  const res = await page.client.send<{ result?: { value?: unknown } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    { sessionId: page.sessionId, timeoutMs },
  )
  return res.result?.value
}

/** 轮询直到表达式为真；到截止时刻仍未成立时抛出，写明等待的是哪一步。 */
async function until(page: PageHandle, expression: string, deadline: number, what: string) {
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`${what}加载超时`)
    if ((await evaluate(page, expression, left)) === true) return
    await Bun.sleep(POLL_MS)
  }
}
