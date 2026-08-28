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

/**
 * 会话记的是**接口 + 模型**一对，不是单一个模型名。接口名取 `qy init` 的预置键，
 * 种出来的数据形状才和真实运行一致（模型选择的第一层就是接口）。
 */
const REF = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const

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
  createConversation(store, { workspaceId: ws.id, ...REF, title })
}

const conv = createConversation(store, {
  workspaceId: ws.id,
  ...REF,
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
  model: REF.model,
  clientRequestId: crypto.randomUUID(),
  userMessageId: user.id,
  messageIdUpperBound: user.id,
  contextSnapshot: [],
})
markRunRunning(store, run.id)

let seq = 0
const step = (input: Parameters<typeof appendStep>[1]) =>
  appendStep(store, { ...input, runId: run.id, seq: ++seq })

/** 动作语义与真实运行一致：由后端解析后随 step 落库，前端不回猜。 */
const ACTIONS = {
  grep: { kind: 'query' as const, objectLabel: '内容', target: 'author_id' },
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
    kind: 'run' as const,
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

/*
 * 派活的三种形状：派一件成了、派一件没派出去、派一张图。
 * 三者画的是同一张卡（`DelegateCard`），截图要能一眼看出它们同形。
 */
step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'subagent',
  toolCallId: 'c6',
  status: 'success',
  payload: {
    kind: 'tool_result',
    args: { task: '把夹具里遗留的空作者记录清一遍，顺带确认没有别的用例依赖它' },
    action: { kind: 'run', objectLabel: '子 agent', target: '' },
    outcome: {
      status: 'success',
      executed: true,
      message: '临时子 agent 做完了',
      data: {
        output: '夹具里三条空作者记录已清理，market 与 admin 两组用例都不依赖它们。',
        conversationId: 'cv_demo_child',
      },
    },
  },
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'subagent',
  toolCallId: 'c7',
  status: 'failure',
  payload: {
    kind: 'tool_result',
    args: { agent: 'perf', task: '跑一遍压测看归属改动有没有拖慢发布接口' },
    action: { kind: 'run', objectLabel: '子 agent', target: 'perf' },
    outcome: {
      status: 'failure',
      executed: true,
      message: '没有 perf。现在能派的是：reviewer、cli:claude',
      errorKind: 'not_found',
    },
  },
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'subagent',
  toolCallId: 'c9',
  status: 'success',
  payload: {
    kind: 'tool_result',
    args: { agent: 'cli:claude', task: '把 README 里那段安装说明按新的目录结构改一遍' },
    action: { kind: 'run', objectLabel: '子 agent', target: 'cli:claude' },
    outcome: {
      status: 'success',
      executed: true,
      message: 'Anthropic claude 做完了',
      data: {
        output:
          '已更新 README 的安装一节。\n\n### 回执\n- 变更文件：README.md\n- 实现方式：按新的 packages/ 与 apps/ 两级结构重写路径示例，删掉了指向旧 src/ 的三处引用。\n- 未完成项：无',
        session: 'f7bfc67d-548d-45d1-8eb5-2bb9de724d21',
      },
    },
  },
})

step({
  runId: run.id,
  seq: 0,
  kind: 'tool_action',
  toolName: 'workflow',
  toolCallId: 'c8',
  status: 'success',
  payload: {
    kind: 'tool_result',
    args: {
      goal: '把归属改动的影响面一次过完：接口、前台、回归',
      nodes: [
        { id: 'api', agent: '', task: '核接口层' },
        { id: 'web', agent: 'cli:claude', task: '核前台创作者中心' },
        { id: 'review', agent: 'reviewer', task: '合并两份结论并复核', needs: ['api', 'web'] },
      ],
    },
    action: { kind: 'run', objectLabel: '编排', target: '' },
    outcome: {
      status: 'success',
      executed: true,
      message: '3 个节点全部做完',
      data: {
        nodes: [
          {
            nodeId: 'api',
            agent: '',
            label: '临时子 agent',
            status: 'done',
            output: '发布接口只剩一个写入点。',
            durationMs: 8200,
            conversationId: 'cv_demo_api',
          },
          {
            nodeId: 'web',
            agent: 'cli:claude',
            label: 'Anthropic claude',
            status: 'done',
            output: '创作者中心那条路已经跟着改了。',
            durationMs: 53000,
          },
          {
            nodeId: 'review',
            agent: 'reviewer',
            label: '代码审查',
            status: 'done',
            output: '两份结论一致，回归用例补了一条。',
            durationMs: 12400,
            conversationId: 'cv_demo_review',
          },
        ],
      },
    },
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
