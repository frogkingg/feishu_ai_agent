# 真实飞书卡片发送测试报告

## 测试目标

验证 MeetingAtlas 在保持飞书任务、日程、Wiki / Doc 写入 dry-run 的前提下，可以通过
`lark-cli` 把 confirmation card 真实发送到飞书测试群。

本次测试是“真实飞书卡片发送测试”，不是完整真实写入测试。点击确认前不会创建飞书
任务、日程、Wiki 或 Doc。

## 测试配置

```env
FEISHU_DRY_RUN=true
FEISHU_CARD_SEND_DRY_RUN=false
FEISHU_CARD_ACTIONS_ENABLED=true
LARK_VERIFICATION_TOKEN=<configured in Feishu app>
LARK_ENCRYPT_KEY=<configured in Feishu app>
LARK_CARD_CALLBACK_URL_HINT=https://your-domain/webhooks/feishu/card-action
LARK_CLI_BIN=lark-cli
LLM_PROVIDER=mock
```

该配置表示：

- `FEISHU_DRY_RUN=true` 保护任务、日程、Wiki / Doc 不真实写入。
- `FEISHU_CARD_SEND_DRY_RUN=false` 只允许卡片真实发送。
- `LARK_ENCRYPT_KEY` 用于飞书 `X-Lark-Signature` 验签，`LARK_VERIFICATION_TOKEN` 用于校验 payload token。
- `LARK_CLI_BIN=lark-cli` 是本地实际 CLI 命令名。
- `LLM_PROVIDER=mock` 是为了避免真实 LLM 波动影响飞书链路测试。

## 测试命令

启动服务：

```bash
PORT=3000 \
SQLITE_PATH=/tmp/meeting-atlas-real-card-test-$(date +%s).db \
FEISHU_DRY_RUN=true \
FEISHU_CARD_SEND_DRY_RUN=false \
FEISHU_CARD_ACTIONS_ENABLED=true \
LARK_CLI_BIN=lark-cli \
LLM_PROVIDER=mock \
npm run dev
```

另一个终端执行 send-cards demo：

```bash
MEETING_ATLAS_BASE_URL=http://127.0.0.1:3000 \
npm run demo:full-p0 -- --send-cards --chat-id <test_chat_id>
```

注意：`<test_chat_id>` 是测试群占位符，提交文档中不记录真实 chat ID。

## 测试结果

- 飞书测试群收到 5 张确认卡片。
- action cards: 3
- calendar cards: 1
- create_kb cards: 1
- card_send CLI runs: success
- 全局 `FEISHU_DRY_RUN=true`，未真实创建任务、日程、Wiki 或 Doc。

实际收到的卡片为：

1. action card: 整理无人机现有操作流程
2. action card: 确认试飞场地权限
3. calendar card: 无人机操作员访谈
4. action card: 整理无人机风险清单
5. create_kb card: 无人机操作方案

## 截图说明

本轮不提交真实飞书测试群截图，避免把群聊信息或内部上下文带入仓库。截图保存在本地或路演材料中。

如后续确认可以提交脱敏截图，建议放在：

```text
docs/assets/real-feishu-card-test/
```

建议文件名：

- `real-card-action-01.png`
- `real-card-calendar-01.png`
- `real-card-create-kb-01.png`

## 安全边界

- 未真实创建任务。
- 未真实创建日程。
- 未真实创建 Wiki / Doc。
- 真实发送仅限确认卡片本身，不等于确认或执行卡片里的业务动作。

## 当前限制

- 真实飞书任务 / 日程 / Wiki / Doc 创建仍未打开。
- 飞书卡片按钮回调已经接入 `/webhooks/feishu/card-action`，但公网回调必须同时配置 `LARK_ENCRYPT_KEY`、`LARK_VERIFICATION_TOKEN` 和 `LARK_CARD_CALLBACK_URL_HINT`。
- 如真实发卡失败，可查看 `/dev/state` 的 `cli_runs`，或只读辅助接口 `/dev/card-send-runs`，定位 `lark.im.send_card` 的 `stderr` / `error`。

查看 `/dev/state`：

```bash
curl http://127.0.0.1:3000/dev/state
```

如果本地有 `jq`，可以过滤 send-card CLI 结果：

```bash
curl -s http://127.0.0.1:3000/dev/state \
  | jq '.cli_runs[] | select(.tool == "lark.im.send_card") | {id, dry_run, status, stdout, stderr, error, created_at}'
```

## 下一步计划

- 用真实飞书会议事件验证 `/webhooks/feishu/event` 是否通过验签并生成卡片。
- 回调后仍先在 `FEISHU_DRY_RUN=true` 下执行 `confirm` / `reject`。
- 继续保持真实任务、日程、Wiki / Doc 写入关闭，直到下一阶段单独放开。
