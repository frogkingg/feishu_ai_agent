# Feishu CLI Notes

Phase 4 wired confirmation execution into the tool layer.

Phase 6 still keeps knowledge-base creation as local dry-run Markdown.
The current card-send phase adds a `lark.im.send_card` wrapper for confirmation cards.
Real Feishu writes remain disabled by default through `FEISHU_DRY_RUN=true`;
card sending has its own `FEISHU_CARD_SEND_DRY_RUN` switch, which defaults to `true`.

## Feishu Safety Modes

| Mode                                        | Config                                                    | Result                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode A: full dry-run, default safe mode     | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=true`  | Does not send real cards; does not create real tasks; does not create real calendar events; does not create real Wiki / Doc resources; all CLI calls are recorded as `planned` / dry-run. |
| Mode B: real confirmation cards only        | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=false` | Sends real Feishu confirmation cards; tasks, calendars, Wiki / Doc remain dry-run; this is the recommended first real Feishu test mode.                                                   |
| Mode C: full real mode, not recommended yet | `FEISHU_DRY_RUN=false`                                    | Future mode for real task, calendar, Wiki / Doc writes; not recommended now; CLI failures must not be recorded as success.                                                                |

## Current Tool Commands

The tool layer currently uses abstract command arguments:

```text
lark task create ...
lark calendar event create ...
```

These are placeholders inside `src/tools/larkTask.ts` and
`src/tools/larkCalendar.ts`, not product workflow assumptions.

Confirmation card sending uses the calibrated IM shortcut shape:

```text
lark-cli im +messages-send --chat-id oc_xxx --msg-type interactive --content <card-json> --as bot
lark-cli im +messages-send --user-id ou_xxx --msg-type interactive --content <card-json> --as bot
```

In Mode A, MeetingAtlas does not execute the binary for card sends; it records the
planned command in `cli_runs` with tool `lark.im.send_card`. To verify real card
sending while keeping tasks, calendars, and knowledge-base writes dry-run, use Mode B:
`FEISHU_DRY_RUN=true FEISHU_CARD_SEND_DRY_RUN=false` after the bot and CLI command shape
are calibrated.

The real card-send smoke configuration is:

```env
FEISHU_DRY_RUN=true
FEISHU_CARD_SEND_DRY_RUN=false
LARK_CLI_BIN=lark-cli
LLM_PROVIDER=mock
```

This configuration opens only the IM card delivery path. Confirming a card still executes
through the confirmation layer and remains dry-run while `FEISHU_DRY_RUN=true`.

Before enabling real writes, calibrate command names and payload shape with the
local CLI:

```bash
lark-cli --help
lark-cli task --help
lark-cli calendar --help
lark-cli schema <method>
```

The default `LARK_CLI_BIN` is `lark-cli`.

## Safety Rules

- All write actions must originate from a confirmation request.
- Dry-run must not execute `execFile`.
- `FEISHU_CARD_SEND_DRY_RUN` only controls IM card sending; action/calendar/create_kb
  execution still follows `FEISHU_DRY_RUN`.
- Every CLI plan or execution is recorded in `cli_runs`.
- Token, secret, authorization, and access token values are redacted before recording.
- Sending a confirmation card is not the same as confirming the action. It must
  not mark action/calendar/create_kb requests as executed.
- Real card sending must return a real `message_id`; otherwise it fails and
  must not write a fake `card_message_id`.
- For confirmed execution writes, if the CLI is unavailable or exits with an
  error in real mode, the confirmation request must become `failed`;
  action/calendar rows must not be marked `created`.
- For card sending, if the CLI is unavailable or exits with an error in real
  mode, the send-card result must be `failed`; the confirmation request remains
  unexecuted and must not receive a fake `card_message_id`.
- Knowledge-base creation remains dry-run only until Phase 7 wires `larkWiki` /
  `larkDoc`; real mode must fail instead of creating mock wiki URLs.
- Mode C (`FEISHU_DRY_RUN=false`) is not recommended yet. When it is enabled in the
  future, CLI failures must never be turned into fake task, calendar, Wiki, or Doc success.

## Webhook Boundary

`POST /webhooks/feishu/event` currently supports Feishu challenge response and
logs unrecognized payloads before returning accepted.

Signature verification, event de-duplication, and mapping real meeting/minutes
events into MeetingAtlas inputs are Phase 7 work.

`POST /webhooks/feishu/card` is a dry-run-only skeleton for card button callbacks.
It maps `action_key` and `request_id` back to confirmation actions, refuses to run when
`FEISHU_DRY_RUN=false`, and must receive production-grade signature verification before
public exposure.
