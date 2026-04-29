# MeetingAtlas Demo Script

本文档说明 `npm run demo:full-p0` 的自动化验收流程。脚本只验证 P0 Demo 主链路，不会接真实飞书写入。

## Demo 目标

演示 MeetingAtlas 从两场会议转写中自动抽取待办和日程，经过用户确认后进入 Feishu dry-run 执行记录，并在第二场高度相关会议后建议创建知识库。

核心验证点：

- 真实或 mock LLM 均能完成会议抽取链路。
- action/calendar confirmation 可以被自动确认。
- edited payload 会进入最终状态。
- 两场无人机相关会议会触发 `create_kb` confirmation。
- 确认 `create_kb` 后会生成 mock 知识库和 `kb_created` 更新记录。

## 如何运行

启动服务：

```bash
npm run dev
```

在另一个终端运行完整 P0 Demo：

```bash
npm run demo:full-p0
```

默认服务地址是 `http://127.0.0.1:3000`。如果服务运行在其他地址：

```bash
MEETING_ATLAS_BASE_URL=http://127.0.0.1:3000 npm run demo:full-p0
```

推荐使用干净的 dry-run 数据库做演示：

```bash
PORT=3000 SQLITE_PATH=/tmp/meeting-atlas-demo.db FEISHU_DRY_RUN=true npm run dev
```

## 测试输入

第一场会议：

- title: `无人机操作方案真实 LLM 测试`
- participants: `张三`, `李四`, `Henry`
- transcript highlights: 无人机操作流程、试飞权限、操作员访谈、无人机安全规范
- 预期主题动作：`observe`

第二场会议：

- title: `无人机操作员访谈`
- participants: `张三`, `王五`, `Henry`
- transcript highlights: 继续讨论无人机操作方案、操作流程不统一、试飞前权限确认分散、建立统一无人机操作 SOP、整理风险清单
- 显式知识库意图：`后续要把这两次访谈整理成一个无人机操作方案知识库`
- 预期主题动作：`ask_create`

脚本会自动确认第一条 action，并用 edited payload 确认第二条 action：

```json
{
  "title": "确认无人机试飞场地权限并输出审批说明",
  "owner": "王五",
  "due_date": "2026-05-02",
  "priority": "P0"
}
```

脚本会用 edited payload 确认 calendar：

```json
{
  "participants": ["张三", "李四", "王五"],
  "duration_minutes": 60,
  "location": "线上会议"
}
```

## Demo 流程

| Step | 调用 | 预期输出 |
| --- | --- | --- |
| 1 | `GET /health` | `ok=true`，`dry_run=true`，返回当前 `llm_provider` |
| 2 | `POST /dev/meetings/manual` 提交第一场会议 | 返回 `meeting_id`，`extraction.action_items.length >= 2`，`extraction.calendar_drafts.length >= 1` |
| 3 | 校验第一场 topic match | `topic_match.suggested_action = observe`，不创建 `create_kb` |
| 4 | `GET /dev/confirmations` | 能看到第一场 action/calendar confirmation |
| 5 | `POST /dev/confirmations/:id/confirm` 确认第一条 action | action 进入 executed/confirmed 状态，并产生 dry-run CLI 记录 |
| 6 | 使用 edited payload 确认第二条 action | 最终 action owner/due_date/priority/title 使用用户确认值 |
| 7 | 使用 edited payload 确认 calendar | calendar participants/location/duration 使用用户确认值 |
| 8 | `POST /dev/meetings/manual` 提交第二场会议 | 返回第二个 `meeting_id` |
| 9 | 校验第二场 topic match | `score >= 0.9`，`suggested_action = ask_create`，`candidate_meeting_ids.length >= 2` |
| 10 | `GET /dev/confirmations` | 能看到 `request_type=create_kb` 的 confirmation |
| 11 | 确认 `create_kb` | 创建 mock 知识库记录 |
| 12 | `GET /dev/state` | `knowledge_bases.length >= 1`，`knowledge_updates.length >= 1`，最新 update 为 `kb_created` |

## 成功标准

脚本成功时终端会输出：

```text
✅ MeetingAtlas P0 Demo passed

LLM Provider: openai-compatible
Feishu Write Mode: dry-run
Meetings processed: 2
Action confirmations executed: 2
Calendar confirmations executed: 1
Knowledge base confirmations executed: 1
Knowledge base name: 无人机操作方案
Knowledge base URL: mock://...
Knowledge update: kb_created
```

关键断言失败时脚本会输出清晰错误原因，并以 `process.exit(1)` 退出。

成功运行后会生成：

- `demo-output/p0-demo-latest.json`: 最近一次 Demo 的结构化结果，已加入 `.gitignore`。
- `demo-output/p0-demo-report.md`: 最近一次 Demo 的人类可读报告，可以作为阶段成果留存。

报告不会写入 API Key，也不会写入 `.env` 内容。

## Dry-run 与真实飞书模式差异

| 项目 | Dry-run Demo | 真实飞书模式 |
| --- | --- | --- |
| 飞书写入 | 不写真实飞书，只记录 dry-run CLI run | 后续接入真实 CLI/API 后才会写任务、日程、知识库或消息 |
| URL | 知识库 URL 为 `mock://...` | 应返回真实飞书 Wiki/Doc URL |
| 安全边界 | `demo:full-p0` 要求 `FEISHU_DRY_RUN=true`，检测到真实写入模式会拒绝执行 | 需要单独的真实写入验收脚本和权限确认 |
| LLM | 可以使用 `mock` 或 `openai-compatible` | 推荐继续保持 LLM 与飞书写入开关解耦 |
| Demo 报告 | 记录流程结果，不含密钥或 `.env` | 真实模式报告同样不应包含密钥 |

当前 P0 Demo 的目标是证明确认链路、状态一致性、主题聚类和知识库建议闭环已经跑通；真实飞书写入、真实卡片和真实 Wiki/Doc 创建不在本脚本范围内。
