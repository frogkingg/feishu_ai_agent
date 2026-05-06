# MeetingAtlas P0 Demo Report

本文档是 P0 Demo 的阶段成果说明。

最新一次实际运行结果由 `npm run demo:full-p0` 写入
`demo-output/p0-demo-report.md`。

## 录屏前验收口径

当前 RC commit：`6b9fb08`。

- 真实 LLM dry-run canary 已通过，且所有 Feishu dry-run 开关保持为 `true`。
- 真实 Feishu task / calendar / Wiki / Doc canary 已通过，用于证明隔离真实写入链路。
- 服务器公网 `/health` 已通过。
- 录屏默认仍按 dry-run / confirmation-first 口径演示，不真实写飞书。
- 飞书妙记事件回调公网验收已通过：签名 `vc.meeting.recording_ready_v1` 合成事件被接收，重复事件幂等，后台状态为 `processed`。
- 卡片按钮公网链路是独立验收项；录屏如不演示点击回调，不要把它和妙记事件回调混成一个证明点。

`demo-output/p0-demo-report.md` 只保留完整 P0 主链路结果。send-cards dry-run
链路会写入 `demo-output/send-cards-demo-report.md`，用于证明确认卡片发送计划能进入
`lark.im.send_card` 工具层。两份报告互补：前者证明完整执行闭环，后者证明卡片发送
dry-run 链路，不互相替代。

## Demo 目标

MeetingAtlas P0 Demo 验证一条完整的会议后执行闭环：

- 从会议转写中抽取 action items 和 calendar drafts。
- 通过 confirmation request 让用户确认或修正。
- 为每个 confirmation 生成 dry-run card JSON，作为高影响动作的安全确认层。
- 在 dry-run 模式下记录 Feishu CLI 执行结果。
- 识别两场高度相关会议，生成 `create_kb` confirmation。
- 用户确认后生成 mock 知识库和 `kb_created` 更新记录。
- 第三场会议命中已有知识库，生成 `append_meeting` confirmation。
- 用户确认后生成 `meeting_added` 更新记录，把新会议追加到 mock 知识库。

本阶段不验证真实飞书任务、日程、Wiki/Doc 创建或 LLM prompt 改动。
当前卡片可以进入 `larkIm.sendCard` dry-run wrapper，但 `FEISHU_DRY_RUN=true`
时只记录发送计划，不真实发送飞书卡片。

## 测试输入

第一场会议用于建立主题观察队列：

- title: `无人机操作方案真实 LLM 测试`
- 主题关键词：无人机、操作流程、试飞权限、操作员访谈
- 预期结果：生成 action/calendar confirmations，topic match 保持 `observe`

第二场会议用于触发知识库建议：

- title: `无人机操作员访谈`
- 主题内容：
  继续讨论无人机操作方案、操作流程不统一、试飞权限确认分散、
  统一无人机操作 SOP、风险控制清单
- 显式意图：`把这两次访谈整理成一个无人机操作方案知识库`
- 预期结果：`topic_match.score >= 0.9`，`suggested_action = ask_create`

第三场会议用于触发追加到已有知识库：

- title: `无人机实施风险评审`
- 主题内容：
  继续围绕无人机操作方案评审风险，补充试飞权限、现场安全员、电池状态、
  天气等风险控制信息
- 显式意图：`加入已有知识库，不要再新建一个`
- 预期结果：`suggested_action = ask_append`，生成 1 条 `append_meeting`
  confirmation 和 1 张 append meeting card

用户确认时的 edited payload：

- action:
  将 title 改为 `确认无人机试飞场地权限并输出审批说明`，owner 改为 `王五`，
  due_date 改为 `2026-05-02`，priority 改为 `P0`
- calendar:
  将 participants 改为 `张三`, `李四`, `王五`，
  duration_minutes 改为 `60`，location 改为 `线上会议`

## Demo 流程

| Step | 操作                                | 预期输出                                                              |
| ---- | ----------------------------------- | --------------------------------------------------------------------- |
| 1    | 启动服务并访问 `GET /health`        | 服务可达，`dry_run=true`，返回当前 LLM provider                       |
| 2    | 提交第一场会议                      | 至少生成 2 条 action items 和 1 条 calendar draft                     |
| 3    | 校验第一场主题判断                  | `suggested_action=observe`，不生成 `create_kb`                        |
| 4    | 查询 `/dev/confirmations`           | 返回待确认的 action/calendar 请求                                     |
| 5    | 查询 `/dev/cards`                   | 第一场后至少有 2 张 action card 和 1 张 calendar card                 |
| 6    | 确认第一条 action                   | action 进入确认执行状态，并写入 dry-run CLI 记录                      |
| 7    | 用 edited payload 确认第二条 action | 数据库最终字段使用用户确认值                                          |
| 8    | 用 edited payload 确认 calendar     | participants/location/duration 使用用户确认值                         |
| 9    | 提交第二场会议                      | 第二场会议成功处理并返回 topic match                                  |
| 10   | 校验第二场主题判断                  | `score >= 0.9`，`suggested_action=ask_create`，候选会议至少包含两场   |
| 11   | 查询 `create_kb` confirmation       | `/dev/confirmations` 能看到 `request_type=create_kb`                  |
| 12   | 查询 `/dev/cards`                   | 第二场后能看到 1 张 create_kb card                                    |
| 13   | 确认第二场 action 和 `create_kb`    | 第二场 action 写入 dry-run CLI 记录，并生成 mock 知识库记录           |
| 14   | 提交第三场会议                      | 第三场会议成功处理并命中已有知识库                                    |
| 15   | 校验第三场主题判断                  | `suggested_action=ask_append`，`matched_kb_id` 指向已有 mock 知识库   |
| 16   | 查询第三场 confirmations            | 能看到 action、calendar、`append_meeting` 三类 confirmation           |
| 17   | 查询 `/dev/cards`                   | 第三场 action、calendar、append meeting card 都可见                   |
| 18   | 确认第三场 action/calendar/append   | action/calendar 写入 dry-run CLI 记录，append 生成 `meeting_added`    |
| 19   | 查询 `/dev/state`                   | 无未处理 confirmation；updates 依次包含 `kb_created`、`meeting_added` |

## 成功标准

完整 P0 Demo 通过时应满足：

- Meetings processed: `3`
- Action confirmations executed: `4`
- Calendar confirmations executed: `2`
- Knowledge base confirmations executed: `1`
- Append meeting confirmations executed: `1`
- Card previews generated: `8`
- Action cards: `4`
- Calendar cards: `2`
- Knowledge base cards: `1`
- Append meeting cards: `1`
- Pending confirmations: `0`
- Latest knowledge base name 包含 `无人机操作方案`
- `wiki_url` 以 `mock://` 开头
- `homepage_url` 以 `mock://` 开头
- Knowledge updates: `kb_created -> meeting_added`
- Latest knowledge update: `meeting_added`
- Feishu Write Mode: `dry-run`

终端应输出类似：

```text
✅ MeetingAtlas P0 Demo passed

LLM Provider: openai-compatible
Feishu Write Mode: dry-run
Mode note: FEISHU_DRY_RUN=true; this demo did not perform real Feishu writes.
Meetings processed: 3
Action confirmations executed: 4
Calendar confirmations executed: 2
Knowledge base confirmations executed: 1
Append meeting confirmations executed: 1
Card previews generated: 8
Action cards: 4
Calendar cards: 2
Knowledge base cards: 1
Append meeting cards: 1
Pending confirmations: 0
Knowledge base name: 无人机操作方案
Knowledge base URL: mock://...
Knowledge update: meeting_added
```

## Dry-run 与真实飞书模式差异

| 项目          | 当前 P0 dry-run                                            | 真实飞书模式                                                     |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| 任务/日程创建 | 只写入本地 dry-run CLI 记录                                | 需要真实调用飞书任务和日历能力                                   |
| 知识库创建    | 创建本地 mock 记录，URL 为 `mock://...`                    | 需要真实创建 Wiki/Doc                                            |
| 卡片消息      | 生成 dry-run card JSON；可 dry-run 记录 send-card CLI 计划 | `FEISHU_DRY_RUN=false` 后通过 `larkIm.sendCard` 真实发送确认卡片 |
| 安全策略      | `demo:full-p0` 检测到 `dry_run=false` 会停止               | 真实模式需单独脚本和人工确认                                     |
| 报告内容      | 不包含 API Key，不包含 `.env` 内容                         | 真实模式报告也必须继续脱敏                                       |

## 如何运行

启动服务：

```bash
npm run dev
```

运行完整 Demo：

```bash
npm run demo:full-p0
```

如果服务不在默认地址：

```bash
MEETING_ATLAS_BASE_URL=http://127.0.0.1:3000 npm run demo:full-p0
```

推荐演示前使用独立 SQLite 文件，避免历史数据影响候选会议和 confirmation 数量：

```bash
PORT=3000 SQLITE_PATH=/tmp/meeting-atlas-demo.db FEISHU_DRY_RUN=true npm run dev
```

## 卡片确认层

卡片确认层是 MeetingAtlas 对所有高影响动作的统一安全边界。当前 P0 中，
action、calendar、create_kb、append_meeting confirmation 都会生成 card preview，并写入
`original_payload_json.card_preview`，同时可通过 `/dev/cards` 读取未完成
confirmation 的卡片队列。

这些 card preview 可以通过 `POST /dev/confirmations/:id/send-card` 或
`POST /dev/cards/send-all` 进入 `larkIm.sendCard`。在 `FEISHU_DRY_RUN=true`
下只会记录 `lark.im.send_card` 的 `cli_runs`，不会真实发送到飞书。
这只表示确认卡片发送链路进入工具层，不代表真实飞书任务、日程、Wiki 或 Doc 写入已经接入。

`remind_later`、`convert_to_task`、`append_current_only` 目前只接入 card dry-run
preview stub，用于保证 demo 卡片按钮不会 404。stub 不会创建任务、日程或知识库。

cards-only 与 send-cards 模式仍只覆盖前两场会议：它们用于验证卡片生成/发送计划，
不执行 confirmations，也不会创建或追加知识库。
