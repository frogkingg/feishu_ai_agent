# 飞书 CLI 机器人部署与测试

当前可一起编辑的飞书 CLI 机器人入口：

- App 控制台：https://open.feishu.cn/app/cli_a9618b51257a1bcd/version

不要把 App Secret、Token 或回调密钥写进仓库。仓库只记录部署步骤、权限、验证方式和常见问题。

## 1. 本地准备

```bash
npm install
cp .env.example .env
npm run build
```

在 `.env` 中配置：

- `OPENAI_API_KEY`
- `OPENAI_API_URL`
- `OPENAI_MODEL`
- 可选：`LARK_POLL_CHAT_IDS`
- 可选：`LARK_POLL_INTERVAL_MS`

如果本机 `lark-cli` 不在 PATH，可以设置：

```bash
LARK_CLI_BIN=/path/to/lark-cli
```

## 2. 配置 lark-cli 应用

首次配置：

```bash
lark-cli config init --new
```

配置时选择或填写当前 CLI 机器人应用。应用入口见本页顶部控制台链接。

检查配置：

```bash
lark-cli config show
```

注意：不要把 `config show` 中的密钥或敏感字段复制到 GitHub、文档或群聊。

## 3. 身份选择

lark-cli 有两类身份：

| 身份 | 参数 | 适用场景 |
| --- | --- | --- |
| Bot | `--as bot` | 机器人收发消息、应用级写入、事件订阅 |
| User | `--as user` | 访问用户自己的云文档、日历、知识库、邮箱等资源 |

当前 `src/index.ts` 里的机器人消息监听和回复默认走 bot 身份。

## 4. 控制台权限建议

P0 Demo 至少需要关注这些能力：

| 能力 | 用途 | 身份 |
| --- | --- | --- |
| IM 消息接收 | 监听群聊消息 | Bot |
| IM 消息发送/回复 | 回复用户、推送项目简报 | Bot |
| 事件订阅 | 长连接接收 `im.message.receive_v1` | Bot |
| 云文档 / 知识库 | 创建和更新项目作战室 | Bot 或 User |
| 多维表格 | 任务池、风险表、看板 | Bot 或 User |
| 任务 | 创建待办、同步状态 | Bot 或 User |
| 妙记 / 视频会议 | 读取会后纪要和 AI 产物 | User 优先 |

遇到 `Permission denied` 时，不要猜权限。读取错误里的：

- `permission_violations`
- `console_url`
- `hint`

Bot 身份缺权限：去控制台补 scope。  
User 身份缺权限：用最小 scope 做增量授权，例如：

```bash
lark-cli auth login --scope "<missing_scope>"
```

## 5. 事件订阅配置

在飞书开发者后台确认：

- 事件订阅方式：长连接
- 已订阅事件：`im.message.receive_v1`
- 机器人已加入测试群
- 已开通机器人接收消息和发送消息相关权限

本地手动验证长连接：

```bash
lark-cli event +subscribe --event-types im.message.receive_v1 --compact --quiet --as bot
```

在测试群里发一条消息，终端应该能看到 compact JSON 事件。

## 6. 启动机器人

开发调试：

```bash
npm start
```

后台运行：

```bash
npm run bot:daemon
npm run bot:status
npm run bot:log
```

停止：

```bash
npm run bot:stop
```

## 7. Smoke Test

### 测试 1：基础构建

```bash
npm run build
```

预期：TypeScript 编译通过。

### 测试 2：飞书配置可读取

```bash
lark-cli config show
```

预期：能读到当前应用配置。不要记录敏感字段。

### 测试 3：事件能收到

```bash
lark-cli event +subscribe --event-types im.message.receive_v1 --compact --quiet --as bot
```

预期：群里发送消息后，终端出现 JSON 事件。

### 测试 4：机器人能回复

```bash
npm start
```

在测试群发：

```text
你好
```

预期：机器人回复 ProjectPilot 的能力说明。

### 测试 5：项目创建意图

在测试群发：

```text
帮我们创建一个飞书比赛项目，目标是 5 月 7 日前完成可运行 Demo。July 负责产品，A 负责开发，B 负责设计。
```

当前最小版本预期：机器人能识别创建项目意图，并要求补充项目信息。后续版本应升级为自动创建知识库、任务池和项目总览。

## 8. 降级轮询

如果事件订阅暂时不稳定，可以用轮询兜底。

在 `.env` 中配置：

```bash
LARK_POLL_CHAT_IDS=oc_xxx,oc_yyy
LARK_POLL_INTERVAL_MS=5000
```

再运行：

```bash
npm start
```

机器人启动时会先忽略历史消息，只处理后续新消息。

## 9. 常见问题

### Bot 收不到消息

检查：

- 机器人是否加入目标群
- 控制台是否订阅 `im.message.receive_v1`
- 是否启用长连接事件订阅
- 是否开通消息接收权限

### 能收到事件但回复失败

检查：

- 是否开通消息发送/回复权限
- 当前群是否允许机器人发言
- `message_id` 是否来自有效消息
- 错误里是否有缺失 scope

### User 能读到，Bot 读不到

这是正常差异。Bot 默认看不到用户个人云空间、日历和邮箱资源。需要决定这个能力应该走 bot 还是 user 身份，并在文档里写清楚。

### 大模型无回复

检查：

- `.env` 是否有 `OPENAI_API_KEY`
- `OPENAI_API_URL` 是否正确
- `OPENAI_MODEL` 是否可用
- 终端是否出现 LLM API 错误
