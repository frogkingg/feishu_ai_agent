# Project Skills

这个目录放项目级 Skill 草案、能力说明和后续可复用脚本。

当前机器上已经有一组本地 `lark-cli` Skills，位于 `.agents/skills/`。那些更像底层能力说明；本目录面向 ProjectPilot 业务场景，建议沉淀以下类型：

| 类型 | 示例 | 说明 |
| --- | --- | --- |
| 原子 Skill | `lark-doc-create-project-space` | 直接封装一个稳定飞书能力 |
| 编排 Skill | `workflow-meeting-action-items` | 串联多个原子能力形成业务闭环 |
| Demo Skill | `demo-project-kickoff` | 为比赛演示准备的固定路径 |
| 评估 Skill | `eval-project-summary-quality` | 验证输出质量和效果 |

新增 Skill 前先阅读：

- `docs/CAPABILITY_GUIDE.md`
- `docs/SKILL_AUTHORING.md`

推荐先从这三个 Skill 草案开始：

1. `workflow-project-kickoff`：从项目输入创建知识库、任务池和初始计划。
2. `workflow-meeting-action-items`：从会议纪要提取待办并进入确认/创建。
3. `workflow-onboarding-brief`：从项目知识包生成新人上手包。
