# MeetingAtlas / 会脉 Agent

MeetingAtlas / 会脉 Agent 是一个由飞书会议纪要触发的个人执行闭环与主题知识库 Agent。

会议结束后，它读取会议纪要、妙记或转写文本，抽取个人待办、后续日程、关键结论、风险、资料引用和主题关键词；所有任务、日程、知识库、资料归档等副作用都必须先生成确认请求，用户确认后才执行。默认 dry-run，不真实写飞书。

## 当前状态

仓库已从旧 ProjectPilot 实验重启为 MeetingAtlas。根目录就是新的主项目，不再保留旧 ProjectPilot 运行时代码、旧 Skill 草稿、旧源材料文档和重复工程目录。

当前 P0 主链路已经可演示：

- `processMeetingWorkflow` 编排会议抽取、主题聚类和 confirmation 生成。
- Action / calendar / create_kb / append_meeting 都先进入 confirmation request，用户确认后才执行。
- 飞书卡片支持 dry-run 预览、真实发送 canary、按钮回调和最终状态同步。
- 知识库创建会让 Knowledge Curator LLM 生成页面草案，并把首页和子页一起写入 Wiki / Doc 工具层。
- 追加会议会调用 Knowledge Curator append mode，生成 `KnowledgeBaseAppendDraft` 增量草案并写入 `knowledge_updates.after_text`。
- 自然语言负责人无法解析为 `ou_` open_id 时，任务仍会创建，并把 `负责人（待认领）` 写入任务描述。
- `/dev/*` 和飞书 webhook 在非本地环境下 fail closed：缺少 `DEV_API_KEY` 或 `LARK_VERIFICATION_TOKEN` 时返回 503。
- 默认仍是全 dry-run，不真实写飞书；真实写入按卡片、任务、日程、知识库分层打开。

## 快速开始

MeetingAtlas 使用 `node:sqlite`，本地需要 Node.js 24+。如果使用 nvm：

```bash
nvm use
```

```bash
npm install
npm run build
npm run test
npm run evaluate
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

`/health` 会同时返回全局写入开关和卡片发送开关：

```json
{
  "dry_run": true,
  "card_send_dry_run": true
}
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
FEISHU_CARD_SEND_DRY_RUN=true
FEISHU_EVENT_CARD_CHAT_ID=
LARK_CLI_BIN=lark-cli
LLM_PROVIDER=mock
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_TIMEOUT_MS=30000
LLM_MAX_INPUT_CHARS=30000
LLM_TEMPERATURE=0
LLM_MAX_TOKENS=4096
LLM_DEBUG_RAW=false
SQLITE_PATH=./data/meeting-atlas.db
DEV_API_KEY=
LARK_VERIFICATION_TOKEN=
LARK_ENCRYPT_KEY=
LARK_CARD_CALLBACK_URL_HINT=
```

### 飞书安全模式

MeetingAtlas 当前使用全局 dry-run、卡片发送 dry-run 和分项写入 dry-run 分层控制飞书能力：

| 模式                             | 配置                                                                                                                              | 结果                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模式 A：全 dry-run，默认安全模式 | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=true`                                                                          | 不真实发送卡片；不真实创建任务；不真实创建日程；不真实创建 Wiki / Doc；所有 CLI 都只记录 `planned` / dry-run；提交版和默认演示保持该模式。                        |
| 模式 B：只真实发送确认卡片       | `FEISHU_DRY_RUN=true`<br>`FEISHU_CARD_SEND_DRY_RUN=false`                                                                         | 真实发送飞书确认卡片；任务、日程、Wiki / Doc 仍然 dry-run；这是当前推荐的第一层真实飞书测试模式。                                                                 |
| 模式 C：隔离真实写入 canary      | `FEISHU_DRY_RUN=false` 做 full real canary，或在隔离环境里只关闭一个 `FEISHU_*_CREATE_DRY_RUN` / `FEISHU_KNOWLEDGE_WRITE_DRY_RUN` | 可以跑 action/calendar/knowledge 的 per-workflow 或 full real canary 代码闭环；真实写入只在专用 DB、专用接收人和权限校准后逐项开启，不作为共享提交/演示默认模式。 |

`FEISHU_DRY_RUN=true` 是默认安全模式。确认 action/calendar/create_kb 后只写本地记录和 dry-run 输出，不真实创建飞书任务、日程、Wiki 或 Doc。
`FEISHU_CARD_SEND_DRY_RUN` 只控制确认卡片是否真实发送，默认值必须保持为 `true`。因此可以保持 `FEISHU_DRY_RUN=true`，只在校准好 `LARK_CLI_BIN` 和飞书 bot 权限后设置 `FEISHU_CARD_SEND_DRY_RUN=false`，用于真实发送确认卡片；任务、日程和知识库写入仍保持 dry-run。

当 `FEISHU_DRY_RUN=false` 或关闭单项 dry-run 时，action/calendar/knowledge write 必须真实调用 `LARK_CLI_BIN` 且命令成功；CLI 不存在或命令失败会把确认请求标记为 `failed`，不会写成 created。若只想验证真实卡片发送，不要关闭 `FEISHU_DRY_RUN`，改用 `FEISHU_CARD_SEND_DRY_RUN=false`。
Mode C 的定位是隔离 canary/readiness：可以证明 per-workflow 或 full real canary 的代码闭环，但不得把共享环境、提交版默认配置或比赛演示口径描述成已经全量真实写入。提交版默认仍保留 dry-run / confirmation-first 安全边界。

服务启动时会打印当前安全模式和缺失配置。非 `development` / `test` 环境下：

- `DEV_API_KEY` 未配置时，所有 `/dev/*` 请求返回 503。
- `LARK_VERIFICATION_TOKEN` 未配置时，飞书 event webhook 和 card-action webhook 返回 503。
- `LARK_ENCRYPT_KEY` 用于校验飞书请求头 `X-Lark-Signature`；`LARK_VERIFICATION_TOKEN` 用于校验飞书事件 payload 里的 token。两者都配置后才算真实 webhook ready。
- `FEISHU_EVENT_CARD_CHAT_ID` 可选；配置后，视频会议事件生成的确认卡会直接发到该群，避免只尝试 DM 主持人导致现场“没反应”。

## 真实闭环配置检查清单

今天提交前推荐验收顺序：

1. **模式 A：全 dry-run。** 使用全新 `SQLITE_PATH`、`FEISHU_DRY_RUN=true`、`FEISHU_CARD_SEND_DRY_RUN=true` 跑完整 P0 主链路，确认 action/calendar/create_kb 都先生成 confirmation，执行结果只写 dry-run 记录。
2. **模式 B：真实卡片。** 仍保持 `FEISHU_DRY_RUN=true`，只设置 `FEISHU_CARD_SEND_DRY_RUN=false`，用专用接收人验证 confirmation card 真实发送和回调 readiness；任务、日程、Wiki / Doc 仍然 dry-run。
3. **模式 C：单项真实写入 canary/readiness。** 只在隔离 DB、隔离接收人和已校准 CLI 权限下逐项打开 task、calendar 或 knowledge write；CLI 失败不得伪造成功，提交版默认演示不依赖共享环境真实写入。

打通真实飞书闭环需要确认以下四项：

1. **飞书开放平台配置**
   - 事件订阅 → 请求地址：`https://your-domain/webhooks/feishu/event`
   - 事件订阅 → 勾选 `vc.meeting.recording_ready_v1`
   - 消息卡片 → 请求地址：`https://your-domain/webhooks/feishu/card-action`
   - 记录 Verification Token → 填入 `LARK_VERIFICATION_TOKEN`
   - 记录 Encrypt Key → 填入 `LARK_ENCRYPT_KEY`

2. **环境变量**（最小真实发卡配置）

   ```env
   FEISHU_DRY_RUN=true
   FEISHU_CARD_SEND_DRY_RUN=false
   FEISHU_CARD_ACTIONS_ENABLED=true
   FEISHU_EVENT_CARD_CHAT_ID=<oc_xxx 可选但推荐>
   LARK_VERIFICATION_TOKEN=<your-token>
   LARK_ENCRYPT_KEY=<your-encrypt-key>
   LARK_CARD_CALLBACK_URL_HINT=https://your-domain/webhooks/feishu/card-action
   LARK_CLI_BIN=lark-cli
   LLM_PROVIDER=openai-compatible
   LLM_BASE_URL=...
   LLM_API_KEY=...
   LLM_MODEL=...
   ```

3. **lark-cli 登录验证**

   ```bash
   lark-cli auth status
   lark-cli im messages send --help
   ```

4. **本地端口暴露**（需要 ngrok 或类似工具）

   ```bash
   ngrok http 3000
   # 把 https://xxx.ngrok.io/webhooks/feishu/card-action 同时填到：
   # 1. 飞书开放平台「消息卡片请求地址」
   # 2. LARK_CARD_CALLBACK_URL_HINT
   ```

真实发送未完成 confirmation card 前，系统会检查 `FEISHU_CARD_ACTIONS_ENABLED=true`、`LARK_VERIFICATION_TOKEN` / `LARK_ENCRYPT_KEY` 非空、`LARK_CARD_CALLBACK_URL_HINT` 是公网 http/https URL 且以 `/webhooks/feishu/card-action` 结尾。任一条件不满足会 fail fast，不调用 lark-cli 发送可点击但会 200671 的卡片。

真实 LLM 实验时保持 `FEISHU_DRY_RUN=true`，只切换模型提供方：

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-provider.example.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model
```

服务启动时会根据 `LLM_PROVIDER` 选择 LLM client：`mock` 使用本地稳定 fixture，`openai-compatible` 调用 Chat Completions API 处理会议转写。

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

返回的每条 confirmation 都会附带 `dry_run_card`，这是当前阶段的飞书卡片确认层雏形：
创建 confirmation 时，同一份 JSON 也会写入 `original_payload_json.card_preview`，保留原来的
`draft` / `meeting_id` 等字段，确认和拒绝逻辑仍读取原字段。

```json
{
  "card_type": "action_confirmation",
  "title": "确认待办：整理无人机操作流程",
  "summary": "负责人：张三；截止：2026-05-01",
  "sections": [],
  "editable_fields": [],
  "actions": ["confirm", "confirm_with_edits", "reject", "not_mine", "remind_later"]
}
```

Calendar confirmation card 会使用同样的 dry-run JSON 结构，并提供
`confirm`、`confirm_with_edits`、`reject`、`convert_to_task`、`remind_later`。

Create KB confirmation card 会展示 `topic_name`、`suggested_goal`、`score`、
`match_reasons`、`candidate_meeting_ids`、`default_structure` 和安全说明，并提供
`create_kb`、`edit_and_create`、`append_current_only`、`reject`、`never_remind_topic`。

也可以单独查看某条确认请求的卡片 JSON：

```bash
curl http://127.0.0.1:3000/dev/confirmations/<id>/card
```

查看所有未完成 confirmation 的卡片预览：

```bash
curl http://127.0.0.1:3000/dev/cards
```

发送单张确认卡片，支持指定群聊 `chat_id` 或私聊接收人 `recipient`。在模式 A 下只记录
`planned` / dry-run；在模式 B 下会真实发送确认卡片：

```bash
curl -X POST http://127.0.0.1:3000/dev/confirmations/<id>/send-card \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"oc_xxx"}'
```

发送当前所有未完成 confirmation 的确认卡片。同样遵循模式 A / B 的卡片发送开关：

```bash
curl -X POST http://127.0.0.1:3000/dev/cards/send-all \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"ou_xxx"}'
```

在模式 B 下，`FEISHU_CARD_SEND_DRY_RUN=false` 且 `recipient` 必须是飞书 open_id 或
`chat_id` 必须是飞书群 ID；如果 CLI 未安装、命令形状不匹配或返回结果缺少
`message_id`，`send-card` 会失败，不会伪造成功的 `card_message_id`。

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

## 飞书事件入口

当前提供两个飞书 webhook 入口：

```bash
POST /webhooks/feishu/event
POST /webhooks/feishu/card-action
```

- challenge 请求会原样返回 `{ "challenge": "..." }`。
- `vc.meeting.recording_ready_v1` 会进入会议处理后台任务；未识别事件返回 `{ "accepted": true }`。
- card-action 会把按钮 payload 映射回 confirmation action，并同步卡片终态。
- 非本地环境必须配置 `LARK_VERIFICATION_TOKEN`；缺失时返回 503，不再放行。

完整演示路径见 [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)。
`npm run demo:full-p0` 会额外校验卡片预览：第一场会议后至少 2 张 action card 和
1 张 calendar card，第二场会议后 1 张 create_kb card，并在报告里输出
`Card previews generated: 4`。
`full-p0` 和卡片阶段脚本启动时都会先读取 `/dev/state`，默认要求干净 SQLite DB：
`meetings`、`action_items`、`calendar_drafts`、`knowledge_bases`、
`confirmation_requests` 必须全部为空。刚跑过 `full-p0` 后，请换新的
`SQLITE_PATH` 再跑 `--send-cards`。

推荐每次演示用新的 dry-run 数据库启动服务：

```bash
PORT=3000 SQLITE_PATH=/tmp/meeting-atlas-demo-$(date +%s).db FEISHU_DRY_RUN=true FEISHU_CARD_SEND_DRY_RUN=true LLM_PROVIDER=mock npm run dev
```

卡片阶段也可以只跑确认卡片链路：

```bash
npm run demo:full-p0 -- --cards-only
npm run demo:full-p0 -- --send-cards --chat-id oc_xxx
```

`--send-cards` 在模式 A 下只验证卡片发送 dry-run，会记录 `lark.im.send_card` 的
`planned` / dry-run `cli_runs`，不执行 confirmations，也不创建任务、日程或知识库。
只有服务启动时显式进入模式 B，设置 `FEISHU_CARD_SEND_DRY_RUN=false`，才会尝试真实发送确认卡片。开发调试可以加 `--allow-dirty`
绕过干净库检查，但不推荐录 Demo 使用。

## 效果验证评测

`npm run evaluate` 会运行离线效果评测集：8 条人工标注会议样本、fixture mock extraction、
内存 SQLite workflow，不连接真实飞书，也不修改 `FEISHU_DRY_RUN`。默认使用评测 mock；
如需手动对比真实模型，可设置 `EVALUATION_LLM_PROVIDER=openai-compatible`，并提供
`LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`。自动化测试始终固定为 mock。

默认报告的汇总项叫 `Mock Fixture 流程通过率`：它验证人工标签、fixture extraction、
workflow、topic clustering、confirmation 生成和指标计算是否按预期工作，不代表真实
LLM 在未知会议上的准确率。真实模型复测报告会标注 `Real LLM Extraction Evaluation`、
provider、model 和运行时间。

输出报告：

```text
evaluation-output/evaluation-latest.json
evaluation-output/evaluation-report.md
```

报告覆盖 fixture/real extraction matching、用户接受度代理指标、估算效率提升，以及 8 类关键评测场景：
明确待办、明确日程、截止时间非日程、模糊表达不生成任务、相关会议触发知识库、
不相关会议不触发知识库、有决策但无待办、有风险但无明确负责人。
核心指标会单独列出 action item recall、粗略 precision、owner / due date 准确率、
calendar recall / precision、deadline-vs-calendar 区分、知识库触发准确率、false positive
count 和每场会议平均 confirmation burden。
效率提升估算采用简单人工耗时模型：人工整理一场会议待办和日程约 5-10 分钟，
人工创建知识库并整理两场会议约 20-30 分钟，Agent 耗时使用脚本实际运行秒数。

## 目录结构

```text
.
├── docs/          # 架构、开发计划、Demo 和飞书 CLI 说明
├── evaluation/    # 离线效果验证评测集、人工标签和报告脚本
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
- 不绕过 confirmation 直接调用飞书写操作。
- 不在未隔离环境里直接开启完整真实写入。
- 暂不把已有知识库核心页面的 page token 持久化；真实增量更新核心页属于下一步。

## 下一步

下一步重点是 T2b：设计 `knowledge_bases` / `knowledge_updates` 的页面 token 存储策略，然后把 append mode 的增量草案真实写回“整体分析 / 当前进度 / 风险 / 变更记录”等核心页面。在这之前，追加会议已经能让 LLM 生成可审计的增量草案，并保存在 `knowledge_updates.after_text`。
