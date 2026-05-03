# Feishu CLI Notes

MeetingAtlas routes Feishu side effects through tool wrappers only after a
confirmation request is accepted. Real Feishu writes remain disabled by default
through `FEISHU_DRY_RUN=true`.

The tool layer currently covers:

- `lark.im.send_card` and `lark.im.update_card` for confirmation card delivery and status sync.
- `lark.task.create` for confirmed action items.
- `lark.calendar.create` for confirmed calendar drafts.
- `lark.wiki.spaces.create`, `lark.doc.create`, and `lark.docs.update` for knowledge-base write canaries.

Each class of write has its own dry-run switch so real tests can be opened one lane at a time.

## Feishu Safety Modes

| Mode                                        | Config                                                    | Result                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode A: full dry-run, default safe mode     | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=true`  | Does not send real cards; does not create real tasks; does not create real calendar events; does not create real Wiki / Doc resources; all CLI calls are recorded as `planned` / dry-run. |
| Mode B: real confirmation cards only        | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=false` | Sends real Feishu confirmation cards; tasks, calendars, Wiki / Doc remain dry-run; this is the recommended first real Feishu test mode.                                                   |
| Mode C: per-workflow or full real canary    | `FEISHU_DRY_RUN=false` or a single write dry-run set false | Allows real task, calendar, Wiki / Doc writes after explicit calibration; not recommended for unisolated environments. CLI failures must not be recorded as success.                      |

## Current Tool Commands

Confirmed task creation uses:

```text
lark-cli task +create --summary <title> --description <description> [--due <date>] [--assignee <ou_id>] --as user
```

If the owner is a natural-language name instead of an `ou_` open_id, MeetingAtlas
does not silently drop it. The task description is appended with
`负责人（待认领）：<name>`, and the result reports `owner_resolved=false`.

Confirmed calendar creation uses:

```text
lark-cli calendar +create --summary <title> --start <iso> --end <iso> --description <agenda> [--attendee-ids <ou_ids>] --as user
```

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

Knowledge-base creation uses:

```text
lark-cli wiki spaces create --data <json> --format json --yes --as user
lark-cli wiki +node-create --space-id <space_id> --title <page_title> --obj-type docx --as user
lark-cli docs +update --api-version v2 --doc <doc_token> --command append --content <markdown> --doc-format markdown --as user
```

`createKnowledgeBaseWorkflow` writes the generated homepage page as a doc using
`--space-id`; it does not treat a Wiki `space_id` as a `parent_node_token`.

Before enabling real writes, calibrate command names, permissions, and payload
shape with the local CLI:

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
- Knowledge-base real writes are canary-gated by `FEISHU_KNOWLEDGE_WRITE_DRY_RUN`;
  CLI failures must never be turned into fake Wiki or Doc success.
- Mode C (`FEISHU_DRY_RUN=false`) is not recommended for shared or unisolated
  environments. When enabled, CLI failures must never be turned into fake task,
  calendar, Wiki, or Doc success.

## Webhook Boundary

`POST /webhooks/feishu/event` supports Feishu challenge response, signature
verification when `LARK_VERIFICATION_TOKEN` is configured, and accepted handling
for unrecognized events.

`vc.meeting.recording_ready_v1` events are mapped into MeetingAtlas meeting
processing in the background.

`POST /webhooks/feishu/card-action` maps button payloads back to confirmation
actions, executes accepted operations through the confirmation layer, and syncs
the final card status.

In `development` and `test`, missing `LARK_VERIFICATION_TOKEN` is allowed with a
warning for local testing. In all other environments, missing verification token
returns 503 for Feishu webhooks. `/dev/*` follows the same fail-closed rule for
`DEV_API_KEY`.
