import { ProjectPatchDecision, RouterDecision } from "../llm/schemas";
import { hasGroundingEvidence } from "../memory/project-store";

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function guardProjectPatch(route: RouterDecision, patch: ProjectPatchDecision): GuardResult {
  if (patch.action === "none") {
    return { ok: true };
  }

  if (route.safetyLabel !== "normal") {
    return { ok: false, reason: `安全标签为 ${route.safetyLabel}，不允许写入项目状态` };
  }

  if (!hasGroundingEvidence(patch.grounding)) {
    return { ok: false, reason: "缺少 grounding evidence，不能写入项目状态" };
  }

  const writes =
    patch.action === "project_create" ||
    patch.action === "project_update" ||
    Boolean(patch.tasks?.length || patch.risks?.length || patch.decisions?.length || patch.notes?.length);
  if (writes && !patch.requiresConfirmation) {
    return { ok: false, reason: "项目状态写入默认需要确认" };
  }

  return { ok: true };
}
