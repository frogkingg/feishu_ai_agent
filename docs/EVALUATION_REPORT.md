# MeetingAtlas Evaluation Report

本文档记录当前 mock fixture 流程验证结果，用于比赛交付物中的效果验证章节。完整机器生成报告见 `evaluation-output/mock-fixture-evaluation-report.md`。

重要边界：默认 `mock` 评测使用人工维护的 fixture extraction，不代表真实 LLM 在未知会议上的准确率。它证明的是人工标签、fixture extraction、workflow、topic clustering、confirmation 生成和指标计算可以按预期跑通。这不是线上生产效果，不是大规模泛化准确率。真实 LLM 抽取效果需要使用 `EVALUATION_LLM_PROVIDER=openai-compatible` 另行复测，计划见 `docs/REAL_LLM_EVALUATION_PLAN.md`。

## 为什么要评测

MeetingAtlas 的 P0 能力包括会议抽取、确认请求、dry-run 卡片、任务/日程 dry-run 创建，以及两场相关会议后的 create_kb 建议。评测用于证明：

- 抽取结果是否足够准确。
- confirmation request 是否会增加可接受的确认负担，而不是制造噪音。
- topic clustering 是否能区分相关会议和不相关会议。
- Agent 相比人工整理会议和知识库是否有明显效率提升。

## 评测设置

| Item                | Value                                                 |
| ------------------- | ----------------------------------------------------- |
| Command             | `npm run evaluate`                                    |
| Provider            | `mock` fixture extraction                             |
| Generated at        | `2026-04-29T12:43:27.632Z`                            |
| Write mode          | dry-run only                                          |
| Fixture count       | 8 meetings                                            |
| JSON output         | `evaluation-output/evaluation-latest.json`            |
| Markdown output     | `evaluation-output/mock-fixture-evaluation-report.md` |
| Compatibility entry | `evaluation-output/evaluation-report.md`              |

本轮未连接真实飞书，未修改 `FEISHU_DRY_RUN`，未创建真实任务、日程或知识库。

## 样本设计

| Sample                    | Expected behavior                                                    |
| ------------------------- | -------------------------------------------------------------------- |
| `drone_01`                | 抽取明确 action、owner、due date 和明确 calendar；首场主题只 observe |
| `drone_02`                | 与 `drone_01` 相关，触发 create_kb；抽取决策和风险                   |
| `product_review_01`       | 与前两场无人机场景不相关，不触发 create_kb                           |
| `product_review_02`       | 与 `product_review_01` 相关，触发 create_kb                          |
| `campus_competition_01`   | 多 action、多 owner、明确彩排日程和 Demo 范围决策                    |
| `no_action_chitchat_01`   | 闲聊，不生成 action/calendar/kb                                      |
| `ambiguous_schedule_01`   | 模糊时间表达，不生成任务；有决策但无待办；有风险但无负责人           |
| `deadline_vs_calendar_01` | 截止时间不是会议，应生成 action 而不是 calendar                      |

关键场景覆盖：8/8。

## 指标定义

| Metric                          | Definition                                                              |
| ------------------------------- | ----------------------------------------------------------------------- |
| Action item recall              | 人工标注 action item 中，标题被生成结果命中的比例。                     |
| Action item precision           | 生成 action item 中，标题能命中人工标注的比例；粗略估算。               |
| Owner accuracy                  | 带 owner 标注的 action item 中，标题命中且 owner 完全一致的比例。       |
| Due date accuracy               | 带 due_date 标注的 action item 中，标题命中且 due date 完全一致的比例。 |
| Calendar recall                 | 人工标注 calendar draft 中，标题和 start_time 被生成结果命中的比例。    |
| Calendar precision              | 生成 calendar draft 中，能命中人工标注 calendar draft 的比例。          |
| Deadline-vs-calendar accuracy   | 截止时间不是日程的样本中，没有错误生成 calendar draft 的比例。          |
| Knowledge base trigger accuracy | expected_should_create_kb 与实际 ask_create 是否一致的比例。            |
| False positive count            | 未命中人工标注的 action/calendar 生成项，加上误触发 create_kb 的数量。  |
| Confirmation burden             | 平均每场会议生成的 confirmation request 数量。                          |

## 当前 Mock Fixture 流程验证结果

| Metric                              | Result          |
| ----------------------------------- | --------------- |
| Samples                             | 8               |
| Mock fixture pipeline pass rate     | 100.0% (50/50)  |
| Fixture action item recall          | 100.0%          |
| Fixture action item precision       | 100.0%          |
| Fixture owner match                 | 100.0%          |
| Fixture due date match              | 100.0%          |
| Fixture calendar recall / precision | 100.0% / 100.0% |
| Deadline-vs-calendar route check    | 100.0%          |
| Knowledge base trigger route check  | 100.0%          |
| Fixture decision recall             | 100.0%          |
| Fixture risk recall                 | 100.0%          |
| Fixture topic keyword recall        | 100.0%          |
| False positive count                | 0               |
| Confirmation burden                 | 1.88 / meeting  |
| User acceptance proxy               | 100.0% (15/15)  |

解释：上表中的 100.0% 是 mock fixture pipeline 对固定人工标签的通过率，不是“模型准确率”。它可以用于证明评测框架和 P0 workflow 可复现，但不能直接作为真实 LLM 泛化表现。这不是线上生产效果，不是大规模泛化准确率。

## 效率提升估算

估算模型：

- 人工整理一场会议待办和日程：约 5-10 分钟。
- 人工创建知识库并整理两场会议：约 20-30 分钟。
- Agent dry-run 完整处理：使用脚本实际运行时间。

当前结果：

| Item                            | Result                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| Meetings                        | 8                                                               |
| Expected create_kb triggers     | 2                                                               |
| Manual meeting cleanup          | 40.0 - 80.0 minutes                                             |
| Manual KB creation              | 40.0 - 60.0 minutes                                             |
| Manual total                    | 80.0 - 140.0 minutes                                            |
| Manual midpoint                 | 110.0 minutes                                                   |
| Mock dry-run automation runtime | 0.02 seconds                                                    |
| Theoretical manual time avoided | 80.0 - 140.0 minutes                                            |
| Efficiency interpretation       | Estimated automation upper bound, not real-world audited saving |

解释：mock 评测使用 fixture extraction，因此 automation runtime 极短。该耗时不包含真实 LLM 延迟、真实飞书 API 延迟和用户确认等待时间。基于人工耗时模型，当前自动化链路只展示理论节省上界；真实节省比例需要用真实 LLM 和真实用户确认链路复测。

## 如何运行

```bash
npm run evaluate
```

输出：

```text
evaluation-output/evaluation-latest.json
evaluation-output/mock-fixture-evaluation-report.md
evaluation-output/evaluation-report.md
```

JSON 文件用于机器读取，已被 `.gitignore` 忽略；mock fixture Markdown 报告可提交。`evaluation-output/evaluation-report.md` 是兼容入口，用来说明当前默认报告是 mock fixture，真实 LLM 报告需要另跑。

## 如何用真实 LLM 复测

```bash
EVALUATION_LLM_PROVIDER=openai-compatible \
LLM_BASE_URL=https://your-provider.example.com/api/v3 \
LLM_API_KEY=your-api-key \
LLM_MODEL=your-model \
npm run evaluate
```

复测说明：

- 真实 LLM 复测仍然只运行 dry-run workflow。
- 脚本会调用现有 `MeetingExtractionAgent`，再进入 `processMeetingWorkflow` 和 topic clustering。
- 真实模型报告会显示 `Real LLM Extraction Evaluation`、provider、model 和运行时间。
- 真实模型报告输出到 `evaluation-output/real-llm-evaluation-report.md`。
- 真实模型可能降低或提高指标，报告会保留同一套字段定义，便于与 mock fixture pipeline 对比。
- 自动化测试仍固定为 mock，不依赖真实 LLM。
- 真实 LLM 报告合并前需要人工抽查样本输出，详见 `docs/REAL_LLM_EVALUATION_PLAN.md`。

## 局限性

- 当前样本只有 8 条，适合证明 P0 场景覆盖，不代表大规模生产效果。
- 当前 mock 结果依赖 fixture extraction，主要验证流程、路由和指标计算；不能宣称为真实 LLM 准确率。
- 真实抽取能力需要用 openai-compatible 复测，并在报告中单独标注 provider、model 和运行时间。
- Precision 使用标题包含匹配和字段精确匹配，属于工程化粗略估算。
- 效率提升使用人工耗时假设模型，不是对真实用户的工时审计。
- 当前评测不覆盖真实飞书权限、真实卡片发送、真实任务/日程/Wiki 创建。
