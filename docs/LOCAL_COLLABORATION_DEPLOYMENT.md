# 本机协同部署方案

这个阶段先把一台电脑作为 ProjectPilot 的本地生产环境。GitHub 仓库是唯一代码源，本机只负责运行稳定版本和保管本地授权。

当前协同仓库：

- https://github.com/frogkingg/feishu_ai_agent

## 角色分工

| 角色 | 负责内容 |
| --- | --- |
| GitHub 仓库 | 代码、文档、PR、Issue、版本记录 |
| 本机生产环境 | 常驻监听飞书群聊、调用 lark-cli、保存本地 `.env` 和 Keychain 授权 |
| 开发同学 | 从分支发 PR，不直接改生产机器上的运行代码 |
| 生产值守同学 | 合并后在本机执行部署、查看状态、处理重启和日志 |

## 基本规则

1. `main` 永远保持可运行，演示前只从 `main` 部署。
2. 本机 `.env`、Keychain、运行日志不进仓库。
3. 写入飞书的能力必须在 PR 里写清楚权限、影响范围和验收方式。
4. 生产机器不手改代码；紧急修复也先建分支，合并后部署。
5. 机器人能力变更后，必须至少通过 `npm run build` 和一次飞书侧 smoke test。

## 推荐流程

```text
建 Issue
-> 开发分支
-> PR
-> npm run build
-> 飞书侧验证说明
-> 合并 main
-> 本机部署
-> 群内同步结果
```

## 本机首次接入仓库

如果这台电脑还没有绑定远端仓库：

```bash
git remote add origin https://github.com/frogkingg/feishu_ai_agent.git
```

如果已有旧 remote，先确认再调整：

```bash
git remote -v
```

注意：不要把 `.env`、`.runtime/`、本机 LaunchAgent plist、Keychain 内容提交到仓库。

## 本机部署命令

标准部署：

```bash
cd /Users/henryxian/Documents/飞书比赛
npm run bot:install
npm run bot:status
```

如果已经配置好 GitHub remote，可用：

```bash
PROJECTPILOT_DEPLOY_REMOTE=origin PROJECTPILOT_DEPLOY_BRANCH=main sh scripts/deploy-local.sh
```

这条命令会：

1. 运行 `lark-cli doctor`
2. 安装依赖
3. 构建 TypeScript
4. 从 GitHub 快进更新 `main`
5. 重装 LaunchAgent
6. 输出机器人状态

## 日常检查

```bash
npm run bot:status
npm run bot:doctor
npm run bot:log
```

健康状态至少应该看到：

- `launchctl` 中 `com.projectpilot.bot` 是 `running`
- 主进程是 `node .../dist/index.js`
- 子进程包含 `lark-cli event +subscribe`
- 群聊里发 `ping` 后机器人能回复

## 事故处理

### 机器人无响应

```bash
npm run bot:doctor
npm run bot:status
npm run bot:log
```

优先看：

- 电脑是否联网、是否处于登录状态
- `lark-cli doctor` 是否通过
- `com.projectpilot.bot` 是否 running
- 日志中是否有缺失 scope、token 过期、模型接口错误

### 刚合并的版本有问题

优先回滚 GitHub 的 `main`，再重新部署本机。

如果只是临时停止机器人：

```bash
npm run bot:stop
```

恢复：

```bash
npm run bot:install
```

## 迁移到服务器时要替换的部分

| 本机阶段 | 服务器阶段 |
| --- | --- |
| LaunchAgent | systemd / Docker / PM2 |
| 本机 Keychain user token | OAuth token 数据库存储和刷新 |
| `.env` 手动维护 | 云服务器 secret 管理 |
| 本机日志文件 | 集中日志和告警 |
| 手动部署 | CI/CD 或一键部署脚本 |

迁移前，先保证本机阶段的工具边界稳定：IM、Calendar、Task、Docs/Wiki/Base 都以明确工具函数或模块暴露，不把业务判断和 CLI 参数拼接混在一团。
