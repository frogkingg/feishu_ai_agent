# ProjectPilot MVP 飞书群测试流

这条链路通过 `PROJECTPILOT_MVP_MODE=1` 开启，优先处理 Demo-first MVP 指令；未命中的消息继续走旧 Router / project-patch fallback。

## 本地启动

```bash
cd /Users/henryxian/Documents/飞书比赛
PROJECTPILOT_MVP_MODE=1 PROJECTPILOT_LARK_WRITE_MODE=mock npm run dev
```

写入模式：

- `mock`：只写 `.runtime/mvp/state.json` 和 `.runtime/mvp/artifacts/*.md`
- `hybrid`：优先尝试已打通的 lark-cli 命令，失败后 mock fallback
- `cli`：用于后续真实飞书写入命令打通后的验证

当前版本只确认了 IM 文本发送命令；项目空间、任务池、飞书任务创建先走本地 mock artifact。

## 群聊测试消息

### 1. 创建项目草案

在飞书群里 @Bot：

```text
创建项目「ProjectPilot Demo 闭环」
目标：跑通项目立项、项目计划、会议纪要转任务、确认执行、项目简报闭环
deadline：4月30日
负责人：Henry
成员：小王负责前端、小李负责飞书写入、小张负责测试
交付物：飞书群 Demo、本地 artifact、项目简报
```

预期：Bot 返回项目草案、里程碑、前 8 个任务草案和确认命令：

```text
确认立项 draft_xxx
```

### 2. 确认立项

回复：

```text
确认立项 draft_xxx
```

预期：Bot 创建 MVP 项目状态，生成 `.runtime/mvp/state.json` 和 `.runtime/mvp/artifacts/*_overview.md`、`*_task_pool.md`。

### 3. 粘贴会议纪要

```text
会议纪要：
今天确认先做 MVP 主链路，Henry 负责整体验收，4月30日前完成。
小王负责把群聊草案文案调短，明天完成。
小李负责飞书任务写入 fallback，后天完成。
风险：真实飞书任务 API 命令还没打通，可能先用本地模拟。
决策：本周 Demo 先用文本确认，不做复杂卡片。
```

预期：Bot 返回会议摘要、Action Items、风险、决策和确认命令：

```text
确认创建任务 draft_xxx
```

### 4. 确认创建任务

回复：

```text
确认创建任务 draft_xxx
```

预期：Bot 将会议任务、风险、决策写入 MVP 状态和 task pool。真实飞书任务命令未打通时，会明确提示：

```text
已使用本地模拟写入，缺少真实飞书写入权限/命令未打通
```

### 5. 查看项目简报

@Bot：

```text
项目简报
```

预期：Bot 返回目标、进度、任务数量、阻塞数量、风险和 artifact 路径。

### 6. 风险扫描

@Bot：

```text
风险扫描
```

预期：Bot 基于结构化任务规则扫描 P0/P1 缺负责人、缺 dueDate、已过期未完成、Blocked，并返回 Green / Yellow / Red。

## 故障排查

- 没有进入 MVP：确认启动命令里有 `PROJECTPILOT_MVP_MODE=1`
- 没有生成文件：检查 `.runtime/mvp/state.json` 和 `.runtime/mvp/artifacts/`
- 确认命令无效：确认 draft id 完整，例如 `draft_mhxxx_abcd12`
- 群里无回复：先用 `npm run build` 排除编译错误，再检查 lark-cli 事件监听和机器人是否在群里
- 真实飞书写入失败：当前项目空间/任务创建命令还未打通，会自动 mock fallback；后续接入前必须先用 `lark-cli --help` 或 `lark-cli schema ...` 确认命令结构
