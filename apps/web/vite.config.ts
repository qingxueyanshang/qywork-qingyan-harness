import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

/** sidecar 在哪个端口。由 `scripts/dev.ts` 灌进来，单独跑 vite 时回落到默认值。 */
const AGENT_PORT = process.env.QYWORK_PORT ?? '7717'

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5180,
    // **必须显式绑 127.0.0.1**：不写 host 时 vite 只监听 `::1`，而 Tauri CLI 探测
    // `devUrl` 里的 `localhost` 走的是 IPv4，两边碰不上，`tauri dev` 会一直卡在
    // 「Waiting for your frontend dev server」直到 180s 超时。
    host: '127.0.0.1',
    // 端口被占时**宁可直接失败**，不要顺延到 5181：顺延之后 vite 自己是好的，
    // 但 Tauri 的 devUrl 还指着 5180，表现成同一个超时，排查方向完全被带偏。
    strictPort: true,
    // 开发时前端和 qy serve 分开跑，代理过去省得配 CORS。
    // **端口跟着 `QYWORK_PORT` 走**：`scripts/dev.ts` 起不来 7717 时会往上挪一个
    // （上次留下的后台进程可能还攥着那个端口），写死在这里就代理到一个空端口上。
    proxy: {
      '/api': { target: `http://127.0.0.1:${AGENT_PORT}`, changeOrigin: true },
      '/stream': { target: `ws://127.0.0.1:${AGENT_PORT}`, ws: true },
    },
  },
  build: {
    target: 'es2022',
    // **不要**手动把 @codemirror/@lezer 归成一个 chunk。
    // 语言包是动态 import 的，手动归组会把它们全部合并回同一个 chunk
    // （实测 593 kB），按需加载就失效了。交给 Vite 按动态导入边界自动切分。
    chunkSizeWarningLimit: 700,
  },
})
