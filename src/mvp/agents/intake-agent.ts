import { callStructuredLlm } from "../../llm/client";
import { ProjectSpec, createMvpId, validateProjectSpec } from "../schemas";

function compact(value: string | null | undefined) {
  return value?.trim() || null;
}

function splitList(value: string | undefined) {
  if (!value) {
    return [];
  }
  return value
    .split(/[、,，;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractAfterLabel(text: string, labels: string[]) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = text.match(new RegExp(`(?:${labelPattern})\\s*[是为:：]?\\s*([^。；;\\n]+)`));
  return compact(match?.[1]);
}

function extractProjectName(text: string) {
  const quoted = text.match(/[「《"']([^」》"']{2,50})[」》"']/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const called = text.match(/(?:项目(?:名|名称)?|叫|名叫)\s*[是为:：]?\s*([^，。；;\n]{2,50})/);
  if (called?.[1] && !/(目标|负责人|成员|deadline|截止)/i.test(called[1])) {
    return called[1].trim();
  }

  const created = text.match(/(?:创建项目|新建项目|立项|帮我们创建一个项目)\s*([^，。；;\n]{2,50})/);
  return compact(created?.[1]);
}

function extractDeadline(text: string) {
  const explicit = text.match(
    /(?:deadline|DDL|截止|交付|上线|完成时间|时间)\s*[是为:：到在前]*\s*([0-9]{4}[-/.年][0-9]{1,2}(?:[-/.月][0-9]{1,2}日?)?|[0-9]{1,2}月[0-9]{1,2}日|本周[一二三四五六日天]?|下周[一二三四五六日天]?|明天|后天|月底|月末|周[一二三四五六日天])/i,
  );
  if (explicit?.[1]) {
    return explicit[1].trim();
  }
  const dateOnly = text.match(/[0-9]{4}[-/.年][0-9]{1,2}(?:[-/.月][0-9]{1,2}日?)?|[0-9]{1,2}月[0-9]{1,2}日/);
  return compact(dateOnly?.[0]);
}

function extractMembers(text: string, owner: string | null) {
  const members = new Map<string, { name: string; role: string | null }>();
  if (owner) {
    members.set(owner, { name: owner, role: "负责人" });
  }

  const memberLine = extractAfterLabel(text, ["成员", "团队", "参与人", "分工"]);
  for (const part of splitList(memberLine || undefined)) {
    const roleMatch = part.match(/^(.{1,20}?)(?:负责|承担|做|:|：|-|—|\/)(.+)$/);
    const name = (roleMatch?.[1] || part).replace(/^@/, "").trim();
    const role = compact(roleMatch?.[2]);
    if (name) {
      members.set(name, { name, role });
    }
  }

  const inlineRoles = text.matchAll(/@?([\u4e00-\u9fa5A-Za-z0-9_]{2,12})\s*(?:负责|承担|做)\s*([^，。；;\n]{2,24})/g);
  for (const match of inlineRoles) {
    const name = match[1].trim();
    if (!/(我们|项目|目标|成员|负责人)/.test(name)) {
      members.set(name, { name, role: match[2].trim() });
    }
  }

  return [...members.values()];
}

export function heuristicProjectSpec(text: string): ProjectSpec {
  const owner = extractAfterLabel(text, ["负责人", "owner", "Owner"]);
  const spec: ProjectSpec = {
    projectId: createMvpId("proj"),
    name: extractProjectName(text),
    goal: extractAfterLabel(text, ["目标", "项目目标", "希望", "要达成"]),
    deadline: extractDeadline(text),
    owner,
    members: [],
    deliverables: splitList(extractAfterLabel(text, ["交付物", "产出", "输出"] ) || undefined),
    constraints: splitList(extractAfterLabel(text, ["约束", "限制", "注意"] ) || undefined),
    unknownFields: [],
  };
  spec.members = extractMembers(text, spec.owner);

  if (!spec.name) {
    spec.unknownFields.push("项目名");
  }
  if (!spec.goal) {
    spec.unknownFields.push("目标");
  }
  if (!spec.deadline) {
    spec.unknownFields.push("deadline");
  }
  if (!spec.owner) {
    spec.unknownFields.push("负责人");
  }
  if (!spec.members.length) {
    spec.unknownFields.push("成员分工");
  }
  return spec;
}

export async function intakeAgent(text: string): Promise<ProjectSpec> {
  const fallback = heuristicProjectSpec(text);
  try {
    const raw = await callStructuredLlm(
      [
        {
          role: "system",
          content: [
            "你是 ProjectPilot 的项目立项 Intake Agent。",
            "你只能输出 JSON object，不能输出 Markdown，不能执行工具。",
            "从用户文本抽取 ProjectSpec。缺失字段必须填 null，并把字段名放入 unknownFields，禁止编造。",
            "projectId 如果用户没有提供，填入传入的 fallbackProjectId。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            fallbackProjectId: fallback.projectId,
            schema: {
              projectId: "string",
              name: "string|null",
              goal: "string|null",
              deadline: "string|null",
              owner: "string|null",
              members: [{ name: "string", role: "string|null" }],
              deliverables: ["string"],
              constraints: ["string"],
              unknownFields: ["string"],
            },
            text,
          }),
        },
      ],
      "tool",
    );
    if (!raw) {
      return fallback;
    }
    return validateProjectSpec(raw);
  } catch (error) {
    console.warn("MVP intake-agent 使用 heuristic fallback:", error instanceof Error ? error.message : error);
    return fallback;
  }
}
