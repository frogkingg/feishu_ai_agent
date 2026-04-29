# Card Dry-run Design

本文档说明 MeetingAtlas 当前阶段的飞书卡片确认层设计。

## 定位

卡片确认层是所有高影响动作的安全确认层。凡是可能创建任务、创建日程、
创建知识库或改变后续协作状态的动作，都必须先生成 confirmation request 和
card preview，用户确认后才进入执行流程。

当前实现只生成 dry-run card JSON，不真实发送飞书卡片，不调用真实飞书写入能力，
也不会把 `FEISHU_DRY_RUN` 改为 `false`。

真实飞书卡片发送将在下一阶段接入，计划通过 `larkIm/sendCard` 完成。

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

下一阶段会把当前 dry-run card JSON 映射到真实飞书卡片 DSL，并通过
`larkIm/sendCard` 发送到飞书会话。真实发送接入后仍需保留当前 dry-run API，
用于本地 demo、自动化测试和安全回归。

真实卡片接入前不得让任务、日程、知识库等高影响动作绕过 confirmation request。
