# 飞书项目管理专家 Agent 需求文档

## 0. 文档信息

**项目名称**：ProjectPilot / 飞书项目领航员  
**项目定位**：面向飞书协作场景的项目管理专家 Agent  
**核心概念**：Living Project Space / 活项目知识库  
**目标场景**：项目立项、会议纪要、群聊讨论、任务推进、风险预警、阶段复盘  
**MVP 目标**：在飞书内完成「项目立项 → 自动创建项目知识库 → 自动拆解节点和任务 → 会后自动生成待办 → 更新项目总览和风险」的闭环 Demo。

---

## 1. 背景与问题

在团队项目推进中，信息通常分散在多个飞书产品中：

- 群聊：大量临时决策、负责人认领、风险暴露
- 日历：会议时间、评审节点、交付节奏
- 会议纪要 / 妙记：会议结论、Action Items、风险和阻塞
- 文档 / 知识库：项目背景、需求说明、方案沉淀
- 飞书任务：具体待办和负责人
- 多维表格：项目状态、进度、风险和统计

传统项目管理的问题在于：

1. 项目立项后，知识库和任务表需要手动搭建。
2. 会议结束后，纪要里的 Action Items 很容易没人跟进。
3. 群聊中产生的决策和风险很难沉淀。
4. 项目总览页经常过期，变成死文档。
5. 任务、风险、节点、负责人之间缺少自动关联。
6. 项目管理依赖某个项目经理持续手动维护，成本高且容易遗漏。

因此，本项目希望通过飞书 CLI / OpenAPI + 多 Agent 架构，构建一个能够自动维护项目知识库和执行闭环的项目管理专家 Agent。

---

## 2. 产品定位

### 2.1 一句话定位

**ProjectPilot 是一个能在飞书内自动创建项目空间，并随着会议、群聊和任务推进持续更新项目知识库、任务进度和风险状态的项目管理专家 Agent。**

### 2.2 核心价值

ProjectPilot 不是一个普通的 Todo Bot，而是一个项目管理专家。它的价值包括：

- 自动搭建项目知识库，降低项目启动成本
- 自动拆解项目节点、模块、任务和子任务
- 自动从会议纪要中提取 Action Items 并创建飞书任务
- 自动更新项目总览、进度条、风险和决策记录
- 自动识别逾期、无负责人、依赖阻塞、成员过载等风险
- 自动生成项目日报 / 周报 / 阶段总结
- 将项目知识从“被动查找”变成“主动维护和推送”

### 2.3 产品关键词

- 活项目知识库
- 项目作战室
- 会议驱动任务闭环
- 多 Agent 项目管理专家
- 飞书协作空间自动维护
- 从原始协作信息到结构化项目资产

---

## 3. 目标用户

### 3.1 核心用户

| 用户类型 | 诉求 | 痛点 |
|---|---|---|
| 项目负责人 / PM | 快速立项、拆解任务、追踪风险 | 手动维护成本高，容易遗漏 |
| 团队成员 | 清楚知道自己要做什么、什么时候交付 | 会议后任务不清晰，责任不明确 |
| 管理者 / Mentor | 快速了解项目状态和风险 | 需要反复问进度，信息分散 |
| 比赛团队 / 学生团队 | 快速从 0 到 1 搭建项目协作空间 | 时间短，缺少成熟项目管理流程 |

### 3.2 MVP 首选用户

飞书 AI 校园挑战赛参赛团队。

原因：

- 时间周期短，项目节点明确
- 飞书生态使用频繁
- 会议、群聊、文档、任务都能形成闭环
- Demo 容易展示项目启动、推进和复盘全过程

---

## 4. 用户场景

### 4.1 场景 A：项目立项

ProjectPilot 支持两种立项触发方式：**显式立项** 和 **主动发现**。

#### 方式 1：显式立项

用户在飞书群里 @ProjectPilot：

> 帮我们创建一个飞书比赛项目，目标是 5 月 7 日前完成可运行 Demo。July 负责产品，A 负责开发，B 负责设计，C 负责路演材料。

#### 方式 2：主动发现潜在新项目

在用户没有 @ProjectPilot 的情况下，Agent 可以基于会议纪要或群聊片段进行低频检测。当系统连续识别到以下信号时，主动在群里发出确认卡片：

- 出现新的项目名称、目标或交付物
- 多人围绕同一主题持续讨论
- 出现明确负责人、截止时间或分工
- 出现“我们要做”“这周先完成”“下次评审前交付”等项目启动信号
- 会议纪要中出现未关联到已有项目的 Action Items

Agent 不会直接创建项目，而是先询问：

> 我注意到大家可能正在讨论一个新项目：飞书比赛项目。是否需要我帮你们创建项目空间，并整理目标、成员、节点和待办？
>
> [创建项目] [先生成草稿] [忽略] [不要再提醒此话题]

Agent 自动完成：

1. 解析项目名称、目标、成员、截止时间、交付物。
2. 创建项目知识库。
3. 创建项目总览页。
4. 创建多维表格项目数据库。
5. 自动拆解里程碑、模块、任务和子任务。
6. 发确认卡片给项目负责人。

---

### 4.2 场景 B：会后自动创建任务

会议结束后，Agent 读取会议纪要或妙记：

- 提取会议总结
- 提取决策记录
- 提取 Action Items
- 识别负责人、截止时间、优先级
- 识别风险和阻塞
- 将结果发到项目群中确认

用户点击「确认创建」后，Agent 自动：

- 创建飞书任务
- 写入多维表格任务池
- 更新项目总览页
- 将会议纪要挂载到知识库
- 将风险写入风险表

---

### 4.3 场景 C：项目进度自动更新

当任务状态变化、会议纪要新增、风险状态变化时，Agent 自动更新：

- 项目总进度
- 节点进度
- 模块进度
- 子任务进度
- 风险数量
- 逾期任务
- 最近进展
- 下周重点

---

### 4.4 场景 D：风险自动预警

Agent 定时扫描项目状态，发现：

- P0 任务无负责人
- 任务即将逾期但状态仍未开始
- 某个节点没有支撑任务
- 某个成员任务过载
- 会议连续多次提到同一阻塞
- 关键依赖任务延期

Agent 自动在群里提醒：

> 当前项目状态为黄色。Demo 接入节点下有 3 个任务未开始，其中 1 个 P0 任务没有负责人，可能影响 5 月 7 日交付。建议今天内确认负责人或收缩范围。

---

## 5. 产品目标

### 5.1 MVP 目标

在 Demo 中跑通以下闭环：

```text
项目立项输入
↓
自动创建项目知识库
↓
自动创建项目数据库
↓
自动拆解节点 / 模块 / 任务 / 子任务
↓
会议纪要进入系统
↓
自动提取 Action Items
↓
用户确认后创建飞书任务
↓
更新项目总览、进度和风险
↓
群聊推送项目简报
```

### 5.2 非目标

MVP 阶段不做：

- 全量监听所有群聊消息
- 企业级复杂权限管理
- 复杂甘特图
- 多项目组合管理
- 跨公司外部协作权限
- 完整替代飞书项目
- 复杂 GitHub / 代码仓库深度集成

---

## 6. 核心功能需求

## 6.1 项目立项解析

### 功能说明

用户通过群聊 @Bot 或表单输入项目信息，Agent 自动解析为结构化 Project Spec。

### 输入

- 项目名称
- 项目目标
- 截止时间
- 项目成员
- 成员角色
- 交付物
- 备注说明

### 输出字段

```json
{
  "project_name": "飞书比赛项目",
  "goal": "5 月 7 日前完成可运行 Demo",
  "deadline": "2026-05-07",
  "members": [
    {"name": "July", "role": "产品负责人"},
    {"name": "A", "role": "开发"},
    {"name": "B", "role": "设计"}
  ],
  "deliverables": ["可运行 Demo", "项目介绍", "效果验证报告"],
  "constraints": ["两周内完成", "优先使用飞书 CLI"]
}
```

### 验收标准

- 能从自然语言中识别项目名称、目标、时间、成员和交付物。
- 缺失字段能标记为 `unknown`，而不是乱编。
- 能生成一份可确认的项目立项卡片。

---

## 6.2 自动创建项目知识库

### 功能说明

项目立项后，Agent 自动创建项目知识库和基础文档结构。

### 知识库目录结构

```text
项目知识库
├── 00 项目总览
├── 01 项目背景与目标
├── 02 项目成员与职责
├── 03 项目里程碑与节点
├── 04 模块拆解
│   ├── 模块 A：产品定义
│   ├── 模块 B：飞书 Bot 接入
│   ├── 模块 C：会议纪要转任务
│   ├── 模块 D：项目 Dashboard
│   └── 模块 E：路演与效果验证
├── 05 会议纪要
├── 06 Action Items / 待办池
├── 07 风险与阻塞
├── 08 决策记录
├── 09 变更记录
├── 10 资料与引用链接
└── 11 项目复盘
```

### 验收标准

- 能自动创建基础 Wiki / Doc 结构。
- 项目总览页包含项目目标、周期、成员、进度、风险和最近进展。
- 每个页面能写入项目 ID 和关联多维表格链接。

---

## 6.3 自动创建多维表格项目数据库

### 功能说明

Agent 自动创建一个项目数据库，用于承载长期状态，防止模型上下文爆炸。

### 推荐表结构

#### 1. Projects 项目表

| 字段 | 类型 | 说明 |
|---|---|---|
| project_id | 文本 | 项目唯一 ID |
| name | 文本 | 项目名称 |
| goal | 长文本 | 项目目标 |
| status | 单选 | Not Started / Active / Paused / Done |
| health | 单选 | Green / Yellow / Red |
| progress | 数字 | 0–100 |
| owner | 人员 | 项目负责人 |
| deadline | 日期 | 最终截止时间 |
| wiki_url | URL | 项目知识库链接 |
| created_at | 日期时间 | 创建时间 |

#### 2. Milestones 节点表

| 字段 | 类型 | 说明 |
|---|---|---|
| milestone_id | 文本 | 节点 ID |
| project_id | 关联 | 所属项目 |
| name | 文本 | 节点名称 |
| description | 长文本 | 节点说明 |
| owner | 人员 | 负责人 |
| deadline | 日期 | 截止时间 |
| status | 单选 | Not Started / In Progress / Blocked / Done |
| progress | 数字 | 0–100 |
| weight | 数字 | 节点权重 |
| definition_of_done | 长文本 | 完成标准 |

#### 3. Modules 模块表

| 字段 | 类型 | 说明 |
|---|---|---|
| module_id | 文本 | 模块 ID |
| project_id | 关联 | 所属项目 |
| name | 文本 | 模块名称 |
| owner | 人员 | 模块负责人 |
| related_milestone | 关联 | 关联节点 |
| status | 单选 | Not Started / In Progress / Blocked / Done |
| progress | 数字 | 模块进度 |

#### 4. Tasks 任务表

| 字段 | 类型 | 说明 |
|---|---|---|
| task_id | 文本 | 内部任务 ID |
| feishu_task_guid | 文本 | 飞书任务 ID |
| project_id | 关联 | 所属项目 |
| milestone_id | 关联 | 所属节点 |
| module_id | 关联 | 所属模块 |
| title | 文本 | 任务标题 |
| description | 长文本 | 任务说明 |
| owner | 人员 | 负责人 |
| collaborators | 多人员 | 协作人 |
| priority | 单选 | P0 / P1 / P2 |
| status | 单选 | Not Started / In Progress / Blocked / Done |
| due_date | 日期 | 截止时间 |
| progress | 数字 | 任务进度 |
| parent_task_id | 文本 | 父任务 ID |
| dependencies | 多关联 | 依赖任务 |
| source | 单选 | Manual / Meeting / Chat / Plan |
| source_url | URL | 来源链接 |
| definition_of_done | 长文本 | 验收标准 |

#### 5. Risks 风险表

| 字段 | 类型 | 说明 |
|---|---|---|
| risk_id | 文本 | 风险 ID |
| project_id | 关联 | 所属项目 |
| title | 文本 | 风险标题 |
| description | 长文本 | 风险说明 |
| level | 单选 | P0 / P1 / P2 |
| probability | 单选 | High / Medium / Low |
| impact | 单选 | High / Medium / Low |
| owner | 人员 | 风险负责人 |
| mitigation | 长文本 | 应对方案 |
| status | 单选 | Open / Monitoring / Resolved |
| source_url | URL | 来源链接 |

#### 6. Meetings 会议表

| 字段 | 类型 | 说明 |
|---|---|---|
| meeting_id | 文本 | 会议 ID |
| project_id | 关联 | 所属项目 |
| title | 文本 | 会议标题 |
| time | 日期时间 | 会议时间 |
| participants | 多人员 | 参会人 |
| minutes_url | URL | 会议纪要链接 |
| summary | 长文本 | 会议摘要 |
| extracted_tasks | 数字 | 提取任务数 |
| extracted_risks | 数字 | 提取风险数 |

#### 7. Decisions 决策表

| 字段 | 类型 | 说明 |
|---|---|---|
| decision_id | 文本 | 决策 ID |
| project_id | 关联 | 所属项目 |
| decision | 长文本 | 决策内容 |
| reason | 长文本 | 决策原因 |
| owner | 人员 | 决策人 |
| impact | 长文本 | 影响范围 |
| source_url | URL | 来源链接 |
| created_at | 日期时间 | 创建时间 |

#### 8. Changes 变更表

| 字段 | 类型 | 说明 |
|---|---|---|
| change_id | 文本 | 变更 ID |
| project_id | 关联 | 所属项目 |
| before | 长文本 | 变更前 |
| after | 长文本 | 变更后 |
| reason | 长文本 | 变更原因 |
| impact | 长文本 | 影响范围 |
| owner | 人员 | 变更负责人 |
| created_at | 日期时间 | 创建时间 |

### 验收标准

- 能自动创建核心表。
- 能写入项目、节点、模块、任务、风险、会议、决策记录。
- 每条记录能关联 project_id。
- Agent 后续只读取必要表和必要字段，避免读完整知识库。

---

## 6.4 自动拆解节点、模块、任务和子任务

### 功能说明

Agent 根据 Project Spec 自动生成项目计划。

### 输出结构

```text
Project
↓
Milestones
↓
Modules
↓
Tasks
↓
Subtasks
```

### 示例

```text
Milestone：Demo 跑通
Module：飞书 Bot 接入
Task：完成群聊消息监听
Subtasks：
- 创建飞书应用
- 开通消息事件权限
- 配置事件订阅
- 接收 im.message.receive_v1
- 解析 @机器人消息
- 返回确认卡片
```

### 验收标准

- 能根据项目截止时间反推节点。
- 每个节点至少包含负责人、截止时间、状态、完成标准。
- 每个任务至少包含负责人、截止时间、优先级、所属模块。
- 输出先进入任务池，不直接大批量创建飞书任务。
- 用户确认后再创建飞书任务。

---

## 6.5 会后自动提取 Action Items

### 功能说明

会议结束后，Agent 自动读取会议纪要，提取会议结果并写入系统。

### 需要提取的信息

- 会议摘要
- 会议结论
- Action Items
- 负责人
- 截止时间
- 风险和阻塞
- 决策记录
- 项目变更

### 输出格式

```json
{
  "meeting_summary": "本次会议确认 MVP 范围收敛为项目立项、知识库生成、会议纪要转任务和风险提醒。",
  "action_items": [
    {
      "title": "完成飞书 Bot 事件订阅配置",
      "owner": "A",
      "due_date": "2026-04-26",
      "priority": "P0",
      "source": "meeting"
    }
  ],
  "decisions": [
    {
      "decision": "MVP 阶段只处理 @机器人消息，不全量监听群聊",
      "reason": "降低权限风险和误触发风险"
    }
  ],
  "risks": [
    {
      "title": "会议纪要提取准确率不稳定",
      "level": "P1",
      "mitigation": "加入用户确认卡片"
    }
  ]
}
```

### 验收标准

- 能从会议纪要中提取至少 80% 的明确 Action Items。
- 不明确负责人或截止时间时，不乱编，标记为待确认。
- 创建任务前必须经过确认。
- 会议摘要、任务、风险、决策分别写入对应表。

---

## 6.6 项目总览和进度条更新

### 功能说明

Agent 自动根据任务和节点状态更新项目总览页。

### 总览页内容

- 项目名称
- 项目目标
- 项目周期
- 项目负责人
- 当前阶段
- 项目健康状态
- 项目总进度
- 节点进度
- 任务完成情况
- 当前风险
- 最近会议结论
- 本周重点
- 下周计划

### 进度计算建议

MVP 阶段使用简单规则：

```text
任务进度 = 已完成子任务数 / 总子任务数
节点进度 = 节点下任务平均进度
项目总进度 = Σ 节点进度 × 节点权重
```

### 状态规则

```text
Green：无 P0/P1 未处理风险，关键节点按计划推进
Yellow：存在 P1 风险、轻微延期或负责人缺失
Red：存在 P0 风险、关键节点延期或核心任务阻塞
```

### 验收标准

- 项目总览能展示实时进度。
- 进度数据来自多维表格，而不是模型主观判断。
- 每次更新写入更新时间。
- 能显示项目健康状态和风险摘要。

---

## 6.7 风险自动识别与预警

### 功能说明

Agent 定时或事件触发扫描项目状态，识别风险并推送提醒。

### 风险规则

| 风险类型 | 识别规则 | 风险等级 |
|---|---|---|
| 无负责人风险 | P0/P1 任务 owner 为空 | P0 / P1 |
| 无截止时间风险 | 关键任务 due_date 为空 | P1 |
| 逾期风险 | due_date 已过但状态不是 Done | P0 / P1 |
| 临期风险 | 24 小时内到期但未开始 | P1 |
| 依赖阻塞风险 | 依赖任务 Blocked 或逾期 | P0 / P1 |
| 节点空心化风险 | Milestone 下无支撑任务 | P1 |
| 过载风险 | 单个成员 P0/P1 任务过多 | P1 |
| 决策缺失风险 | 会议多次讨论但无明确决策 | P2 |

### 验收标准

- 能识别至少 3 类风险。
- 能将风险写入 Risks 表。
- 能在群里推送风险提醒。
- 能给出建议动作，而不只是报错。

---

## 6.8 群聊确认和推送

### 功能说明

Agent 在关键操作前后通过飞书群聊卡片与用户交互。

### 关键卡片

1. 项目立项确认卡片
2. 项目计划确认卡片
3. 会后任务确认卡片
4. 风险提醒卡片
5. 项目周报卡片
6. 任务变更确认卡片

### 设计原则

- 高风险操作必须确认
- 批量创建任务必须确认
- 不确定字段必须标注“待确认”
- 卡片中提供“确认 / 修改 / 忽略”选项

### 验收标准

- 用户能在群里确认任务创建。
- Agent 能根据确认结果执行下一步。
- 执行完成后在群里反馈结果。

---

## 7. 多 Agent 架构设计

## 7.1 为什么要多 Agent

单 Agent 方案的问题：

1. 工具过多，模型容易选错工具。
2. 上下文过长，会议、文档、任务混在一起容易爆炸。
3. 权限过大，安全风险高。
4. 任务边界不清晰，难以评测每一步是否正确。
5. 项目状态越积越多，模型会变成“宇宙垃圾桶”。

多 Agent 的目标：

- 每个 Agent 只负责一个窄任务
- 每个 Agent 只加载必要工具和 Skill
- 总控 Agent 不读全文，只做路由
- 长期状态放在多维表格和知识库中
- 模型上下文只保留当前任务所需片段

---

## 7.2 Agent 总体结构

```text
飞书群聊 / 会议纪要 / 日历 / 文档
        ↓
Event Listener
        ↓
PM Orchestrator 总控 Agent
        ↓
分发给专业子 Agent
        ↓
子 Agent 调用 lark-cli / OpenAPI
        ↓
写入多维表格 / 知识库 / 任务 / 日历 / 群聊
```

---

## 7.3 Agent 分工

### 0. PM Orchestrator 总控 Agent

**定位**：项目经理大脑，只负责路由和编排，不直接处理长文档。

**职责**：

- 接收事件
- 判断事件类型
- 确定 project_id
- 选择要调用的子 Agent
- 聚合子 Agent 输出
- 决定是否需要用户确认
- 触发下一步动作

**不能做的事**：

- 不读取完整会议纪要
- 不读取完整知识库
- 不直接创建大量任务
- 不直接更新复杂文档

**输入示例**：

```json
{
  "event_type": "meeting_ended",
  "project_id": "proj_001",
  "source_url": "https://...",
  "meeting_id": "m_001"
}
```

**输出示例**：

```json
{
  "route_to": ["MeetingAgent", "TaskAgent", "KnowledgeAgent", "DashboardAgent"],
  "requires_confirmation": true
}
```

---

### 1. Intake Agent：立项解析 Agent

**职责**：

- 从自然语言中提取项目定义
- 识别项目目标、成员、截止时间、交付物
- 生成 Project Spec
- 标记缺失字段

**使用工具**：

- 可不调用飞书工具
- 可调用 contact 工具查人员 ID

**输出**：Project Spec JSON

---

### 2. Space Builder Agent：项目空间搭建 Agent

**职责**：

- 创建项目知识库
- 创建项目总览文档
- 创建模块页面
- 创建多维表格项目数据库
- 创建基础表结构
- 写入初始项目信息

**使用工具 / Skill**：

- lark-wiki
- lark-doc
- lark-base
- lark-drive

**上下文限制**：

- 只读取 Project Spec
- 不读取会议全文
- 不读取群聊历史

---

### 3. Planner Agent：项目计划拆解 Agent

**职责**：

- 根据项目目标生成 Milestones
- 根据 Milestones 生成 Modules
- 根据 Modules 生成 Tasks
- 根据 Tasks 生成 Subtasks
- 生成负责人、截止时间、优先级、验收标准

**使用工具 / Skill**：

- lark-base
- lark-task：仅在用户确认后使用

**输出**：Plan JSON

---

### 4. Meeting Agent：会议纪要处理 Agent

**职责**：

- 读取会议纪要
- 提取会议摘要
- 提取 Action Items
- 提取风险
- 提取决策
- 提取项目变更

**使用工具 / Skill**：

- lark-minutes
- lark-vc

**上下文限制**：

- 可以读取会议全文
- 只把结构化摘要传给总控
- 不把会议全文传给其他 Agent

---

### 5. Task Agent：任务创建与同步 Agent

**职责**：

- 创建飞书任务
- 创建子任务
- 设置负责人、截止时间、提醒
- 同步任务状态到多维表格
- 更新任务链接

**使用工具 / Skill**：

- lark-task
- lark-contact
- lark-base

**安全规则**：

- 批量创建任务前必须确认
- 不确定负责人时不创建，进入待确认状态
- 每次任务变更写入 Change Log

---

### 6. Knowledge Curator Agent：知识库维护 Agent

**职责**：

- 更新项目总览文档
- 更新模块页面
- 归档会议纪要
- 追加决策记录
- 追加风险记录
- 追加变更记录

**使用工具 / Skill**：

- lark-doc
- lark-wiki
- lark-base

**上下文限制**：

- 只读当前页面摘要和新增变更
- 不重新读取整个知识库
- 以增量方式更新文档

---

### 7. Risk Agent：风险识别 Agent

**职责**：

- 扫描任务、节点、风险表
- 识别逾期、无负责人、无截止时间、依赖阻塞
- 计算项目健康状态
- 生成风险建议

**使用工具 / Skill**：

- lark-base
- lark-task

**上下文限制**：

- 只读结构化数据
- 不读长文档

---

### 8. Dashboard Agent：进度和看板更新 Agent

**职责**：

- 计算任务进度
- 计算节点进度
- 计算项目总进度
- 更新项目总览
- 生成周报数据

**使用工具 / Skill**：

- lark-base
- lark-doc

**原则**：

- 进度计算由程序完成
- 模型只负责解释变化和生成摘要

---

### 9. Comms Agent：群聊沟通 Agent

**职责**：

- 发送确认卡片
- 发送项目简报
- 发送风险提醒
- 回复用户追问
- 把复杂项目状态翻译成人话

**使用工具 / Skill**：

- lark-im

**上下文限制**：

- 只拿最终结果和少量背景
- 不直接读取会议全文或全部任务表

---

## 8. 多 Agent 如何实现

## 8.1 推荐技术路线

MVP 不需要上来就做复杂的 Agent 框架。推荐三阶段：

### 阶段 1：伪多 Agent

用一个后端服务实现多个“Agent 函数”。每个函数有自己的 Prompt、输入 Schema、输出 Schema 和可调用工具。

```text
orchestrator()
intake_agent()
space_builder_agent()
planner_agent()
meeting_agent()
task_agent()
risk_agent()
dashboard_agent()
comms_agent()
```

优点：

- 最容易开发
- 最容易 Debug
- 最适合比赛 Demo
- 不需要复杂 Agent runtime

---

### 阶段 2：轻量多 Agent 编排

每个 Agent 独立成模块，由 Orchestrator 调用。

```text
/agents
  orchestrator.ts
  intake-agent.ts
  space-builder-agent.ts
  planner-agent.ts
  meeting-agent.ts
  task-agent.ts
  risk-agent.ts
  dashboard-agent.ts
  comms-agent.ts
```

每个 Agent 统一接口：

```ts
interface AgentInput {
  projectId?: string;
  eventType: string;
  payload: Record<string, any>;
}

interface AgentOutput {
  status: "success" | "needs_confirmation" | "failed";
  data: Record<string, any>;
  nextAgents?: string[];
  errors?: string[];
}
```

---

### 阶段 3：真正多 Agent Runtime

如果时间充足，再考虑：

- LangGraph
- OpenAI Agents SDK
- 自研事件队列
- OpenClaw 集成
- Temporal / BullMQ 任务队列

但比赛 MVP 不建议第一天就上复杂框架。

---

## 8.2 推荐 MVP 技术栈

### 后端

- Node.js / TypeScript
- Express / Fastify
- Zod 做 Schema 校验
- child_process 调用 lark-cli
- SQLite / JSON 文件做本地缓存
- 飞书多维表格作为项目主数据库

### LLM

- 豆包 1.6 / OpenAI / Claude 均可
- 每个 Agent 使用独立 Prompt
- 输出必须是 JSON
- 所有 JSON 用 Zod 校验

### 飞书能力

- 飞书 Bot：群聊入口
- lark-event：接收消息事件
- lark-im：发消息和卡片
- lark-doc：创建和更新文档
- lark-wiki：创建知识库节点
- lark-base：创建多维表格和记录
- lark-task：创建任务和子任务
- lark-minutes / lark-vc：处理会议纪要
- lark-calendar：创建节点会议或评审日程

---

## 8.3 基础工程结构

```text
project-pilot/
├── src/
│   ├── index.ts
│   ├── agents/
│   │   ├── orchestrator.ts
│   │   ├── intakeAgent.ts
│   │   ├── spaceBuilderAgent.ts
│   │   ├── plannerAgent.ts
│   │   ├── meetingAgent.ts
│   │   ├── taskAgent.ts
│   │   ├── knowledgeAgent.ts
│   │   ├── riskAgent.ts
│   │   ├── dashboardAgent.ts
│   │   └── commsAgent.ts
│   ├── tools/
│   │   ├── larkCli.ts
│   │   ├── larkBase.ts
│   │   ├── larkDoc.ts
│   │   ├── larkTask.ts
│   │   └── larkIm.ts
│   ├── schemas/
│   │   ├── projectSpec.ts
│   │   ├── projectPlan.ts
│   │   ├── meetingExtraction.ts
│   │   ├── task.ts
│   │   └── risk.ts
│   ├── prompts/
│   │   ├── intake.md
│   │   ├── planner.md
│   │   ├── meeting.md
│   │   ├── risk.md
│   │   └── comms.md
│   ├── services/
│   │   ├── eventRouter.ts
│   │   ├── projectState.ts
│   │   ├── confirmation.ts
│   │   └── progressCalculator.ts
│   └── utils/
│       ├── logger.ts
│       └── id.ts
├── .env
├── package.json
└── README.md
```

---

## 8.4 Orchestrator 伪代码

```ts
async function orchestrator(event: FeishuEvent) {
  const normalizedEvent = normalizeEvent(event);

  if (normalizedEvent.type === "project_create_request") {
    const projectSpec = await intakeAgent(normalizedEvent.message);
    const projectSpace = await spaceBuilderAgent(projectSpec);
    const projectPlan = await plannerAgent(projectSpec, projectSpace);

    await commsAgent.sendProjectPlanConfirmation({
      projectSpec,
      projectSpace,
      projectPlan
    });

    return;
  }

  if (normalizedEvent.type === "meeting_ended") {
    const extraction = await meetingAgent({
      meetingId: normalizedEvent.meetingId,
      projectId: normalizedEvent.projectId
    });

    await commsAgent.sendActionItemsConfirmation(extraction);
    return;
  }

  if (normalizedEvent.type === "task_status_changed") {
    await dashboardAgent.updateProgress(normalizedEvent.projectId);
    await riskAgent.scanProject(normalizedEvent.projectId);
    return;
  }
}
```

---

## 8.5 lark-cli 调用封装

后端不要到处直接写 CLI 命令，应该统一封装：

```ts
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function runLarkCli(args: string[]) {
  const { stdout, stderr } = await execFileAsync("lark", args, {
    timeout: 30000,
    env: process.env
  });

  if (stderr) {
    console.warn(stderr);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}
```

然后不同工具模块调用：

```ts
export async function createDoc(title: string, content: string) {
  return runLarkCli([
    "doc",
    "create",
    "--title",
    title,
    "--content",
    content,
    "--output",
    "json"
  ]);
}
```

注意：实际 CLI 命令名称需要根据当前安装版本的 `lark --help` 和对应 skill 文档确认。需求文档中不要写死所有命令，开发时以本地 CLI schema 为准。

---

## 8.6 每个 Agent 的 Prompt 模板

### Intake Agent Prompt

```text
你是项目立项解析 Agent。
你的任务是从用户自然语言中提取项目定义。
只输出 JSON，不要输出解释。
缺失信息使用 null，不要编造。

需要提取：
- project_name
- goal
- deadline
- members
- roles
- deliverables
- constraints
- unknown_fields
```

### Planner Agent Prompt

```text
你是项目计划拆解 Agent。
你的任务是根据 Project Spec 生成项目 Milestones、Modules、Tasks 和 Subtasks。

要求：
1. 每个 Milestone 必须有完成标准。
2. 每个 Task 必须属于一个 Module 和一个 Milestone。
3. 每个 Task 必须有 owner、priority、due_date。如果无法确定，设置为 null。
4. 不要创建过多任务，MVP 阶段控制在 10–20 个任务。
5. 输出 JSON。
```

### Meeting Agent Prompt

```text
你是会议纪要分析 Agent。
你的任务是从会议纪要中提取会议摘要、Action Items、风险、决策和变更。

规则：
1. 不确定负责人时，owner 设为 null。
2. 不确定截止时间时，due_date 设为 null。
3. 只提取明确可执行的事项。
4. 风险必须包含 level、reason 和 suggested_action。
5. 输出 JSON。
```

### Risk Agent Prompt

```text
你是项目风险识别 Agent。
你的任务是基于结构化项目数据识别风险。

你只能根据输入数据判断，不允许编造不存在的问题。
请输出：
- health: Green / Yellow / Red
- risks
- suggested_actions
- priority_recommendations
```

### Comms Agent Prompt

```text
你是项目沟通 Agent。
你的任务是把结构化项目状态转化为适合飞书群聊的简洁提醒。

风格：
- 清晰
- 直接
- 不制造焦虑
- 明确下一步动作
- 适合团队协作
```

---

## 9. 上下文防爆设计

## 9.1 原则

```text
大数据不进模型
全文不进总控
状态不靠聊天记忆
每个 Agent 只读当前任务所需信息
长期记忆放进多维表格和知识库
```

## 9.2 具体策略

### 策略 1：总控 Agent 不读全文

总控只接收：

```json
{
  "event_type": "meeting_ended",
  "project_id": "proj_001",
  "source_id": "meeting_001"
}
```

### 策略 2：子 Agent 只读自己的数据

- Meeting Agent 读会议纪要
- Task Agent 读任务 JSON
- Risk Agent 读结构化任务表和风险表
- Knowledge Agent 读页面摘要和新增变更

### 策略 3：所有长内容先摘要再传递

会议全文 → Meeting Agent → 结构化摘要 → 其他 Agent  
知识库全文 → 页面摘要 → Knowledge Agent  
任务列表全集 → 过滤后的异常任务 → Risk Agent

### 策略 4：所有状态落入多维表格

不要让模型记住项目状态。每次执行前从多维表格读最新状态。

### 策略 5：增量更新

不要每次重写整个知识库，只追加：

- 新会议摘要
- 新任务
- 新风险
- 新决策
- 新变更

---

## 10. 权限与安全策略

### 10.1 操作分级

| 操作 | 风险等级 | 是否需要确认 |
|---|---|---|
| 读取项目文档 | 低 | 否 |
| 创建知识库模板 | 中 | 是 |
| 创建任务草稿 | 中 | 是 |
| 批量创建飞书任务 | 高 | 是 |
| 修改负责人 | 高 | 是 |
| 修改截止时间 | 高 | 是 |
| 删除任务 / 文档 | 极高 | MVP 不做 |

### 10.2 MVP 安全规则

1. 默认只处理 @机器人消息。
2. 不默认监听所有群聊内容。
3. 任何批量创建任务必须经过确认。
4. 不确定字段必须标注待确认。
5. 所有自动修改写入 Changes 表。
6. Bot 身份和用户身份分开处理。
7. 删除类能力 MVP 阶段禁止。

---

## 11. Demo 故事线

### Step 1：项目立项

用户在群里输入：

> @ProjectPilot 创建一个项目：飞书比赛项目。目标是 5 月 7 日前完成可运行 Demo，成员包括 July、A、B、C。July 负责产品，A 负责开发，B 负责设计，C 负责路演。

Agent 返回：

> 我识别到一个新项目，是否创建项目空间？

用户确认。

Agent 创建：

- 项目知识库
- 项目总览页
- 多维表格数据库
- 初始节点和任务池

---

### Step 2：自动生成项目计划

Agent 发出项目计划确认卡片：

- M1 项目定义完成
- M2 飞书 Bot 接入完成
- M3 知识库自动生成完成
- M4 会议纪要转任务完成
- M5 Dashboard 与风险提醒完成
- M6 Demo 和路演材料完成

用户确认后创建飞书任务。

---

### Step 3：会议纪要进入系统

会议结束后，Agent 读取会议纪要，提取：

- 3 条会议结论
- 5 个 Action Items
- 2 个风险
- 1 个需求变更

Agent 发确认卡片：

> 我识别到 5 个待办，是否创建任务？

用户确认后，Agent 创建任务并更新任务池。

---

### Step 4：项目总览自动更新

Agent 更新项目总览：

- 项目进度：35%
- 当前阶段：技术接入
- 风险状态：Yellow
- 逾期任务：0
- P1 风险：2

---

### Step 5：风险预警

第二天，Agent 发现：

- 一个 P0 任务没有负责人
- 一个节点下没有支撑任务

Agent 群内提醒：

> 当前项目状态为黄色。Demo 接入节点存在负责人缺失风险，建议今天内确认 owner。

---

## 12. MVP 开发排期建议

## Day 1：飞书基础接入

- 创建飞书应用
- 配置 Bot
- 安装并配置 lark-cli
- 跑通 lark-cli 身份认证
- 跑通发送群消息
- 跑通创建文档 / 多维表格 / 任务中至少一个能力

## Day 2：项目立项和知识库生成

- 实现 Intake Agent
- 实现 Space Builder Agent
- 自动创建项目总览文档
- 自动创建多维表格核心表

## Day 3：项目计划拆解

- 实现 Planner Agent
- 生成 Milestones / Modules / Tasks / Subtasks
- 写入多维表格任务池
- 生成项目计划确认卡片

## Day 4：任务创建闭环

- 实现 Task Agent
- 用户确认后创建飞书任务
- 任务链接回写多维表格
- 创建子任务

## Day 5：会议纪要处理

- 实现 Meeting Agent
- 读取会议纪要或模拟会议纪要
- 提取 Action Items / Risks / Decisions
- 创建任务确认卡片

## Day 6：Dashboard 和风险

- 实现 Dashboard Agent
- 实现 Risk Agent
- 计算项目进度
- 更新项目总览页
- 群聊推送风险提醒

## Day 7：Demo 打磨

- 串联完整故事线
- 准备测试数据
- 准备录屏
- 写效果验证报告
- 补充失败兜底和确认机制

---

## 13. 效果验证指标

### 13.1 准确性指标

| 指标 | 说明 |
|---|---|
| Action Item 识别准确率 | 人工标注与 Agent 输出对比 |
| 负责人识别准确率 | 是否正确识别 owner |
| 截止时间识别准确率 | 是否正确解析 due date |
| 风险识别有效率 | 识别风险是否真实存在 |

### 13.2 效率指标

| 指标 | 传统方式 | Agent 方式 |
|---|---|---|
| 创建项目知识库时间 | 15–30 分钟 | 1–3 分钟 |
| 会后整理任务时间 | 10–20 分钟 | 1–2 分钟 |
| 更新项目总览时间 | 5–10 分钟 | 自动 |
| 风险检查时间 | 5–15 分钟 | 自动 |

### 13.3 用户接受度指标

- 任务确认率
- 卡片点击率
- 自动生成任务被修改比例
- 自动生成风险被采纳比例
- 项目成员主观评分

---

## 14. 优先级

### P0 必须完成

- 飞书 Bot 接入
- lark-cli 调用封装
- 项目立项解析
- 项目知识库自动创建
- 多维表格项目数据库创建
- 项目节点 / 任务拆解
- 会议纪要转 Action Items
- 用户确认后创建飞书任务
- 项目总览进度更新

### P1 强烈建议完成

- 风险自动识别
- 决策记录自动沉淀
- 变更记录自动沉淀
- 群聊项目简报
- 子任务进度条

### P2 有时间再做

- 成员负载分析
- 自动创建日历节点
- 复杂权限配置
- GitHub / 代码仓库接入
- 多项目管理
- 更精美的 Dashboard

---

## 15. 关键风险

| 风险 | 影响 | 应对 |
|---|---|---|
| CLI 命令与文档不一致 | 开发卡住 | 以本地 `lark --help` 和 schema 为准 |
| 飞书权限申请不足 | 无法创建任务或读取会议 | 先用 Bot 可用能力 + 模拟数据兜底 |
| 会议纪要接口接入复杂 | 会后闭环受阻 | MVP 可先用手动粘贴纪要模拟 |
| Agent 输出不稳定 | 任务创建错误 | JSON Schema 校验 + 确认卡片 |
| 上下文过长 | 成本高、幻觉高 | 多 Agent + 多维表格状态中枢 |
| 自动操作风险 | 用户不信任 | 所有高风险操作先确认 |

---

## 16. 最终方案总结

ProjectPilot 的核心不是“自动创建任务”，而是构建一个会自我维护的项目空间。

它将飞书中的：

- 群聊
- 会议纪要
- 知识库
- 多维表格
- 飞书任务
- 日历

连接成一个持续生长的项目管理系统。

最终希望实现：

```text
项目一立项，空间自动生成；
会议一结束，任务自动沉淀；
任务一变化，进度自动更新；
风险一出现，团队自动收到提醒；
项目一结束，复盘自动形成。
```

这就是 ProjectPilot 的产品核心：

**让项目知识库从死文档变成活的项目管理专家。**

