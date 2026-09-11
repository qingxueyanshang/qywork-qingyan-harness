# 模型接入

在“系统设置”中添加模型服务，选择接口协议，填写 Base URL、API Key 和模型名称。
内置模型目录提供默认规格，不限制你添加其他 model id。

接口支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses。
选择协议时，以所连接端点提供的接口为准。通过第三方接口接入时，使用第三方接口给出的地址与凭证。

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
| `chatReasoningProtocol` | Chat Completions 的历史回传规则；普通接口可省略 |
| `thinksByDefault` | 模型是否默认思考 |
| `reasoningEcho` | Responses 的思考回传形式；需要回传明文推理时使用 `reasoning_text` |

使用 Responses 时，协议键改为 `openai_responses`，普通档位参数仍使用
`thinking: "reasoning_effort"`。保存后重新检测。

具体型号的内置规格见[模型目录](../packages/ai/src/catalog.ts)，检测逻辑见
[探测实现](../packages/ai/src/probe.ts)。

[返回项目介绍](../README.md) · [文档索引](INDEX.md)
