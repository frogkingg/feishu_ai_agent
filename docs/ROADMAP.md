# 路线图

## P0.5：群聊 Agent 稳定性修复

目标：先把 ProjectPilot 调整成可靠的状态化 PM 同事 Agent，解决上下文污染、状态误承接和工具误触发。

- [ ] Topic Store：按 `chat_id` 管理多个 topic，而不是全局 pending/recent activity
- [ ] Topic 状态机：支持 `observing / proposed / confirming / committed / updating / closed`
- [ ] 两段式路由：先 Router 判断 topic 和动作，再交给日程/任务/项目/聊天 Specialist Skill
- [ ] 短上下文切片：只把当前 topic 的证据和相关消息给模型
- [ ] 时间解析剥离：用确定性解析层处理上海时区时间，避免下午时间被转成凌晨
- [ ] 工具安全闸：飞书写入必须有 grounding evidence，玩笑/辱骂/反讽不能触发工具
- [ ] DeepSeek V4-Pro 切换验证：结构化路由使用 JSON Output，必要时再接 strict tool calls
- [ ] 群聊 smoke test：覆盖聚餐、会议、改参与人、普通吐槽、@ 自然聊天

## P0：跑通项目推进闭环

目标：能在 Demo 中展示 ProjectPilot 如何从项目输入到任务和知识库更新。

- [ ] 立项文本解析：项目名称、目标、截止时间、成员和分工
- [ ] 创建项目知识库和项目总览
- [ ] 创建多维表格任务池、风险表和节点表
- [ ] Planner Agent 生成节点、模块、任务和子任务草案
- [ ] Meeting Agent 从纪要提取 Action Items、决策和风险
- [ ] Task Agent 创建飞书任务并回写任务池
- [ ] Project Agent 更新项目总览、进度和风险
- [ ] IM 推送项目简报

## P1：新人/中途加入上手

目标：证明同一套项目知识包可以支持第二个场景入口。

- [ ] 识别新人加入或用户请求上手包
- [ ] 汇总项目背景、当前进度、关键决策和风险
- [ ] 推荐必读文档和当前相关任务
- [ ] 在群聊或私聊中主动分发上手包

## P2：主动风险和周期报告

目标：从被动响应升级为低频主动维护。

- [ ] 定时扫描逾期、无负责人、依赖阻塞
- [ ] 生成项目日报 / 周报 / 阶段复盘
- [ ] 汇总会议和任务变化
- [ ] 自动维护风险表和变更日志

## 工程化补齐

- [ ] 给核心解析逻辑补单元测试
- [ ] 把飞书 CLI 调用封装为稳定 adapter
- [ ] 为每类能力补输入输出样例
- [ ] 补 GitHub Actions 的 build/test 检查
- [ ] 明确 Demo 环境 bootstrap 步骤
