# 如何教会 ProjectPilot 新流程与能力

这份文档回答一个问题：当我们希望 ProjectPilot 像真人同事一样学会新的飞书协作流程时，团队应该怎么做。

核心原则：不要直接把一大段 prompt 塞进系统里。先定义同事式流程，再封装工具，最后接到 Agent 路由和本机部署链路。

## 能力的三层

| 层级 | 作用 | 产物 |
| --- | --- | --- |
| 流程层 | 定义它应该如何理解、追问、确认和回群 | 能力规格文档 / Issue |
| 工具层 | 真正调用飞书 API、lark-cli、LLM 或本地服务 | `src/tools/*` 或 Skill |
| 路由层 | 判断一条群消息应该进入哪个能力 | Agent router / workflow |

模型负责理解和生成，飞书 API 负责执行动作。写入动作必须能追溯到明确工具调用，不能只靠模型声称“我已经做了”。

## 新能力交付流程

```text
建 Capability Issue
-> 写能力规格
-> 补工具实现
-> 接入 Agent 路由
-> 本地构建
-> 飞书侧 smoke test
-> PR 合并
-> 本机 deploy:local
-> 群内同步验收结果
```

## 能力规格必须写清楚什么

每个能力都先按模板写规格，模板见：

- [`docs/templates/CAPABILITY_SPEC.md`](templates/CAPABILITY_SPEC.md)

最少要回答：

1. 用户会怎么说。
2. Agent 应该怎么判断这是这个能力。
3. 哪些信息可以自动补全。
4. 哪些信息不够时必须追问。
5. 哪些情况必须先确认，不能直接写入。
6. 调用哪个飞书能力或本地工具。
7. 成功后如何回群。
8. 失败时如何解释和降级。

## 推荐代码形态

当前最小版本还集中在 `src/index.ts`，后续新增能力时优先拆成下面的形态：

```text
src/
├── agent/
│   ├── router.ts
│   └── workflows.ts
├── capabilities/
│   ├── calendar-create.ts
│   ├── task-create.ts
│   └── meeting-action-items.ts
└── tools/
    ├── lark-calendar.ts
    ├── lark-im.ts
    ├── lark-task.ts
    └── lark-doc.ts
```

推荐能力接口：

```ts
type Capability = {
  name: string;
  match: (message: IncomingMessage) => boolean;
  collect: (message: IncomingMessage) => ParsedInput;
  askMissing: (input: ParsedInput) => string | undefined;
  execute: (input: ParsedInput) => Promise<CapabilityResult>;
  reply: (result: CapabilityResult) => string;
};
```

这样每个新能力都是一个可独立评审、测试和回滚的模块。

## 写入动作的安全分级

| 类型 | 示例 | 策略 |
| --- | --- | --- |
| 只回复 | 解释项目状态、总结背景 | 可以直接回复 |
| 轻写入 | 创建个人日程、创建草稿任务 | 信息明确时可直接执行，回群确认 |
| 协作写入 | 给别人分配任务、邀请参会人、写项目知识库 | 需要明确对象和影响范围 |
| 高风险写入 | 删除、覆盖、批量变更 | 必须先确认，必要时 dry-run |

## 当前已接入能力示例：创建日程

触发示例：

```text
明天下午3点创建日程「项目同步会」
```

当前处理方式：

1. 规则判断是创建日程意图。
2. 解析标题、日期、开始时间、默认 30 分钟时长。
3. 信息明确时调用 `lark-cli calendar +create --as user`。
4. 用 bot 身份回群确认。
5. 信息不足时追问明确开始时间。

后续增强方向：

- 支持参会人识别。
- 支持模糊时间推荐。
- 支持会议室候选。
- 支持创建前确认策略。
- 支持从群上下文推断标题和项目。

## 队友如何贡献

1. 从 GitHub 新建 `Capability Request` Issue。
2. 复制能力规格模板，写清楚流程。
3. 开分支实现，不直接改本机生产环境。
4. PR 中必须勾选 `npm run build`，并写明飞书侧 smoke test。
5. 合并后由本机值守同学运行：

```bash
cd /Users/henryxian/Documents/飞书比赛
npm run deploy:local
```

## PR 验收清单

- `npm run build` 通过。
- 新能力有规格说明或 Issue 链接。
- 涉及飞书写入时说明身份类型：`bot` 或 `user`。
- 涉及权限时列出 scope。
- 有一条群聊测试口令。
- 成功和失败回复都不声称未执行的动作已经完成。
