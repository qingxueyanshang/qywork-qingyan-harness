/** hongcheng 的素材上传与视频请求结构；任务生命周期由 OpenAIVideosAdapter 负责。 */
import { mediaParamValues } from '@qywork/core'
import type { MediaModelSpec } from '../catalog.ts'
import { sendJson } from '../http.ts'
import { MediaError, type MediaInput, type MediaRequest } from '../types.ts'

/** 上传单个素材并校验回执；生成请求仅使用返回的公网地址。 */
export async function uploadHongchengReference(
  input: MediaInput,
  base: string,
  auth: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = new URL('/refhost/upload', base).href
  let uploaded = ''
  await sendJson(
    endpoint,
    {
      method: 'POST',
      headers: { ...auth, 'content-type': input.mime, 'x-requested-with': 'XMLHttpRequest' },
      body: new Blob([input.bytes]),
    },
    signal,
    {
      stage: 'upload',
      validate(body) {
        const value = body.url ?? body.ref_url
        if (typeof value !== 'string' || !value.trim()) return '上传接口未返回素材地址'
        if (!value.startsWith('https://') && !/^\/(?!\/)/.test(value))
          return '上传接口未返回有效的 HTTPS 素材地址'
        try {
          const url = new URL(value, endpoint)
          if (url.protocol !== 'https:' || url.username || url.password)
            return '上传接口未返回有效的 HTTPS 素材地址'
          uploaded = url.href
        } catch {
          return '上传接口未返回有效的 HTTPS 素材地址'
        }
      },
    },
  )
  return uploaded
}

/**
 * 参考素材同时写入顶层字段与 `metadata.__workbench_refs`：渠道网关对部分线路丢弃顶层的参考素材字段，
 * 由参考透传服务按 `__workbench_refs`（含本次的 `trace_id`）把素材交给上游。只写顶层字段时，
 * 这些线路的任务以「提示词引用的参考素材缺失」失败。`duration` 为整数秒，与 `seconds` 同时发送。
 */
export async function hongchengVideoPayload(
  req: MediaRequest,
  spec: MediaModelSpec,
  base: string,
  auth: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const references: Record<string, string[]> = {}
  const bridged: Record<string, string[]> = {}
  const fields = {
    reference: ['reference_images', 'reference_image_urls'],
    video: ['reference_videos', 'reference_video_urls'],
    audio: ['reference_audios', 'reference_audio_urls'],
  } as const
  for (const input of req.inputs) {
    if (!(input.role in fields)) throw new MediaError('该模型不支持首尾帧输入；未提交生成')
  }
  for (const input of req.inputs) {
    const [field, bridge] = fields[input.role as keyof typeof fields]
    const uploaded = await uploadHongchengReference(input, base, auth, signal)
    references[field] ??= []
    references[field].push(uploaded)
    bridged[bridge] ??= []
    bridged[bridge].push(uploaded)
  }
  const params = mediaParamValues(spec.params, req.params)
  const shape = {
    resolution: params.resolution,
    aspect_ratio: params.aspect_ratio,
    ratio: params.aspect_ratio,
  }
  return {
    ...params,
    ...shape,
    duration: Number(params.seconds),
    ...references,
    metadata: {
      __workbench_passthrough: shape,
      ...(req.inputs.length
        ? { __workbench_refs: { ...bridged, trace_id: `ref-${crypto.randomUUID()}` } }
        : {}),
    },
  }
}
