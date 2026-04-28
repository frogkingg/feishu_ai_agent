# MeetingAtlas / 会脉 Agent

MeetingAtlas / 会脉 Agent 是一个由飞书会议纪要触发的个人执行闭环与主题知识库 Agent。

会议结束后，它读取会议纪要、妙记或转写文本，抽取个人待办、后续日程、关键结论、风险、资料引用和主题关键词；所有任务、日程、知识库、资料归档等副作用都必须先生成确认请求，用户确认后才执行。默认 dry-run，不真实写飞书。

## 当前状态

仓库已从旧 ProjectPilot 实验重启为 MeetingAtlas。根目录就是新的主项目，不再保留旧 ProjectPilot 运行时代码、旧 Skill 草稿、旧源材料文档和重复工程目录。

当前已完成到 Phase 6：

- Fastify + TypeScript 服务骨架。
- SQLite 状态层和核心 repository。
- Zod schema 校验。
- Mock LLM 会议抽取。
- 手动提交会议转写的本地 Demo API。
- Action item 与 calendar draft 生成。
- Confirmation request 确认流程。
- 飞书 CLI wrapper dry-run 记录。
- 两场相关无人机会议后的主题聚类建议。
- 确认 `create_kb` 后 dry-run 生成主题知识库 Markdown。

## 快速开始

```bash
npm install
npm run build
npm run test
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

## 环境变量

复制 `.env.example` 后按需修改：

```bash
cp .env.example .env
```

关键默认值：

```bash
NODE_ENV=development
PORT=3000
FEISHU_DRY_RUN=true
LARK_CLI_BIN=lark
LLM_PROVIDER=mock
SQLITE_PATH=./data/meeting-atlas.db
```

`FEISHU_DRY_RUN=true` 是默认安全模式。确认 action/calendar/create_kb 后只写本地记录和 dry-run 输出，不真实调用飞书写操作。

## 本地 Demo

提交第一场无人机会议：

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

提交第二场无人机会议后，会生成“无人机操作方案”知识库创建建议：

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

查看状态和知识库 Markdown：

```bash
curl http://127.0.0.1:3000/dev/state
```

完整演示路径见 [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)。

## 目录结构

```text
.
├── docs/          # 架构、开发计划、Demo 和飞书 CLI 说明
├── fixtures/      # 本地 Demo 会议转写与 Mock LLM 期望输出
├── src/           # MeetingAtlas 服务、Agent、workflow、schema、tools
├── tests/         # Vitest 单元和集成测试
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## 当前不做

- 不做全量群聊监听。
- 不做全量邮箱扫描。
- 不做无确认自动创建任务、日程或知识库。
- 不做删除飞书任务、日程、文档或知识库。
- 不把长会议全文、完整知识库、完整表格或完整群聊历史直接塞进模型上下文。
- 不接入复杂 Agent Runtime。
- 不真实调用飞书写操作，除非显式设置 `FEISHU_DRY_RUN=false` 并校准 CLI。

## 下一步

Phase 7：校准真实飞书 CLI 命令，补齐 `larkWiki` / `larkDoc` / `sendCard` 的真实模式 fallback，并把 dry-run 知识库创建平滑迁移到飞书 Wiki / Doc。
