# 团队协作指南

这个仓库的目标是让产品、开发、设计和路演同学能围绕同一份项目资产推进，而不是各自维护一套版本。

## 协作原则

1. 先对齐场景，再写代码。
2. 所有能力都要能追溯到 Demo 闭环。
3. 写入飞书的能力必须记录权限、输入、输出和失败处理。
4. 重要结论沉淀到文档，临时讨论留在群聊。
5. 新增 Skill 先写说明和验收标准，再补脚本。

## 分支建议

| 分支 | 用途 |
| --- | --- |
| `main` | 稳定版本，能通过构建，适合演示前拉取 |
| `feat/<short-name>` | 新功能或新能力 |
| `docs/<short-name>` | 文档、PRD、协作说明 |
| `demo/<short-name>` | 演示脚本、固定数据、路演流程 |
| `fix/<short-name>` | 修 bug 或补配置 |

## 本机生产环境协同

当前先把一台电脑作为本地生产环境运行机器人。GitHub 仓库作为唯一代码源，本机只负责拉取稳定版本、保管 `.env` 和飞书本地授权、运行 LaunchAgent。

专门协同仓库：

- https://github.com/frogkingg/feishu_ai_agent

协同规则：

1. 团队成员通过分支和 PR 改代码，不直接在生产机器上手改运行文件。
2. 合并到 `main` 后，由生产值守同学在本机执行 `npm run deploy:local` 或 `npm run bot:install`。
3. 本机 `.env`、`.runtime/`、LaunchAgent 状态和 Keychain 授权不进仓库。
4. 每次涉及飞书写入能力的 PR，都要说明写入对象、身份类型和回滚方式。
5. 如果机器人异常，先跑 `npm run bot:doctor`，再决定是重启、补权限还是回滚。

详细部署说明见：[`docs/LOCAL_COLLABORATION_DEPLOYMENT.md`](LOCAL_COLLABORATION_DEPLOYMENT.md)。

## Issue 使用方式

优先用仓库里的模板建 Issue：

- `Capability Request`：登记新的飞书、LLM、本地运行能力
- `Skill Spec`：设计或补齐一个 ProjectPilot Skill
- `Demo Task`：拆比赛 Demo 的具体任务

每个 Issue 至少说明：

- 服务哪个场景
- 输入和输出是什么
- 需要哪些飞书权限或环境配置
- Demo 中怎么验收

## PR 规则

发 PR 前至少确认：

- `npm run build` 能通过
- README 或相关 docs 已更新
- 如果涉及飞书写入，说明写入位置和权限
- 如果涉及 Skill，补齐输入、输出、失败处理和验收标准
- 不提交 `.env`、token、app secret、运行日志

## 文档分工

| 文档 | 维护重点 |
| --- | --- |
| `README.md` | 项目入口、快速开始、阅读顺序 |
| `docs/PROJECT_CONTEXT.md` | 项目定位、P0 Demo、非目标 |
| `docs/ARCHITECTURE.md` | Agent 分工、数据对象、事件流 |
| `docs/CAPABILITY_GUIDE.md` | 飞书/LLM/本地能力边界 |
| `docs/SKILL_AUTHORING.md` | Skill 编写规范 |
| `docs/CLI_BOT_DEPLOYMENT_TESTING.md` | CLI 机器人部署、权限和测试 |
| `docs/LOCAL_COLLABORATION_DEPLOYMENT.md` | 本机生产环境、GitHub 协作和迁云前部署流程 |
| `docs/ROADMAP.md` | P0/P1/P2 任务拆分 |

## 新增能力流程

```text
建 Issue
-> 补能力说明 / Capability Spec
-> 补 Skill 草案
-> 实现代码或脚本
-> 本地测试
-> 飞书侧验证
-> PR 合并
```

如果是让 Agent 学会新的群聊流程，优先使用 `Agent Capability` Issue 模板，并参考 [`docs/CAPABILITY_DEVELOPMENT.md`](CAPABILITY_DEVELOPMENT.md)。

## 负责人建议

| 方向 | 主要负责内容 |
| --- | --- |
| 产品 | 场景、验收标准、Demo 主线、PRD |
| 开发 | TypeScript 运行时、CLI 调用、数据写入 |
| 设计 | 项目作战室结构、卡片/文档展示、路演视觉 |
| 路演 | Demo 脚本、效果验证报告、风险兜底方案 |

## 安全规则

- 不提交 `.env`。
- 不在 Issue、PR、群聊里贴 app secret、access token 或用户 token。
- 需要用户授权时，只贴授权链接和需要的 scope，不贴本地敏感配置。
- 删除、覆盖、批量写入飞书内容前，先在 Issue 或 PR 里说明影响范围。
