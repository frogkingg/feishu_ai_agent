# MeetingAtlas 评测报告入口

生成时间：2026-04-29T12:43:27.632Z

当前默认 `npm run evaluate` 生成的是 mock fixture pipeline validation，不代表真实 LLM 在未知会议上的准确率。

- 当前主报告：`evaluation-output/mock-fixture-evaluation-report.md`
- Mock fixture 报告：`evaluation-output/mock-fixture-evaluation-report.md`
- 真实 LLM 报告：`evaluation-output/real-llm-evaluation-report.md`

真实 LLM 评测运行方式：

```bash
EVALUATION_LLM_PROVIDER=openai-compatible npm run evaluate
```

详见 `docs/REAL_LLM_EVALUATION_PLAN.md`。
