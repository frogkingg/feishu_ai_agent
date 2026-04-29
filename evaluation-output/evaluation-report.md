# MeetingAtlas Evaluation Reports

本文件是评测报告入口页，不直接承载 mock fixture 或 real LLM 的完整指标结果。

## 当前可用报告

### 1. Mock Fixture Pipeline Validation

文件：

- `evaluation-output/mock-fixture-evaluation-report.md`

用途：

- 验证人工标签、fixture extraction、workflow、topic clustering、confirmation request 和指标计算是否按预期工作。
- 该报告中的 100% 是 mock fixture 流程通过率，不代表真实 LLM 在未知会议上的准确率。

### 2. Real LLM Evaluation

文件：

- `evaluation-output/real-llm-evaluation-report.md`

状态：

- 尚未提交。
- 需要使用真实模型运行：

```bash
EVALUATION_LLM_PROVIDER=openai-compatible npm run evaluate
```

真实 LLM 报告需要记录 provider、model、runtime、schema validation failures、JSON repair count、false positives 和人工复核备注。

## 重要说明

- 不要把 mock fixture 结果解读为真实模型准确率。
- mock fixture 报告用于证明 P0 pipeline 和评测框架可运行。
- 真实 LLM 效果需要单独复测并人工抽查。

详见 `docs/REAL_LLM_EVALUATION_PLAN.md`。
