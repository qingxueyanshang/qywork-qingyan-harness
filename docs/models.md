# 模型接入

在“系统设置”中添加模型服务，选择接口协议，填写 Base URL、API Key 和模型名称。
内置模型目录提供默认规格，不限制你添加其他 model id。

接口支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses。
选择协议时，以所连接端点提供的接口为准。通过中转站接入时，使用中转站给出的地址与凭证。

## MiniMax M3.1 Flash Preview 与 Step 5 Preview

本次新增 `MiniMax-M3.1-Flash-Preview` 与 `step-5-preview`，不追加 MiniMax M2.x、Step 3.x 历史型号。
原有 MiniMax M3 仍按自己的规格保留。

| 模型 | 上下文 | 最大输出 | 思考强度 | 接口 |
|---|---:|---:|---|---|
| MiniMax-M3.1-Flash-Preview | 1,000,000 | 524,288 | low / medium / high / xhigh / max | Chat、Responses、Messages |
| step-5-preview | 1,000,000 | 64,000 | low / medium / high | Chat、Messages |

MiniMax M3.1 Preview 需要 **M Plan 订阅 Key**，目前不面向普通按量 Key。
国内 Chat / Responses Base URL 为 `https://api.minimax.cn/v1`，Messages 为
`https://api.minimax.cn/anthropic`；国际账户使用相应的 `api.minimax.io` 地址。
模型默认以 `max` 强度思考，不支持关闭思考。未公布按 token 单价，模型库显示“—”，
不沿用 M3 的价格；现有运行用量中的零金额表示未估算费用，不表示订阅免费。

Step 普通 API 的 Chat Base URL 为 `https://api.stepfun.com/v1`，Messages 为
`https://api.stepfun.com`。Step Plan 应按订阅文档使用其专用地址和 Key。
标准价格为人民币 / 百万 token：未命中输入 7、缓存命中 0.35、输出 20；首次缓存写入按普通输入计费。
Chat 返回的顶层 `usage.cached_tokens` 计入缓存命中，不再按普通输入重复计费。

两款模型均支持图片；当前 Chat 适配器支持视频输入，Responses / Messages 不声明尚未接入的视频传法。
MiniMax 的历史思考按协议完整回传，工具定义保留原生 required / optional 语义。
本地协议回归不等同于官方端点实测。

2026-10-01 核对：[MiniMax 接口](https://platform.minimax.io/docs/api-reference/text-chat-openai)、
[M Plan 接入](https://platform.minimax.io/docs/m-plan/other-tools)、
[Step 模型规格](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview)、
[Step 定价](https://platform.stepfun.com/docs/zh/guides/pricing/details)。

## DeepSeek Pro 计价

`deepseek-v4-pro` 继续独立提供服务，不再按原定下线日期自动改用 Flash 单价。
人民币 / 百万 token 高峰价为输入 9、缓存命中 0.30、输出 27；空闲时段按现有分时规则减半。
Pro 保持文本模型能力，`deepseek-flash` 的规格与价格独立维护。
2026-10-01 核对：[官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、
[服务保留说明](https://api-docs.deepseek.com/updates/)。

## Google 与 xAI 图片、视频生成

在设置的接口页添加下列模型 ID 后，模型会进入对应的图像或视频类别。
Google 官方 Base URL 为 `https://generativelanguage.googleapis.com/v1beta`，
xAI 官方 Base URL 为 `https://api.x.ai/v1`；添加时按地址与目录选择生成协议。
已保存模型的协议以配置为准，修改地址不会自动迁移协议。

| 类别 | 模型 ID | 显示名称 |
|---|---|---|
| 图像 | `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite |
| 图像 | `gemini-3.1-flash-image` | Nano Banana 2 |
| 图像 | `gemini-3-pro-image` | Nano Banana Pro |
| 图像 | `grok-imagine-image-2.0` | Grok Imagine Image 2.0 |
| 视频 | `gemini-omni-1.1-flash` | Gemini Omni Flash |
| 视频 | `veo-3.1-generate-preview` | Veo 3.1 |
| 视频 | `veo-3.1-fast-generate-preview` | Veo 3.1 Fast |
| 视频 | `veo-3.1-lite-generate-preview` | Veo 3.1 Lite |
| 视频 | `grok-imagine-video-1.5` | Grok Imagine Video 1.5 |

Gemini 图片支持生成与参考图修改。Omni 接入文生、首帧、首尾帧、参考图和单个视频输入；
Veo 接入文生、首帧、首尾帧，Standard / Fast 另支持参考图；Veo 的视频延长未接入。
Grok 图片支持最多五张参考图修改，视频接入文生、首帧、首尾帧与参考图；
未开放的自定义音频参考和旧版视频编辑能力不列入新模型能力。

参数使用各家原生名称。Gemini 使用 `aspect_ratio` / `image_size`，
Veo 使用 `aspectRatio` / `durationSeconds`，Grok 使用 `aspect_ratio` / `duration`。
目录约束会在请求前检查；Veo 高分辨率与参考图生成要求 8 秒，Grok 参考图和首尾帧最高 720p。
异步任务沿用现有任务记录，失败后可按任务号查询、下载，恢复时不重复提交。

Gemini 按接口回报的输入、文字/思考输出和图片/视频输出 token 分别计费；
xAI 优先采用响应中的 `usage.cost_in_usd_ticks` 实际扣费。
Veo 的生成响应未提供计价所需的实际时长、分辨率，用量账本金额显示 N/A；
发送前可按选择的时长与分辨率显示目录报价。任何接口缺少计量时均不估填实际金额。
中转站沿用其兼容协议，能力取协议与模型交集，官方单价不自动用于中转账单。

2026-10-01 核对：[Gemini 图片](https://ai.google.dev/gemini-api/docs/image-generation)、
[Omni](https://ai.google.dev/gemini-api/docs/omni)、[Veo](https://ai.google.dev/gemini-api/docs/veo)、
[Google 价格](https://ai.google.dev/gemini-api/docs/pricing)、
[Grok 图片](https://docs.x.ai/developers/model-capabilities/images/generation)、
[Grok 视频](https://docs.x.ai/developers/model-capabilities/video/generation)、
[xAI 价格](https://docs.x.ai/developers/pricing)、[xAI 实际扣费](https://docs.x.ai/developers/cost-tracking)。
本地协议回归不等同于官方端点实际生成验证。

## GPT-6.1 Sol

内置收录 `gpt-6.1-sol`，显示为 **GPT-6.1 Sol**，原有 `gpt-6-sol` 独立保留。
选择 OpenAI Responses，官方 Base URL 为 `https://api.openai.com/v1`。
官方 Chat Completions 不支持该模型的工具调用。

支持文本、图片输入和文本输出；上下文 1,050,000 token，最大输出 128,000 token。
思考档位为 `low / medium / high / xhigh / max`，未选择时使用官方默认 `medium`；
不支持 `none` 和 `minimal`。

目录采用标准处理价格，单位为美元 / 百万 token：

| 提示词总 token | 未命中输入 | 缓存读取 | 缓存写入 | 输出 |
|---|---:|---:|---:|---:|
| ≤ 272,000 | 2 | 0.10 | 2.50 | 10 |
| > 272,000 | 4 | 0.20 | 5 | 15 |

提示词总量包括缓存读取与写入；超过分界后，整条请求使用长上下文价格。
2026-09-30 核对：[官方模型规格](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、
[发布说明](https://developers.openai.com/api/docs/changelog)、
[缓存规则](https://developers.openai.com/api/docs/guides/prompt-caching)。
本地协议回归不等同于官方端点实测；中转站的可用性与价格以所接端点为准。

## 小米 MiMo

内置收录 `mimo-v2.6-pro`、`mimo-v2.6-flash`、`mimo-v2.6-pro-ultraspeed`，
按模型 ID 与接口协议分别映射。三款使用 1M 上下文、131072 token 输出上限，
默认开启思考。图片输入已接入；官方的音频与视频能力尚未接入当前媒体管线。

| 接口协议 | 官方 Base URL | 历史思考回传 |
|---|---|---|
| OpenAI Chat Completions | `https://api.xiaomimimo.com/v1` | `reasoning_content` |
| OpenAI Responses | `https://api.xiaomimimo.com/v1` | `reasoning` 条目中的 `reasoning_text` |
| Anthropic Messages | `https://api.xiaomimimo.com/anthropic` | `thinking` 内容块 |

MiMo 使用标准 JSON 工具参数，不需要 XML 工具调用格式。程序按各接口的结构化字段
接收工具调用，回复正文中的 `<tool_call>` 标签仍是正文。

官方目前将 Responses 中所有正向 effort 值映射到相同的思考行为，只有 `none` 关闭思考。
因此目录不声明多档强度，检测也不会凭接口接受参数就增加档位。沿用模型默认思考，
按官方建议回传文本轮和工具轮的历史思考。

目录采用国内按量单价，单位为人民币 / 百万 token：

| 模型 | 未命中输入 | 缓存命中 | 输出 |
|---|---:|---:|---:|
| MiMo V2.6 Pro | 3 | 0.025 | 6 |
| MiMo V2.6 Flash | 1 | 0.02 | 2 |
| MiMo V2.6 Pro UltraSpeed | 30 | 0.25 | 60 |

2026-09-22 核对：[模型规格](https://mimo.mi.com/models/zh-CN/mimo-v2.6-pro)、
[官方价格](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)、
[Chat](https://mimo.mi.com/docs/zh-CN/api/chat/openai-api)、
[Responses](https://mimo.mi.com/docs/zh-CN/api/chat/responses)、
[Messages](https://mimo.mi.com/docs/zh-CN/api/chat/anthropic-api)。
本地协议回归验证不等同于官方端点实测；通过中转站接入时，应按其文档覆盖规格与价格。

## GLM 5.3 系列

收录 `glm-5.3`、`glm-5.3-flash`、`glm-5.3-flashx`，均为 1M 上下文、
131072 token 输出上限。Flash / FlashX 支持图片；视频当前仅在 Chat 接口接入。
FlashX 为加速版本，官方暂未将其纳入 GLM Coding Plan，需使用按量 API。

| 接口 | 官方 Base URL | 独立思考档位 | 历史思考 |
|---|---|---|---|
| Chat Completions | `https://open.bigmodel.cn/api/paas/v4` | low / high / max | `reasoning_content`，开启保留思考 |
| Responses | `https://open.bigmodel.cn/api/v1` | high / max | `reasoning.content` 中的单个 `reasoning_text` 对象 |

Responses 的 `low / medium` 实际映射为 `high`，`xhigh` 映射为 `max`，目录只显示独立档位。
工具 schema 保留原生必填和可选字段，不将可选项改成必填 nullable。
Responses 使用 `prompt_cache_key`；Chat 按官方公共前缀自动缓存，不发送该字段。

国内按量价格（人民币 / 百万 token，输入 / 输出 / 缓存命中）：
GLM-5.3 为 **8 / 28 / 2**，Flash 为 **0.8 / 2.8 / 0.23**，
FlashX 为 **2 / 7 / 0.57**。Flash 的八月优惠已结束。

2026-09-22 核对：[Flash / FlashX](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)、
[定价](https://docs.bigmodel.cn/cn/guide/start/pricing)、
[Responses 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction)、
[请求与响应结构](https://docs.bigmodel.cn/api-reference/response/创建-response)。

## Grok 4.7

`grok-4.7` 支持文本和图片输入，500K 上下文，官方不设独立文本输出上限。
Chat / Responses 均支持 `low / medium / high / xhigh`，官方默认 `high`。
两协议的 Base URL 均为 `https://api.x.ai/v1`，工具 schema 保留可选字段。

- Chat 用请求头 `x-grok-conv-id` 维持缓存亲和。
- Responses 用 `prompt_cache_key`；返回的加密 reasoning 条目原样保存在任务思考步骤中，
  随历史恢复并回传同一模型，不作为可见思考正文，也不发送给其他模型。

标准单价（美元 / 百万 token，输入 / 输出 / 缓存命中）为 **2 / 6 / 0.5**；
提示词达到 200K 时，整条请求为 **4 / 12 / 1**。美国区域端点另有溢价，
使用该端点或中转站时应覆盖价格。Grok 4.7 Fast 尚未开放公共 API，不录入 API 模型库。

2026-09-22 核对：[接入与协议差异](https://docs.x.ai/developers/grok-4-7)、
[模型规格](https://docs.x.ai/developers/models/grok-4.7)、
[官方定价](https://docs.x.ai/developers/pricing)。

本次已用官方 GLM 端点验证 FlashX Chat 与 Flash Responses 的两轮工具调用，
均正确返回结构化参数并完成工具结果续接。Grok 4.7 的协议、历史持久化与恢复通过本地测试，
尚未用官方凭证实测；这些验证不代表所有模态、长上下文及缓存命中率均已验收。

## 思考档位检测

点击模型旁的“检测”即可检查当前端点。源码用户也可以在仓库根目录执行：

```powershell
bun run packages/cli/src/index.ts probe my-model --save
```

`my-model` 替换为已配置的模型名称；`--save` 将检测结论保存到该接口下的模型配置。
省略 `--save` 时只显示结果。检测会向配置的服务商发送少量真实请求。

- 已声明思考档位的模型，逐一校验该列表，端点检测只能缩小这个集合。
- 未声明档位的模型，尝试 `low / medium / high / xhigh / max`。
- 检测还会发送一个非法值作为对照。如果该值也被接受，或出现超时、限速等情况，
  对应结论标为未确认，保留已保存的配置。
- 未知模型的检测结果表示“接口接受”，不能据此证明各个参数对应不同的实际推理强度。

同名模型在不同接口的检测结果分别保存，检测不会修改全局模型规格。

## 特殊参数格式

只有端点需要特殊思考参数或历史回传规则时，才需要手动配置这一节。
在默认配置文件 `~/.qywork/config.json` 的 `catalog` 中，按“模型 ID|接口协议”声明。
设置了 `QYWORK_HOME` 时，配置文件位于该目录。

例如，自定义模型使用 DeepSeek 风格的思考参数和历史回传规则：

```json
{
  "catalog": {
    "my-model|openai_chat_completions": {
      "thinking": "deepseek_thinking",
      "effortLevels": ["low", "high", "max"],
      "chatReasoningProtocol": "deepseek_preserved",
      "thinksByDefault": true
    }
  }
}
```

将这段合并到已有配置中，模型 ID 须与接口中填写的一致。示例的参数与档位应根据端点实际支持情况填写。

| 字段 | 用途 |
|---|---|
| `thinking` | 思考参数格式。普通 `reasoning_effort` 接口使用 `reasoning_effort` |
| `effortLevels` | 要校验的档位列表；未声明时才尝试五个候选值 |
| `chatReasoningProtocol` | 历史思考回传规则；`preserved` 保留所有轮次且不增加厂商开关；普通接口可省略 |
| `thinksByDefault` | 模型是否默认思考 |
| `reasoningEcho` | Responses 的思考回传形式：`reasoning_text` 为数组，`reasoning_text_object` 为单个对象，`encrypted_content` 回传原始密文条目 |

使用 Responses 时，协议键改为 `openai_responses`，普通档位参数仍使用
`thinking: "reasoning_effort"`。保存后重新检测。

具体型号的内置规格见[模型目录](../packages/ai/src/catalog.ts)，检测逻辑见
[探测实现](../packages/ai/src/probe.ts)。

## 生成模型（图像 · 视频 · 音频）

生成模型挂在已有的模型服务下，与对话模型共用 API Key 与 Base URL。在模型服务的模型列表里输入
「模型库」图像、视频、音频页签中列出的模型 ID，回车即挂上；每类第一个成为该类的默认模型。
生成模型不出现在对话的模型选择里，也没有「检测」按钮：检测一次就是真实生成一次。

接口协议按服务地址决定：百炼官方地址走百炼原生接口；火山方舟官方地址的视频走方舟任务接口，
出图走 OpenAI 兼容接口；可灵开放平台官方地址（`https://api-beijing.klingai.com`、`https://api-singapore.klingai.com`）
的视频走可灵接口，使用可灵控制台创建的 API Key；其他地址（包括中转站）走 OpenAI 兼容的 `/images`、`/videos`、`/audio/speech`。
中转站的 `/v1/videos` 只支持文生视频。

可灵也可以经百炼调用，模型 ID 形如 `kling/kling-v3-video-generation`，仅北京地域，需先在百炼控制台开通。
可灵官方接口的视频素材只接受网络地址，因此以参考视频编辑只能经百炼调用。

对话中，模型通过 `generate_image`、`generate_video`、`generate_audio` 调用生成模型，
按「模型库」里该模型的参数表自行填写尺寸、时长、音色等参数；参数不合法时在发出请求前拦下。
产物写入工作区，默认目录为 `generated/`，会话中点击路径即可在右侧预览。

视频提交后会在输出位置旁写一个 `.task.json` 任务记录，完成后删除。等待被中断、超时或程序退出时记录会保留，
让模型用 `generate_video` 的 `resume` 取回结果，不会重新提交。

模型库未收录的生成模型在 `config.json` 中手写，`kind` 取值见
[生成协议](../packages/core/src/domain/media.ts)：

```json
{
  "providers": {
    "qwen": {
      "kind": "openai_chat_completions",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "models": {},
      "media": { "wan2.6-t2v": { "kind": "dashscope_videos" } }
    }
  },
  "mediaDefaults": { "video": { "provider": "qwen", "model": "wan2.6-t2v" } }
}
```

未收录的模型使用该协议的通用参数表。

生成费用按接口返回的用量计算：图片按张、视频按秒（火山 Seedance 按 token）、语音按字符，单价取各家官方价格页的原价，
不计限时折扣与免费额度；可灵官方接口直接使用任务结果中的扣费金额。费用计入该轮金额、「运行」面板与用量统计。
经中转站调用、且与官方使用同一协议的模型（如出图的 `/images`）按官方原价计算，中转站的实际收费可能不同。
未收录的模型、协议与官方不同的调用（如中转站的 `/v1/videos`）、OpenAI 语音合成（接口不返回用量），
以及从可灵资源包扣费的任务，金额显示为 N/A。

[返回项目介绍](../README.md) · [文档索引](INDEX.md)
