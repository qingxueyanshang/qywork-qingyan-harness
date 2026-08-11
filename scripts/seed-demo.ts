#!/usr/bin/env bun
/**
 * 往指定账本里种一份有代表性的会话，供界面截图与人工评估用。
 *
 * 不跑真实模型：截图要能复现、要快、要不花钱。但**数据形状必须与真实运行完全一致**
 * ——同样经 repos 写入、同样的 step 种类和状态，否则截出来的图和真实界面不是一回事。
 *
 *   bun run scripts/seed-demo.ts <db路径> <工作区路径>
 */

import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  finishRun,
  markRunRunning,
  Store,
  upsertWorkspace,
} from '@qywork/store'

const [dbPath, workspaceRoot] = Bun.argv.slice(2)
if (!dbPath || !workspaceRoot) {
  process.stderr.write('用法: bun run scripts/seed-demo.ts <db> <workspace>\n')
  process.exit(2)
}

const store = new Store({ path: dbPath })
const ws = upsertWorkspace(store, workspaceRoot, 'qywork')

// 历史会话先建：列表按 updated_at 倒序，后建的排前面，
// 有内容的那条要排第一才会被默认选中。
for (const title of [
  '审查桌面端 harness agent',
  '分析文件夹内容',
  '实时语音聊天',
  '排查 React 与 Plan 循环异常',
  '检查代码覆盖时间线',
  '检查未提交内容',
  '排查启动卡住问题',
]) {
  createConversation(store, { workspaceId: ws.id, model: 'deepseek-v4-flash', title })
}

const conv = createConversation(store, {
  workspaceId: ws.id,
  model: 'deepseek-v4-flash',
  title: '修复工具上传发布归属',
})

const user = appendMessage(store, {
  conversationId: conv.id,
  role: 'user',
  content: '真机校验一下，确认没有问题，关闭前后端所有服务，并清理缓存',
})

const run = createRun(store, {
  conversationId: conv.id,
  workspaceId: ws.id,
  model: 'deepseek-v4-flash',
  clientRequestId: crypto.randomUUID(),
  userMessageId: user.id,
  messageIdUpperBound: user.id,
})
markRunRunning(store, run.id)

let seq = 0
const step = (input: Parameters<typeof appendStep>[1]) =>
  appendStep(store, { ...input, runId: run.id, seq: ++seq })

/** 动作语义与真实运行一致：由后端解析后随 step 落库，前端不回猜。 */
const ACTIONS = {
  grep: { kind: 'search' as const, objectLabel: '内容', target: 'author_id' },
  read_file: {
    kind: 'read' as const,
    objectLabel: '文件',
    target: 'services/core-api/qybox_core/routes/tools.py',
  },
  edit_file: {
    kind: 'edit' as const,
    objectLabel: '文件',
    target: 'services/core-api/qybox_core/routes/tools.py',
  },
  run_command: {
    kind: 'execute' as const,
    objectLabel: '命令',
    target: 'uv run --extra dev python -m pytest tests/market -q',
  },
}

step({
  runId: run.id,
  seq: 0,
  kind: 'text',
  content:
    '我会先定位发布归属的写入点，确认作者字段来自当前登录管理员而不是历史空作者，再关闭服务并清理可重新生成的缓存。',
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'grep',
  toolCallId: 'c1',
  status: 'success',
  payload: {
    kind: 'tool_result',
    args: { pattern: 'author_id', glob: '*.py' },
    action: ACTIONS.grep,
    outcome: { status: 'success', executed: true, message: '命中 14 行（ripgrep）' },
  },
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'read_file',
  toolCallId: 'c2',
  status: 'success',
  payload: {
    kind: 'tool_result',
    args: { path: 'services/core-api/qybox_core/routes/tools.py' },
    action: ACTIONS.read_file,
    outcome: { status: 'success', executed: true, message: '读取 tools.py（212 行）' },
  },
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'edit_file',
  toolCallId: 'c3',
  status: 'success',
  payload: {
    kind: 'tool_result',
    args: { path: 'services/core-api/qybox_core/routes/tools.py' },
    action: ACTIONS.edit_file,
    outcome: {
      status: 'success',
      executed: true,
      message: '编辑 services/core-api/qybox_core/routes/tools.py（1 处）',
      fileChanges: [
        {
          path: 'services/core-api/qybox_core/routes/tools.py',
          changeType: 'modified',
          additions: 6,
          deletions: 3,
        },
      ],
    },
  },
})

step({
  runId: run.id,
  seq: 0,
  kind: 'text',
  content: `归属写入点在 \`publish_tool\` 里：它取的是请求体传来的 author_id，为空时回落到历史空作者。**静默回落**正是这个 bug 的根源。

改成始终取当前会话管理员，缺失时直接拒绝：

\`\`\`python
def publish_tool(payload: ToolPayload, session: Session) -> Tool:
    # 作者恒为当前登录管理员；请求体里的 author_id 一律忽略。
    if session.admin_id is None:
        raise Forbidden("发布需要管理员身份")
    return store.publish(payload, author_id=session.admin_id)
\`\`\`

影响面：

| 入口 | 修前 | 修后 |
| --- | --- | --- |
| 后台管理创建 | 空作者 | 当前管理员 |
| 前台创作者中心 | 空作者 | 当前管理员 |
`,
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'run_command',
  toolCallId: 'c4',
  status: 'failure',
  payload: {
    kind: 'tool_result',
    args: { command: 'uv run --extra dev python -m pytest tests/market -q' },
    action: ACTIONS.run_command,
    outcome: {
      status: 'failure',
      executed: true,
      message: '命令退出码 1',
      data: { exitCode: 1 },
    },
  },
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'run_command',
  toolCallId: 'c5',
  status: 'success',
  payload: {
    kind: 'tool_result',
    args: { command: 'uv run --extra dev python -m pytest tests/market -q' },
    action: ACTIONS.run_command,
    outcome: { status: 'success', executed: true, message: '命令执行成功' },
  },
})

const assistant = appendMessage(store, {
  conversationId: conv.id,
  role: 'assistant',
  content:
    '归属已经修正：工具与知识库的发布都绑定当前管理员，历史空作者草稿仍不公开。测试首次失败是因为夹具里留了旧的空作者记录，清掉后全绿。前后端服务已关闭，可重新生成的缓存已清理。',
})

finishRun(store, run.id, {
  status: 'done',
  stopReason: 'completed',
  assistantMessageId: assistant.id,
})

store.close()
process.stdout.write(`seeded ${conv.id}\n`)
