---
name: browser-click-lands-on-ancestor
description: 浏览器点击返回「已发出」而页面无响应时，先比较回执中的落点坐标；命中判定接受祖先元素，落在控件外缘的点击仍判为成功
metadata:
  type: project
---

内置浏览器的命中判定（`packages/server/src/browser/page.ts` 的 `INSPECT_FN`）把「命中点落在目标的祖先上」也判为命中
（`hit.contains(el)`），用于 `pointer-events: none` 的子元素。因此点击落在圆角控件的角上、命中外层容器时，
动作照常发出并返回成功，控件不响应。

2026-11-17 实例：GPT 6.1 Sol 在每次点击中填写 `point: {x:0,y:0}`，工具按元素左上角执行，同一个按钮连续点击 190 次没有响应。
已改为全零落点按缺省（元素中心）处理。

**How to apply:** 用户反映「点了没反应、反复点同一个按钮」时，从 `steps.payload` 取 `outcome.data.point`，
与同一元素不带 `point` 时的落点比较：两者相差半个元素尺寸即为落在角上。真实渲染的复现用 Node 驱动 Playwright
（无头 Edge），对目标元素调用导出的 `INSPECT_FN` 并在返回坐标处点击。相关：[[diagnose-from-the-local-db]]。
