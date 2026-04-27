# 如何教会 ProjectPilot 新流程与能力

这份文档回答一个问题：当我们希望 ProjectPilot 像真人同事一样学会新的飞书协作流程时，团队应该怎么做。

核心原则：代码只负责门禁和工具安全，Skill 负责语义判断。不要把复杂沟通逻辑写成一堆关键词规则；先定义同事式流程，再把模型需要判断的上下文结构化喂给 Skill，最后由工具层执行安全的飞书动作。

## 能力的三层

| 层级 | 作用 | 产物 |
| --- | --- | --- |
| 流程层 | 定义它应该如何理解、追问、确认和回群 | 能力规格文档 / Issue |
| 工具层 | 真正调用飞书 API、lark-cli、LLM 或本地服务 | `src/tools/*` 或 Skill |
| 路由层 | 判断一条群消息应该进入哪个能力 | Agent router / workflow |

模型负责理解和生成，飞书 API 负责执行动作。写入动作必须能追溯到明确工具调用，不能只靠模型声称“我已经做了”。

## ProjectPilot Skill 分工

`skills/projectpilot-conversation/SKILL.md` 是群聊语义判断的核心。它应该描述“一个真人同事会怎么理解这段聊天”，例如：

- 未 `@` 时是否继续观察，还是已经该主动给确认卡片。
- 已有候选安排时，短句是不是在补时间、地点、参与人或取消。
- 刚创建过日程时，后续“不对，改到晚上10:30”是不是在修改真实日程。
- “大家/我们都/他们也来/刚才同意的”应该如何从群成员和上下文里判断参与人。

代码层只做这些事：

- 判断是否值得调用模型，避免普通闲聊都打扰群聊。
- 给模型提供 `recent_context`、`pending_activity`、`recent_activity`、`chat_members`。
- 校验模型输出，参与人只能来自群成员列表。
- 执行安全工具调用，比如发卡片、创建/更新日程、发回执。

新增语义时优先改 Skill，不优先加硬编码规则。只有涉及权限、安全边界、真实工具调用参数时，才改代码。

## 同事型 Agent 写法

ProjectPilot 的第一层目标不是“猜命令”，而是像 PM 同事一样参与飞书协作。新增或调整 Skill 时，优先写清楚三件事：

- **自然对话**：被 @ 或私聊时，先回答真实问题，可以追问，也可以给判断；不要因为没有工具动作就说无法判断。
- **建设性建议**：未 @ 时默认安静，只有 owner 缺失、风险暴露、决策悬空、任务可沉淀等高价值场景才短促介入。
- **工具动作**：只有识别出明确飞书动作时才进入工具流程；协作写入默认先确认，模型不能声称自己已经执行。

结构化路由推荐输出：

```json
{
  "response_mode": "silent | chat | suggest | confirm_action | execute_action",
  "tool_intent": "none | calendar_create | calendar_update | task_create | project_intake | doc_update | risk_check",
  "assistant_reply": "给群里的自然回复或追问",
  "requires_confirmation": true
}
```

其中 `response_mode` 决定 ProjectPilot 是否说话以及怎么说，`tool_intent` 只决定代码层接哪个安全工具。不要把聊天语气、业务判断、CLI 参数拼接混成同一个规则。

## 上下文治理 v2

新增能力时不要只继续加 Prompt。群聊里的“明天吃饭”“这周五开会”“你明天不用来了”“666”可能同时出现，如果都放进同一个长上下文，模型很容易串话、误承接、误触发工具。

新能力必须先定义：

- `topic`：这条消息是在开启新话题、更新已有话题，还是普通聊天。
- `state`：话题处于 `observing / proposed / confirming / committed / updating / closed` 哪个阶段。
- `grounding`：工具动作依赖哪些原文证据，例如 `message_id`、时间文本、地点文本、参与人文本。
- `confirmation`：哪些写入必须等卡片或文本确认。

推荐 Router 输出草案：

```json
{
  "response_mode": "silent | chat | suggest | confirm_action | execute_action",
  "topic_action": "none | create_topic | update_topic | close_topic",
  "topic_id": "",
  "tool_intent": "none | calendar_create | calendar_update | task_create | project_intake | doc_update | risk_check",
  "grounding": {
    "message_ids": [],
    "evidence_texts": []
  },
  "safety_label": "normal | joke | insult | hypothetical | ambiguous",
  "assistant_reply": "",
  "requires_confirmation": true
}
```

执行原则：

- 状态机优先于长上下文：只给模型当前 topic 的短上下文和必要证据。
- 工具调用必须有 grounding evidence；没有证据时只能追问或建议，不能写入。
- 未 `@` 默认静默；`@` 必须自然回复，但玩笑、辱骂、反讽不能触发飞书工具。
- 普通聊天、项目建议、日程创建、任务沉淀要拆成 Router + Specialist Skill，不再由一个大 Skill 兼顾所有场景。

## 新能力交付流程

```text
建 Capability Issue
-> 写能力规格
-> 补工具实现
-> 接入 Agent 路由
-> 本地构建
-> 飞书侧 smoke test
-> PR 合并
-> 本机 deploy:local
-> 群内同步验收结果
```

## 能力规格必须写清楚什么

每个能力都先按模板写规格，模板见：

- [`docs/templates/CAPABILITY_SPEC.md`](templates/CAPABILITY_SPEC.md)

最少要回答：

1. 用户会怎么说。
2. Agent 应该怎么判断这是这个能力。
3. 哪些信息可以自动补全。
4. 哪些信息不够时必须追问。
5. 哪些情况必须先确认，不能直接写入。
6. 调用哪个飞书能力或本地工具。
7. 成功后如何回群。
8. 失败时如何解释和降级。

## 推荐代码形态

当前最小版本还集中在 `src/index.ts`，后续新增能力时优先拆成下面的形态：

```text
src/
├── agent/
│   ├── router.ts
│   └── workflows.ts
├── capabilities/
│   ├── calendar-create.ts
│   ├── task-create.ts
│   └── meeting-action-items.ts
└── tools/
    ├── lark-calendar.ts
    ├── lark-im.ts
    ├── lark-task.ts
    └── lark-doc.ts
```

推荐能力接口：

```ts
type Capability = {
  name: string;
  match: (message: IncomingMessage) => boolean;
  collect: (message: IncomingMessage) => ParsedInput;
  askMissing: (input: ParsedInput) => string | undefined;
  execute: (input: ParsedInput) => Promise<CapabilityResult>;
  reply: (result: CapabilityResult) => string;
};
```

这样每个新能力都是一个可独立评审、测试和回滚的模块。

## 写入动作的安全分级

| 类型 | 示例 | 策略 |
| --- | --- | --- |
| 只回复 | 解释项目状态、总结背景 | 可以直接回复 |
| 轻写入 | 创建个人日程、创建草稿任务 | 信息明确时可直接执行，回群确认 |
| 协作写入 | 给别人分配任务、邀请参会人、写项目知识库 | 需要明确对象和影响范围 |
| 高风险写入 | 删除、覆盖、批量变更 | 必须先确认，必要时 dry-run |

## 当前已接入能力示例：创建日程

触发示例：

```text
明天下午3点创建日程「项目同步会」
```

当前处理方式：

1. 规则判断是创建日程意图。
2. 解析标题、日期、开始时间、默认 30 分钟时长。
3. 信息明确时调用 `lark-cli calendar +create --as user`。
4. 用 bot 身份回群确认。
5. 信息不足时追问明确开始时间。

后续增强方向：

- 支持参会人识别。
- 支持模糊时间推荐。
- 支持会议室候选。
- 支持创建前确认策略。
- 支持从群上下文推断标题和项目。

## 队友如何贡献

1. 从 GitHub 新建 `Capability Request` Issue。
2. 复制能力规格模板，写清楚流程。
3. 开分支实现，不直接改本机生产环境。
4. PR 中必须勾选 `npm run build`，并写明飞书侧 smoke test。
5. 合并后由本机值守同学运行：

```bash
cd /Users/henryxian/Documents/飞书比赛
npm run deploy:local
```

## PR 验收清单

- `npm run build` 通过。
- 新能力有规格说明或 Issue 链接。
- 涉及飞书写入时说明身份类型：`bot` 或 `user`。
- 涉及权限时列出 scope。
- 有一条群聊测试口令。
- 成功和失败回复都不声称未执行的动作已经完成。
