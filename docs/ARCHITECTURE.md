# Architecture

MeetingAtlas 当前是一个 LLM-first、确认优先、CLI-first 的 TypeScript 服务。

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
  -> POST /webhooks/feishu/event
  -> POST /webhooks/feishu/card-action

Workflow layer
  -> processMeetingWorkflow
  -> createKnowledgeBaseWorkflow
  -> appendMeetingToKnowledgeBaseWorkflow

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
  -> larkWiki.ts / larkDoc.ts
  -> larkIm.ts
```

## Core Rules

- Orchestrating workflows do not call Feishu write APIs directly.
- All side effects start from a `confirmation_requests` row.
- Business judgment lives in prompts and LLM outputs, not keyword lists or scoring rules in code.
- LLM-shaped outputs are parsed through Zod before being persisted or executed; malformed structured output enters a repair loop where supported.
- `FEISHU_DRY_RUN=true` is the default and blocks real Feishu writes.
- Card sending, task creation, calendar creation, and knowledge writes have separate canary dry-run switches.
- Non-local `/dev/*` and Feishu webhook traffic fails closed when required secrets are not configured.
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

## LLM-First Agents

MeetingAtlas treats agents as deterministic function boundaries around model calls:

- `MeetingExtractionAgent` extracts action items, calendar drafts, decisions, risks, source mentions, and topic keywords.
- `TopicClusteringAgent` decides whether a meeting should be observed, create a new knowledge base, append to an existing one, or be ignored.
- `PersonalActionAgent` resolves ambiguous card edits such as ownership completion.
- `KnowledgeCuratorAgent` creates the initial knowledge base page set and, in append mode, emits incremental update drafts.
- `QaAgent` answers questions against persisted meeting and knowledge-base context.

Code is responsible for context assembly, schema validation, repair, routing, persistence, and dry-run safety. It should not replace semantic judgment with regexes, keyword arrays, or weighted score formulas.

## Confirmation State Machine

The confirmation service owns the safety boundary:

- `draft` / `sent`: pending user review
- `edited`: user supplied card or API edits
- `snoozed`: reminder deferred
- `confirmed`: accepted and in execution
- `executed`: side effect completed or dry-run plan recorded
- `rejected` / `failed`: terminal non-execution states

Confirmed execution calls tool wrappers only after the request is terminally authorized. Duplicate terminal card clicks return a no-op result instead of re-executing.

## Knowledge Workflow

Knowledge-base creation and append are split deliberately:

- `createKnowledgeBaseWorkflow` calls Knowledge Curator to generate page content, creates a Wiki space through `larkWiki`, writes `pages[0]` as the homepage doc, then writes remaining pages as sibling docs.
- `appendMeetingToKnowledgeBaseWorkflow` creates an append document when real knowledge writes are enabled, and always asks Knowledge Curator append mode for an incremental `KnowledgeBaseAppendDraft`.
- The append draft is stored in `knowledge_updates.after_text` so the demo can show LLM-generated analysis/progress/risk/changelog changes even before core-page token storage exists.

True in-place updates to existing core pages require a page-token storage design and are tracked separately from P0.

## Feishu Safety Modes

- Mode A: full dry-run. No real Feishu write; CLI calls are recorded as planned.
- Mode B: real confirmation card sending only. Tasks, calendars, and knowledge writes stay dry-run.
- Mode C: per-workflow or full real write canary. This requires calibrated CLI commands, permissions, public callback URL, and webhook verification token.

Startup logs include the current security mode and missing configuration warnings. In production-like environments, missing `DEV_API_KEY` blocks `/dev/*`, and missing `LARK_VERIFICATION_TOKEN` blocks Feishu webhooks.
