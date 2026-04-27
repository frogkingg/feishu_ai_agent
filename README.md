# ProjectPilot / 飞书项目领航员

ProjectPilot 是一个面向飞书协作场景的项目管理专家 Agent。它的目标不是再做一个普通 Todo Bot，而是在飞书里维护一个会随着会议、群聊、任务和知识库变化而持续更新的 Living Project Space / 活项目知识库。

当前仓库用于承载比赛 Demo、能力调用指引、Skill 设计规范，以及后续不同服务能力的集成样例。

## 我们现在的目标

围绕飞书 AI 校园挑战赛 OpenClaw 赛道，先跑通一条足够清楚的 P0 闭环：

```text
项目立项输入
-> 创建项目知识库 / 项目作战室
-> 拆解节点、模块、任务和子任务
-> 会议纪要进入系统
-> 提取 Action Items 并进入确认
-> 创建飞书任务 / 写入多维表格
-> 更新项目总览、进度和风险
-> 在群聊中主动分发简报
```

产品结构保持为一个共享底座服务两个场景入口：

| 层级 | 内容 |
| --- | --- |
| 共享底座 | 项目知识包、飞书 CLI/OpenAPI 调用层、能力注册表、Agent 编排、状态写入 |
| 场景入口 A | 项目推进：立项、任务拆解、会议待办、风险预警、阶段复盘 |
| 场景入口 B | 新人/中途加入：自动生成上手包、推送关键背景、同步当前任务和风险 |

## 当前代码

仓库里已有一个最小 TypeScript 机器人骨架：

- `src/index.ts`：监听飞书消息、调用 LLM、回复群聊消息
- `.env.example`：本地模型和飞书轮询相关配置示例
- `package.json`：本地启动、构建、守护进程脚本
- `.agents/skills/`：当前机器上沉淀的飞书 CLI Skills 和参考文档
- `文档/`：比赛规则、会议纪要、PRD 和源材料

## 快速开始

```bash
npm install
cp .env.example .env
npm run build
npm start
```

常用机器人命令：

```bash
npm run bot:daemon
npm run bot:status
npm run bot:log
npm run bot:stop
```

运行前需要先完成飞书应用和 CLI 配置，并确保本地 `lark-cli` 可用。

## 仓库结构

```text
.
├── src/                    # ProjectPilot 运行时代码
├── docs/                   # 项目上下文、架构、能力和 Skill 指引
├── skills/                 # 项目级 Skill 规范和后续可复用能力入口
├── .agents/skills/         # 本地已有的 lark-cli Skills 资料
├── 文档/                   # 比赛和 PRD 源材料
└── .github/                # GitHub 协作模板
```

## 推荐阅读顺序

1. [项目上下文](docs/PROJECT_CONTEXT.md)
2. [系统架构](docs/ARCHITECTURE.md)
3. [团队协作指南](docs/COLLABORATION.md)
4. [飞书 CLI 机器人部署与测试](docs/CLI_BOT_DEPLOYMENT_TESTING.md)
5. [本机协同部署方案](docs/LOCAL_COLLABORATION_DEPLOYMENT.md)
6. [如何教会 ProjectPilot 新流程与能力](docs/CAPABILITY_DEVELOPMENT.md)
7. [能力调用指引](docs/CAPABILITY_GUIDE.md)
8. [Skill 编写规范](docs/SKILL_AUTHORING.md)
9. [路线图](docs/ROADMAP.md)

## 贡献方式

新增能力时，优先按这个顺序补齐：

1. 在 `docs/CAPABILITY_GUIDE.md` 登记能力边界、输入输出和飞书权限。
2. 在 `docs/SKILL_AUTHORING.md` 对齐 Skill 的命令、失败处理和验收标准。
3. 在 `skills/` 增加项目级 Skill 草案或调用说明。
4. 再补运行时代码、测试或 Demo 脚本。

这样仓库不会变成一堆分散脚本，而是能持续沉淀为可复用的能力库。
