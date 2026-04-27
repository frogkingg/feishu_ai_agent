import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { routeMessageHeuristically } from "../agent/router";
import { ChatContext, NormalizedMessageEvent, Project } from "../llm/schemas";
import { summarizeProjectForPrompt } from "../memory/project-store";
import { createProjectPatchHeuristically } from "../workflows/project-patch";

interface EvalCase {
  name: string;
  context?: {
    activeProject?: string;
  };
  messages: Array<{ text: string }>;
  expected: Record<string, unknown> & {
    shouldNot?: string[];
    expectedPatch?: {
      projectDraft?: {
        name?: string;
        goal?: string;
      };
      tasks?: Array<{
        title?: string;
        ownerName?: string | null;
      }>;
      risks?: Array<{
        description?: string;
        severity?: string;
      }>;
    };
  };
}

function makeActiveProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    id: "eval_project",
    chatId: "eval_chat",
    name,
    status: "draft",
    owners: [],
    members: [],
    milestones: [],
    tasks: [],
    risks: [],
    decisions: [],
    notes: [],
    sourceMessageIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeEvent(text: string, index: number): NormalizedMessageEvent {
  return {
    type: "eval",
    messageId: `eval_message_${index}`,
    chatId: "eval_chat",
    chatType: "group",
    senderId: "eval_user",
    senderName: "Eval User",
    text,
    createTime: Date.now(),
  };
}

function loadFixtures() {
  const fixtureDir = join(__dirname, "fixtures");
  return readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const cases = JSON.parse(readFileSync(join(fixtureDir, file), "utf8")) as EvalCase[];
      return cases.map((item) => ({ ...item, file }));
    });
}

function mismatch(expectedKey: string, expected: unknown, actual: unknown) {
  if (expected === undefined) {
    return undefined;
  }
  return expected === actual ? undefined : `${expectedKey}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function includesMismatch(label: string, expected: string | undefined, actual: string | undefined) {
  if (expected === undefined) {
    return undefined;
  }
  return actual?.includes(expected) ? undefined : `${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`;
}

function patchMismatches(expected: EvalCase["expected"]["expectedPatch"], patch: ReturnType<typeof createProjectPatchHeuristically> | undefined) {
  if (!expected) {
    return [];
  }
  const failures: string[] = [];
  if (!patch) {
    return ["expectedPatch: no patch was produced"];
  }

  const projectNameMismatch = includesMismatch("projectDraft.name", expected.projectDraft?.name, patch.projectDraft?.name);
  const projectGoalMismatch = includesMismatch("projectDraft.goal", expected.projectDraft?.goal, patch.projectDraft?.goal);
  if (projectNameMismatch) failures.push(projectNameMismatch);
  if (projectGoalMismatch) failures.push(projectGoalMismatch);

  expected.tasks?.forEach((expectedTask, index) => {
    const actualTask = patch.tasks?.[index];
    if (!actualTask) {
      failures.push(`tasks[${index}]: missing`);
      return;
    }
    const titleMismatch = includesMismatch(`tasks[${index}].title`, expectedTask.title, actualTask.title);
    if (titleMismatch) failures.push(titleMismatch);
    if (expectedTask.ownerName !== undefined) {
      const expectedOwner = expectedTask.ownerName === null ? undefined : expectedTask.ownerName;
      if (actualTask.ownerName !== expectedOwner) {
        failures.push(
          `tasks[${index}].ownerName: expected ${JSON.stringify(expectedOwner)}, got ${JSON.stringify(actualTask.ownerName)}`,
        );
      }
    }
  });

  expected.risks?.forEach((expectedRisk, index) => {
    const actualRisk = patch.risks?.[index];
    if (!actualRisk) {
      failures.push(`risks[${index}]: missing`);
      return;
    }
    const descriptionMismatch = includesMismatch(
      `risks[${index}].description`,
      expectedRisk.description,
      actualRisk.description,
    );
    if (descriptionMismatch) failures.push(descriptionMismatch);
    if (expectedRisk.severity !== undefined && actualRisk.severity !== expectedRisk.severity) {
      failures.push(
        `risks[${index}].severity: expected ${JSON.stringify(expectedRisk.severity)}, got ${JSON.stringify(actualRisk.severity)}`,
      );
    }
  });

  return failures;
}

async function runCase(testCase: EvalCase, caseIndex: number) {
  const activeProject = testCase.context?.activeProject ? makeActiveProject(testCase.context.activeProject) : undefined;
  const activeProjectSummary = activeProject ? summarizeProjectForPrompt(activeProject) : "";
  const context: ChatContext = { chatId: "eval_chat", messages: [] };
  const event = makeEvent(testCase.messages[testCase.messages.length - 1]?.text || "", caseIndex);
  context.messages.push({ text: event.text, createTime: event.createTime || Date.now(), messageId: event.messageId });

  const route = routeMessageHeuristically(event, activeProjectSummary);
  const patch = ["project", "task", "risk", "decision"].includes(route.primaryDomain)
    ? createProjectPatchHeuristically(event, route, activeProject)
    : undefined;
  const actual = {
    responseMode: route.responseMode,
    primaryDomain: route.primaryDomain,
    intent: route.intent,
    safetyLabel: route.safetyLabel,
    action: patch?.action,
    requiresConfirmation: patch?.requiresConfirmation,
    taskCount: patch?.tasks?.length,
  };

  const failures = [
    mismatch("responseMode", testCase.expected.responseMode, actual.responseMode),
    mismatch("primaryDomain", testCase.expected.primaryDomain, actual.primaryDomain),
    mismatch("intent", testCase.expected.intent, actual.intent),
    mismatch("safetyLabel", testCase.expected.safetyLabel, actual.safetyLabel),
    mismatch("action", testCase.expected.action, actual.action),
    mismatch("requiresConfirmation", testCase.expected.requiresConfirmation, actual.requiresConfirmation),
    mismatch("taskCount", testCase.expected.taskCount, actual.taskCount),
    ...patchMismatches(testCase.expected.expectedPatch, patch),
  ].filter(Boolean) as string[];

  const actualValues = Object.values(actual).filter(Boolean).map(String);
  for (const forbidden of testCase.expected.shouldNot || []) {
    if (actualValues.includes(forbidden)) {
      failures.push(`shouldNot: ${forbidden} appeared in ${JSON.stringify(actual)}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    actual,
  };
}

async function main() {
  const cases = loadFixtures();
  const failures: Array<{ name: string; expected: unknown; actual: unknown; failures: string[] }> = [];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const result = await runCase(testCase, index);
    if (result.ok) {
      console.log(`PASS ${testCase.file} :: ${testCase.name}`);
    } else {
      console.log(`FAIL ${testCase.file} :: ${testCase.name}`);
      failures.push({
        name: `${testCase.file} :: ${testCase.name}`,
        expected: testCase.expected,
        actual: result.actual,
        failures: result.failures,
      });
    }
  }

  if (failures.length) {
    console.error("\nEval failures:");
    for (const failure of failures) {
      console.error(JSON.stringify(failure, null, 2));
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll ${cases.length} eval cases passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
