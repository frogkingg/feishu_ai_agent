import { routeMvpCommand } from "../src/mvp/command-router";
import { heuristicProjectSpec } from "../src/mvp/agents/intake-agent";
import { heuristicProjectPlan } from "../src/mvp/agents/planner-agent";
import { heuristicMeetingExtraction } from "../src/mvp/agents/meeting-agent";
import {
  appendTasks,
  buildProjectBrief,
  confirmDraft,
  createPendingDraft,
  loadState,
  saveState,
  upsertProject,
} from "../src/mvp/store";
import { MvpProjectState, nowIso } from "../src/mvp/schemas";

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const original = loadState();
  try {
    const createCommand = routeMvpCommand("@ProjectPilot 创建项目「Smoke Demo」目标：验证 MVP，负责人：Henry");
    assert(createCommand.command === "project_create_request", "创建项目指令识别失败");

    const confirmCommand = routeMvpCommand("确认创建任务 draft_abc123");
    assert(confirmCommand.command === "confirm_draft", "确认指令识别失败");
    assert(confirmCommand.draftId === "draft_abc123", "确认 draftId 识别失败");

    const spec = heuristicProjectSpec(
      "创建项目「Smoke Demo」目标：跑通 MVP 主链路 deadline：4月30日 负责人：Henry 成员：小王负责前端、小李负责测试",
    );
    const plan = heuristicProjectPlan(spec);
    const timestamp = nowIso();
    const project: MvpProjectState = {
      projectId: spec.projectId,
      chatId: "oc_smoke",
      spec,
      plan,
      tasks: [],
      meetings: [],
      risks: [],
      decisions: [],
      artifactPaths: [],
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    upsertProject(project);
    appendTasks(spec.projectId, plan.tasks);

    const extraction = heuristicMeetingExtraction(
      "会议纪要：小王负责整理项目简报，明天完成。风险：飞书真实任务 API 还未打通。决策：先用文本确认。",
      { ...project, tasks: plan.tasks },
    );
    assert(extraction.actionItems.length > 0, "会议纪要任务提取失败");

    const meetingCommand = routeMvpCommand(
      "会议纪要：小王负责整理项目简报，明天完成。风险：飞书真实任务 API 还未打通。决策：先用文本确认。Action Items 请跟进。",
    );
    assert(meetingCommand.command === "meeting_minutes_ingest", "会议纪要指令识别失败");

    const draft = createPendingDraft("project_create", "oc_smoke", { spec, plan }, spec.projectId);
    const confirmed = confirmDraft(draft.draftId);
    assert(confirmed?.status === "confirmed", "草案确认失败");

    const brief = buildProjectBrief(spec.projectId);
    assert(brief.totalTasks >= 8, "项目简报任务数量异常");

    console.log("MVP smoke test passed");
  } finally {
    saveState(original);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
