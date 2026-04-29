import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { confirmRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures/meetings", name), "utf8");
}

async function processDroneMeetings(repos = createRepositories(createMemoryDatabase())) {
  const llm = new MockLlmClient();

  await processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: "无人机操作方案初步访谈",
      participants: ["张三", "李四"],
      organizer: "张三",
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      transcript_text: readFixture("drone_interview_01.txt")
    }
  });

  await processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: "无人机操作员访谈",
      participants: ["张三", "王五"],
      organizer: "张三",
      started_at: "2026-04-29T10:00:00+08:00",
      ended_at: "2026-04-29T11:00:00+08:00",
      transcript_text: readFixture("drone_interview_02.txt")
    }
  });

  return repos;
}

describe("createKnowledgeBaseWorkflow", () => {
  it("creates knowledge base records and dry-run markdown after create_kb confirmation", async () => {
    const repos = await processDroneMeetings();
    const request = repos.listConfirmationRequests().find((item) => item.request_type === "create_kb");
    expect(request).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, sqlitePath: ":memory:" }),
      id: request!.id
    });

    const knowledgeBases = repos.listKnowledgeBases();
    const updates = repos.listKnowledgeUpdates();
    expect(knowledgeBases).toHaveLength(1);
    expect(knowledgeBases[0]).toMatchObject({
      name: "无人机操作方案",
      status: "active",
      wiki_url: `mock://feishu/wiki/${knowledgeBases[0].id}`,
      homepage_url: `mock://feishu/wiki/${knowledgeBases[0].id}/00-home`
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].update_type).toBe("kb_created");

    const markdown = updates[0].after_text ?? "";
    expect(markdown).toContain("00 首页 / 总览");
    expect(markdown).toContain("01 整体目标");
    expect(markdown).toContain("02 整体分析");
    expect(markdown).toContain("03 当前进度");
    expect(markdown).toContain("05 待办与日程索引");
    expect(markdown).toContain("06 单个会议总结");
    expect(markdown).toContain("07 会议转写记录");
    expect(markdown).toContain("本次会议围绕无人机操作方案初步访谈展开");
    expect(markdown).toContain("本次会议继续围绕无人机操作方案");
    expect(markdown).toContain("无人机安全规范");

    const archivedMeetings = repos.listMeetings().filter((meeting) => meeting.archive_status === "archived");
    expect(archivedMeetings).toHaveLength(2);
    expect(repos.getConfirmationRequest(request!.id)?.status).toBe("executed");
  });

  it("fails in real mode while larkWiki/larkDoc are not implemented", async () => {
    const repos = await processDroneMeetings();
    const request = repos.listConfirmationRequests().find((item) => item.request_type === "create_kb");
    expect(request).toBeTruthy();

    await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: false, sqlitePath: ":memory:" }),
      id: request!.id
    });

    const confirmation = repos.getConfirmationRequest(request!.id);
    expect(confirmation?.status).toBe("failed");
    expect(confirmation?.error).toContain("larkWiki/larkDoc");
    expect(repos.listKnowledgeBases()).toHaveLength(0);
    expect(repos.listKnowledgeUpdates()).toHaveLength(0);
    expect(repos.listMeetings().filter((meeting) => meeting.archive_status === "archived")).toHaveLength(0);
  });
});
