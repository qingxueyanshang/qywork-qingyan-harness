/**
 * 用系统默认浏览器打开地址。登录须在用户自己的浏览器中进行，登录状态才会保留；应用内的面板浏览器不保留。
 *
 * Windows 上不经 `cmd /c start`：地址中的 `&` 会被 cmd 当作命令分隔符。
 */
export function openSystemBrowser(url: string): void {
  const argv =
    process.platform === 'win32'
      ? ['rundll32', 'url.dll,FileProtocolHandler', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url]
  Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
}
