/**
 * 经云端网页打开时，本页位于其 iframe 中；返回电脑列表的入口由本页提供（侧栏头部）。
 *
 * 与云端网页的约定（`qywork.back`）：
 * - `available`：本页已显示返回入口，云端网页据此不再显示自己的返回条；
 * - `requested`：用户点击了返回，由云端网页回到电脑列表。
 * 消息不含令牌与会话内容，因此不限定接收方的来源。
 */

export const embedded = window.parent !== window

export function postBack(state: 'available' | 'requested'): void {
  window.parent.postMessage({ type: 'qywork.back', state }, '*')
}
