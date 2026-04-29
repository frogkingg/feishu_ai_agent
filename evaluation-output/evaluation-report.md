# MeetingAtlas 效果验证评测报告

生成时间：2026-04-29T12:35:16.603Z
执行方式：fixture mock extraction + 内存 SQLite；不连接真实飞书，不修改 FEISHU_DRY_RUN。

## Mock Fixture 流程验证

- Mock Fixture 流程通过率：100.0% (50/50)
- 该指标验证：人工标签、fixture extraction、workflow、topic clustering、confirmation 生成和指标计算是否按预期工作。
- 该指标不代表真实 LLM 在未知会议上的准确率，也不应被解读为模型准确率。
- Provider：mock
- Fixture model：fixture extraction corpus
- 运行时间：0.02 秒

## 指标明细

- 样本数：8
- Action item 召回率：100.0%
- Action item precision 粗略估算：100.0%
- Owner 准确率：100.0%
- Due date 准确率：100.0%
- Calendar 召回 / 精确：100.0% / 100.0%
- Deadline-vs-calendar 区分正确率：100.0%
- Knowledge base trigger accuracy：100.0%
- Decision 召回：100.0%
- Risk 召回：100.0%
- Topic keyword 召回：100.0%
- False positive count：0
- Confirmation burden：1.88 / meeting
- 用户接受度代理指标：100.0% (15/15)
- Mock dry-run 自动化耗时：0.02 秒
- 效率说明：当前只展示理论节省上界，真实节省比例需用真实 LLM 和真实用户确认链路复测。

## 效率提升估算

- 人工整理一场会议待办和日程：约 5-10 分钟。
- 人工创建知识库并整理两场会议：约 20-30 分钟。
- 本评测共 8 场会议，预期触发 2 次知识库创建。
- 人工会议整理耗时：40.0 - 80.0 分钟。
- 人工知识库整理耗时：40.0 - 60.0 分钟。
- 人工总耗时估算：80.0 - 140.0 分钟；中位估算 110.0 分钟。
- Mock dry-run 自动化耗时：0.02 秒。
- 该耗时不包含真实 LLM 延迟、真实飞书 API 延迟和用户确认等待时间。
- 基于人工耗时模型，当前自动化链路展示了理论节省上界；真实节省比例需用真实 LLM 和真实用户确认链路复测。
- 理论可节省人工整理时间：80.0 - 140.0 分钟（上界估算，不作为真实节省比例结论）。

## 局限性

- 当前 mock 评测使用预置 extraction，不代表真实 LLM 准确率。
- 当前样本只有 8 条，只证明 P0 场景覆盖。
- Precision 使用标题包含匹配和字段精确匹配，是工程化粗略估算。
- 效率提升基于人工耗时假设，不是真实用户工时审计。
- 当前不覆盖真实飞书权限、真实卡片发送、真实任务/日程/Wiki 创建。
- 真实效果需要使用 `EVALUATION_LLM_PROVIDER=openai-compatible` 复测。

## 指标定义

- action_item_recall: 人工标注 action item 中，标题被生成结果命中的比例。
- action_item_precision: 生成 action item 中，标题能命中人工标注的比例；这是粗略 precision。
- owner_accuracy: 带 owner 标注的 action item 中，标题命中且 owner 完全一致的比例。
- due_date_accuracy: 带 due_date 标注的 action item 中，标题命中且 due date 完全一致的比例。
- calendar_recall: 人工标注 calendar draft 中，标题和 start_time 被生成结果命中的比例。
- calendar_precision: 生成 calendar draft 中，能命中人工标注 calendar draft 的比例。
- deadline_vs_calendar_accuracy: 标记为 deadline_not_calendar 的样本中，没有错误生成 calendar draft 的比例。
- knowledge_base_trigger_accuracy: 每条样本的 expected_should_create_kb 与 topic clustering 实际 ask_create 是否一致的比例。
- false_positive_count: 未命中人工标注的 action/calendar 生成项，加上误触发 create_kb 的数量。
- confirmation_burden_per_meeting: 平均每场会议生成的 confirmation request 数量。
- agent_runtime_seconds: 脚本本次评测的实际 wall-clock 运行秒数。
- efficiency_lift: 使用人工耗时中位数估算：1 - Agent 实际运行分钟 / 人工总耗时中位数。

## 关键场景覆盖

覆盖进度：8/8

- PASS 明确待办 + 明确负责人 + 明确截止时间：drone_01, campus_competition_01
- PASS 明确日程：drone_01, campus_competition_01
- PASS 只有截止时间但不是日程：deadline_vs_calendar_01
- PASS 模糊表达，不应该生成任务：ambiguous_schedule_01
- PASS 两场相关会议应触发 create_kb：drone_02, product_review_02
- PASS 两场不相关会议不应触发 create_kb：product_review_01
- PASS 有决策但无待办：ambiguous_schedule_01
- PASS 有风险但无明确负责人：ambiguous_schedule_01

## 样本明细

### drone_01 - PASS

- 会议：无人机操作方案初步访谈
- 主题路由：observe；create_kb 期望/实际：false/false
- Action：2/2 expected，预测 2
- Owner：2/2 expected
- Due date：1/1 expected
- Calendar：1/1 expected，预测 1
- Decision：0/0 expected
- Risk：1/1 expected
- Keyword：3/3 expected
- 覆盖场景：明确待办 + 明确负责人 + 明确截止时间；明确日程
- Confirmation 接受度：3/3
- 标注说明：首场无人机会议应抽取两个待办和一个明确访谈日程，但只进入主题观察，不创建知识库。

### drone_02 - PASS

- 会议：无人机操作员访谈
- 主题路由：ask_create；create_kb 期望/实际：true/true
- Action：1/1 expected，预测 1
- Owner：1/1 expected
- Due date：1/1 expected
- Calendar：0/0 expected，预测 0
- Decision：1/1 expected
- Risk：1/1 expected
- Keyword：3/3 expected
- 覆盖场景：两场相关会议应触发 create_kb
- Confirmation 接受度：2/2
- 标注说明：第二场无人机会议与第一场强相关，且明确提出整理成知识库，应触发 create_kb confirmation。

### product_review_01 - PASS

- 会议：产品原型评审会
- 主题路由：observe；create_kb 期望/实际：false/false
- Action：1/1 expected，预测 1
- Owner：1/1 expected
- Due date：1/1 expected
- Calendar：1/1 expected，预测 1
- Decision：1/1 expected
- Risk：1/1 expected
- Keyword：3/3 expected
- 覆盖场景：两场不相关会议不应触发 create_kb
- Confirmation 接受度：2/2
- 标注说明：产品评审样本验证行动项、明确日程和关键决策抽取。

### product_review_02 - PASS

- 会议：产品原型复盘同步
- 主题路由：ask_create；create_kb 期望/实际：true/true
- Action：2/2 expected，预测 2
- Owner：2/2 expected
- Due date：2/2 expected
- Calendar：0/0 expected，预测 0
- Decision：1/1 expected
- Risk：0/0 expected
- Keyword：3/3 expected
- 覆盖场景：两场相关会议应触发 create_kb
- Confirmation 接受度：3/3
- 标注说明：复盘同步里有截止时间但无具体会议时间，不应强行创建 calendar draft；由于已连续两场产品评审，按当前策略应建议创建主题知识库。

### campus_competition_01 - PASS

- 会议：校园比赛 Demo 冲刺会
- 主题路由：observe；create_kb 期望/实际：false/false
- Action：2/2 expected，预测 2
- Owner：2/2 expected
- Due date：2/2 expected
- Calendar：1/1 expected，预测 1
- Decision：1/1 expected
- Risk：1/1 expected
- Keyword：3/3 expected
- 覆盖场景：明确待办 + 明确负责人 + 明确截止时间；明确日程
- Confirmation 接受度：3/3
- 标注说明：比赛冲刺会验证多负责人行动项、彩排日程和 Demo 范围决策。

### no_action_chitchat_01 - PASS

- 会议：午后闲聊
- 主题路由：no_action；create_kb 期望/实际：false/false
- Action：0/0 expected，预测 0
- Owner：0/0 expected
- Due date：0/0 expected
- Calendar：0/0 expected，预测 0
- Decision：0/0 expected
- Risk：0/0 expected
- Keyword：0/0 expected
- 覆盖场景：无
- Confirmation 接受度：0/0
- 标注说明：纯闲聊不应生成待办、日程或知识库建议，用来衡量误报。

### ambiguous_schedule_01 - PASS

- 会议：接口对齐沟通
- 主题路由：observe；create_kb 期望/实际：false/false
- Action：0/0 expected，预测 0
- Owner：0/0 expected
- Due date：0/0 expected
- Calendar：1/1 expected，预测 1
- Decision：1/1 expected
- Risk：1/1 expected
- Keyword：2/2 expected
- 覆盖场景：模糊表达，不应该生成任务；有决策但无待办；有风险但无明确负责人
- Confirmation 接受度：1/1
- 标注说明：存在明确沟通意图但没有具体时间，应生成缺少 start_time 的 calendar draft 等待用户确认。

### deadline_vs_calendar_01 - PASS

- 会议：方案截止时间确认
- 主题路由：observe；create_kb 期望/实际：false/false
- Action：1/1 expected，预测 1
- Owner：1/1 expected
- Due date：1/1 expected
- Calendar：0/0 expected，预测 0
- Decision：0/0 expected
- Risk：0/0 expected
- Keyword：2/2 expected
- 覆盖场景：只有截止时间但不是日程
- Confirmation 接受度：1/1
- 标注说明：明确说明周五前是截止时间不是会议，应该只生成 action item，不生成 calendar draft。
