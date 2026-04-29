# MeetingAtlas Real LLM Evaluation Plan

本文档说明如何在 mock fixture pipeline validation 之外，单独运行真实 LLM 抽取评测。默认 `npm run evaluate` 仍使用 mock fixture，不调用真实模型，不连接真实飞书写入。

## 为什么 Mock Fixture 不等于真实 LLM 准确率

Mock fixture 评测使用人工维护的 extraction JSON。它验证的是：

- fixture 会议文本、人工 label 和 extraction 是否一致。
- `MeetingExtractionAgent` 的 mock provider 是否能把预置 extraction 接入 workflow。
- `processMeetingWorkflow`、topic clustering、confirmation request 生成和指标计算是否按预期工作。
- P0 场景是否被固定样本覆盖。

因此，mock fixture 的 100% 是流程通过率，不是模型在未知会议上的泛化准确率。真实 LLM 可能受到模型版本、上下文长度、temperature、JSON 输出稳定性、schema 校验、网络延迟和 prompt 解释差异影响，必须单独复测并人工抽查。

## 如何运行真实 LLM 评测

真实 LLM 评测只替换抽取层，仍保持 dry-run workflow，不真实发送飞书卡片，不真实创建任务、日程、Wiki 或 Doc。

```bash
EVALUATION_LLM_PROVIDER=openai-compatible npm run evaluate
```

运行前需要在本机安全配置：

```bash
LLM_BASE_URL=https://your-provider.example.com/api/v3
LLM_API_KEY=your-api-key
LLM_MODEL=your-model
```

不要把 `.env`、API Key、数据库文件或真实用户数据提交到仓库。

## 输出文件

- Mock fixture 默认报告：`evaluation-output/mock-fixture-evaluation-report.md`
- 真实 LLM 报告：`evaluation-output/real-llm-evaluation-report.md`
- 兼容入口：`evaluation-output/evaluation-report.md`
- 机器可读 JSON：`evaluation-output/evaluation-latest.json`，已被 `.gitignore` 忽略

真实 LLM 报告应使用 `Real LLM Extraction Evaluation` 语义，不与 mock fixture 流程通过率混写为同一个准确率结论。

## 真实 LLM 评测需要记录

每次真实 LLM 复测至少记录：

- `provider`
- `model`
- `runtime`
- schema validation failures
- JSON repair count
- action/calendar/KB trigger 指标
- false positives
- 手工复核备注

这些信息用于判断失败来自模型抽取、JSON 结构、workflow 路由，还是人工标注和样本边界。

## 避免评测过拟合原则

真实 LLM 评测优化必须服务于产品泛化能力，而不是服务于固定 fixture 得分。

- 不得为了提高评测分数加入领域专属 hardcode，例如直接判断 drone、product、campus 或某个具体 fixture 的标题、人物、会议 ID、文件名、固定句式。
- 允许增强通用规则，例如弱表达过滤、action item 判断门槛、decision/risk 定义、deadline-vs-calendar 区分、两场相关会议后触发 `create_kb`。
- 不允许为无人机、产品评审、校园比赛等具体样本写死路由或抽取结果；这些样本只能用于暴露规则问题，不能成为规则本身。
- 对真实 LLM 复测，报告必须保留失败样本、false positives、schema/JSON 修复信息和人工复核备注，不能通过删除 label、放宽 expected 或隐藏错例来制造通过结论。
- 每次 prompt/router 调整后，应同时检查 mock fixture pipeline 和真实 LLM 报告，确认提升来自通用抽取或路由能力，而不是对评测集的记忆。

## 首轮真实 LLM 评测错例与修复方向

首轮真实 LLM 评测结果为 failed：Extraction evaluation score 66.0% (33/50)，主要问题集中在 action item 误报、decision/risk 召回不足，以及首场产品评审误触发 `create_kb`。

本轮修复方向：

- `product_review_01` 首场主题会议只能进入 observe。Topic clustering 只把原始会议转写中的“整理成知识库 / 建知识库 / 归档知识库”等当作显式知识库意图，不再因为 LLM extraction 里推断出“创建知识库”就直接触发 `ask_create`。
- 非显式知识库意图下，必须存在至少一场强相关历史会议，才允许 `ask_create`。强相关判断使用通用的标题/关键词主题信号重叠，不再依赖单一无人机场景 hardcode。
- `ambiguous_schedule_01` 这类“下周找个时间沟通 / 对齐 / 同步”的表达，应生成缺少 `start_time` 的 calendar draft，并把 `start_time` 放入 `missing_fields`；不能生成 action item。
- Action item 抽取必须有明确责任人或动作主体，并且有可交付物或可完成动作；“需要关注”“可以看看”“后续整理”“建立 SOP”如果缺 owner 或 due date，优先作为 decision/risk，而不是待办。
- Decision 抽取覆盖“决定 / 确认 / 一致认为 / 本次先 / 暂不 / 范围收敛为 / 不做 X 先做 Y / 不再新增字段”等范围和策略取舍，每条必须带 evidence。
- Risk 抽取覆盖“风险 / 阻塞 / 不确定 / 权限分散 / 流程不统一 / 可能影响 / 担心 / 如果……会…… / 缺少……”等表达；risk 不要求 owner，不能为了补 action 而强行转为待办。

复测方式保持不变：

```bash
EVALUATION_LLM_PROVIDER=openai-compatible npm run evaluate
```

复测仍然只替换抽取层，workflow 使用内存 SQLite 和 dry-run confirmation，不连接真实飞书写入，也不修改 `FEISHU_DRY_RUN`。

## 合并前人工抽查

真实 LLM 报告合并前需要人工抽查样本输出：

- 检查每条 action item 是否真的来自会议文本。
- 检查 owner、due date、calendar start_time 是否与人工 label 一致。
- 检查 deadline-vs-calendar 是否没有把截止时间误判成日程。
- 检查 create_kb 触发是否只发生在相关会议对之后。
- 检查 false positive 是否会造成用户确认负担。
- 检查报告中是否明确说明真实 LLM provider、model、运行时间和局限性。

只有完成上述抽查后，真实 LLM 指标才适合作为比赛材料中的效果验证补充。mock fixture 报告只能作为 P0 pipeline validation 证据。
