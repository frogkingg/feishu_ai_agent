# 系统架构

## 总览

ProjectPilot 的架构按四层组织：

```text
交互层
  飞书群聊 / 知识库 / 多维表格 / 日历 / 任务 / 妙记

Agent 编排层
  Project Agent / Planner Agent / Meeting Agent / Task Agent / Risk Agent / Onboarding Agent

能力调用层
  lark-cli Skills / Feishu OpenAPI / LLM / 本地运行时

状态层
  项目知识包 / 任务池 / 风险表 / 决策记录 / 会议记录 / 变更日志
```

## Agent 分工

| Agent | 职责 | 典型输入 | 典型输出 |
| --- | --- | --- | --- |
| Project Agent | 识别项目、维护项目总览和作战室 | 立项文本、群聊指令、项目配置 | 项目总览、知识库节点、多维表格记录 |
| Planner Agent | 拆解节点、模块、任务和子任务 | 项目目标、截止时间、成员分工 | 结构化计划草案、任务池记录 |
| Meeting Agent | 处理纪要和妙记 | 会议纪要、妙记 AI 产物 | 总结、决策、Action Items、风险 |
| Task Agent | 创建和同步飞书任务 | 已确认 Action Items、任务池记录 | 飞书任务、状态回写 |
| Risk Agent | 识别逾期、无负责人、依赖阻塞 | 任务状态、会议阻塞、风险表 | 风险预警、项目状态灯 |
| Onboarding Agent | 生成新人/中途加入上手包 | 项目知识包、当前进度、任务风险 | 上手简报、关键文档入口、待办摘要 |

## 推荐数据对象

| 对象 | 存储位置 | 说明 |
| --- | --- | --- |
| Project | 多维表格 / 知识库总览 | 项目名称、目标、状态、负责人、截止时间 |
| Milestone | 多维表格 | 阶段节点、验收标准、时间范围 |
| Module | 多维表格 | 功能模块、负责人、关联节点 |
| Task | 飞书任务 + 多维表格 | 执行项、负责人、截止时间、状态、优先级 |
| MeetingNote | 知识库 | 会议总结、决策、Action Items、风险 |
| Risk | 多维表格 | 风险描述、等级、负责人、状态、来源 |
| Decision | 知识库 / 多维表格 | 决策内容、影响范围、时间、来源 |

## 事件流

### 1. 项目立项

```text
群聊指令 / 立项文本
-> Project Agent 解析项目元信息
-> Planner Agent 生成节点和任务草案
-> 创建知识库、项目总览、多维表格
-> 群聊发送确认消息
```

### 2. 会后 Action Items

```text
会议纪要 / 妙记
-> Meeting Agent 提取总结、决策、待办、风险
-> 群聊发送确认卡片或文本
-> Task Agent 创建飞书任务
-> Project Agent 回写项目总览和任务池
```

### 3. 风险预警

```text
定时扫描任务池和会议阻塞
-> Risk Agent 识别异常
-> 写入风险表
-> 群聊主动推送项目状态和建议动作
```

## 运行策略

MVP 先用 `lark-cli` 和 TypeScript 运行时串联能力。MCP 可以作为后续界面层或补充能力，不作为当前 Demo 的主路径。

## Agent Runtime vNext

群聊 Agent 不能继续依赖“最近几十条消息 + 一个大 Skill”来判断所有事情。下一版运行时采用状态化工作流，把每个逐渐成形的安排、会议、任务或项目讨论拆成独立 topic，再让模型只看与当前 topic 有关的短上下文。

```text
Message Gate
-> Topic Router
-> Specialist Skill
-> Tool Guard
-> Feishu Action
```

| 阶段 | 职责 |
| --- | --- |
| Message Gate | 判断是否需要处理：未 @ 默认静默，@ 必须进入自然回复或动作判断 |
| Topic Router | 判断当前消息属于新 topic、已有 topic 更新，还是普通聊天 |
| Specialist Skill | 按场景处理：日程、任务、项目、风险、自然对话分别走更窄的 Skill |
| Tool Guard | 校验 grounding evidence、权限、确认状态、幂等和安全边界 |
| Feishu Action | 真正调用飞书 API / `lark-cli`，并把结果回写 topic |

Topic 状态：

| 状态 | 含义 |
| --- | --- |
| `observing` | 未 @ 的早期讨论，只观察，不打扰 |
| `proposed` | 已形成候选事项，但还缺共识或关键字段 |
| `confirming` | 已准备好卡片/文本确认，等待用户确认写入 |
| `committed` | 已创建飞书日程、任务、文档或项目记录 |
| `updating` | 正在修改已存在的飞书对象 |
| `closed` | 已取消、过期或完成，不再承接短句 |

每个 topic 至少绑定：

- 来源消息和 `message_id`。
- grounding evidence：标题、时间、地点、参与人、用户明确指令。
- 参与人候选及其证据来源。
- 飞书对象 ID，例如 calendar `event_id`。
- 更新时间、过期时间和最后一次确认状态。

这样可以避免“新总结会议”被误判成“旧聚餐更新”，也能防止玩笑、吐槽或反讽触发真实工具调用。

## 设计参考

- Anthropic 的 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 强调用 routing、prompt chaining、tool interface 和 human checkpoints 组合出可靠 Agent，而不是把所有复杂度塞进一个 Prompt。
- LangGraph 的 [Durable Execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution) 提供了 thread/checkpoint/human-in-the-loop 的状态化工作流思路；本项目先用轻量 Topic Store 借鉴该模式，不直接引入重框架。
