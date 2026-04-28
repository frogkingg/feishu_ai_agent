# Development Plan

## Phase 0: 仓库重启和工程骨架

状态：完成。

- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `src/config.ts`
- `src/server.ts`
- `src/index.ts`
- `GET /health`
- README 初版
- `.env.example`

## Phase 1: Schema + SQLite 状态层

状态：完成。

- Zod 核心 schema。
- SQLite 建表。
- 基础 repositories。
- schema 和 repository 单元测试。

## Phase 2: LLM 抽象 + Mock Meeting Extraction

状态：完成。

- `LlmClient`
- `MockLlmClient`
- `meetingExtraction.md`
- `MeetingExtractionAgent`
- 第一场无人机 fixture。

## Phase 3: 会议处理 workflow

状态：完成。

- `POST /dev/meetings/manual`
- `processMeetingWorkflow`
- `PersonalActionAgent`
- `CalendarAgent`
- `GET /dev/confirmations`

## Phase 4: 飞书 CLI wrapper + dry-run 执行

状态：完成。

- `src/tools/larkCli.ts`
- `larkTask.ts`
- `larkCalendar.ts`
- `cli_runs` 写入。
- confirmation confirm / reject API。
- `GET /dev/state`

## Phase 5: 主题聚类 + 知识库建议

状态：完成。

- 简单 keyword/title/participant/summary overlap。
- 两场无人机会议后生成 `create_kb` confirmation。

## Phase 6: 知识库 dry-run 创建

状态：完成。

- `KnowledgeCuratorAgent`
- `createKnowledgeBaseWorkflow`
- Markdown 知识库内容。

## Phase 7: 飞书真实集成预留

- CLI inspect。
- fallback mock。
- webhook 入口。
