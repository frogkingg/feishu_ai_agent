# MeetingAtlas Send-cards Demo Report

✅ MeetingAtlas P0 Demo passed

- Generated at: 2026-04-29T09:56:14.019Z
- Mode: send-cards
- Base URL: http://127.0.0.1:3102
- LLM Provider: mock
- Feishu Write Mode: dry-run
- Mode note: FEISHU_DRY_RUN=true; this demo dry-run sends confirmation cards only and does not execute confirmations.
- Meetings processed: 2
- Action confirmations executed: 0
- Calendar confirmations executed: 0
- Knowledge base confirmations executed: 0
- Card previews generated: 5
- Action cards: 3
- Calendar cards: 1
- Knowledge base cards: 1
- Card send CLI records: 5
- Knowledge base name: n/a
- Knowledge base URL: n/a
- Knowledge update: n/a
- Dry-run CLI records: 5

## Topic Flow

- First meeting: mtg_9658e43ee0984d61a676
- First topic action: observe
- First extraction: actions=2, calendars=1
- Second meeting: mtg_b454c07310c4406998ba
- Second topic action: ask_create
- Second topic score: 0.9
- Candidate meetings: mtg_9658e43ee0984d61a676, mtg_b454c07310c4406998ba

## Safety Notes

- Current run is dry-run only; no real Feishu writes were performed.
- This report intentionally does not include API keys, secrets, or `.env` contents.
