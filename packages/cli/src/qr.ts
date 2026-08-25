/**
 * 终端二维码。
 *
 * 用 `qrcode` 包而不是自己写编码器：QR 的分组纠错、掩码选择、版本推导加起来
 * 几百行，写错的表现是「手机扫不出来」而不是报错——最难自测的那一类。
 *
 * `small: true` 用半块字符把两行压成一行，否则在 80 行的终端里放不下。
 */

import QRCode from 'qrcode'

export async function renderQr(text: string): Promise<string> {
  try {
    return await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' })
  } catch (err) {
    // 二维码画不出来不该让 serve 起不来——降级成让用户手动输入链接。
    return `（二维码渲染失败：${err instanceof Error ? err.message : String(err)}）`
  }
}
