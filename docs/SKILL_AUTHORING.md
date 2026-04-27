# Skill 编写规范

这个仓库后续可能会出现很多不同类型的 Skills 或能力调用指引。为了避免变成零散脚本，新增 Skill 时按统一结构写。

## Skill 应该解决什么

一个 Skill 应该封装一类稳定能力，例如：

- 创建项目知识库
- 写入多维表格任务池
- 从会议纪要提取 Action Items
- 创建飞书任务并回写状态
- 生成新人上手包
- 汇总项目周报

不要把多个无关流程塞进一个 Skill。可以用工作流 Skill 编排多个原子 Skill。

## 推荐目录

```text
skills/
└── skill-name/
    ├── SKILL.md
    ├── references/
    │   └── api-or-cli-notes.md
    ├── examples/
    │   ├── input.json
    │   └── output.json
    └── scripts/
        └── helper.ts
```

## SKILL.md 模板

```md
# Skill Name

## 适用场景

说明用户什么时候应该调用这个 Skill。

## 输入

- 字段：
- 类型：
- 是否必填：

## 输出

- 字段：
- 类型：
- 写入位置：

## 调用步骤

1. 校验输入。
2. 查询必要上下文。
3. 执行飞书能力调用。
4. 写入结果。
5. 返回成功摘要和可追溯链接。

## 权限和配置

- 需要的 lark-cli 配置：
- 需要的 scope：
- 需要的环境变量：

## 失败处理

- 权限不足：
- 找不到人员：
- 找不到文档：
- 重复写入：
- API 超时：

## 验收标准

- 可运行命令：
- 预期输出：
- 飞书侧验证点：
```

## 命名约定

- 原子能力：`lark-doc-create-project-space`
- 工作流能力：`workflow-meeting-action-items`
- Demo 能力：`demo-project-kickoff`

## 输入输出约定

所有跨 Agent 或跨 Skill 的结构化输出优先使用 JSON，至少包含：

```json
{
  "project_id": "",
  "source": {
    "type": "meeting_note",
    "url": ""
  },
  "items": [],
  "writes": [],
  "warnings": []
}
```

## 验收要求

每个 Skill 至少补齐：

1. 一个最小输入样例。
2. 一个成功输出样例。
3. 需要的飞书权限。
4. 失败时的降级策略。
5. Demo 中如何展示它的价值。
