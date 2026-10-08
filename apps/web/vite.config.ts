import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

/** sidecar 的端口。由 `scripts/dev.ts` 传入，单独运行 vite 时使用默认值。 */
const AGENT_PORT = process.env.QYWORK_PORT ?? '7717'
/**
 * 桌面源码开发时，前后端代码的更新由 `scripts/dev.ts` 统一协调。
 *
 * 活动 run 期间 sidecar 必须用旧代码执行完毕；此时若 Vite 先通过 HMR 加载新 UI，页面与
 * 后端来自两个版本的源码。新 UI 只识别新后端登记的子会话 busy 状态，旧后端没有该登记，
 * 新建 subagent 后状态条不显示。协调模式下关闭 HMR，空闲后 sidecar 重启，页面根据新的
 * streamId 整页刷新，前后端同时更新。
 */
const COORDINATED_RELOAD = process.env.QYWORK_COORDINATED_RELOAD === '1'

export default defineConfig(({ command }) => ({
  define: {
    __QYWORK_UPDATE_ENDPOINT__:
      command === 'serve' ? (process.env.QYWORK_UPDATE_ENDPOINT ?? 'null') : 'null',
  },
  plugins: [solid()],
  server: {
    port: 5180,
    // 必须显式绑定 127.0.0.1：不设置 host 时 vite 只监听 `::1`，而 Tauri CLI 探测
    // `devUrl` 中的 `localhost` 使用 IPv4，两者无法连通，`tauri dev` 停滞在
    // 「Waiting for your frontend dev server」直至 180s 超时。
    host: '127.0.0.1',
    // 端口被占用时直接失败，不要顺延到 5181：顺延后 vite 正常运行，但 Tauri 的 devUrl
    // 仍指向 5180，现象与上一条的超时相同，排查方向会被误导。
    strictPort: true,
    ...(COORDINATED_RELOAD ? { hmr: false } : {}),
    // 开发时前端与 qy serve 分别运行，经代理转发，无需配置 CORS。
    // 端口跟随 `QYWORK_PORT`：`scripts/dev.ts` 无法占用 7717 时会顺延一个端口
    // （之前的后台进程可能仍占用该端口），在此写死会代理到无服务监听的端口。
    proxy: {
      '/api': { target: `http://127.0.0.1:${AGENT_PORT}`, changeOrigin: true },
      '/stream': { target: `ws://127.0.0.1:${AGENT_PORT}`, ws: true },
      // Art 页面的引导页与库文件由 qy serve 提供（见 packages/server/src/art.ts）。
      '/art': { target: `http://127.0.0.1:${AGENT_PORT}`, changeOrigin: true },
    },
  },
  // mediabunny 只经动态导入使用（时间线导出、Art 录制）。不预先声明时，开发服务器在第一次导出时才打包它
  // 并作废已加载的依赖地址，这次导出以「Failed to fetch dynamically imported module」失败。
  optimizeDeps: { include: ['mediabunny'] },
  build: {
    target: 'es2022',
    // 不要手动把 @codemirror/@lezer 归入同一个 chunk。
    // 语言包通过动态 import 加载，手动归组会把它们全部合并到同一个 chunk
    // （实测 593 kB），按需加载失效。由 Vite 按动态导入边界自动切分。
    chunkSizeWarningLimit: 700,
  },
}))
