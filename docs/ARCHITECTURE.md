# Architecture

MeetingAtlas 当前是一个 CLI-first、确认优先、本地 dry-run 可演示的 TypeScript 服务。

根目录就是主工程，不再依赖旧 ProjectPilot 架构。

## Runtime

```text
Fastify server
  -> GET /health
  -> POST /dev/meetings/manual
  -> GET /dev/confirmations
  -> POST /dev/confirmations/:id/confirm
  -> POST /dev/confirmations/:id/reject
  -> GET /dev/state

Workflow layer
  -> processMeetingWorkflow
  -> createKnowledgeBaseWorkflow

Agents as functions
  -> MeetingExtractionAgent
  -> PersonalActionAgent
  -> CalendarAgent
  -> TopicClusteringAgent
  -> KnowledgeCuratorAgent

State and tools
  -> SQLite repositories
  -> larkCli.ts
  -> larkTask.ts
  -> larkCalendar.ts
```

## Core Rules

- Orchestrating workflows do not call Feishu write APIs directly.
- All side effects start from a `confirmation_requests` row.
- LLM-shaped outputs are parsed through Zod before being persisted or executed.
- `FEISHU_DRY_RUN=true` is the default and blocks real Feishu writes.
- Long transcript text is stored in SQLite; downstream agents receive structured summaries and references.

## SQLite Tables

MVP tables:

- `meetings`
- `action_items`
- `calendar_drafts`
- `knowledge_bases`
- `sources`
- `confirmation_requests`
- `knowledge_updates`
- `cli_runs`

## Topic Clustering

Phase 5 intentionally uses a simple explainable algorithm:

- title keyword overlap
- meeting keyword overlap
- participant overlap
- source mention overlap

The first related meeting only enters `observe`; the second strongly related meeting can generate a `create_kb` confirmation.

## Knowledge Dry-Run

Phase 6 creates local records and Markdown content only:

- `knowledge_bases`
- `knowledge_updates`
- homepage Markdown
- default section structure
- meeting summaries
- transcript references
- action/calendar index

Real Wiki / Doc creation belongs to Phase 7 after inspecting the local Feishu CLI command surface.
