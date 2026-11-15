import type { Migration } from './shared.ts'

export const migration027: Migration = {
  id: 27,
  name: 'tool_image_bytes_array',
  /**
   * 工具结果中的图像字节改为数组：`data.imageData` + `data.mime`
   * → `data.images: [{data, mime}]`。
   *
   * 不迁移的后果已经实测确认，且不报错：剥离字节的 `envelopeResult` 与生成图像块的
   * `imagesOf`（均在 `agent/loop/request.ts`）只识别 `images`，旧行与两者都不匹配，
   * 因此整段 base64 原样进入信封，作为**文本**发出。同一会话实测 12 条旧行共
   * 2.79 MB base64：本地按 4 字符/token 计为 732k，provider 侧约 1.9M，
   * 一次请求直接因超出容量被拒绝；压缩清除大部分后仍有两张图留在窗口中，
   * 占 1M 窗口的 42%（428k），而以图像块发送的实测成本为每张约 1k。
   *
   * **只改键名，不重新编码。** 这些图长边为 1600，只比 `MAX_EDGE` 大 2%，
   * 而 `tools/image.ts` 文件头的实测说明重新编码 PNG 会使体积增大 2.4 倍；
   * 以图像块发送的成本取决于像素数而不是字节数，重新编码不节省任何费用。
   *
   * `mime` 一并移入数组元素：旧结构中它就是该图的 mime，留在 `data` 上会使
   * `envelopeResult` 将其视为图像之外的其他结果，在信封中保留一个
   * `{"mime":"image/png"}`，与新行结构不同；同一次调用在两轮中的内容不一致，
   * 前缀缓存从该处失效。
   *
   * 幂等：转换完成后 `$.outcome.data.imageData` 不存在，重复执行命中零行。
   * WHERE 按 JSON 路径匹配而不是按文本，因此正文中含 `imageData` 标识符的
   * `write_file` / `grep` 记录不受影响（实测库中有 10 条这样的行）。
   */
  sql: `
UPDATE steps
SET payload = json_remove(
  json_set(
    payload,
    '$.outcome.data.images',
    json_array(json_object(
      'data', json_extract(payload, '$.outcome.data.imageData'),
      'mime', json_extract(payload, '$.outcome.data.mime')
    ))
  ),
  '$.outcome.data.imageData',
  '$.outcome.data.mime'
)
WHERE json_extract(payload, '$.outcome.data.imageData') IS NOT NULL;
`,
}
