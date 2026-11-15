/**
 * 电脑控制的五个工具：窗口发现、结构化观察、动作、有限动作序列、等待。
 *
 * 单个动作每次调用发送一条端口命令后即返回，由 Agent 循环决定下一步。序列是同一个
 * `DesktopPort.act` 的有界循环，不重试有副作用的动作：重试一次 invoke 等于在应用中
 * 多提交一次。两者的目标解析与动作组装都经由 `planAct`，只有这一处实现。
 *
 * 六条边界：
 *
 * 1. **端口只经 `ctx.port(DesktopPort)` 取得。** 参数中自报的会话、Run、窗口句柄一概不读取；
 *    模型只持有端口发放的不透明 `windowId`。五个工具在 `requires` 中声明该端口，
 *    没有端口时不注册；工具函数中仍检查一次并如实报错。
 * 2. **动作前的唯一匹配与前置条件在 `shared/target.ts` 判定完毕后再调用端口。** 目标不唯一、
 *    控件缺失、动作不可用、控件被禁用，四种情况都在派发之前作为工具结果返回给模型，
 *    `executed` 为假。
 * 3. **判定依据是产生 `ref` 的那一份观察。** 端口按观察编号返回采集时刻的控件表；
 *    编号失效即要求重新观察，不临时采集一份新表替代：那样模型看到的内容与
 *    判定依据分属两个时刻。
 * 4. **三态回执如实透传。** `not_dispatched` 表示未执行，`submitted` 表示调用已被系统
 *    接受，`unknown` 表示可能已经生效。只有第一种允许 `executed:false`。
 * 5. **歧义只列出候选，不打分。** 同名控件按祖先路径区分，由模型选择；
 *    `resolveTarget` 不按顺序、不按相似度代为选择。
 * 6. **序列遇到边界即截断后缀，已派发的前缀如实保留。** 后缀不会被补执行，
 *    前缀不会被重放。
 */

import type { ToolSpec } from '@qywork/agent'
import { desktopActTool } from './act.ts'
import { desktopObserveTool } from './observe.ts'
import { desktopActSequenceTool } from './sequence.ts'
import { desktopWaitTool } from './wait.ts'
import { desktopWindowsTool } from './windows.ts'

/** 注册顺序在此处确定。五个工具声明同一个端口，整组注册或整组不注册。 */
export const desktopTools: ToolSpec[] = [
  desktopWindowsTool,
  desktopObserveTool,
  desktopActTool,
  desktopActSequenceTool,
  desktopWaitTool,
]
