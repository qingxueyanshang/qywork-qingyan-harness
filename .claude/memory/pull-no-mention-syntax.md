---
name: pull-no-mention-syntax
description: 第三方接口的计费清单与型号目录不提供提示词引用素材的写法，拉取模型无法据此区分各型号
metadata:
  type: project
---

New API 的计费清单 `/api/pricing` 与常见第三方接口公开的型号目录都没有引用写法字段（「@Image1」或「@图片1」）。型号接受哪种写法只登记在生成目录（`MediaModelSpec.mention`）或云端下发的规格中，不从拉取结果读取。

**Why:** 用户问过拉取模型能否检测某型号接受「@Image1」还是「@图片1」。拉取结果中没有可据以判断的字段。

**How to apply:** 不要尝试从拉取结果解析引用写法。要区分只能实际提交一次（计费）或由接口方提供。画布按登记的写法改写手写编号，未登记写法的型号按原文发送，见 [[canvas-prompt-no-hidden-rewrite]]。
