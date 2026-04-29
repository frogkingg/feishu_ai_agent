# Feishu CLI Notes

Phase 4 wired confirmation execution into the tool layer.

Phase 6 still keeps knowledge-base creation as local dry-run Markdown.
The current card-send phase adds a `lark.im.send_card` wrapper for confirmation cards.
Real Feishu writes remain disabled by default through `FEISHU_DRY_RUN=true`;
card sending has its own `FEISHU_CARD_SEND_DRY_RUN` switch, which defaults to `true`.

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

In `FEISHU_CARD_SEND_DRY_RUN=true`, MeetingAtlas does not execute the binary; it records
the planned command in `cli_runs` with tool `lark.im.send_card`. To verify real card
sending while keeping tasks, calendars, and knowledge-base writes dry-run, run with
`FEISHU_DRY_RUN=true FEISHU_CARD_SEND_DRY_RUN=false` after the bot and CLI command shape
are calibrated.

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

## Webhook Boundary

`POST /webhooks/feishu/event` currently supports Feishu challenge response and
logs unrecognized payloads before returning accepted.

Signature verification, event de-duplication, and mapping real meeting/minutes
events into MeetingAtlas inputs are Phase 7 work.
