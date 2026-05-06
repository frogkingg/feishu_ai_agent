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

## Latest RC Result

Release candidate `6b9fb08` passed the real LLM dry-run canary sequence:

1. `npm run canary:real-llm -- --dry-check`
2. `npm run canary:real-llm`

Recorded safe summary:

- masked config: provider `openai-compatible`, API key present, base URL present, model masked, all Feishu dry-run switches `true`
- `ok`: `true`
- total time: about `513.8s`
- `topic_results`: first OpenClaw onboarding meeting stayed `observe`; second related meeting returned `ask_create` with score `0.94`
- `create_kb_results`: one dry-run `create_kb` execution, `failed=false`, `dry_run=true`, `page_count=13`, no forbidden fallback words
- `quality`: `create_kb_present=true`, `single_create_kb_confirm_not_failed=true`, `knowledge_no_forbidden_words=true`, `calendar_missing_fields_clean=true`, `cli_runs_safe=true`, `no_real_feishu_write_or_card_send=true`
- CLI safety: all recorded CLI runs were dry-run planned records; no real Feishu write or card send occurred

One intermediate sandbox run failed at network fetch during smoke extraction; the escalated rerun passed. This was an environment/network restriction, not a schema, prompt, or product-logic failure.
