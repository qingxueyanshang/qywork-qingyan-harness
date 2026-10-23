# 模型接入

在“系统设置”中添加模型服务，选择接口协议，填写 Base URL、API Key 和模型名称。
内置模型目录提供默认规格，不限制你添加其他 model id。

接口支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses。
选择协议时，以所连接端点提供的接口为准。通过中转站接入时，使用中转站给出的地址与凭证。

## Claude Sonnet 5.5

模型 ID 为 `claude-sonnet-5-5`，选择 Anthropic Messages；官方 Base URL 为
`https://api.anthropic.com`。支持文本、图片输入与文本输出，上下文为 1,000,000 token，
单次输出上限为 128,000 token，思考与正文共用输出预算。

思考档位为 `low / medium / high / xhigh / max`，未选择时使用官方默认 `high`。
请求使用自适应思考和可见摘要，档位通过 `output_config.effort` 传递。
工具调用之间的思考摘要沿现有流式通道展示，原生签名与密文按原位置回传；
前缀变化后沿现有规则剥离失效思考块。

标准价格为美元 / 百万 token：输入 2、输出 10、缓存读取 0.10、
5 分钟缓存写入 2.50、1 小时缓存写入 4。最小可缓存前缀为 512 token，
1M 窗口内不另收长上下文溢价；当前请求使用 5 分钟缓存。

2026-10-20 核对：[模型规格](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、
[迁移说明](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)、
[思考强度](https://platform.claude.com/docs/en/build-with-claude/effort)、
[价格](https://platform.claude.com/docs/en/about-claude/pricing)。本地协议回归不等同于官方端点实测。

## Gemini 4 Argon

模型 ID 为 `gemini-4-argon`，选择 OpenAI Chat Completions；官方 Base URL 为
`https://generativelanguage.googleapis.com/v1beta/openai`。支持文本、图片输入与文本输出。
输入、思考和输出共用 1,048,576 token 窗口；当前接入的单次输出上限为 65,536 token。
官方最高 1M 的长输出需要后台执行或续接，当前未接入该流程，也未开放原生音视频与 PDF 输入。

思考档位为 `low / medium / high`，未选择时使用官方默认 `medium`。
请求使用 `reasoning_effort`，不发送采样参数或显式缓存字段；工具 schema 保留原生可选字段。
工具调用和文本响应中的思考签名沿现有推理记录落库，并在后续轮次回到原位置，
不为无签名的并行调用补造签名。签名属于返回的内容片段，工具表或更早上下文变化后仍保留。

标准处理价格，单位为美元 / 百万 token；输出包含思考 token：

| 时段 | 输入 | 缓存读取 | 输出 |
|---|---:|---:|---:|
| 至 2026-11-30 | 2.00 | 0.10 | 10.00 |
| 自 2026-12-01 | 4.00 | 0.20 | 20.00 |

目录按 UTC 日期切换价目。仅支持隐式缓存，最小前缀为 4,096 token；不另收缓存写入费。
新模型尚未标定 tokenizer 密度，使用通用保守估算，不沿用旧 Flash 的实测值。

2026-10-14 核对：[模型规格](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、
[迁移与长输出](https://ai.google.dev/gemini-api/docs/latest-model)、
[兼容接口](https://ai.google.dev/gemini-api/docs/openai)、
[思考签名](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)、
[价格](https://ai.google.dev/gemini-api/docs/pricing)。本地协议回归不等同于官方端点实测。

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
xAI 官方 Base URL 为 `https://api.x.ai/v1`；已收录生成模型默认使用目录协议。
已保存模型的协议以配置为准，修改地址不会改变协议；可在生成模型行的「接入方式」中修改。

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
中转站沿用其兼容协议，仅使用目录已核实的映射；未登记的组合采用协议默认规格，
官方单价不自动用于不同协议的中转账单。

2026-10-01 核对：[Gemini 图片](https://ai.google.dev/gemini-api/docs/image-generation)、
[Omni](https://ai.google.dev/gemini-api/docs/omni)、[Veo](https://ai.google.dev/gemini-api/docs/veo)、
[Google 价格](https://ai.google.dev/gemini-api/docs/pricing)、
[Grok 图片](https://docs.x.ai/developers/model-capabilities/images/generation)、
[Grok 视频](https://docs.x.ai/developers/model-capabilities/video/generation)、
[xAI 价格](https://docs.x.ai/developers/pricing)、[xAI 实际扣费](https://docs.x.ai/developers/cost-tracking)。
本地协议回归不等同于官方端点实际生成验证。

## GPT-6 Luna

内置模型 ID 与官方当前快照均为 `gpt-6-luna`，显示为 **GPT-6 Luna**。
选择 OpenAI Responses，官方 Base URL 为 `https://api.openai.com/v1`。
支持文本、图片输入和文本输出；上下文 1,050,000 token，最大输出 128,000 token。

产品提供 `low / medium / high / xhigh / max` 思考档位，未选择时使用官方默认 `medium`。
官方另支持 `none`，但产品统一不提供关闭思考选项；`none` 与 `minimal` 不等价。
Chat Completions 仅在 `reasoning_effort: none` 时支持函数调用，因此内置接入使用 Responses。

目录采用标准处理价格，单位为美元 / 百万 token：

| 提示词总 token | 未命中输入 | 缓存读取 | 缓存写入 | 输出 |
|---|---:|---:|---:|---:|
| ≤ 272,000 | 0.10 | 0.01 | 0.125 | 0.50 |
| > 272,000 | 0.20 | 0.02 | 0.25 | 0.75 |

提示词总量包括缓存读取与写入；超过分界后，整条请求使用长上下文价格。
官方 2026-09-25 修复了 Luna 的图像编码问题；当前模型 ID 仍为 `gpt-6-luna`，无需新增映射。

2026-10-02 核对：[官方模型规格](https://developers.openai.com/api/docs/models/gpt-6-luna)、
[价格](https://developers.openai.com/api/docs/pricing)、
[发布说明](https://developers.openai.com/api/docs/changelog)。
本地协议回归不等同于官方端点实测；中转站的可用性与价格以所接端点为准。

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
「模型库」图像、视频、音频页签中列出的模型 ID，回车即挂上；中转站的型号用「拉取模型」添加（见下文）。
每类第一个成为该类的默认模型。
生成模型不出现在对话的模型选择里，也没有「检测」按钮：检测一次就是真实生成一次。

新增生成模型默认使用模型库的原生协议，不根据中转域名改变协议。每个生成模型行的「接入方式」
只列出该模型已实现的原生协议与兼容映射，保存后由 `media[id].kind` 决定调用方式。
修改 Base URL 不会覆盖已保存的选择；上方「对话协议」只作用于对话模型。
已收录模型的未核实协议在加载旧配置时校正为目录协议，已登记的兼容映射保留；未收录的自定义模型使用所选协议的默认规格。

中转站的 `/v1/videos` 按已核实的模型映射发送素材：万相使用 `metadata.input.media`，
Seedance 使用 `metadata.content`，Veo 使用 `images` 首帧字段。其他型号采用通用文生参数。
这三类扩展已与 New API 官方仓库的转换器核对；所接中转站仍须提供相同接口扩展。
Sub2API 提供 xAI 格式的 Grok 视频与方舟格式的 Seedance 接口时，分别选择「xAI」「火山方舟」，
复用现有适配器。Grok 返回相对结果地址时按接口地址解析，同源下载携带鉴权，跨域下载不携带接口凭证。
百炼原生接口保留 Base URL 中的部署路径前缀（例如 `/ali`），上传、生成和任务查询使用相同前缀。
这些接入方式不探测中转缺少的参数，不静默删参数或降级重试；中转须实现所选接口的约定。

2026-10-14 补充 `qwen-image-2.1-pro`（千问图像 2.1 Pro），支持文生图、图像编辑及最多 10 张参考图。
透明背景、透明图层编辑或提取主体直接写在提示词中，返回 PNG；不提供独立的 `background`、`output_format` 或 `mask` 参数。
默认使用百炼原生同步接口，也可选择 OpenAI 兼容图片：参考图均以 JSON 传入，尺寸分别为 `宽*高` 和 `宽x高`。
支持 1–6 张输出、1K/2K 尺寸选项、种子、提示词扩写和思考；图像编辑仅支持 `direct` 扩写，关闭扩写时不发送扩写方式及思考参数。
此型号不支持 `negative_prompt`。原生接口按北京地域官方原价 ¥0.25/张输出计价，支持发送前报价，参考图不另计费；
新加坡地域价格不同，当前目录不按地域切换价格；兼容协议不继承原生单价。
已通过本地请求捕获、参数校验、PNG 下载及计费回归，尚未进行此型号的真实云端生成。
依据：[官方型号与价格](https://help.aliyun.com/zh/model-studio/qwen-image-2-1-pro)、[生成与编辑 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)。

2026-10-14 新增千问音频 3.1，接入方式均为「百炼」，使用非流式 HTTP 获取完整音频文件：

| 模型 ID | 输入与控制 | 北京原价（元/百万 Token，输入 / 输出） |
|---|---|---|
| `qwen-audio-3.1-tts-flash` | 文本、新版系统音色、朗读要求、情绪标签、语速、音调、音量；输出 MP3/WAV/Opus | 1.5 / 12 |
| `qwen-audio-3.1-tts-next` | 音频描述或对白，最多 3 段参考音频；支持声道和 MP3 编码控制；输出 WAV/MP3 | 6 / 12 |

新系列使用 `/api/v1/services/audio/tts/SpeechSynthesizer`，参数置于 `input`。
按官方文档使用业务空间地址 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，将占位符替换为自己的业务空间 ID，并配置北京地域 API Key。
Flash 使用 `text`、`voice` 和单数 `instruction`，不能沿用旧版的 `Cherry` 音色或 `instructions` 字段。
Next 使用 `text_prompt` 和 `references[].audio_data`，不接受 `voice`；参考音频按顺序以 `@voice1`、`@voice2`、`@voice3` 引用。
在画布选择 Next 后可添加音频素材或用 `@` 引用；`generate_audio` 工具也支持 `audios` 路径数组。
Next 提示词最多 3000 字符，每段参考音频不超过 10 MB、30 秒，支持 WAV、MP3 和 OGG Opus。
本地校验数量、类型、大小和引用编号，时长与编码有效性由服务端判定。播客单次最多 240 秒，其他场景最多 120 秒，由提示词控制。
当前接入系统音色与完整文件输出，不提供声音复刻管理、流式播放或裸 PCM 输出；新加坡价格不适用上表。
Flash 读取 `input_tokens` / `output_tokens` 计价；Next 官方响应目前仅列出 `usage.duration`，缺少 Token 用量时金额显示 N/A，不用时长或字数推算。
已覆盖本地请求捕获、参考音频、参数联动、下载与费用回归，尚未进行这两个型号的真实云端生成。
依据：[Flash 型号与价格](https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-tts-flash)、[Flash HTTP API](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api)、[新版音色](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)、[Next 型号与价格](https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-tts-next)、[Next API](https://help.aliyun.com/zh/model-studio/audio-generation-api)。

2026-10-22 补充 `gpt-image-2`：中转站仍普遍提供。生成与修改，最多 16 张参考图，尺寸约束与 2.5 系列相同；
质量为 `low` / `medium` / `high` / `auto`（没有 `xhigh`、`max`）；透明背景已停用，背景只提供 `opaque` / `auto`；
不发送 `input_fidelity`。价格与 2.5 系列相同：文字输入 $5、图片输入 $8、图片输出 $30，每百万 Token。
依据：[模型页](https://developers.openai.com/api/docs/models/gpt-image-2)、[图片生成](https://developers.openai.com/api/docs/guides/image-generation)、[价格](https://developers.openai.com/api/docs/pricing)。

2026-10-22 新增 MiniMax 语音合成，接入方式「MiniMax」（`minimax_speech`），非流式 `POST {Base URL}/t2a_v2`：

| 模型 ID | 输入与控制 | 原价（元/万字符） |
|---|---|---|
| `speech-2.8-hd` | 文本（含语气词标签与停顿标记）、327 个系统音色、语速、音量、音调、情绪、语种增强；输出 MP3/WAV/FLAC | 3.5 |
| `speech-2.8-turbo` | 同上 | 2.0 |

Base URL 填 `https://api.minimax.cn/v1`（华北 `https://api-bj.minimaxi.com/v1`，海外 `https://api.minimax.io/v1`）；
这些地址上按名称添加的语音型号默认使用该接入方式。参数平铺填写，请求时按接口结构放入 `voice_setting` 与 `audio_setting`；
音频以 hex 返回，按 `extra_info.usage_characters` 计价（1 个汉字计 2 个字符）。HTTP 200 而 `base_resp.status_code` 非 0 时
报告接口原文。文本最多 10000 字符；情绪 `fluent`、`whisper` 只对 Speech 2.6 生效，未列出。粤语音色须将 `language_boost` 设为
`Chinese,Yue`。不提供声音复刻、音色设计与流式输出；音乐生成的付费接口自 2026-08-20 起不再面向新用户提供，未接入。
已覆盖本地请求捕获、hex 解码、错误码与计费回归，尚未进行真实云端生成。
依据：[同步语音合成 HTTP](https://platform.minimaxi.com/docs/api-reference/speech-t2a-http)、[接入地址](https://platform.minimaxi.com/docs/guides/speech-t2a-websocket)、[系统音色](https://platform.minimaxi.com/docs/faq/system-voice-id)、[价格](https://platform.minimaxi.com/docs/pricing/overview)。

集梦渠道及 `Seedance 2.5 720p` 已于 2026-10-13 移除，不再提供模型目录、协议选择、生成或任务取回。
加载旧配置时移除该渠道的模型及对应默认引用，混合接口中的其他模型和凭证保留。
该渠道专用的影币计价与展示已一并移除。

### 拉取模型

接口页「模型」右侧的「拉取模型」读取该接口上的型号，勾选后添加。适用于 New API 部署的中转站：

- 型号清单与类别来自中转的公开计费清单 `/api/pricing`（不需要 Key）：接口类型含 `openai-video` 的为视频，
  含 `image-generation` 的为图像，其余对话类接口为对话。没有该接口时改读 `{Base URL}/models`（带 Key），
  只有型号名：与生成目录 id 相同的按目录归类；目录 id 之后带 `-`、`.` 或 `_` 开头的后缀的（如 `gpt-image-2.5-sunburst-4k`、
  `gemini-3-pro-image-preview`）按该目录 id 归类，取最长的目录 id，协议按接口地址取默认值；其余作为对话型号。
  手动输入型号 ID 添加时使用同一规则。
- 价格 = 计费量 ×「站点状态」`/api/status` 的充值价 `price` × 分组倍率。对话按倍率计费时每百万 Token 为
  `model_ratio × 2`，按次、按秒为 `model_price`；公式计费（`tiered_expr`）在本地求值。
  对话只取基础档，不折算长上下文档。公式中的 `weekday(时区)`、`hour(时区)` 按一月与七月各一个参考周每 15 分钟求值，
  折算为高峰价与 UTC 高峰时段（`models[id].price.offPeak`），账本按请求时刻计价；多档折扣、各天高峰时段不同或时区有夏令时
  无法用一组时段表示，价格不明。视频与图像价格逐个分辨率档位求值（计量中的 `resolution` 取该档位，图像按 `n = 1`），
  各档金额不同时按档位分别保存（`spec.price.amount` 为「档位 → 金额」），报价按所选尺寸或分辨率计算。可见分组倍率不一致时
  价格不明，价格列留空。2026-10-21 核对：hongcheng 与木木两站算出的价格与各自的计费说明逐项一致，含木木 deepseek-v4.1-flash
  的高峰价与优惠时段、007 系列 480P/720P 的两档单价、gpt-image-2 每张 0.052 元与 2.5 系列每张 3.64 积分。
- 视频型号的时长、画幅、分辨率与素材上限来自渠道目录：hongcheng 为 `/api/workbench-models`，
  木木为 `/docs/typetale-models.json`；图像型号的尺寸、分辨率档位与参考图上限来自木木目录。参数保存在该型号的配置中
  （`media[id].spec`），画布、生成工具与提示词都按它取得规格，且先于同名的内置型号（木木的 `gpt-image-2.5-flare` 等与 OpenAI
  官方同名）；默认时长取最短时长。目录中没有的型号不保存参数，按协议默认规格。
- 对话型号名称与模型库相同时沿用模型库的窗口与思考档位；名称是中转自定义的，在窗口中选择「对应型号」，
  该型号的规格写入模型库覆盖（`catalog[id|协议].base`）。中转价格只写入该接口的型号配置（`models[id].price`），
  不影响同名同协议的其他接口。
- 「对应型号」的选项包括对话模型库与生成目录。选择生成目录中的型号时，该行移到对应类别的页签，按该类别添加，
  对应型号写入 `media[id].spec.base`，参数表与能力取自该型号，不带官方单价；按目录 id 加后缀识别的生成型号已预选对应型号。
  配置写入前校验：`base` 必须是与该型号协议同类别的生成目录 id，且不能与渠道规格字段同时出现。
- 打开窗口即按结果刷新已添加型号的参数与价格。来源是计费清单时，清单中没有的已添加型号标为「已下架」：
  生成工具不再向它提交，已提交的任务仍可取回；目录没有新旧型号名的对应关系，下架后由用户重新选择。

hongcheng 与木木的型号不再写在代码中，模型库也不列出。代码只保留两个渠道的请求格式：

- **hongcheng**（Base URL：`https://hongcheng.lol`）：素材先上传到 `/refhost/upload`，
  再将公网地址通过 `reference_images`、`reference_videos`、`reference_audios` 提交到 `/v1/videos`；
  同一组地址另写入 `metadata.__workbench_refs`（`reference_image_urls` 等，附本次的 `trace_id`），分辨率与画幅写入
  `metadata.__workbench_passthrough`：渠道网关对部分线路丢弃顶层的参考素材字段，由参考透传服务按这份 metadata 交给上游。
  2026-10-21 鸿呈seedance-2.5-GG-ndwx-6 只发顶层字段时，两次均以「提示词引用的参考素材缺失」失败。
  参数为 `seconds`、`duration`（整数秒）、`aspect_ratio`（同时发送 `ratio`）与 `resolution`，提示词以 `@Image1`、`@Video1`、`@Audio1` 引用素材。
  按秒型号的报价按所选时长计算，生成费用按接口回报秒数计量；缺少回报时长时不推算费用。
- **木木**（Base URL：`https://api.mumugofe.com/v1`）：使用 `/videos` 提交、`/video/generations/{id}` 查询、
  成功响应中的 `data.data.download_url` 直链下载，接口凭证不携带到外部成片地址。`seconds` 使用字符串整数，尺寸为 `宽x高`。
  目录的素材传递方式为 `public_urls` 时，本地图片经 `PUT /v1/studio/assets/{sha256}` 上传原始字节，校验回执中的哈希、大小与
  同源签名地址后放入 `images`；为 `json` 时以含 MIME 的 base64 数据地址直接提交；为 `multipart`（sd-2.0-vip）时
  参数作为表单文本字段，参考图逐张放入同名文件字段 `input_reference`，没有参考图时按 JSON 提交。计费清单的
  `billing_usage_schema` 含 `resolution` 的型号，提交时同时发送与所选尺寸对应的 `resolution`：渠道说明「不传分辨率时为720p」。
  目录只给出参考图数量，参考视频与参考音频按 0 处理，待渠道补充字段后开放。不添加未开放的 `face`、帧率或聊天采样参数。
  查询接口的 `NOT_START` 表示任务尚未开始，按排队阶段继续等待原任务。任务成功时按任务记录的 `quota`（实际扣费额度，含分组倍率）
  记账：额度 ÷ 站点状态的 `quota_per_unit` × 充值价；站点状态无法读取时按单价计算。2026-10-21 用三个历史任务核对，
  额度 256849、513699、547945 分别为 ¥3.75、¥7.50、¥8.00；各上游回执中的时长、尺寸字段不一致，常缺失，不作为计量来源。
- **木木图像**（`image_json_v1`）：JSON 提交到 `/images/generations`，字段为 `n: 1`、`size`、`resolution`、`response_format: "url"`、
  `async: true`，参考图为 `images` 中的 base64 数据地址；返回任务号时查询 `/images/generations/tasks/{id}`，成功后读取
  `data[0].url` 下载，直接出图的型号同步返回图片。渠道按请求中的 `resolution` 计价，账本按发送的档位记账。

升级前已添加的 9 个渠道型号（hongcheng 4 个、木木 5 个，含两个木木下架型号）在加载配置时补上与升级前相同的参数，
随下一次保存落盘；重新拉取后按渠道目录更新。木木 007 系列在补上的参数中保留 10 段 MP3 参考音频，重新拉取后按目录改为 0。

渠道格式的实测记录：

- 2026-10-17 木木 30 秒、横屏 720P 实测两次：一次被渠道以版权保护拒绝（拒绝原因只在任务接口的 `fail_reason` 中），
  一次成功生成 1280×720、约 30.04 秒、24 fps 的视频。渠道内容转发接口下载长时间未完成，同一任务的直链约 3 秒完成下载。
- 2026-10-18 木木原生上传：原图散列一致，仅上传一次、提交一次，生成与取回约 675 秒，音视频完整解码通过。
  同日 hongcheng 以同一参考图与 30 秒参数完成生成与下载，成片 1280×720、约 30.04 秒、24 fps，响应未返回计费秒数或实扣金额。
- 2026-10-20 木木原生上传接口只接受图片：有效 MP4 和 MP3 均以 HTTP 400 `Image data or checksum is invalid` 拒绝。

可灵也可以经百炼调用，模型 ID 形如 `kling/kling-v3-video-generation`，仅北京地域，需先在百炼控制台开通。
可灵官方接口的视频素材只接受网络地址，因此以参考视频编辑只能经百炼调用。

### 视频任务与停止（2026-10-12）

截至 2026-10-14，目录包含 37 个生成模型（13 个图像、19 个视频、5 个音频），共 51 个原生或已登记的兼容组合。
模型库、参数面板、Agent 参数说明、发送前校验及适配器共用 `lookupMediaModel(id, kind)`；兼容组合不继承原生接口的官方价格。
协议决定提交、上传、查询和取消方式，模型规格决定参数、素材角色、数量和请求内的特殊结构，不根据模型名称猜测协议。

所有视频共用以下流程：

1. 选择已配置的模型与协议，校验参数与素材，再上传或提交。生成请求发出前显示「准备中」，发出后显示「提交中」；本地计时不代表平台受理。独立素材上传每次请求连续 5 分钟未收到响应数据即结束，标记「素材上传失败，未提交生成」并释放卡片；连接失败或上传响应无效同样不视为生成结果未知，不阻止用户再次发起。上传和生成均不自动重发，此上限不用于生成请求或已受理任务的排队。
2. 平台返回有效任务号后立即保存恢复记录并显示「已提交」；只有明确收到排队或执行状态才显示相应阶段。
3. 查询使用原任务号。正常排队不设总时长上限；连续三次查询异常结束本地等待，保留任务供取回。
4. 只有远端明确返回终态才认定成功或失败。缺失、陌生的状态保留任务，不默认排队，也不删除任务记录。
5. 下载或保存失败沿用原任务取回。提交的连接中断、408、5xx、响应缺少有效任务号均为结果未知；不自动重发生成，本轮结果未确认时阻止再次提交同类生成。
6. 每次生成新增版本，取回只更新指定的原版本，不追加生成或覆盖另一个当前版本。沿用卡片版本切换，未完成版本标记「待取回」；悬停取回按钮可查看任务号、结果位置、费用提示及最近原因，右键可复制任务号。当前成片不被其他待取回任务遮住，不在生成面板堆叠任务历史。
7. 取回状态明确显示为「取回中」，停止时同样按原任务的取消能力处理：能撤销排队任务则撤销，否则暂停查询、下载并保留任务。没有取得任务号的请求不能凭空恢复任务号，须在平台核对，不能用重新生成冒充取回。

| 情形或协议 | 停止及特殊处理 |
|---|---|
| 生成请求尚未发出（全部视频协议，包括素材上传中） | 正常取消并解锁卡片；明确未提交生成、不产生生成费用 |
| 生成请求已发出但尚未收到任务号（全部视频协议） | 立即中止本地等待并解锁卡片；显示远端结果未知，不声称撤销成功。中止期间收到的任务号仍保留供取回 |
| 方舟 `ark_videos` | 已接入排队任务撤销，执行中不能撤销；先查询，避免删除已结束的任务记录 |
| 百炼 `dashscope_videos` | 已接入排队任务撤销；百炼上的万相、可灵共用此行为 |
| OpenAI 视频兼容（含 Mumugofe）、可灵原生、Gemini、Veo、xAI | 当前适配器未接入远端取消；停止键暂停本地等待并保留任务供取回，说明可能继续计费 |
| 方舟、百炼已执行或撤销请求异常 | 同样允许暂停本地等待，保留任务及撤销失败原因，不将停止键永久禁用 |
| xAI | `pending` 表示仍在生成，按生成中展示；不能沿用百炼 `PENDING` 的排队含义 |
| Veo 原生 | 长任务只有是否完成，未完成按处理中展示，不宣称已取得排队位置 |

xAI 用 `request_id`，Veo 用长任务 `name`；其他协议按各自的 `id` 或 `output.task_id` 读取。
Mumugofe 的参数、音频素材及查询端点由其目录声明单独处理；这些差异不改变保存任务、停止等待和取回的共用规则。
xAI 状态含义依据[官方视频生成文档](https://docs.x.ai/developers/model-capabilities/video/generation)。
本次验证覆盖本地 HTTP 端点、恢复记录、画布及工具回归；不代表所有渠道均已完成真实付费成片验收。

### 生成模型核查（2026-10-03）

以下覆盖目录中的全部 **32 个生成模型：12 个图像、17 个视频、3 个语音**。
核查输入用途及数量、参数约束、请求结构和协议映射。数量为当前接入上限，参考图不含首尾帧；
没有接入的厂商能力不显示为可用。未改动模型价格。

| 模型 ID | 已接入能力及核查结果 |
|---|---|
| `gemini-3.1-flash-lite-image`、`gemini-3.1-flash-image`、`gemini-3-pro-image` | 生成和修改，最多 14 张参考图；分别按型号提供图片尺寸 |
| `grok-imagine-image-2.0` | 生成和修改，最多 5 张参考图；原生图片接口保留分辨率、质量和张数 |
| `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | 生成和修改，最多 16 张参考图；修改使用 multipart，质量与尺寸分别校验 |
| `doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-flash-260915` | 生成和修改，最多 10 张参考图；使用 JSON `image` 数组 |
| `qwen-image-3.0-pro`、`qwen-image-3.0` | 最多 3 张参考图；修复兼容协议误用 multipart、尺寸分隔符错误，使用 JSON 图片数组和 `宽x高` |
| `wan2.7-image-pro`、`wan2.7-image` | 最多 9 张参考图；兼容协议同样使用 JSON 图片数组和 `宽x高`；Pro 的 4K 仅限文生单图 |
| `gemini-omni-1.1-flash` | 文生、首帧、首尾帧、最多 6 张参考图及 1 个视频；允许帧与参考图组合，按官方声明格式区分帧与参考图 |
| `veo-3.1-generate-preview`、`veo-3.1-fast-generate-preview` | 原生接口支持文生、首帧、首尾帧和最多 3 张参考图；高分辨率或参考图要求 8 秒；兼容映射支持文生和首帧 |
| `veo-3.1-lite-generate-preview` | 原生接口支持文生、首帧、首尾帧；兼容映射支持文生和首帧 |
| `grok-imagine-video-1.5` | 文生、首帧、尾帧、首尾帧、最多 7 张参考图；修复尾帧单独输入及帧与参考图组合被错误拒绝 |
| `wan3.0-video`、`wan3.0-video-prime` | 原生最多 10 张参考图、5 个视频、5 段音频，可仅带音频；修复兼容协议参考图上限为零、素材丢弃及参数层级错误 |
| `doubao-seedance-2-5-260628` | 最多 30 张参考图、10 个视频、10 段音频，可仅带音频；兼容协议按原生 `content` 内容发送 |
| `doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615` | 最多 9 张参考图、3 个视频、3 段音频；音频须同时带参考图或视频；修复兼容协议素材传输 |
| `kling/kling-v3-omni-video-generation` | 百炼接口支持文生、首帧、首尾帧、最多 7 张参考图或 1 个视频；含视频时最多 4 张参考图；特征参考视频可配首帧 |
| `kling/kling-v3-video-generation` | 百炼接口支持文生、首帧、首尾帧；图片使用地址传输 |
| `kling/kling-v3-turbo-video-generation` | 百炼接口支持文生和首帧；图片使用地址传输 |
| `kling-3.0-omni` | 官方接口支持文生、首帧、首尾帧和最多 7 张参考图；修复遗漏的操作，统一使用 Omni 端点；允许帧与参考图组合 |
| `kling-3.0`、`kling-3.0-turbo` | 官方接口均支持文生和首帧，3.0 另支持首尾帧；请求使用 `settings` 参数结构 |
| `gpt-4o-mini-tts` | 修复省略参数时缺少必填 `voice`；使用目录默认音色，保留格式、语速和指令参数 |
| `qwen3-tts-flash`、`qwen3-tts-instruct-flash` | 修复省略参数时缺少必填音色；文字、音色、语言及指令按百炼原生 `input` 结构发送 |

百炼原生视频接口的本地视频和音频通过临时上传取得 OSS 地址；只接受图片地址的可灵也使用该上传路径。
万相兼容映射支持参考图与首尾帧，当前未接入中转站的视频、音频上传，因此不声明这两类输入可用。
Veo 兼容转换器只读取一张首帧，不将原生接口的首尾帧和参考图能力直接套用。
Google、xAI、可灵及千问语音的其他兼容组合未取得对应转换依据，使用协议默认规格，避免显示无法正确发送的参数。

官方依据：

- OpenAI：[图片生成](https://developers.openai.com/api/docs/guides/image-generation)、[语音合成](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)。
- 阿里云：[千问图片](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)、[万相图片](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)、[万相 3.0 视频](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)、[千问语音](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[可灵视频](https://help.aliyun.com/zh/model-studio/kling-video-generation-api-reference/)、[临时上传](https://help.aliyun.com/zh/model-studio/get-temporary-file-url)。
- 火山引擎：[视频任务接口](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)、[Seedance 2.5](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)、[图片生成接口](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)。
- Google：[Gemini 图片](https://ai.google.dev/gemini-api/docs/image-generation)、[Omni](https://ai.google.dev/gemini-api/docs/omni)、[Veo](https://ai.google.dev/gemini-api/docs/veo)。
- xAI：[图片](https://docs.x.ai/developers/model-capabilities/images/generation)、[视频](https://docs.x.ai/developers/model-capabilities/video/generation)、[参考素材视频](https://docs.x.ai/developers/model-capabilities/video/reference-to-video)。
- 可灵：[能力表](https://kling.ai/document-api/guides/capability-map/video)、[Omni 文生视频](https://kling.ai/document-api/api/video/3-0-omni/text-to-video)、[Omni 图片输入](https://kling.ai/document-api/api/video/3-0-omni/image-to-video)、[Omni 多模态](https://kling.ai/document-api/api/video/3-0-omni/video-omni)。
- New API 项目官方源码：[阿里云转换器](https://github.com/QuantumNous/new-api/blob/main/plugins/tasks/alibaba/plugin.js)、[火山转换器](https://github.com/QuantumNous/new-api/blob/main/plugins/tasks/doubao/plugin.js)、[Google 转换器](https://github.com/QuantumNous/new-api/blob/main/plugins/tasks/google/plugin.js)。
- Sub2API 项目官方源码：[生成接口路由](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/server/routes/gateway.go)、[Seedance 原生接口](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/docs/seedance-api.md)。

已通过本地运行时请求捕获和 13 个型号的官方转换器对照。后续使用本机配置完成了 GPT Image、
千问图像、Grok 视频及万相双参考图视频的真实生成、下载和解码；万相实测型号为 `wan3.0-video`，
不将结果扩展为 Prime 或全部 32 个型号的云端验收。语音尚未进行真实调用。
GPT Image 的该次中转调用请求尺寸为 `1024x1024`，返回文件为 `1254x1254`，因此只确认生成与下载成功，
未确认该中转遵守全部参数。客户端未据此修改参数或缩放产物。

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
