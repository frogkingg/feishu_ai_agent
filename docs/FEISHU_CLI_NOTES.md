# Feishu CLI Notes

Phase 4 wired confirmation execution into the tool layer.

Phase 6 still keeps knowledge-base creation as local dry-run Markdown.
Real Feishu writes remain disabled by default through `FEISHU_DRY_RUN=true`.

## Current Tool Commands

The tool layer currently uses abstract command arguments:

```text
lark task create ...
lark calendar event create ...
```

These are placeholders inside `src/tools/larkTask.ts` and
`src/tools/larkCalendar.ts`, not product workflow assumptions.

Before enabling real writes, calibrate command names and payload shape with the
local CLI:

```bash
lark --help
lark task --help
lark calendar --help
lark schema <method>
```

Depending on the installed binary, `LARK_CLI_BIN` may need to be `lark-cli` instead of `lark`.

## Safety Rules

- All write actions must originate from a confirmation request.
- Dry-run must not execute `execFile`.
- Every CLI plan or execution is recorded in `cli_runs`.
- Token, secret, authorization, and access token values are redacted before recording.
- If the CLI is unavailable or exits with an error in real mode, the
  confirmation request must become `failed`; action/calendar rows must not be
  marked `created`.
- Knowledge-base creation remains dry-run only until Phase 7 wires `larkWiki` /
  `larkDoc`; real mode must fail instead of creating mock wiki URLs.

## Webhook Boundary

`POST /webhooks/feishu/event` currently supports Feishu challenge response and
logs unrecognized payloads before returning accepted.

Signature verification, event de-duplication, and mapping real meeting/minutes
events into MeetingAtlas inputs are Phase 7 work.
