# Claude Agent SDK: canUseTool 回调实现指南

> 本文档记录了在 MyAgents 中实现人工干预工具权限（Human-in-the-Loop）时的关键发现和最佳实践。

## 核心概念

`canUseTool` 是 Claude Agent SDK 提供的回调，允许在 Agent 调用工具前进行权限检查。

## 关键配置

### permissionMode 与 canUseTool 的关系

| permissionMode | canUseTool 行为 |
|----------------|-----------------|
| `'bypassPermissions'` | ❌ 不调用 |
| `'default'` | ✅ 正常调用 |
| `'plan'` | ✅ 正常调用 |
| `'acceptEdits'` | ✅ 正常调用 |

```typescript
// 正确配置
query({
  options: {
    // 根据业务需求选择模式
    permissionMode: needsPermissionCheck ? 'default' : 'bypassPermissions',
    
    canUseTool: async (toolName, input, options) => {
      // 仅在 permissionMode !== 'bypassPermissions' 时被调用
    }
  }
});
```

## ⚠️ 必须包含 updatedInput

当 `canUseTool` 返回 `allow` 时，**必须**包含 `updatedInput` 字段：

```typescript
// ❌ 错误 - 会导致 ZodError
return { behavior: 'allow' };

// ✅ 正确
return { 
  behavior: 'allow',
  updatedInput: input as Record<string, unknown>
};
```

**错误现象**：
```
ZodError: [
  { "code": "invalid_type", "expected": "record", "received": "undefined" }
]
```

## 异步用户确认模式

实现前端用户确认的完整流程。**v0.2.14 起不再使用壁钟超时**——对齐 Claude Code CLI 行为，用户面向的弹窗会一直停留直到：(a) 用户回应、(b) SDK abort signal 触发 `onAbort`、(c) `clearSessionPermissions()` 被 `resetSession` 调用、(d) `runStreamingSession` 的 finally 路径 drain（覆盖 SDK 崩溃 / 异常退出）。详见 `agent-session.ts::drainPendingInteractiveRequests`。

```typescript
// 1. 存储 pending 请求（无 timer 字段）
const pendingPermissions = new Map<string, {
  resolve: (decision: 'allow' | 'deny') => void;
  toolName: string;
  input: unknown;
}>();

// 2. canUseTool 返回 Promise
canUseTool: async (toolName, input, options) => {
  // 检查规则...

  // 需要用户确认时
  const decision = await new Promise<'allow' | 'deny'>((resolve, reject) => {
    const requestId = generateId();

    const cleanup = () => {
      pendingPermissions.delete(requestId);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      // 用 AbortError reject，让 SDK 自己生成单一 tool_result；
      // 早期版本 resolve('deny') 会导致重复 tool_result（"tool_use ids must be unique"）。
      reject(new DOMException('Aborted', 'AbortError'));
    };

    options.signal?.addEventListener('abort', onAbort);
    pendingPermissions.set(requestId, { resolve, toolName, input });

    // 发送 SSE 事件到前端
    broadcast('permission:request', { requestId, toolName, input });
  });

  return decision === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: '用户拒绝' };
};

// 3. API 端点处理用户响应
app.post('/api/permission/respond', (req) => {
  const { requestId, decision } = req.body;
  const pending = pendingPermissions.get(requestId);
  if (pending) {
    pendingPermissions.delete(requestId);
    pending.resolve(decision === 'deny' ? 'deny' : 'allow');
  }
});
```

### 为什么不用壁钟超时

| 场景 | 旧（10min timer） | 新（v0.2.14） |
|------|------------------|---------------|
| 用户离开 8 分钟回来 | Modal 还在 ✓ | Modal 还在 ✓ |
| 用户离开 30 分钟 / 整夜回来 | Modal 已被 `:expired` 清掉，AI 误以为被拒 ✗ | Modal 还在，符合用户心智模型 ✓ |
| Mac 睡眠后唤醒 | `setTimeout` 在唤醒瞬间触发，瞬间清掉 ✗ | 不受影响 ✓ |
| Session abort / reset | onAbort 清理 ✓ | 同 ✓ |
| SDK subprocess 崩溃 | timer 兜底（10min 后）✗ 慢 | finally 路径 drain，立即清理 ✓ |
| Tab 关闭 → sidecar 退出 | 进程死掉，Map 一并消失 ✓ | 同 ✓ |

参考：`/Users/zhihu/Documents/project/claude-code/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` 用 `shouldDefer: true` 也是永不超时。

## 特殊工具处理：AskUserQuestion

`AskUserQuestion` 是 SDK 内置工具，用于向用户提问。与普通权限检查不同，它需要收集用户答案并通过 `updatedInput` 返回。

### 关键实现要点

```typescript
canUseTool: async (toolName, input, options) => {
  // 1. 检测 AskUserQuestion 工具
  if (toolName === 'AskUserQuestion') {
    // 2. 验证输入结构
    if (!isValidAskUserQuestionInput(input)) {
      return { behavior: 'deny', message: '无效的问题格式' };
    }

    // 3. 广播到前端，等待用户回答
    const answers = await handleAskUserQuestion(input, options.signal);

    // 4. 用户取消 → deny
    if (answers === null) {
      return { behavior: 'deny', message: '用户取消了问答' };
    }

    // 5. 返回带 answers 的 updatedInput
    return {
      behavior: 'allow',
      updatedInput: { ...input, answers }  // ⚠️ 必须包含 answers
    };
  }

  // 其他工具走正常权限检查...
};
```

### 答案格式

SDK 期望的 `answers` 格式：
```typescript
{
  "0": "选项标签",           // 单选
  "1": "标签1,标签2,标签3"   // 多选用逗号分隔
}
```

### 输入验证函数

```typescript
function isValidAskUserQuestionInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return false;

  return obj.questions.every((q: unknown) => {
    if (!q || typeof q !== 'object') return false;
    const question = q as Record<string, unknown>;
    return (
      typeof question.question === 'string' &&
      typeof question.header === 'string' &&
      Array.isArray(question.options) &&
      question.options.length >= 2 &&
      typeof question.multiSelect === 'boolean'
    );
  });
}
```

### 与 Permission 处理的区别

| 方面 | Permission | AskUserQuestion |
|------|-----------|-----------------|
| 返回值 | `'allow'` / `'deny'` | `answers` / `null` |
| updatedInput | 原样返回 | 必须添加 `answers` 字段 |
| 超时时间 | 无壁钟超时（v0.2.14） | 无壁钟超时（v0.2.14） |
| 清理路径 | onAbort / clearSessionPermissions / SDK exit drain | 同左 + `:expired` SSE 广播 |
| 用途 | 权限控制 | 收集用户输入 |

## IM Bot 权限审批转发

Desktop 端的权限请求通过 SSE `broadcast()` 发送到前端。IM Bot 端无法接收 SSE 广播，因此 `checkToolPermission()` 额外通过 `imStreamCallback('permission-request')` 将请求注入 IM SSE 流。

```typescript
// agent-session.ts: checkToolPermission()
broadcast('permission:request', { requestId, toolName, input: inputPreview });

// 同时转发给 IM 流（如果活跃）
if (imStreamCallback) {
  imStreamCallback('permission-request', JSON.stringify({ requestId, toolName, input: inputPreview }));
}
```

Rust 侧 `stream_to_im()` 解析 `permission-request` 事件后，通过 `adapter.send_approval_card()` 发送飞书交互卡片或 Telegram Inline Keyboard。用户审批结果通过 `POST /api/im/permission-response` 回传到 `handlePermissionResponse()`，复用与 Desktop 端相同的 Promise 解除机制。

详见 [IM 集成架构 §2.11](./im_integration_architecture.md)。

## 最佳实践

1. **始终处理 AbortSignal** - SDK 可能在任何时候中止请求
2. **设置超时** - 防止无限等待用户响应
3. **清理 Timer** - 用户响应后立即清理，避免内存泄漏
4. **日志分级** - 内部机制用 `debug`，用户操作用 `info`
5. **输入验证** - 对 AskUserQuestion 等复杂工具，验证输入结构
6. **共享类型** - 前后端使用共享类型定义，避免重复和不一致

## ⚠️ 常见问题：SSE 事件白名单

新增 SSE 事件时，必须同时更新 `src/renderer/api/SseConnection.ts` 中的事件白名单：

```typescript
// src/renderer/api/SseConnection.ts
const JSON_EVENTS = new Set([
    // ... 其他事件
    'permission:request',
    'ask-user-question:request',  // ← 新事件必须加到这里
]);
```

**症状**：后端 `broadcast()` 正常执行，但前端收不到事件，UI 不响应。

**原因**：`SseConnection` 只为白名单中的事件注册监听器，未注册的事件会被静默忽略。

**检查步骤**：
1. 确认后端日志显示 broadcast 已执行
2. 确认前端 TabProvider 的 switch case 中没有收到日志
3. 检查 `SseConnection.ts` 的 `JSON_EVENTS` / `STRING_EVENTS` / `NULL_EVENTS`
