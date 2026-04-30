# Real LLM Setup

MeetingAtlas 先接真实 LLM，但继续保持 `FEISHU_DRY_RUN=true`。

这样可以先验证会议转写抽取质量、schema 稳定性和确认请求生成效果。

同时也能避免还没校准好的飞书任务、日历、Wiki、Doc 命令产生真实写入。

如果要验证真实飞书会议纪要/转写读取，可以继续保持写入 dry-run：

```env
FEISHU_DRY_RUN=true
FEISHU_READ_DRY_RUN=false
```

这样只会真实读取飞书妙记，不会真实创建任务、日程、Wiki 或 Doc。

## 1. 准备环境变量

从示例文件复制一份本地 `.env`：

```bash
cp .env.example .env
```

不要提交 `.env`，也不要把 API Key 发给 AI 或贴进聊天记录。

## 2. 配置真实 LLM

编辑 `.env`：

```env
FEISHU_DRY_RUN=true
FEISHU_READ_DRY_RUN=true

LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-provider.example.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model
```

可选参数：

```env
LLM_TIMEOUT_MS=60000
LLM_TEMPERATURE=0
LLM_MAX_TOKENS=4096
LLM_DEBUG_RAW=false
```

如果使用比赛提供的豆包 / 火山方舟资源，请以比赛文档中的 EP、模型 ID、API Key、Base URL 为准，不要按示例值猜。

## 3. 启动服务

```bash
nvm use
npm install
npm run build
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

## 4. 先跑 LLM Smoke Test

这个接口只验证真实 LLM 是否能产出合法 `MeetingExtractionResult`，
不写数据库、不创建确认请求。

```bash
curl -X POST http://127.0.0.1:3000/dev/llm/smoke-test \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "张三下周五前整理无人机操作流程。下周二上午十点再约一次操作员访谈。"
  }'
```

期望返回：

```json
{
  "provider": "openai-compatible",
  "model": "your-model",
  "ok": true,
  "result": {
    "meeting_summary": "...",
    "action_items": [],
    "calendar_drafts": []
  }
}
```

如果返回 500，先看 `error` 字段。

常见原因是模型没有输出合法 JSON，或输出字段没有通过 schema。

## 5. 用真实 LLM 生成确认请求

`/dev/meetings/manual` 会使用当前配置的 LLM 处理会议转写，并把
action/calendar/create_kb 生成确认请求。

因为 `FEISHU_DRY_RUN=true`，后续确认也只会记录 dry-run CLI payload，
不会真实写飞书。

```bash
curl -X POST http://127.0.0.1:3000/dev/meetings/manual \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "无人机操作方案初步访谈",
    "participants": ["张三", "李四"],
    "organizer": "张三",
    "started_at": "2026-04-28T10:00:00+08:00",
    "ended_at": "2026-04-28T11:00:00+08:00",
    "transcript_text": "张三下周五前整理无人机操作流程。下周二上午十点再约一次操作员访谈。"
  }'
```

查看确认请求：

```bash
curl http://127.0.0.1:3000/dev/confirmations
```

确认某条请求时仍是 dry-run：

```bash
curl -X POST http://127.0.0.1:3000/dev/confirmations/<id>/confirm \
  -H 'Content-Type: application/json' \
  -d '{}'
```

查看 dry-run 记录：

```bash
curl http://127.0.0.1:3000/dev/state
```

## Safety Notes

- 不要提交 `.env`。
- 不要把 API Key 发给 AI。
- `FEISHU_DRY_RUN=true` 时不会真实写飞书。
- 真实飞书任务、日历、Wiki、Doc 写入要等 CLI 命令和权限在后续阶段校准后再开启。
