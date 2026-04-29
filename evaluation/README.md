# MeetingAtlas Effectiveness Evaluation

This folder contains the offline evaluation set for the competition effect report.
It does not connect to Feishu, does not change `FEISHU_DRY_RUN`, and runs against an
in-memory SQLite database with deterministic fixture LLM outputs by default.

```bash
npm run evaluate
```

The default provider is the fixture-backed mock evaluator. To compare against a real
OpenAI-compatible model manually, set `EVALUATION_LLM_PROVIDER=openai-compatible`
and provide `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Tests always pin the
provider back to `mock`. Real LLM reports are labeled as `Real LLM Extraction
Evaluation` and include provider, model, and runtime.

The command writes:

- `evaluation-output/evaluation-latest.json` (ignored by git)
- `evaluation-output/mock-fixture-evaluation-report.md` for the default mock run
- `evaluation-output/real-llm-evaluation-report.md` for real LLM runs
- `evaluation-output/evaluation-report.md` as a compatibility entry/index

The default report title is `MeetingAtlas P0 Mock Fixture 评测报告`. Its headline
number is a pipeline pass rate for manual labels, fixture extractions, workflow,
topic clustering, confirmation generation, and metric calculation. It is not a
real LLM accuracy claim for unknown meetings. See
`docs/REAL_LLM_EVALUATION_PLAN.md` before using real LLM results in a delivery
report.

The report covers four competition-facing views:

- Fixture/real extraction matching: action items, calendar drafts, decisions,
  topic keywords, and create_kb routing.
- User acceptance proxy: generated confirmations that match the manual labels.
- Efficiency lift: estimated manual processing time versus confirmation review time.
- Scenario coverage: the required edge cases for tasks, schedules, decisions, risks, and KB routing.

The core metric section explicitly reports action item recall, rough action item precision,
owner accuracy, due date accuracy, calendar recall/precision, deadline-vs-calendar accuracy,
knowledge-base trigger accuracy, false positive count, and confirmation burden per meeting.

The efficiency section uses a simple delivery-friendly model:

- Manual action/calendar cleanup: 5-10 minutes per meeting.
- Manual knowledge-base creation for two meetings: 20-30 minutes.
- Agent processing time: measured from the actual evaluation script wall-clock runtime.

Required scenario tags:

- `explicit_action_owner_due`: 明确待办 + 明确负责人 + 明确截止时间
- `explicit_calendar`: 明确日程
- `deadline_not_calendar`: 只有截止时间但不是日程
- `ambiguous_no_task`: 模糊表达，不应该生成任务
- `related_meetings_create_kb`: 两场相关会议应触发 create_kb
- `unrelated_meetings_no_create_kb`: 两场不相关会议不应触发 create_kb
- `decision_without_action`: 有决策但无待办
- `risk_without_owner`: 有风险但无明确负责人

Fixture layout:

```text
evaluation/fixtures/
  manifest.json
  meetings/*.txt
  labels/*.label.json
  extractions/*.extraction.json
```
