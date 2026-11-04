/**
 * 三种对话协议的请求体中，本仓库的适配器会发送的顶层字段。
 *
 * 云端网关只转发名单内的字段，名单外的字段一律拒绝：上游按更高单价计费的选项（优先处理档、快速模式、
 * 指定推理地域等）都是顶层字段，网关按标准价计费，转发即少收。
 * 适配器新增顶层字段时必须同时加入本名单，`request-fields.test.ts` 按各适配器实际发出的请求体检查；
 * 漏加时更新后的电脑端经云端发出的请求会被拒绝。电脑端发版前须先部署云端。
 */

import type { ProviderKind } from '@qywork/core'

export const REQUEST_FIELDS: Readonly<Record<ProviderKind, readonly string[]>> = {
  anthropic_messages: [
    'model',
    'max_tokens',
    'system',
    'messages',
    'tools',
    'thinking',
    'output_config',
    'stream',
  ],
  openai_chat_completions: [
    'model',
    'messages',
    'max_tokens',
    'tools',
    'preserve_thinking',
    'thinking',
    'reasoning_effort',
    'prompt_cache_key',
    'stream',
    'stream_options',
  ],
  openai_responses: [
    'model',
    'instructions',
    'input',
    'max_output_tokens',
    'tools',
    'reasoning',
    'prompt_cache_key',
    'store',
    'stream',
  ],
}
