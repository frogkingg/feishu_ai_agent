# MeetingAtlas Evaluation Plan

本文档说明 MeetingAtlas “效果验证报告自动化”的评测设计。目标不是做学术级 benchmark，而是为比赛交付物提供一套可复现、可解释、能证明 P0 价值的离线评测。

## 为什么要评测

MeetingAtlas 的核心承诺是把会议转写转成可确认、可执行、可沉淀的后续动作。只展示 Demo 链路还不够，需要证明三件事：

- 准确性：能否稳定抽取 action items、calendar drafts、decisions、risks、topic keywords，并正确触发 create_kb。
- 用户接受度：生成的 confirmation request 是否大多是用户愿意确认的，而不是制造额外噪音。
- 效率提升：相比人工整理会议待办、日程和知识库，Agent dry-run 链路能节省多少时间。

本评测默认不连接真实飞书，不修改 `FEISHU_DRY_RUN`，不创建真实任务、日程或知识库。

## 样本设计

评测集位于 `evaluation/fixtures/`：

```text
evaluation/fixtures/
  manifest.json
  meetings/*.txt
  labels/*.label.json
  extractions/*.extraction.json
```

当前包含 8 条会议样本：

| Sample                    | 主要目的                                                     |
| ------------------------- | ------------------------------------------------------------ |
| `drone_01`                | 明确待办、负责人、截止时间；明确日程；首场相关会议只 observe |
| `drone_02`                | 第二场无人机相关会议触发 create_kb；包含决策和风险           |
| `product_review_01`       | 产品评审场景，和前序无人机会议不相关，不触发 create_kb       |
| `product_review_02`       | 第二场产品评审相关会议触发 create_kb                         |
| `campus_competition_01`   | 多负责人 action、明确彩排日程、Demo 范围决策                 |
| `no_action_chitchat_01`   | 闲聊场景，不应生成任务、日程或知识库建议                     |
| `ambiguous_schedule_01`   | 模糊时间表达、不生成任务；有决策但无待办；有风险但无负责人   |
| `deadline_vs_calendar_01` | 只有截止时间但不是日程，应生成 action 而不是 calendar        |

必须覆盖的关键场景：

- 明确待办 + 明确负责人 + 明确截止时间。
- 明确日程。
- 只有截止时间但不是日程。
- 模糊表达，不应该生成任务。
- 两场相关会议应触发 create_kb。
- 两场不相关会议不应触发 create_kb。
- 有决策但无待办。
- 有风险但无明确负责人。

每条 label 通过 `covered_scenarios` 声明覆盖场景，脚本会检查覆盖率。

## 指标定义

| Metric                            | Definition                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `action_item_recall`              | 人工标注 action item 中，标题被生成结果命中的比例。                                       |
| `action_item_precision`           | 生成 action item 中，标题能命中人工标注的比例；这是粗略 precision。                       |
| `owner_accuracy`                  | 带 owner 标注的 action item 中，标题命中且 owner 完全一致的比例。                         |
| `due_date_accuracy`               | 带 due_date 标注的 action item 中，标题命中且 due date 完全一致的比例。                   |
| `calendar_recall`                 | 人工标注 calendar draft 中，标题和 start_time 被生成结果命中的比例。                      |
| `calendar_precision`              | 生成 calendar draft 中，能命中人工标注 calendar draft 的比例。                            |
| `deadline_vs_calendar_accuracy`   | 标记为 deadline_not_calendar 的样本中，没有错误生成 calendar draft 的比例。               |
| `knowledge_base_trigger_accuracy` | 每条样本的 expected_should_create_kb 与 topic clustering 实际 ask_create 是否一致的比例。 |
| `false_positive_count`            | 未命中人工标注的 action/calendar 生成项，加上误触发 create_kb 的数量。                    |
| `confirmation_burden_per_meeting` | 平均每场会议生成的 confirmation request 数量。                                            |
| `agent_runtime_seconds`           | 脚本本次评测的实际 wall-clock 运行秒数。                                                  |
| `efficiency_lift`                 | 使用人工耗时中位数估算：`1 - Agent 实际运行分钟 / 人工总耗时中位数`。                     |

## 效率模型

效率提升不是精确工时审计，而是用于比赛说明的保守估算：

- 人工整理一场会议待办和日程：约 5-10 分钟。
- 人工创建知识库并整理两场会议：约 20-30 分钟。
- Agent dry-run 完整处理耗时：由脚本实际 wall-clock 计时。

脚本输出人工会议整理耗时、人工知识库整理耗时、人工总耗时、Agent 耗时、估算节省分钟数和节省比例。

## 如何运行

默认 mock fixture 流程验证：

```bash
npm run evaluate
```

输出：

```text
evaluation-output/evaluation-latest.json
evaluation-output/evaluation-report.md
```

其中 `evaluation-output/evaluation-latest.json` 已加入 `.gitignore`，不提交；`evaluation-output/evaluation-report.md` 可作为阶段产物提交。

自动化测试调用 `runEffectivenessEvaluation({ llmProvider: "mock" })`，因此不会依赖真实 LLM 或本机 `.env`。

默认报告会将核心汇总写为 `Mock Fixture 流程通过率`。这个指标验证人工标签、fixture extraction、workflow、topic clustering、confirmation 生成和指标计算是否按预期工作，不代表真实 LLM 在未知会议上的准确率。

## 当前 Mock Fixture 流程验证结果

当前 mock fixture 结果见 `docs/EVALUATION_REPORT.md` 和 `evaluation-output/evaluation-report.md`。核心结论：

- 8 条样本全部通过。
- 关键场景覆盖：8/8。
- Mock Fixture 流程通过率为 100%。
- Fixture action item、calendar、owner、due date、knowledge base trigger 路由检查均与人工标签一致。
- False positive count 为 0。
- Confirmation burden 为 1.88 / meeting。

这些结果只能证明固定 fixture pipeline 可复现，不能写成真实 LLM 准确率。

## 如何用真实 LLM 复测

真实 LLM 复测只替换模型抽取层，仍保持 dry-run，不连接真实飞书写入。

```bash
EVALUATION_LLM_PROVIDER=openai-compatible \
LLM_BASE_URL=https://your-provider.example.com/api/v3 \
LLM_API_KEY=your-api-key \
LLM_MODEL=your-model \
npm run evaluate
```

说明：

- `EVALUATION_LLM_PROVIDER` 默认是 `mock`。
- 设置为 `openai-compatible` 时，脚本使用现有 `MeetingExtractionAgent` 调用真实兼容模型。
- 真实 LLM 报告会显示 `Real LLM Extraction Evaluation`、provider、model 和运行时间。
- 若缺少 `LLM_BASE_URL`、`LLM_API_KEY` 或 `LLM_MODEL`，配置会 fail fast。
- 测试环境仍固定为 mock，不会因为本机 `.env` 中有真实模型配置而变得不稳定。

## 局限性

- 样本量小，适合 P0 交付证明，不代表泛化到所有会议类型。
- mock 结果使用 fixture extraction，主要验证评测框架、workflow、topic clustering 和指标计算。
- 真实 LLM 复测会受模型版本、temperature、prompt 解析和网络延迟影响。
- 当前 matching 逻辑以 `title_contains`、owner、due_date、start_time 等字段为主，precision 是粗略估算。
- 效率模型是交付说明模型，不是实测人工工时；真实团队习惯会影响节省比例。
- 评测不覆盖真实飞书权限、真实 IM 卡片发送、真实任务/日程/Wiki 创建。
