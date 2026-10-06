/**
 * 终端二维码。
 *
 * 使用 `qrcode` 包而不是自行实现编码器：QR 的分组纠错、掩码选择、版本推导合计
 * 数百行，实现错误时的现象是手机无法识别而不是报错，难以自测。
 *
 * `small: true` 用半块字符把两行合并为一行，否则 80 行的终端无法容纳。
 */

import QRCode from 'qrcode'

export async function renderQr(text: string): Promise<string> {
  try {
    return await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })
  } catch (err) {
    // 二维码渲染失败不应导致 serve 无法启动：降级为由用户手动输入链接。
    return `（二维码渲染失败：${err instanceof Error ? err.message : String(err)}）`
  }
}
