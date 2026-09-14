/**
 * 内置浏览器插件。
 *
 * 每个工具是**一次有限操作**：发一条 `host.browser.*` 就返回，由 agent 再观察再决定
 * 下一步。这里不自己循环、不解释任务、不重试有副作用的动作——重试一次点击等于在网站上
 * 多提交一次。
 *
 * 反向 RPC 必须带 `parentCallId`：宿主按它取回这次调用的工作区、会话与 Run，
 * 参数里自报的身份一概不作数。调用取消或超时之后这个 id 立即失效，宿主会发
 * `call.cancelled`，此后不再发起新的宿主调用。
 *
 * `tabs` 的 `bind` 用于接管一页到本会话：本会话自己开的页不用 bind（直接操作即可），
 * bind 是给「用户在聊天里点名的、他自己开的那页」用的，归属判定在宿主。
 */

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

/** 在飞的宿主调用。宿主回 `host.result` 时按 id 结掉。 */
const waiting = new Map()
/** 已被宿主作废的工具调用。它们不再发起新的宿主调用。 */
const cancelled = new Set()

function host(parentCallId, method, params) {
  if (cancelled.has(parentCallId)) {
    return Promise.reject(new Error('本次调用已被取消'))
  }
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    send({ type: 'host', id, method, params, parentCallId })
  })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i = buf.indexOf('\n')
  while (i >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    i = buf.indexOf('\n')
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'host.result') {
      const w = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (w) {
        if (msg.ok) w.resolve(msg.result)
        else w.reject(new Error(msg.error?.message ?? '宿主调用失败'))
      }
    } else if (msg.type === 'call.cancelled') {
      cancelled.add(msg.id)
    } else if (msg.type === 'call') {
      void handle(msg)
    }
  }
})

const TOOLS = {
  tabs: async (id, p) => {
    if (p.action === 'create') {
      const tab = await host(id, 'browser.open', { url: p.url })
      return { message: `已打开 ${tab.tabId}：${tab.url}`, data: { tab } }
    }
    if (p.action === 'bind') {
      const tab = await host(id, 'browser.bind', { tabId: p.tabId })
      return { message: `已接管 ${tab.tabId}：${tab.url}`, data: { tab } }
    }
    if (p.action === 'close') {
      await host(id, 'browser.close', { tabId: p.tabId })
      return { message: `已关闭 ${p.tabId}`, data: {} }
    }
    if (p.action !== 'list')
      throw new Error(`action 只能是 list / create / bind / close，收到 ${p.action}`)
    const { tabs } = await host(id, 'browser.tabs', {})
    const mine = tabs.filter((t) => t.controlled).length
    const user = tabs.filter((t) => !t.controlled).length
    return {
      message:
        `${tabs.length} 个标签页，其中 ${mine} 个归本会话（可直接操作）` +
        (user ? `，${user} 个是用户开的（用户点名后可 bind 接管）` : ''),
      data: { tabs },
    }
  },

  navigate: async (id, p) => {
    const tab = await host(id, 'browser.navigate', {
      tabId: p.tabId,
      action: p.action,
      url: p.url,
    })
    return { message: `${tab.tabId} 现在是 ${tab.url}`, data: { tab } }
  },

  observe: async (id, p) => {
    const ob = await host(id, 'browser.observe', {
      tabId: p.tabId,
      frame: p.frame,
      screenshot: p.screenshot,
      offset: p.offset,
    })
    const { image, ...rest } = ob
    return {
      message:
        `${ob.title || '(无标题)'} · ${ob.url} · ${ob.elements.length} 个元素` +
        (ob.truncated ? '（还有更多，用 offset 继续取）' : ''),
      data: { ...rest, ...(image ? { images: [image] } : {}) },
    }
  },

  act: async (id, p) => {
    const r = await host(id, 'browser.act', {
      tabId: p.tabId,
      observationId: p.observationId,
      action: p.action,
      ref: p.ref,
      text: p.text,
      key: p.key,
      deltaY: p.deltaY,
    })
    return {
      message: `${p.action} 已发出${r.element ? `：${r.element}` : ''}。页面可能已变化，下一步先重新观察`,
      data: r,
    }
  },

  wait: async (id, p) => {
    const r = await host(id, 'browser.wait', {
      tabId: p.tabId,
      selector: p.selector,
      timeoutMs: p.timeoutMs,
    })
    return {
      message: r.found
        ? `${p.selector} 已出现`
        : `没等到 ${p.selector}（${r.reason ?? 'timeout'}）`,
      data: r,
    }
  },

  upload: async (id, p) => {
    const r = await host(id, 'browser.upload', {
      tabId: p.tabId,
      observationId: p.observationId,
      ref: p.ref,
      paths: p.paths,
    })
    return { message: `已交给文件输入框 ${r.files.length} 个文件`, data: r }
  },

  download: async (id, p) => {
    const r = await host(id, 'browser.download', {
      tabId: p.tabId,
      observationId: p.observationId,
      ref: p.ref,
      path: p.path,
    })
    if (r.blocked) {
      return {
        status: 'failure',
        message: `下载被拦下：${r.blocked}${r.suggestedName ? `（${r.suggestedName}）` : ''}`,
        data: r,
      }
    }
    return { message: `已保存到 ${r.path}，${r.bytes} 字节`, data: r }
  },
}

async function handle(msg) {
  const tool = TOOLS[msg.method]
  if (!tool) {
    send({
      id: msg.id,
      ok: true,
      result: { status: 'failure', message: `没有这个工具：${msg.method}` },
    })
    return
  }
  try {
    const r = await tool(msg.id, msg.params ?? {})
    send({ id: msg.id, ok: true, result: { status: 'success', executed: true, ...r } })
  } catch (err) {
    // 动作可能已经发到网站上了，所以 executed 保持 true：失败不等于没发生。
    send({
      id: msg.id,
      ok: true,
      result: { status: 'failure', executed: true, message: String(err?.message ?? err) },
    })
  }
}

send({ type: 'ready' })
