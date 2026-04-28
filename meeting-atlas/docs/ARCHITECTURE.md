# Architecture

当前实现到 Phase 6：本地手动会议输入、Mock LLM 抽取、任务/日程草案、确认请求、dry-run CLI 执行记录、主题聚类建议和知识库 Markdown dry-run 创建。

```text
Fastify server
  -> GET /health
  -> POST /dev/meetings/manual
  -> GET /dev/confirmations
  -> POST /dev/confirmations/:id/confirm
  -> POST /dev/confirmations/:id/reject
  -> GET /dev/state

Zod schemas
  -> ActionItemDraft
  -> CalendarEventDraft
  -> MeetingExtractionResult
  -> TopicMatchResult
  -> ConfirmationRequest
  -> KnowledgeBaseDraft

SQLite
  -> migrations
  -> repositories

Mock LLM
  -> MeetingExtractionAgent
  -> PersonalActionAgent
  -> CalendarAgent
  -> TopicClusteringAgent
  -> KnowledgeCuratorAgent
  -> ConfirmationService
  -> processMeetingWorkflow
  -> createKnowledgeBaseWorkflow

Tools
  -> larkCli.ts
  -> larkTask.ts
  -> larkCalendar.ts
  -> cli_runs
```

## 旧代码处理

旧 ProjectPilot 代码保持在仓库原位，但 `meeting-atlas/` 不引用旧架构、旧命名或旧 workflow。后续如果需要仓库级清洁，可以把旧代码移入 `_legacy_ignored/`，这应作为单独操作处理。

## 当前边界

- 不调用真实 LLM。
- 默认不真实创建飞书任务 / 日程。
- 主题聚类使用标题、关键词、参会人和资料引用重叠，不使用向量库。
- 知识库创建只写本地 `knowledge_bases`、`knowledge_updates` 和 Markdown dry-run 内容。

## 后续方向

Phase 7 校准真实飞书 CLI 写入、卡片发送和 Wiki/Doc 创建命令。
