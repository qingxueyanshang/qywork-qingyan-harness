/**
 * 读取本机字体的用例的运行条件。判据只有 `fontsAvailable` 一个函数：给定的字体文件都在本机字体目录中时运行，
 * 否则跳过，并在输出中写明缺少的文件。不要改为读取时失败：读取不存在的文件时用例以 ENOENT 失败，
 * 输出中看不出缺少的是字体。
 *
 * `LOCAL_FONTS` 用于断言取自开发机字体文件（版本、字形编号、度量）与 WPS 实测结果的排版用例：
 * 要求 `REQUIRED` 中的全部字体，且不在 GitHub Actions 上运行。GitHub Actions 的 Windows 映像缺少等线、黑体、
 * 楷体等中文补充字体，Arial 的版本也不同；发布前的本机门禁运行这些用例。用例读取新的字体文件时须加入 `REQUIRED`。
 *
 * 只读取宋体、Times New Roman 与 Cambria Math 的用例以各自读取的字体清单直接调用 `fontsAvailable`，
 * 不加 GitHub Actions 条件：这三种字体在 GitHub Actions 的 Windows 映像上存在，用例在其上运行。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')

function skip(reason: string): false {
  console.warn(`读取本机字体的用例跳过：${reason}`)
  return false
}

/** 给定的字体文件都在本机字体目录中时返回 true；否则输出原因并返回 false。不是 Windows 时返回 false。 */
export function fontsAvailable(files: readonly string[]): boolean {
  if (process.platform !== 'win32') return skip('不是 Windows')
  const missing = files.filter((file) => !existsSync(join(FONTS, file)))
  return missing.length === 0 || skip(`${FONTS} 中缺少 ${missing.join('、')}`)
}

/** 排版用例读取的全部字体文件。 */
const REQUIRED = [
  'arial.ttf',
  'arialbd.ttf',
  'calibri.ttf',
  'cambria.ttc',
  'comic.ttf',
  'consola.ttf',
  'cour.ttf',
  'Deng.ttf',
  'ebrima.ttf',
  'georgia.ttf',
  'georgiab.ttf',
  'lucon.ttf',
  'malgun.ttf',
  'micross.ttf',
  'mingliub.ttc',
  'msgothic.ttc',
  'msyh.ttc',
  'segoepr.ttf',
  'seguiemj.ttf',
  'simfang.ttf',
  'simhei.ttf',
  'simkai.ttf',
  'simsun.ttc',
  'simsunb.ttf',
  'Sitka.ttc',
  'tahoma.ttf',
  'times.ttf',
  'trebuc.ttf',
  'verdana.ttf',
  'wingding.ttf',
  'YuGothR.ttc',
]

export const LOCAL_FONTS =
  process.env.GITHUB_ACTIONS === 'true'
    ? skip('GitHub Actions 的字体与开发机不同（LOCAL_FONTS）')
    : fontsAvailable(REQUIRED)
