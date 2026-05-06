# Card Dry-run Design

本文档说明 MeetingAtlas 当前阶段的飞书卡片确认层设计。

## 定位

卡片确认层是所有高影响动作的安全确认层。凡是可能创建任务、创建日程、
创建知识库或改变后续协作状态的动作，都必须先生成 confirmation request 和
card preview，用户确认后才进入执行流程。

当前实现会生成 dry-run card JSON，并提供 `larkIm.sendCard` 集成。
`FEISHU_CARD_SEND_DRY_RUN` 独立控制确认卡片是否真实发送，默认值必须为 `true`。
在 `FEISHU_CARD_SEND_DRY_RUN=true` 下，发送卡片只会记录 `cli_runs`，不会真实发送飞书消息，
也不会调用真实飞书任务、日程、Wiki 或 Doc 写入能力。需要只验证真实卡片发送时，可以保持
`FEISHU_DRY_RUN=true`，并显式设置 `FEISHU_CARD_SEND_DRY_RUN=false`。

## 飞书安全模式

| 模式                                    | 配置                                                                                                                              | 结果                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模式 A：全 dry-run，默认安全模式        | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=true`                                                                          | 不真实发送卡片；不真实创建任务；不真实创建日程；不真实创建 Wiki / Doc；所有 CLI 都只记录 `planned` / dry-run；提交版和默认演示保持该模式。                                                  |
| 模式 B：只真实发送确认卡片              | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=false`                                                                         | 真实发送飞书确认卡片；任务、日程、Wiki / Doc 仍然 dry-run；这是当前推荐的第一层真实飞书测试模式。                                                                                           |
| 模式 C：per-workflow / full real canary | `FEISHU_DRY_RUN=false` 做 full real canary，或在隔离环境里只关闭一个 `FEISHU_*_CREATE_DRY_RUN` / `FEISHU_KNOWLEDGE_WRITE_DRY_RUN` | 可以跑 task/calendar/knowledge 的单项真实写入 canary 或 full real canary 代码闭环；真实写入只在隔离 DB、隔离接收人和权限校准后逐项开启；CLI 失败不得伪造成功，不作为共享提交/演示默认模式。 |

Demo 报告资产拆分为两类：完整 P0 主链路继续写入
`demo-output/p0-demo-report.md`；send-cards dry-run 验收写入
`demo-output/send-cards-demo-report.md`。前者证明确认后执行闭环，后者证明确认卡片
发送计划进入 `lark.im.send_card`，两者互补而不是替代关系。

`full-p0`、`cards-only` 和 `send-cards` 默认都要求干净 SQLite DB。脚本启动时会先
读取 `/dev/state`，确认 `meetings`、`action_items`、`calendar_drafts`、
`knowledge_bases`、`confirmation_requests` 全部为空；dirty DB 会在第一场会议
POST 前失败。刚跑过 `full-p0` 后，如需验证 `send-cards`，请换新的 `SQLITE_PATH`
重新启动 dry-run 服务。

## 当前输出

每个 confirmation request 会在 `original_payload_json` 中保留原始业务 payload，
并追加 `card_preview`：

```json
{
  "draft": {},
  "meeting_id": "mtg_xxx",
  "card_preview": {
    "card_type": "action_confirmation",
    "title": "...",
    "summary": "...",
    "sections": [],
    "editable_fields": [],
    "actions": [],
    "dry_run": true,
    "version": "dry_run_v1"
  }
}
```

`card_preview` 不替代原来的 `draft`。确认和拒绝逻辑继续读取原有字段，
避免卡片展示层污染执行层。

## API

`GET /dev/cards`

返回所有未完成 confirmation 的 dry-run card JSON。已 `executed`、`rejected`
或 `failed` 的 confirmation 不会出现在此队列。

`GET /dev/confirmations/:id/card`

返回单个 confirmation 的 dry-run card JSON。

`GET /dev/confirmations`

仍返回 confirmation request 列表，并附带 `dry_run_card`，便于调试。

`POST /dev/confirmations/:id/send-card`

把单个 confirmation 的 card preview 映射为飞书 interactive card payload，并通过
`lark.im.send_card` 进入 CLI wrapper。请求体支持二选一：

```json
{ "recipient": "ou_xxx" }
```

```json
{ "chat_id": "oc_xxx" }
```

模式 A 下不会执行 `lark-cli`，只会记录一条 tool 为 `lark.im.send_card` 的
`planned` / dry-run `cli_runs`。模式 B 下，也就是 `FEISHU_CARD_SEND_DRY_RUN=false`
时会调用：

```text
lark-cli im +messages-send --msg-type interactive --content <card-json> --as bot
```

如果 CLI 不存在、命令未校准或返回结果中没有 `message_id`，接口必须返回失败，
不得写入假的 `card_message_id`。这个开关只影响卡片发送；任务、日程和知识库写入
仍由 `FEISHU_DRY_RUN` 控制。

真实卡片发送验收推荐配置为：

```env
FEISHU_DRY_RUN=true
FEISHU_CARD_SEND_DRY_RUN=false
FEISHU_CARD_ACTIONS_ENABLED=true
LARK_VERIFICATION_TOKEN=<configured in Feishu app>
LARK_CARD_CALLBACK_URL_HINT=https://your-domain/webhooks/feishu/card-action
LARK_CLI_BIN=lark-cli
LLM_PROVIDER=mock
```

该配置只打开飞书 IM 确认卡片发送和卡片按钮回调，不打开任务、日程、Wiki 或 Doc 的真实写入。发送态 confirmation card 必须可确认；只读 / display-only 卡片只用于确认、拒绝、失败或执行完成后的结果态。如果 callback 公网地址、`LARK_CARD_CALLBACK_URL_HINT` 或验签尚未配置，真实发送会 fail fast，不应发送真实确认卡。飞书开放平台「消息卡片请求地址」必须与 `LARK_CARD_CALLBACK_URL_HINT` 一致。

`POST /dev/cards/send-all`

对所有未完成 confirmation 批量执行同样的 send-card dry-run/real wrapper。未指定
`chat_id` 或 `recipient` 时，会使用每条 confirmation 自身的 `recipient`。

`npm run demo:full-p0 -- --send-cards --chat-id <chat_id>` 会调用这个接口。该模式
只发送确认卡片，不执行 confirm/reject，因此 action、calendar、create_kb 的
confirmations executed 为 `0` 是预期结果。
默认 Demo 服务应保持模式 A；只有真实发卡验收时才进入模式 B，显式关闭
`FEISHU_CARD_SEND_DRY_RUN`。
`--allow-dirty` 仅用于开发调试，不推荐录 Demo 使用。

`POST /dev/confirmations/:id/remind-later`
`POST /dev/confirmations/:id/convert-to-task`
`POST /dev/confirmations/:id/append-current-only`

这些接口是 card dry-run preview stub，用于保证卡片按钮在本地 demo 中不会 404。
它们只会校验 confirmation 是否存在，并返回 `ok: true`、`dry_run: true` 和当前
preview action 名称。当前阶段不会真实调用飞书，不会创建任务、日程或知识库，
也不会修改 `FEISHU_DRY_RUN`。

## 卡片类型

Action confirmation card 展示任务标题、推荐负责人、推荐原因、截止时间、优先级、
置信度、evidence、missing_fields 和来源 meeting_id。可编辑字段包括 title、
owner、due_date、priority、collaborators。

Calendar confirmation card 展示日程标题、开始时间、结束时间或时长、参与人、地点、
agenda、evidence、confidence 和 missing_fields。可编辑字段包括 title、start_time、
end_time、duration_minutes、participants、location、agenda。

Create KB confirmation card 展示 topic_name、suggested_goal、score、match_reasons、
candidate_meeting_ids、default_structure 和安全说明：用户确认前不会创建知识库。
可编辑字段包括 topic_name、suggested_goal、default_structure。

## 下一阶段

当前阶段只代表“确认卡片发送链路”接入了 dry-run wrapper，不代表真实飞书任务、
日程、Wiki 或 Doc 写入已经接入。真实写入仍必须继续走 confirmation request，
并在单独阶段逐项校准。

后续接入真实写入或真实卡片回调时，不得让任务、日程、知识库等高影响动作绕过
confirmation request。

Mode C 是隔离 canary/readiness，不是共享提交或默认演示模式。它可以用于验证
per-workflow 或 full real canary 的代码闭环，但必须使用专用 DB、专用接收人和已校准
CLI 权限逐项打开；即使进入 full real canary，也必须保证 CLI 失败不得伪造任务、
日程、Wiki 或 Doc 创建成功。
