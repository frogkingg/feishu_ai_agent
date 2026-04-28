# Demo Script

当前 Phase 6 已能演示“手动提交会议转写 -> Mock LLM 抽取 -> 生成确认请求 -> dry-run 执行到工具层 -> 两场相关会议后建议创建知识库 -> dry-run 生成知识库 Markdown”。

## 当前可演示

启动服务：

```bash
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

提交会议：

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

确认其中一个请求：

```bash
curl -X POST http://127.0.0.1:3000/dev/confirmations/<id>/confirm \
  -H 'Content-Type: application/json' \
  -d '{}'
```

拒绝其中一个请求：

```bash
curl -X POST http://127.0.0.1:3000/dev/confirmations/<id>/reject \
  -H 'Content-Type: application/json' \
  -d '{"reason":"稍后再处理"}'
```

查看 dry-run CLI 记录：

```bash
curl http://127.0.0.1:3000/dev/state
```

提交第二场无人机会议：

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

查看知识库创建建议：

```bash
curl http://127.0.0.1:3000/dev/confirmations
```

确认 `create_kb` 请求：

```bash
curl -X POST http://127.0.0.1:3000/dev/confirmations/<create_kb_id>/confirm \
  -H 'Content-Type: application/json' \
  -d '{}'
```

查看生成的知识库记录和 Markdown：

```bash
curl http://127.0.0.1:3000/dev/state
```

运行测试：

```bash
npm run test
```

## 完整演示路径

1. 启动服务。
2. 提交第一场无人机会议到 `POST /dev/meetings/manual`。
3. 查看待办确认请求：`GET /dev/confirmations`。
4. 确认任务创建：`POST /dev/confirmations/:id/confirm`。
5. 查看 dry-run CLI 记录：`GET /dev/state`。
6. 提交第二场无人机会议。
7. 查看知识库创建建议。
8. 确认创建知识库。
9. 查看生成的知识库 Markdown。
10. 真实飞书模式下，这些 dry-run 结果会变成任务、日程、知识库页面和卡片消息。
