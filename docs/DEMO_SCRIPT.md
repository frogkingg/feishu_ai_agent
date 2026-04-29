# MeetingAtlas Demo Script

本文档说明 `npm run demo:full-p0` 的自动化验收流程。

脚本默认验证 P0 Demo 主链路，不会接真实飞书写入，也不会真实发送飞书卡片。
也可以切到卡片阶段模式：只生成确认卡片，或在 dry-run 下记录确认卡片发送计划。
`full-p0`、`cards-only` 和 `send-cards` 启动时都会先读取 `/dev/state`，
默认要求使用干净 SQLite DB。

## Demo 目标

演示 MeetingAtlas 从两场会议转写中自动抽取待办和日程，经过用户确认后进入
Feishu dry-run 执行记录，并在第二场高度相关会议后建议创建知识库。

核心验证点：

- 真实或 mock LLM 均能完成会议抽取链路。
- action/calendar confirmation 可以被自动确认。
- 每条 confirmation 都会生成飞书卡片 dry-run JSON，包含展示区、可编辑字段和动作按钮；action card 额外包含 `confirm_with_edits`、`not_mine`、`remind_later`，calendar card 额外包含 `confirm_with_edits`、`convert_to_task`、`remind_later`，create_kb card 使用 `create_kb`、`edit_and_create`、`append_current_only`、`never_remind_topic`。
- 卡片 preview 是所有高影响动作的安全确认层：任务、日程和知识库创建都必须先生成卡片 JSON，用户确认前不执行副作用。
- `--send-cards` 模式会调用 `/dev/cards/send-all`，在 dry-run 下只记录 `lark.im.send_card` 的 `cli_runs`。
- 启动时先检查 `/dev/state`：`meetings`、`action_items`、`calendar_drafts`、`knowledge_bases`、`confirmation_requests` 必须全部为空。
- edited payload 会进入最终状态。
- 两场无人机相关会议会触发 `create_kb` confirmation。
- 确认 `create_kb` 后会生成 mock 知识库和 `kb_created` 更新记录。

## 如何运行

启动服务：

```bash
PORT=3000 SQLITE_PATH=/tmp/meeting-atlas-demo-$(date +%s).db FEISHU_DRY_RUN=true FEISHU_CARD_SEND_DRY_RUN=true LLM_PROVIDER=mock npm run dev
```

在另一个终端运行完整 P0 Demo：

```bash
npm run demo:full-p0
```

默认服务地址是 `http://127.0.0.1:3000`。如果服务运行在其他地址：

```bash
MEETING_ATLAS_BASE_URL=http://127.0.0.1:3000 npm run demo:full-p0
```

只生成 confirmation cards，不自动确认、不写任务/日程/知识库：

```bash
npm run demo:full-p0 -- --cards-only
```

生成 cards 后执行 dry-run send-card，支持指定群聊或接收人：

```bash
npm run demo:full-p0 -- --send-cards --chat-id oc_xxx
npm run demo:full-p0 -- --send-cards --recipient ou_xxx
```

完整 P0 和 send-cards 是互补验收，不是互相替代：

- `full-p0` 用来证明 action、calendar、create_kb confirmation 的完整执行闭环。
- `send-cards` 用来证明确认卡片可以进入 `larkIm.sendCard` dry-run wrapper；它只验证卡片发送 dry-run，不执行 confirmations。
- `cards-only` 只证明卡片 preview 生成，不执行确认也不发送卡片。

默认情况下，`full-p0`、`cards-only` 和 `send-cards` 都拒绝复用 dirty DB。
如果刚跑过 `full-p0`，同一个 `SQLITE_PATH` 已经有 2 场会议、confirmation 和
knowledge base；继续跑 `--send-cards` 会被脚本拒绝。换新的 `SQLITE_PATH`
再启动服务即可。

开发调试时可以显式绕过干净库检查，但不推荐录 Demo 使用：

```bash
npm run demo:full-p0 -- --allow-dirty
```

## 测试输入

第一场会议：

- title: `无人机操作方案真实 LLM 测试`
- participants: `张三`, `李四`, `Henry`
- transcript highlights: 无人机操作流程、试飞权限、操作员访谈、无人机安全规范
- 预期主题动作：`observe`

第二场会议：

- title: `无人机操作员访谈`
- participants: `张三`, `王五`, `Henry`
- transcript highlights:
  继续讨论无人机操作方案、操作流程不统一、试飞前权限确认分散、
  建立统一无人机操作 SOP、整理风险清单
- 显式知识库意图：`后续要把这两次访谈整理成一个无人机操作方案知识库`
- 预期主题动作：`ask_create`

脚本会自动确认第一条 action，并用 edited payload 确认第二条 action：

```json
{
  "title": "确认无人机试飞场地权限并输出审批说明",
  "owner": "王五",
  "due_date": "2026-05-02",
  "priority": "P0"
}
```

脚本会用 edited payload 确认 calendar：

```json
{
  "participants": ["张三", "李四", "王五"],
  "duration_minutes": 60,
  "location": "线上会议"
}
```

## Demo 流程

| Step | 调用                                       | 预期输出                                                                     |
| ---- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| 1    | `GET /health`                              | `ok=true`，`dry_run=true`，`card_send_dry_run=true`，返回当前 `llm_provider` |
| 2    | `GET /dev/state`                           | 演示关键表均为空；dirty DB 直接失败，不 POST 第一场会议                      |
| 3    | `POST /dev/meetings/manual` 提交第一场会议 | 返回 `meeting_id`，至少 2 条 action 和 1 条 calendar                         |
| 4    | 校验第一场 topic match                     | `topic_match.suggested_action = observe`，不创建 `create_kb`                 |
| 5    | `GET /dev/confirmations`                   | 能看到第一场 action/calendar confirmation，且每条都附带 `dry_run_card`       |
| 5.1  | `GET /dev/cards`                           | 第一场后至少返回 2 张 action card 和 1 张 calendar card                      |
| 6    | 确认第一条 action                          | action executed，并产生 dry-run CLI 记录                                     |
| 7    | 使用 edited payload 确认第二条 action      | 最终 action owner/due_date/priority/title 使用用户确认值                     |
| 8    | 使用 edited payload 确认 calendar          | calendar participants/location/duration 使用用户确认值                       |
| 9    | `POST /dev/meetings/manual` 提交第二场会议 | 返回第二个 `meeting_id`                                                      |
| 10   | 校验第二场 topic match                     | `score >= 0.9`，`suggested_action = ask_create`                              |
| 11   | `GET /dev/confirmations`                   | 能看到 `request_type=create_kb` 的 confirmation                              |
| 11.1 | `GET /dev/cards`                           | 第二场后能看到 1 张 create_kb card                                           |
| 12   | 确认 `create_kb`                           | 创建 mock 知识库记录                                                         |
| 13   | `GET /dev/state`                           | 有 knowledge base，最新 update 为 `kb_created`                               |

`--cards-only` 会跑到第二场卡片生成后停止，不调用 confirm/reject。
`--send-cards` 会在此基础上调用 `POST /dev/cards/send-all`，默认只验证 send-card dry-run CLI 记录。
因此 `--send-cards` 的 confirmations executed 为 `0` 是预期结果，它只发送确认卡片，
不执行确认动作。

## 卡片 Dry-run 说明

当前卡片预览通过 `GET /dev/cards` 和 `GET /dev/confirmations/:id/card` 返回。
`POST /dev/confirmations/:id/send-card` 和 `POST /dev/cards/send-all` 会把 card preview
映射为飞书 interactive card payload，并进入 `larkIm.sendCard`。

在 `FEISHU_CARD_SEND_DRY_RUN=true` 下，send-card 不执行真实 CLI，只写 `cli_runs`：

```json
{
  "tool": "lark.im.send_card",
  "dry_run": 1,
  "status": "planned"
}
```

这只代表“确认卡片发送计划”已经进入工具层，不代表真实飞书任务、日程、Wiki 或 Doc
写入已经接入。

卡片里的 `remind_later`、`convert_to_task`、`append_current_only` 按钮在当前阶段
只接到 dry-run preview stub。stub 只返回本地预览结果，避免 demo 卡片按钮 404；
不会真实创建任务、日程、知识库。

真实发送模式需要显式设置 `FEISHU_CARD_SEND_DRY_RUN=false`，并保证 `LARK_CLI_BIN`
可用、命令形状已校准、返回 `message_id`。否则接口会失败，不会伪造成功。

## 成功标准

脚本成功时终端会输出：

```text
✅ MeetingAtlas P0 Demo passed

Mode: full-p0
LLM Provider: openai-compatible
Feishu Write Mode: dry-run
Mode note: FEISHU_DRY_RUN=true; this demo did not perform real Feishu writes.
Meetings processed: 2
Action confirmations executed: 2
Calendar confirmations executed: 1
Knowledge base confirmations executed: 1
Card previews generated: 4
Action cards: 2
Calendar cards: 1
Knowledge base cards: 1
Card send CLI records: 0
Knowledge base name: 无人机操作方案
Knowledge base URL: mock://...
Knowledge update: kb_created
```

关键断言失败时脚本会输出清晰错误原因，并以 `process.exit(1)` 退出。
如果服务复用了 dirty DB，脚本会在第一场会议 POST 前失败，并打印当前
`meetings`、`action_items`、`calendar_drafts`、`knowledge_bases`、
`confirmation_requests` 数量和新的 `SQLITE_PATH` 启动命令。

成功运行后会生成：

- `full-p0`: `demo-output/p0-demo-latest.json` 和 `demo-output/p0-demo-report.md`。
- `cards-only`: `demo-output/cards-only-demo-latest.json` 和 `demo-output/cards-only-demo-report.md`。
- `send-cards`: `demo-output/send-cards-demo-latest.json` 和 `demo-output/send-cards-demo-report.md`。

`demo-output/*.json` 已加入 `.gitignore`，不作为报告资产提交。
Markdown 报告可以提交：`p0-demo-report.md` 代表完整 P0 主链路，
`send-cards-demo-report.md` 代表卡片发送 dry-run 链路。

报告不会写入 API Key，也不会写入 `.env` 内容。

## Dry-run 与真实飞书模式差异

| 项目       | Dry-run Demo                                          | 真实飞书模式                                                         |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| 飞书写入   | 不写真实任务/日程/Wiki/Doc，只记录 dry-run CLI run    | 未来才写任务、日程、知识库                                           |
| 卡片确认层 | 生成 dry-run card JSON；可选择 dry-run send-card 记录 | `FEISHU_CARD_SEND_DRY_RUN=false` 后通过 `larkIm.sendCard` 真实发卡片 |
| URL        | 知识库 URL 为 `mock://...`                            | 应返回真实飞书 Wiki/Doc URL                                          |
| 安全边界   | 要求 `FEISHU_DRY_RUN=true`                            | 真实写入需要单独验收和权限确认                                       |
| LLM        | 可以使用 `mock` 或 `openai-compatible`                | 推荐继续保持 LLM 与飞书写入开关解耦                                  |
| Demo 报告  | 记录流程结果，不含密钥或 `.env`                       | 真实模式报告同样不应包含密钥                                         |

当前 P0 Demo 的目标是证明确认链路、状态一致性、主题聚类和知识库建议闭环已经跑通。

真实飞书任务、日程、Wiki/Doc 创建不在本脚本范围内。真实卡片发送也只有在显式关闭
`FEISHU_CARD_SEND_DRY_RUN` 且 CLI 已校准时才会发生。
