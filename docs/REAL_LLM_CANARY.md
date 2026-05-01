# Real LLM Canary Harness

Use this harness when validating DeepSeek/OpenAI-compatible behavior without real Feishu writes.

```bash
npm run canary:real-llm -- --dry-check
npm run canary:real-llm
```

The command refuses to run unless all five safety switches are explicitly true:

- `FEISHU_DRY_RUN`
- `FEISHU_CARD_SEND_DRY_RUN`
- `FEISHU_TASK_CREATE_DRY_RUN`
- `FEISHU_CALENDAR_CREATE_DRY_RUN`
- `FEISHU_KNOWLEDGE_WRITE_DRY_RUN`

It also requires `LLM_PROVIDER=openai-compatible` plus present `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Output only shows provider and a masked model name; it never prints the API key or full base URL.

By default the harness uses a fresh SQLite DB under `/tmp/meetingatlas-real-llm-canary-<timestamp>.db`, runs a smoke extraction, two OpenClaw/onboarding meetings, and dry-run confirmation of generated `create_kb` requests. Each workflow step and each `generateJson` call prints start/end timing, schema name, and timeout status. The final JSON summary reports topic decisions, confirmation/card counts, knowledge page titles, forbidden fallback-word checks, calendar missing-field checks, and `cli_runs` safety.

Useful options:

```bash
npm run canary:real-llm -- --help
npm run canary:real-llm -- --sqlite-path /tmp/meetingatlas-real-llm-canary-manual.db
npm run canary:real-llm -- --llm-timeout-ms 180000 --step-timeout-ms 600000
```

Do not commit `.env`, SQLite DBs, or raw canary output containing meeting data.
