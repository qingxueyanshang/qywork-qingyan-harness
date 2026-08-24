# 第三方依赖许可证清单

本文件记录 qywork 直接声明的第三方依赖及其许可证。它不涉及 qywork 自有代码、青研魔盒自有代码，或开发过程中的功能/界面参考。

版本以本仓库的 `bun.lock` 与 `apps/desktop/src-tauri/Cargo.lock` 为准；两份锁文件同时固定了下列依赖的传递依赖。发布桌面安装包时，应将本文件随安装包一同提供，并在升级依赖后重新核对。

## Bun / npm 运行时依赖

| 组件 | 锁定版本 | 许可证 |
| --- | ---: | --- |
| `@anthropic-ai/sdk` | 0.80.0 | MIT |
| `@codemirror/lang-css` | 6.3.1 | MIT |
| `@codemirror/lang-html` | 6.4.12 | MIT |
| `@codemirror/lang-javascript` | 6.2.5 | MIT |
| `@codemirror/lang-json` | 6.0.2 | MIT |
| `@codemirror/lang-markdown` | 6.5.2 | MIT |
| `@codemirror/lang-python` | 6.2.1 | MIT |
| `@codemirror/lang-rust` | 6.0.2 | MIT |
| `@codemirror/merge` | 6.12.2 | MIT |
| `@codemirror/state` | 6.7.1 | MIT |
| `@codemirror/view` | 6.43.8 | MIT |
| `@silvia-odwyer/photon-node` | 0.3.4 | Apache-2.0 |
| `@xterm/addon-fit` | 0.11.0 | MIT |
| `@xterm/xterm` | 6.0.0 | MIT |
| `codemirror` | 6.0.2 | MIT |
| `highlight.js` | 11.11.1 | BSD-3-Clause |
| `marked` | 18.0.9 | MIT |
| `openai` | 6.49.0 | Apache-2.0 |
| `qrcode` | 1.5.4 | MIT |
| `solid-js` | 1.9.14 | MIT |
| `unpdf` | 1.8.1 | MIT |
| `xss` | 1.0.15 | MIT |
| `zod` | 4.3.6 | MIT |

## Rust / Cargo 桌面运行时依赖

| 组件 | 锁定版本 | 许可证 |
| --- | ---: | --- |
| `anyhow` | 1.0.104 | MIT OR Apache-2.0 |
| `notify` | 8.2.0 | CC0-1.0 |
| `notify-debouncer-full` | 0.5.0 | MIT OR Apache-2.0 |
| `parking_lot` | 0.12.5 | MIT OR Apache-2.0 |
| `portable-pty` | 0.9.0 | MIT |
| `serde` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | 2.7.2 | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | 2.5.4 | Apache-2.0 OR MIT |
| `tauri-plugin-shell` | 2.3.5 | Apache-2.0 OR MIT |
| `tokio` | 1.53.1 | MIT |
| `windows` | 0.61.3 | MIT OR Apache-2.0 |

## 构建与开发依赖

这些组件用于构建、测试或打包，不作为 qywork 的业务运行时依赖发布。

| 组件 | 锁定版本 | 许可证 |
| --- | ---: | --- |
| `@biomejs/biome` | 2.3.5 | MIT OR Apache-2.0 |
| `@tauri-apps/cli` | 2.11.4 | Apache-2.0 OR MIT |
| `@types/bun` | 1.3.14 | MIT |
| `@types/qrcode` | 1.5.6 | MIT |
| `playwright` | 1.62.1 | Apache-2.0 |
| `tauri-build` | 2.6.3 | Apache-2.0 OR MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 7.3.6 | MIT |
| `vite-plugin-solid` | 2.11.14 | MIT |

## 说明

- qywork 自身以 [Apache-2.0](LICENSE) 发布；本清单不会改变 qywork 的许可证。
- 每项组件仍按其上游许可证授权；完整依赖图与精确版本见 `bun.lock` 和 `apps/desktop/src-tauri/Cargo.lock`。
- 本清单是依赖透明度记录，不是对任何外部项目源码的“移植”或“基于其开发”的声明。
