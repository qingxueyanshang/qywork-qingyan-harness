---
name: relay-catalog-no-mention-syntax
description: hongcheng 与木木的公开型号目录不提供提示词引用素材的写法，拉取模型无法据此区分各型号
metadata:
  type: project
---

2026-10-27 核对：hongcheng `/api/workbench-models` 的条目字段为 id、name、description、api_model、duration、resolution、aspect_ratios、max_image_refs、max_video_refs、max_audio_refs、enabled、group、refbridge_path、price；木木 `/docs/typetale-models.json` 及其接入说明 `/docs/model-catalog-integration.html` 同样没有引用写法字段。两站的计费清单 `/api/pricing` 也没有。

**Why:** 用户问过拉取模型能否检测某型号接受「@Image1」还是「@图片1」。代码中 hongcheng 全部型号统一为 `@Image{n}`（`channels.ts`），木木型号不设写法；这不是从目录读取的。

**How to apply:** 不要尝试从这几个接口解析引用写法。要区分只能实际提交一次（计费）或由渠道提供。`refbridge_path` 为空的型号（如 SR-Seedance-2.5-720p）出现过「图片1 requires a corresponding image asset, but none was provided」，二者是否相关尚未验证。画布按登记的写法改写手写编号，木木型号没有登记写法，按原文发送，见 [[canvas-prompt-no-hidden-rewrite]]。
