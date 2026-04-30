# 飞书卡片回调接入计划

## 1. 为什么下一步是卡片回调

真实飞书确认卡片已经可以发送到测试群，但按钮点击还没有形成闭环。当前用户点击卡片按钮后，动作不会自动回到 MeetingAtlas，也不会自动触发本地 confirmation。

下一步应该先让飞书卡片按钮点击回到 MeetingAtlas 的 confirmation 流程，而不是马上真实创建任务、日程、Wiki 或 Doc。也就是说，目标是打通「真实卡片按钮 -> MeetingAtlas 回调 -> dry-run confirm / reject」。

## 2. 技术前提

飞书回调不能访问 `localhost`。本地开发服务需要一个可被飞书平台访问的公网 URL。

开发阶段推荐：

- `ngrok`
- `cloudflared tunnel`
- 临时部署到云服务器 / Vercel / Render / Railway 等

飞书应用后台需要配置 Card Action / Event callback URL，指向公开地址下的 MeetingAtlas 回调接口。

## 3. 后端目标接口

计划新增或完善：

```text
POST /webhooks/feishu/card
```

该接口接收飞书卡片按钮回调，并把真实按钮动作映射回 MeetingAtlas 的 confirmation request。

当前 skeleton 的边界：

- 支持飞书 challenge 返回。
- 解析到 `request_id` / `action_key` 时，才进入 dry-run confirmation 处理。
- 解析不到 `request_id` 或 `action_key` 时，返回 `accepted` 和 `normalized_preview`，不报错、不执行。
- 当前不做真实验签，验签是 Callback-3 的强制 TODO。

## 4. 回调 Payload 处理

需要从飞书卡片回调 payload 中提取：

- `request_id`
- `action_key`
- `edited fields`，如后续支持卡片编辑字段
- `operator` / `user_id`
- `message_id`
- `open_chat_id` / `chat_id`
- `token` / `signature` 信息

解析结果必须保留足够排查信息，但不能把 token、signature、secret 或其他敏感信息写入日志或报告。

当前开发友好 parser 先支持以下路径：

- `value.request_id`
- `value.action_key`
- `action.value.request_id`
- `action.value.action_key`
- `event.action.value.request_id`
- `event.action.value.action_key`

## 5. action_key 映射

预期映射：

| action_key            | 处理方式                                                   |
| --------------------- | ---------------------------------------------------------- |
| `confirm`             | `confirmationService.confirmRequest`                       |
| `confirm_with_edits`  | `confirmationService.confirmRequest` with `edited_payload` |
| `reject`              | `confirmationService.rejectRequest`                        |
| `not_mine`            | reject or route to organizer                               |
| `remind_later`        | preview stub                                               |
| `convert_to_task`     | preview stub                                               |
| `append_current_only` | preview stub                                               |
| `create_kb`           | `confirmationService.confirmRequest`                       |
| `edit_and_create`     | `confirmationService.confirmRequest` with `edited_payload` |
| `never_remind_topic`  | `confirmationService.rejectRequest` with reason            |

当前阶段即使调用 `confirmRequest`，也必须保持 `FEISHU_DRY_RUN=true`，只做 dry-run 执行。

## 6. 安全要求

- 必须验签。
- 当前 skeleton 暂不做真实验签；TODO: Callback-3 补齐验签后才能长期暴露公网回调。
- 必须幂等。
- 不能绕过 confirmation request。
- `request_id` 不存在时返回 404 / ignored。
- 已 `executed` 的 confirmation 再次点击必须返回 `already_processed`。
- 当前阶段即使点击 `confirm`，也仍然保持 `FEISHU_DRY_RUN=true`，只 dry-run 创建任务、日程、Wiki / Doc。
- 不得因为卡片按钮回调接入而直接打开真实任务、日程、Wiki 或 Doc 创建。
- 回调失败可以记录可排查错误，但不能记录凭证、token、signature 或 API key。

## 7. 分阶段实现建议

| Phase      | 目标                                                               |
| ---------- | ------------------------------------------------------------------ |
| Callback-0 | 只记录回调 payload，不执行。                                       |
| Callback-1 | 解析 `request_id` / `action_key`，调用 dev confirmation endpoint。 |
| Callback-2 | 支持 edited fields。                                               |
| Callback-3 | 验签和幂等完善。                                                   |
| Callback-4 | 再考虑真实任务 / 日程 / Wiki 写入。                                |

当前推荐先完成 Callback-0 到 Callback-1，并保持 `FEISHU_DRY_RUN=true`。真实写入必须在卡片回调闭环、验签、幂等、错误处理都稳定后再单独验收。
