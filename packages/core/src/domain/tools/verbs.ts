import type { ActionKind } from '../../protocol/events.ts'

/**
 * 工具行的动词与它所属的动作。
 *
 * 工具只声明动词，动作由本表得出，二者不会不一致。每个动词只属于一个动作：同一个动词在所有类目下含义相同。
 * 动作仍决定展开内容的分支与上下文压缩的「涉及的文件」（`read` / `write` / `edit` 的目标计入），
 * 因此目标不是文件路径的工具（浏览器标签页、窗口编号、宠物名）不要选用这三类动作下的动词。
 */
export const VERB_KINDS = {
  列出: 'query',
  查找: 'query',
  搜索: 'query',
  读取: 'read',
  查看: 'read',
  获取: 'read',
  取回: 'read',
  等待: 'read',
  创建: 'write',
  新建: 'write',
  生成: 'write',
  制作: 'write',
  导出: 'write',
  截取: 'write',
  保存: 'write',
  导入: 'write',
  安装: 'write',
  修改: 'edit',
  覆盖: 'edit',
  更新: 'edit',
  移动: 'edit',
  启用: 'edit',
  重置: 'edit',
  取消: 'edit',
  停止: 'edit',
  删除: 'delete',
  运行: 'run',
  派发: 'run',
  调用: 'call',
  打开: 'call',
  关闭: 'call',
  接管: 'call',
  切换: 'call',
  返回: 'call',
  前进: 'call',
  刷新: 'call',
  点击: 'call',
  双击: 'call',
  右击: 'call',
  悬停: 'call',
  填写: 'call',
  输入: 'call',
  选择: 'call',
  滚动: 'call',
  按键: 'call',
  拖动: 'call',
  展开: 'call',
  折叠: 'call',
  激活: 'call',
  缩放: 'call',
  上传: 'call',
  下载: 'call',
  操作: 'call',
} as const satisfies Record<string, ActionKind>

export type ToolVerb = keyof typeof VERB_KINDS
