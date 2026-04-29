import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateEvaluationMetrics,
  calculateMatchStats,
  readEvaluationFixtureSet,
  runEffectivenessEvaluation,
  type EffectivenessEvaluationResult,
  type SampleEvaluation
} from "../../scripts/evaluate-fixtures";

function makeSample(overrides: Partial<SampleEvaluation>): SampleEvaluation {
  return {
    id: "sample",
    title: "Sample",
    notes: "test sample",
    topic_action: "observe",
    expected_should_create_kb: false,
    generated_create_kb: false,
    kb_route_correct: true,
    action_items: calculateMatchStats(0, 0, 0),
    calendar_drafts: calculateMatchStats(0, 0, 0),
    action_owner: { expected: 0, correct: 0, accuracy: 1 },
    action_due_date: { expected: 0, correct: 0, accuracy: 1 },
    decisions: calculateMatchStats(0, 0, 0),
    risks: calculateMatchStats(0, 0, 0),
    topic_keywords: calculateMatchStats(0, 0, 0),
    covered_scenarios: [],
    generated_confirmations: 0,
    accepted_confirmations: 0,
    false_positive_confirmations: 0,
    issues: [],
    ...overrides
  };
}

describe("effectiveness evaluation", () => {
  let result: EffectivenessEvaluationResult;

  beforeAll(async () => {
    result = await runEffectivenessEvaluation({
      writeOutputs: false,
      generatedAt: "2026-04-29T00:00:00.000Z",
      llmProvider: "mock"
    });
  });

  function sampleById(id: string): SampleEvaluation {
    const sample = result.samples.find((item) => item.id === id);
    expect(sample).toBeDefined();
    return sample!;
  }

  it("reads fixtures, labels, and fixture extractions", () => {
    const fixtures = readEvaluationFixtureSet();
    const droneIndex = fixtures.manifest.findIndex((item) => item.id === "drone_01");
    const noActionIndex = fixtures.manifest.findIndex(
      (item) => item.id === "no_action_chitchat_01"
    );

    expect(fixtures.manifest).toHaveLength(8);
    expect(fixtures.labels).toHaveLength(fixtures.manifest.length);
    expect(fixtures.extractions).toHaveLength(fixtures.manifest.length);
    expect(fixtures.meetingTexts).toHaveLength(fixtures.manifest.length);
    expect(droneIndex).toBeGreaterThanOrEqual(0);
    expect(noActionIndex).toBeGreaterThanOrEqual(0);
    expect(fixtures.meetingTexts[droneIndex]).toContain("无人机");
    expect(fixtures.labels[droneIndex]?.expected_action_items[0]).toMatchObject({
      owner: "张三",
      due_date: "2026-05-01"
    });
    expect(fixtures.extractions[droneIndex]?.action_items[0]?.title).toContain("无人机");
    expect(fixtures.labels[noActionIndex]?.expected_action_items).toEqual([]);
    expect(fixtures.labels[noActionIndex]?.expected_calendar_drafts).toEqual([]);
  });

  it("calculates match stats and aggregate metrics", () => {
    expect(calculateMatchStats(2, 3, 1)).toMatchObject({
      expected: 2,
      predicted: 3,
      matched: 1,
      false_positives: 2,
      recall: 0.5
    });
    expect(calculateMatchStats(2, 3, 1).precision).toBeCloseTo(1 / 3);
    expect(calculateMatchStats(0, 0, 0).recall).toBe(1);
    expect(calculateMatchStats(0, 0, 0).precision).toBe(1);

    const metrics = calculateEvaluationMetrics(
      [
        makeSample({
          id: "deadline-ok",
          action_items: calculateMatchStats(2, 3, 1),
          action_owner: { expected: 2, correct: 1, accuracy: 0.5 },
          action_due_date: { expected: 1, correct: 1, accuracy: 1 },
          decisions: calculateMatchStats(1, 1, 1),
          risks: calculateMatchStats(1, 1, 0),
          topic_keywords: calculateMatchStats(2, 2, 1),
          covered_scenarios: ["deadline_not_calendar"],
          generated_confirmations: 3,
          accepted_confirmations: 2,
          false_positive_confirmations: 1
        }),
        makeSample({
          id: "calendar-and-kb-fp",
          calendar_drafts: calculateMatchStats(1, 2, 1),
          expected_should_create_kb: false,
          generated_create_kb: true,
          kb_route_correct: false,
          generated_confirmations: 2,
          accepted_confirmations: 1,
          false_positive_confirmations: 1
        })
      ],
      [{ expected_should_create_kb: false }, { expected_should_create_kb: true }],
      30
    );

    expect(metrics.samples).toBe(2);
    expect(metrics.expected_units).toBe(9);
    expect(metrics.matched_units).toBe(5);
    expect(metrics.overall_accuracy).toBeCloseTo(5 / 9);
    expect(metrics.action_item_recall).toBe(0.5);
    expect(metrics.action_item_precision).toBeCloseTo(1 / 3);
    expect(metrics.owner_accuracy).toBe(0.5);
    expect(metrics.due_date_accuracy).toBe(1);
    expect(metrics.calendar_recall).toBe(1);
    expect(metrics.calendar_precision).toBe(0.5);
    expect(metrics.deadline_vs_calendar_accuracy).toBe(1);
    expect(metrics.knowledge_base_trigger_accuracy).toBe(0.5);
    expect(metrics.false_positive_count).toBe(4);
    expect(metrics.confirmation_burden_per_meeting).toBe(2.5);
    expect(metrics.user_acceptance_proxy).toBe(0.6);
    expect(metrics.agent_minutes_estimate).toBe(0.5);
  });

  it("passes the offline fixture evaluation without writing reports", () => {
    expect(result.status).toBe("passed");
    expect(result.dry_run_only).toBe(true);
    expect(result.llm_provider).toBe("mock");
    expect(result.evaluation_context).toEqual({
      evaluation_type: "mock_fixture_pipeline",
      provider: "mock",
      model: "fixture extraction corpus"
    });
    expect(result.metrics.samples).toBe(8);
    expect(result.metrics.overall_accuracy).toBe(1);
    expect(result.metrics.action_item_recall).toBe(1);
    expect(result.metrics.action_item_precision).toBe(1);
    expect(result.metrics.owner_accuracy).toBe(1);
    expect(result.metrics.due_date_accuracy).toBe(1);
    expect(result.metrics.calendar_recall).toBe(1);
    expect(result.metrics.calendar_precision).toBe(1);
    expect(result.metrics.deadline_vs_calendar_accuracy).toBe(1);
    expect(result.metrics.knowledge_base_trigger_accuracy).toBe(1);
    expect(result.metrics.risk_recall).toBe(1);
    expect(result.metrics.false_positive_count).toBe(0);
    expect(result.metrics.confirmation_burden_per_meeting).toBe(15 / 8);
    expect(result.metrics.agent_runtime_seconds).toBeGreaterThanOrEqual(0);
    expect(result.metrics.manual_meeting_minutes_min).toBe(40);
    expect(result.metrics.manual_meeting_minutes_max).toBe(80);
    expect(result.metrics.manual_kb_minutes_min).toBe(40);
    expect(result.metrics.manual_kb_minutes_max).toBe(60);
    expect(result.metrics.manual_total_minutes_min).toBe(80);
    expect(result.metrics.manual_total_minutes_max).toBe(140);
    expect(result.metrics.agent_minutes_estimate).toBe(result.metrics.agent_runtime_seconds / 60);
    expect(result.metrics.minutes_saved_estimate).toBeGreaterThan(0);
    expect(result.metrics.efficiency_lift).toBeGreaterThan(0.99);
    expect(result.metrics.user_acceptance_proxy).toBe(1);
    expect(result.metrics.false_positive_confirmations).toBe(0);
    expect(result.metric_definitions.action_item_recall).toContain("人工标注 action item");
    expect(result.scenario_coverage.missing).toEqual([]);
    expect(result.scenario_coverage.covered).toEqual(result.scenario_coverage.required);
    expect(result.report_paths).toEqual({
      json: null,
      markdown: null
    });
  });

  it("keeps the deadline-vs-calendar case as an action item only", () => {
    const sample = sampleById("deadline_vs_calendar_01");

    expect(sample.covered_scenarios).toContain("deadline_not_calendar");
    expect(sample.action_items.predicted).toBe(1);
    expect(sample.action_items.matched).toBe(1);
    expect(sample.calendar_drafts.predicted).toBe(0);
    expect(sample.generated_confirmations).toBe(1);
    expect(result.metrics.deadline_vs_calendar_accuracy).toBe(1);
  });

  it("does not generate action confirmation for no_action_chitchat", () => {
    const sample = sampleById("no_action_chitchat_01");

    expect(sample.action_items.predicted).toBe(0);
    expect(sample.calendar_drafts.predicted).toBe(0);
    expect(sample.generated_create_kb).toBe(false);
    expect(sample.generated_confirmations).toBe(0);
    expect(sample.false_positive_confirmations).toBe(0);
  });

  it("triggers create_kb after the two drone meetings", () => {
    const firstDrone = sampleById("drone_01");
    const secondDrone = sampleById("drone_02");

    expect(firstDrone.generated_create_kb).toBe(false);
    expect(firstDrone.kb_route_correct).toBe(true);
    expect(secondDrone.expected_should_create_kb).toBe(true);
    expect(secondDrone.generated_create_kb).toBe(true);
    expect(secondDrone.topic_action).toBe("ask_create");
    expect(secondDrone.kb_route_correct).toBe(true);
  });

  it("labels mock reports as fixture pipeline validation, not real model accuracy", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "meeting-atlas-eval-"));
    try {
      const reportResult = await runEffectivenessEvaluation({
        outputDir,
        writeOutputs: true,
        generatedAt: "2026-04-29T00:00:00.000Z",
        llmProvider: "mock"
      });
      expect(reportResult.report_paths.markdown).not.toBeNull();

      const markdown = readFileSync(reportResult.report_paths.markdown!, "utf8");
      expect(markdown).toContain("Mock Fixture 流程通过率：100.0% (50/50)");
      expect(markdown).toContain("不代表真实 LLM 在未知会议上的准确率");
      expect(markdown).toMatch(/不代表真实 LLM.*准确率/);
      expect(markdown).toContain("Mock dry-run 自动化耗时：");
      expect(markdown).toContain(
        "该耗时不包含真实 LLM 延迟、真实飞书 API 延迟和用户确认等待时间。"
      );
      expect(markdown).toContain(
        "当前自动化链路展示了理论节省上界；真实节省比例需用真实 LLM 和真实用户确认链路复测。"
      );
      expect(markdown).toContain("上界估算，不作为真实节省比例结论");
      expect(markdown).toContain("## 局限性");
      expect(markdown).toContain("当前 mock 评测使用预置 extraction，不代表真实 LLM 准确率。");
      expect(markdown).toContain("当前样本只有 8 条，只证明 P0 场景覆盖。");
      expect(markdown).toContain("Precision 使用标题包含匹配和字段精确匹配，是工程化粗略估算。");
      expect(markdown).toContain("效率提升基于人工耗时假设，不是真实用户工时审计。");
      expect(markdown).toContain("当前不覆盖真实飞书权限、真实卡片发送、真实任务/日程/Wiki 创建。");
      expect(markdown).toContain(
        "真实效果需要使用 `EVALUATION_LLM_PROVIDER=openai-compatible` 复测。"
      );
      expect(markdown).not.toContain("总体准确率");
      expect(markdown).not.toContain("估算节省时间：100.0%");
      expect(markdown).not.toContain("Estimated efficiency lift");
      expect(markdown).not.toContain("100.0% efficiency lift");
      expect(markdown).not.toContain("Real LLM Extraction Evaluation");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
