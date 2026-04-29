# MeetingAtlas P0 Demo Report

本文档是 P0 Demo 的阶段成果说明。

最新一次实际运行结果由 `npm run demo:full-p0` 写入
`demo-output/p0-demo-report.md`。

## Demo 目标

MeetingAtlas P0 Demo 验证一条完整的会议后执行闭环：

- 从会议转写中抽取 action items 和 calendar drafts。
- 通过 confirmation request 让用户确认或修正。
- 为每个 confirmation 生成 dry-run card JSON，作为高影响动作的安全确认层。
- 在 dry-run 模式下记录 Feishu CLI 执行结果。
- 识别两场高度相关会议，生成 `create_kb` confirmation。
- 用户确认后生成 mock 知识库和 `kb_created` 更新记录。

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

用户确认时的 edited payload：

- action:
  将 title 改为 `确认无人机试飞场地权限并输出审批说明`，owner 改为 `王五`，
  due_date 改为 `2026-05-02`，priority 改为 `P0`
- calendar:
  将 participants 改为 `张三`, `李四`, `王五`，
  duration_minutes 改为 `60`，location 改为 `线上会议`

## Demo 流程

| Step | 操作 | 预期输出 |
| --- | --- | --- |
| 1 | 启动服务并访问 `GET /health` | 服务可达，`dry_run=true`，返回当前 LLM provider |
| 2 | 提交第一场会议 | 至少生成 2 条 action items 和 1 条 calendar draft |
| 3 | 校验第一场主题判断 | `suggested_action=observe`，不生成 `create_kb` |
| 4 | 查询 `/dev/confirmations` | 返回待确认的 action/calendar 请求 |
| 5 | 查询 `/dev/cards` | 第一场后至少有 2 张 action card 和 1 张 calendar card |
| 6 | 确认第一条 action | action 进入确认执行状态，并写入 dry-run CLI 记录 |
| 7 | 用 edited payload 确认第二条 action | 数据库最终字段使用用户确认值 |
| 8 | 用 edited payload 确认 calendar | participants/location/duration 使用用户确认值 |
| 9 | 提交第二场会议 | 第二场会议成功处理并返回 topic match |
| 10 | 校验第二场主题判断 | `score >= 0.9`，`suggested_action=ask_create`，候选会议至少包含两场 |
| 11 | 查询 `create_kb` confirmation | `/dev/confirmations` 能看到 `request_type=create_kb` |
| 12 | 查询 `/dev/cards` | 第二场后能看到 1 张 create_kb card |
| 13 | 确认 `create_kb` | 生成 mock 知识库记录 |
| 14 | 查询 `/dev/state` | 有 knowledge base，最新 update 为 `kb_created` |

## 成功标准

完整 P0 Demo 通过时应满足：

- Meetings processed: `2`
- Action confirmations executed: `2`
- Calendar confirmations executed: `1`
- Knowledge base confirmations executed: `1`
- Card previews generated: `4`
- Action cards: `2`
- Calendar cards: `1`
- Knowledge base cards: `1`
- Latest knowledge base name 包含 `无人机操作方案`
- `wiki_url` 以 `mock://` 开头
- `homepage_url` 以 `mock://` 开头
- Latest knowledge update: `kb_created`
- Feishu Write Mode: `dry-run`

终端应输出类似：

```text
✅ MeetingAtlas P0 Demo passed

LLM Provider: openai-compatible
Feishu Write Mode: dry-run
Meetings processed: 2
Action confirmations executed: 2
Calendar confirmations executed: 1
Knowledge base confirmations executed: 1
Card previews generated: 4
Action cards: 2
Calendar cards: 1
Knowledge base cards: 1
Knowledge base name: 无人机操作方案
Knowledge base URL: mock://...
Knowledge update: kb_created
```

## Dry-run 与真实飞书模式差异

| 项目 | 当前 P0 dry-run | 真实飞书模式 |
| --- | --- | --- |
| 任务/日程创建 | 只写入本地 dry-run CLI 记录 | 需要真实调用飞书任务和日历能力 |
| 知识库创建 | 创建本地 mock 记录，URL 为 `mock://...` | 需要真实创建 Wiki/Doc |
| 卡片消息 | 生成 dry-run card JSON；可 dry-run 记录 send-card CLI 计划 | `FEISHU_DRY_RUN=false` 后通过 `larkIm.sendCard` 真实发送确认卡片 |
| 安全策略 | `demo:full-p0` 检测到 `dry_run=false` 会停止 | 真实模式需单独脚本和人工确认 |
| 报告内容 | 不包含 API Key，不包含 `.env` 内容 | 真实模式报告也必须继续脱敏 |

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
action、calendar、create_kb confirmation 都会生成 card preview，并写入
`original_payload_json.card_preview`，同时可通过 `/dev/cards` 读取未完成
confirmation 的卡片队列。

这些 card preview 可以通过 `POST /dev/confirmations/:id/send-card` 或
`POST /dev/cards/send-all` 进入 `larkIm.sendCard`。在 `FEISHU_DRY_RUN=true`
下只会记录 `lark.im.send_card` 的 `cli_runs`，不会真实发送到飞书。
这只表示确认卡片发送链路进入工具层，不代表真实飞书任务、日程、Wiki 或 Doc 写入已经接入。

`remind_later`、`convert_to_task`、`append_current_only` 目前只接入 card dry-run
preview stub，用于保证 demo 卡片按钮不会 404。stub 不会创建任务、日程或知识库。
