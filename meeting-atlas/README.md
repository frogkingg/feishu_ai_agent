# MeetingAtlas / 会脉 Agent

MeetingAtlas / 会脉 Agent 是一个基于飞书会议纪要触发的个人执行闭环与主题知识库 Agent。

它从会议纪要 / 妙记 / 转写文本开始，后续会生成个人待办草案、日程草案和主题知识库建议；所有创建任务、创建日程、创建知识库、归档资料等高影响动作都必须先生成确认请求。

## 为什么重启

仓库中的旧代码是 ProjectPilot / 飞书项目管理专家方向的实验，偏项目管理 Bot。MeetingAtlas 的新方向是会议纪要触发的个人执行和主题知识沉淀，所以本工程不基于旧架构继续开发。

当前新工程位于 `meeting-atlas/`，旧代码保持在仓库原位但不引用。后续如需清理，可单独移动到 `_legacy_ignored/`。

## 当前阶段

已完成 Phase 0 到 Phase 6。

已完成：

- Node.js / TypeScript / Fastify 工程骨架。
- `GET /health`。
- 环境变量配置。
- Zod 核心 schema。
- SQLite 建表和基础 repositories。
- Mock LLM 抽取。
- `MeetingExtractionAgent`。
- `PersonalActionAgent`。
- `CalendarAgent`。
- `ConfirmationService`。
- `processMeetingWorkflow`。
- `POST /dev/meetings/manual`。
- `GET /dev/confirmations`。
- `POST /dev/confirmations/:id/confirm`。
- `POST /dev/confirmations/:id/reject`。
- `GET /dev/state`。
- 飞书 CLI wrapper dry-run 记录。
- action/calendar confirmation dry-run 执行。
- `TopicClusteringAgent` 简单可解释主题聚类。
- 两场无人机会议后生成 `create_kb` confirmation。
- `KnowledgeCuratorAgent` dry-run 生成知识库 Markdown。
- `createKnowledgeBaseWorkflow` 写入 `knowledge_bases` 和 `knowledge_updates`。
- schema、repository、agent、workflow、API 测试。

未实现：

- 真实飞书任务 / 日程创建。
- 真实飞书卡片。
- 真实飞书知识库 / 文档创建。

这些会在后续 Phase 7 逐步校准。

## 安装

```bash
cd /Users/henryxian/Documents/飞书比赛/meeting-atlas
npm install
```

## 环境变量

见 `.env.example`：

```bash
NODE_ENV=development
PORT=3000
FEISHU_DRY_RUN=true
LARK_CLI_BIN=lark
LLM_PROVIDER=mock
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
SQLITE_PATH=./data/meeting-atlas.db
```

`FEISHU_DRY_RUN=true` 是默认安全模式。确认 action/calendar 后会写入 `cli_runs` 并返回虚拟飞书链接，不会真实调用飞书写操作。

## 本地运行

```bash
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

返回示例：

```json
{
  "ok": true,
  "service": "meeting-atlas",
  "phase": "phase-6",
  "dry_run": true,
  "sqlite_path": "/absolute/path/data/meeting-atlas.db"
}
```

提交无人机会议 fixture：

```bash
TRANSCRIPT=$(python - <<'PY'
from pathlib import Path
import json
print(json.dumps(Path('fixtures/meetings/drone_interview_01.txt').read_text()))
PY
)

curl -X POST http://127.0.0.1:3000/dev/meetings/manual \
  -H 'Content-Type: application/json' \
  -d "{
    \"title\":\"无人机操作方案初步访谈\",
    \"participants\":[\"张三\",\"李四\"],
    \"organizer\":\"张三\",
    \"started_at\":\"2026-04-28T10:00:00+08:00\",
    \"ended_at\":\"2026-04-28T11:00:00+08:00\",
    \"transcript_text\":$TRANSCRIPT
  }"
```

查看确认请求：

```bash
curl http://127.0.0.1:3000/dev/confirmations
```

确认请求：

```bash
curl -X POST http://127.0.0.1:3000/dev/confirmations/<id>/confirm \
  -H 'Content-Type: application/json' \
  -d '{}'
```

拒绝请求：

```bash
curl -X POST http://127.0.0.1:3000/dev/confirmations/<id>/reject \
  -H 'Content-Type: application/json' \
  -d '{"reason":"不是我的"}'
```

查看当前状态和 `cli_runs`：

```bash
curl http://127.0.0.1:3000/dev/state
```

提交第二场无人机会议后会生成知识库创建建议：

```bash
TRANSCRIPT=$(python - <<'PY'
from pathlib import Path
import json
print(json.dumps(Path('fixtures/meetings/drone_interview_02.txt').read_text()))
PY
)

curl -X POST http://127.0.0.1:3000/dev/meetings/manual \
  -H 'Content-Type: application/json' \
  -d "{
    \"title\":\"无人机操作员访谈\",
    \"participants\":[\"张三\",\"王五\"],
    \"organizer\":\"张三\",
    \"started_at\":\"2026-04-29T10:00:00+08:00\",
    \"ended_at\":\"2026-04-29T11:00:00+08:00\",
    \"transcript_text\":$TRANSCRIPT
  }"
```

确认 `create_kb` 请求后，`GET /dev/state` 可看到 `knowledge_bases`、`knowledge_updates` 和生成的 Markdown 内容。

## 运行测试

```bash
npm run test
```

当前测试覆盖：

- `ActionItemDraft` schema。
- `CalendarEventDraft` schema。
- `MeetingExtractionResult` schema。
- `TopicMatchResult` 阈值规则。
- `ConfirmationRequest` schema。
- SQLite 初始化和基础 repository 写入。
- `GET /health`。
- `MockLlmClient` fixture 输出。
- `MeetingExtractionAgent` schema 校验。
- `processMeetingWorkflow` 集成。
- `POST /dev/meetings/manual` 生成 action/calendar confirmation。
- dry-run 不真实调用 lark。
- confirm action 写入 `cli_runs`。
- confirm calendar 写入 `cli_runs`。
- reject 更新状态且不执行 CLI。
- 两场无人机会议后生成 `create_kb` confirmation。
- 确认 `create_kb` 后写入知识库记录和 Markdown 更新。

## 如何接入飞书 CLI

当前已实现 `src/tools/larkCli.ts`，但真实业务命令仍需按本机 CLI 校准。见 `docs/FEISHU_CLI_NOTES.md`。

当前规则：

- 使用 `child_process.execFile`。
- `args` 必须是 `string[]`。
- 所有 CLI 调用记录到 `cli_runs`。
- dry-run 下不执行真实写操作。
- token / secret / authorization 日志脱敏。
- `FEISHU_DRY_RUN=false` 后才允许进入真实执行路径。

## 当前不做什么

- 不做全量群聊监听。
- 不做全量邮箱扫描。
- 不做无确认创建任务、日程或知识库。
- 不做删除任务、日程、文档或知识库。
- 不接入真实 LLM。
- 不调用真实飞书写操作。
- 不实现复杂多 Agent Runtime。
- 不真实创建飞书知识库或文档。
