import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures/meetings", name), "utf8");
}

describe("TopicClusteringAgent", () => {
  it("observes the first drone meeting and creates a KB confirmation after the second related meeting", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const llm = new MockLlmClient();

    const first = await processMeetingWorkflow({
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

    expect(first.topic_match.suggested_action).toBe("observe");
    expect(repos.listConfirmationRequests().some((request) => request.request_type === "create_kb")).toBe(false);

    const second = await processMeetingWorkflow({
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

    const createKbRequests = repos
      .listConfirmationRequests()
      .filter((request) => request.request_type === "create_kb");

    expect(second.topic_match.suggested_action).toBe("ask_create");
    expect(second.topic_match.candidate_meeting_ids).toHaveLength(2);
    expect(createKbRequests).toHaveLength(1);
    expect(JSON.parse(createKbRequests[0].original_payload_json)).toMatchObject({
      topic_name: "无人机操作方案",
      meeting_ids: second.topic_match.candidate_meeting_ids
    });
  });
});
