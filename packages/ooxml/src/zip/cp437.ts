/**
 * CP437 解码，用于未设置 UTF-8 标志位的 ZIP 成员名。
 *
 * 0x00–0x7F 按 ASCII 解码，0x80–0xFF 按下表。各端 `TextDecoder` 均不支持 CP437，因此自带码表。
 */

const HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

export function decodeCp437(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    out += b < 0x80 ? String.fromCharCode(b) : HIGH.charAt(b - 0x80)
  }
  return out
}
