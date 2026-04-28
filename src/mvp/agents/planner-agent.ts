import { callStructuredLlm } from "../../llm/client";
import {
  Milestone,
  Module,
  ProjectPlan,
  ProjectSpec,
  ProjectTaskDraft,
  createMvpId,
  validateProjectPlan,
} from "../schemas";

function milestone(id: number, name: string, spec: ProjectSpec, dueDate: string | null = null): Milestone {
  return {
    milestoneId: createMvpId(`mile${id}`),
    name,
    description: null,
    owner: spec.owner,
    dueDate,
    status: "Not Started",
  };
}

function task(
  title: string,
  spec: ProjectSpec,
  moduleName: string | null,
  milestoneName: string,
  priority: ProjectTaskDraft["priority"],
  evidence: string,
  owner: string | null = null,
): ProjectTaskDraft {
  return {
    taskId: createMvpId("task"),
    title,
    description: null,
    owner: owner || spec.owner,
    dueDate: null,
    priority,
    status: "Not Started",
    moduleName,
    milestoneName,
    source: "Plan",
    evidence,
    confidence: 0.68,
  };
}

export function heuristicProjectPlan(spec: ProjectSpec): ProjectPlan {
  const projectName = spec.name || "未命名项目";
  const milestones = [
    milestone(1, "立项与范围确认", spec),
    milestone(2, "方案设计与任务拆解", spec),
    milestone(3, "核心实现与联调", spec),
    milestone(4, "验收与发布准备", spec, spec.deadline),
  ];

  const modules: Module[] = [
    {
      moduleId: createMvpId("mod"),
      name: "项目管理与推进",
      description: "目标、排期、风险、同步节奏",
      owner: spec.owner,
      milestoneName: "立项与范围确认",
    },
    {
      moduleId: createMvpId("mod"),
      name: "核心交付物",
      description: spec.goal,
      owner: spec.members[0]?.name || spec.owner,
      milestoneName: "核心实现与联调",
    },
    {
      moduleId: createMvpId("mod"),
      name: "验收与复盘",
      description: "验收标准、演示材料、复盘沉淀",
      owner: spec.members[1]?.name || spec.owner,
      milestoneName: "验收与发布准备",
    },
  ];

  const ownerByRole = (hint: string) => spec.members.find((member) => member.role?.includes(hint))?.name || null;
  const evidence = `来自立项文本：${projectName}${spec.goal ? `，目标：${spec.goal}` : ""}`;
  const tasks: ProjectTaskDraft[] = [
    task("确认项目目标、边界和成功标准", spec, "项目管理与推进", milestones[0].name, "P0", evidence),
    task("梳理成员分工和沟通节奏", spec, "项目管理与推进", milestones[0].name, "P0", evidence),
    task("建立项目计划和里程碑看板", spec, "项目管理与推进", milestones[1].name, "P0", evidence),
    task("拆解核心模块和依赖关系", spec, "核心交付物", milestones[1].name, "P0", evidence, ownerByRole("产品")),
    task("完成第一版核心交付物草案", spec, "核心交付物", milestones[2].name, "P0", evidence, ownerByRole("开发")),
    task("组织中期评审并记录决策", spec, "项目管理与推进", milestones[2].name, "P1", evidence),
    task("完成联调、验收和问题修复", spec, "核心交付物", milestones[3].name, "P0", evidence, ownerByRole("测试")),
    task("整理演示材料和项目简报", spec, "验收与复盘", milestones[3].name, "P1", evidence),
  ];

  for (const deliverable of spec.deliverables.slice(0, 5)) {
    tasks.push(task(`交付物确认：${deliverable}`, spec, "核心交付物", milestones[3].name, "P1", evidence));
  }

  while (tasks.length < 8) {
    tasks.push(task(`补充任务 ${tasks.length + 1}`, spec, "项目管理与推进", milestones[1].name, "P2", evidence));
  }

  return {
    projectId: spec.projectId,
    summary: `${projectName} 的 MVP 项目计划：先确认目标与范围，再拆解任务，随后推进核心交付和验收简报。`,
    milestones,
    modules,
    tasks: tasks.slice(0, 15),
    assumptions: [
      "所有飞书写入先以草案确认，不直接执行。",
      "未明确 owner 或 dueDate 的任务保持 null，等待后续确认。",
    ],
    unknownFields: spec.unknownFields,
  };
}

export async function plannerAgent(spec: ProjectSpec): Promise<ProjectPlan> {
  const fallback = heuristicProjectPlan(spec);
  try {
    const raw = await callStructuredLlm(
      [
        {
          role: "system",
          content: [
            "你是 ProjectPilot 的项目 Planner Agent。",
            "你只能输出 JSON object，不能输出 Markdown，不能执行工具。",
            "输入 ProjectSpec，输出 ProjectPlan。生成 4-6 个 milestones，8-15 个 tasks。",
            "任务都是草案，不创建飞书任务。owner/dueDate 不确定必须填 null。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            spec,
            requiredTaskShape: {
              taskId: "string",
              title: "string",
              description: "string|null",
              owner: "string|null",
              dueDate: "string|null",
              priority: "P0|P1|P2",
              status: "Not Started|In Progress|Blocked|Done",
              moduleName: "string|null",
              milestoneName: "string|null",
              source: "Plan",
              evidence: "string",
              confidence: "number 0..1",
            },
          }),
        },
      ],
      "tool",
    );
    if (!raw) {
      return fallback;
    }
    const plan = validateProjectPlan(raw);
    return plan.projectId === spec.projectId ? plan : { ...plan, projectId: spec.projectId };
  } catch (error) {
    console.warn("MVP planner-agent 使用 heuristic fallback:", error instanceof Error ? error.message : error);
    return fallback;
  }
}
