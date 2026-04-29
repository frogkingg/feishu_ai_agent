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

## 合并前人工抽查

真实 LLM 报告合并前需要人工抽查样本输出：

- 检查每条 action item 是否真的来自会议文本。
- 检查 owner、due date、calendar start_time 是否与人工 label 一致。
- 检查 deadline-vs-calendar 是否没有把截止时间误判成日程。
- 检查 create_kb 触发是否只发生在相关会议对之后。
- 检查 false positive 是否会造成用户确认负担。
- 检查报告中是否明确说明真实 LLM provider、model、运行时间和局限性。

只有完成上述抽查后，真实 LLM 指标才适合作为比赛材料中的效果验证补充。mock fixture 报告只能作为 P0 pipeline validation 证据。
