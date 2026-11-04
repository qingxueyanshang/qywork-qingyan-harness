/**
 * 本机字体用例的运行条件。这些用例的断言取自开发机上的字体文件（版本、字形编号、度量）与 WPS 的实测结果，
 * 只在 Windows 开发机上运行。GitHub Actions 的 Windows 映像缺少等线、黑体、楷体等中文补充字体，Arial 的版本也不同，
 * 在其上不运行；发布前的本机门禁运行全部本机字体用例。
 */
export const LOCAL_FONTS = process.platform === 'win32' && process.env.GITHUB_ACTIONS !== 'true'
