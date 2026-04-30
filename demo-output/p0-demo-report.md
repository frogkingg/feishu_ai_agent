# MeetingAtlas P0 Demo Report

✅ MeetingAtlas P0 Demo passed

- Generated at: 2026-04-30T15:08:58.664Z
- Mode: full-p0
- Base URL: http://127.0.0.1:3001
- LLM Provider: mock
- Feishu Write Mode: dry-run
- Mode note: FEISHU_DRY_RUN=true; this demo did not perform real Feishu writes.
- Meetings processed: 3
- Action confirmations executed: 4
- Calendar confirmations executed: 2
- Knowledge base confirmations executed: 1
- Append meeting confirmations executed: 1
- Card previews generated: 8
- Action cards: 4
- Calendar cards: 2
- Knowledge base cards: 1
- Append meeting cards: 1
- Card send CLI records: 0
- Knowledge base name: 无人机操作流程主题知识库
- Knowledge base URL: mock://feishu/wiki/kb\_无人机操作流程主题知识库
- Knowledge update: meeting_added
- Knowledge updates: kb_created -> meeting_added
- Pending confirmations: 0
- Pending confirmation IDs: none
- Dry-run CLI records: 6

## Topic Flow

- First meeting: mtg_187ac1f6dd4046c09a37
- First topic action: observe
- First extraction: actions=2, calendars=1
- Second meeting: mtg_e8ea4d8102a4456b8d51
- Second topic action: ask_create
- Second topic score: 0.9
- Candidate meetings: mtg_187ac1f6dd4046c09a37, mtg_e8ea4d8102a4456b8d51
- Third meeting: mtg_d65938e6d4a34970ae67
- Third topic action: ask_append
- Third matched knowledge base: kb\_无人机操作流程主题知识库
- Third extraction: actions=1, calendars=1

## Product Story

- Meeting 1 creates personal action and calendar confirmation cards.
- Meeting 2 detects a repeated drone-operation topic and creates the knowledge base after confirmation.
- Meeting 3 matches the existing knowledge base and appends a meeting update after confirmation.

## Safety Notes

- Current run is dry-run only; no real Feishu writes were performed.
- This report intentionally does not include API keys, secrets, or `.env` contents.
