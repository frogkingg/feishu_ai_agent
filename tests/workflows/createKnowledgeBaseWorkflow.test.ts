import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { confirmRequest, createConfirmationRequest } from "../../src/services/confirmationService";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories, type MeetingRow } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";
import { processMeetingWorkflow } from "../../src/workflows/processMeetingWorkflow";

function readFixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures/meetings", name), "utf8");
}

async function processDroneMeetings(
  repos = createRepositories(createMemoryDatabase()),
  options: {
    organizer?: string;
    firstParticipants?: string[];
    secondParticipants?: string[];
  } = {}
) {
  const llm = new MockLlmClient();
  const organizer = options.organizer ?? "张三";

  await processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: "无人机操作方案初步访谈",
      participants: options.firstParticipants ?? ["张三", "李四"],
      organizer,
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      minutes_url: "https://example.feishu.cn/minutes/min_001",
      transcript_url: "https://example.feishu.cn/minutes/transcript_001",
      transcript_text: readFixture("drone_interview_01.txt")
    }
  });

  await processMeetingWorkflow({
    repos,
    llm,
    meeting: {
      title: "无人机操作员访谈",
      participants: options.secondParticipants ?? ["张三", "王五"],
      organizer,
      started_at: "2026-04-29T10:00:00+08:00",
      ended_at: "2026-04-29T11:00:00+08:00",
      minutes_url: "https://example.feishu.cn/minutes/min_002",
      transcript_url: "https://example.feishu.cn/minutes/transcript_002",
      transcript_text: readFixture("drone_interview_02.txt")
    }
  });

  return repos;
}

function createMeeting(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: "mtg_single",
    external_meeting_id: null,
    title: "单会知识库沉淀",
    started_at: "2026-04-30T10:00:00+08:00",
    ended_at: "2026-04-30T11:00:00+08:00",
    organizer: "ou_owner",
    participants_json: JSON.stringify(["ou_owner", "ou_member"]),
    minutes_url: "https://example.feishu.cn/minutes/min_single",
    transcript_url: "https://example.feishu.cn/minutes/transcript_single",
    transcript_text: "会议明确需要先把单场材料整理成知识库，后续再追加更多会议。",
    summary: "用户明确确认本场会议已经足够形成一版知识库。",
    keywords_json: JSON.stringify(["知识库", "沉淀"]),
    matched_kb_id: null,
    match_score: null,
    archive_status: "not_archived",
    action_count: 0,
    calendar_count: 0,
    created_at: "2026-04-30T10:00:00+08:00",
    updated_at: "2026-04-30T10:00:00+08:00",
    ...overrides
  };
}

describe("createKnowledgeBaseWorkflow", () => {
  it("creates knowledge base records and dry-run markdown after create_kb confirmation", async () => {
    const repos = await processDroneMeetings();
    const request = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "create_kb");
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
      name: "无人机操作流程主题知识库",
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
    expect(markdown).toContain("04 关键结论与决策");
    expect(markdown).toContain("05 待办与日程索引");
    expect(markdown).toContain("06 会议索引");
    expect(markdown).toContain("会议总结 / M1");
    expect(markdown).toContain("转写引用");
    expect(markdown).toContain("关联资料");
    expect(markdown).toContain("风险与假设");
    expect(markdown).toContain("变更记录");
    expect(markdown).toContain("## 当前状态");
    expect(markdown).toContain("## 下一步");
    expect(markdown).toContain("## 关键结论");
    expect(markdown).toContain("## 未解决问题");
    expect(markdown).not.toContain("### 可执行信息");
    expect(markdown).toContain("https://example.feishu.cn/minutes/min_001");
    expect(markdown).toContain("https://example.feishu.cn/minutes/transcript_001");
    expect(markdown).toContain("本次会议围绕无人机操作方案初步访谈展开");

    const archivedMeetings = repos
      .listMeetings()
      .filter((meeting) => meeting.archive_status === "archived");
    expect(archivedMeetings).toHaveLength(2);
    expect(markdown).not.toContain(archivedMeetings[0].id);
    expect(markdown).not.toContain(archivedMeetings[1].id);
    expect(repos.getConfirmationRequest(request!.id)?.status).toBe("executed");
  });

  it("executes a confirmed single-meeting create_kb when the LLM already suggested ask_create", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const meeting = repos.createMeeting(createMeeting());
    const request = createConfirmationRequest({
      repos,
      requestType: "create_kb",
      targetId: "kb_single_topic",
      recipient: "ou_owner",
      originalPayload: {
        topic_name: "单会知识库沉淀",
        topic_match: {
          current_meeting_id: meeting.id,
          matched_kb_id: null,
          matched_kb_name: null,
          score: 0.8,
          match_reasons: ["LLM 判断本场会议已经足够形成一版知识库"],
          suggested_action: "ask_create",
          candidate_meeting_ids: [meeting.id]
        },
        candidate_meeting_ids: [meeting.id],
        meeting_ids: [meeting.id],
        match_reasons: ["LLM 判断本场会议已经足够形成一版知识库"],
        score: 0.8,
        reason: "用户确认创建知识库，confirmation 是执行安全边界。"
      }
    });

    const confirmed = await confirmRequest({
      repos,
      config: loadConfig({ feishuDryRun: true, sqlitePath: ":memory:" }),
      id: request.id,
      llm: new MockLlmClient()
    });

    expect(confirmed.confirmation.status).toBe("executed");
    expect(confirmed.confirmation.error).toBeNull();
    expect(repos.listKnowledgeBases()).toHaveLength(1);
    expect(repos.listKnowledgeUpdates()).toHaveLength(1);
    expect(repos.getMeeting(meeting.id)?.archive_status).toBe("archived");
    expect(repos.getConfirmationRequest(request.id)?.status).toBe("executed");
  });

  it("creates a wiki space for the owner and writes child doc pages with the knowledge canary", async () => {
    const repos = await processDroneMeetings(undefined, {
      organizer: "ou_owner",
      firstParticipants: ["ou_owner", "ou_member_a", "not_open_id"],
      secondParticipants: ["ou_member_a", "ou_member_b"]
    });
    const request = repos
      .listConfirmationRequests()
      .find((item) => item.request_type === "create_kb");
    expect(request).toBeTruthy();
    const createdArgs: string[][] = [];
    let createdNodeCount = 0;
    const runner: LarkCliRunner = async (_bin, args) => {
      createdArgs.push(args);
      if (args[0] === "wiki" && args[1] === "spaces" && args[2] === "create") {
        return {
          stdout: JSON.stringify({
            data: {
              space: {
                space_id: "space_1"
              }
            }
          }),
          stderr: ""
        };
      }

      if (args[0] === "wiki" && args[1] === "members" && args[2] === "create") {
        return {
          stdout: JSON.stringify({
            data: {
              member: {
                member_id: args[args.indexOf("--data") + 1]
              }
            }
          }),
          stderr: ""
        };
      }

      if (args[0] === "docs" && args[1] === "+update") {
        return {
          stdout: JSON.stringify({
            data: {
              result: "success",
              updated_blocks_count: 1
            }
          }),
          stderr: ""
        };
      }

      createdNodeCount += 1;
      const nodeToken = `node_${createdNodeCount}`;
      return {
        stdout: JSON.stringify({
          data: {
            node_token: nodeToken,
            obj_token: `doc_${createdNodeCount}`,
            url: `https://example.feishu.cn/wiki/${nodeToken}`,
            space_id: "my_library"
          }
        }),
        stderr: ""
      };
    };

    await confirmRequest({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuKnowledgeWriteDryRun: false,
        sqlitePath: ":memory:"
      }),
      id: request!.id,
      runner
    });

    const confirmation = repos.getConfirmationRequest(request!.id);
    expect(confirmation?.status).toBe("executed");
    expect(confirmation?.error).toBeNull();
    expect(repos.listKnowledgeBases()).toHaveLength(1);
    expect(repos.listKnowledgeBases()[0]).toMatchObject({
      wiki_url: "https://www.feishu.cn/wiki/space_1",
      homepage_url: "https://www.feishu.cn/wiki/space_1"
    });
    expect(repos.listKnowledgeUpdates()).toHaveLength(1);
    expect(
      repos.listMeetings().filter((meeting) => meeting.archive_status === "archived")
    ).toHaveLength(2);
    const spaceCreateArgs = createdArgs.filter(
      (args) => args[0] === "wiki" && args[1] === "spaces" && args[2] === "create"
    );
    const wikiNodeCreateArgs = createdArgs.filter(
      (args) => args[0] === "wiki" && args[1] === "+node-create"
    );
    const memberCreateArgs = createdArgs.filter(
      (args) => args[0] === "wiki" && args[1] === "members" && args[2] === "create"
    );
    const updateArgs = createdArgs.filter((args) => args[0] === "docs" && args[1] === "+update");
    const childPageCount = wikiNodeCreateArgs.length;
    expect(spaceCreateArgs).toHaveLength(1);
    expect(memberCreateArgs).toHaveLength(0);
    expect(childPageCount).toBe(12);
    expect(updateArgs).toHaveLength(12);
    expect(spaceCreateArgs[0]).toEqual([
      "wiki",
      "spaces",
      "create",
      "--data",
      expect.any(String),
      "--format",
      "json",
      "--yes",
      "--as",
      "user"
    ]);
    expect(JSON.parse(spaceCreateArgs[0][spaceCreateArgs[0].indexOf("--data") + 1])).toEqual({
      name: "无人机操作流程主题知识库",
      description: "Mock LLM 生成的知识库草案。"
    });
    expect(wikiNodeCreateArgs[0]).toEqual(
      expect.arrayContaining(["--space-id", "space_1", "--title", "01 整体目标"])
    );
    expect(wikiNodeCreateArgs[1]).toEqual(
      expect.arrayContaining(["--space-id", "space_1", "--title", "02 整体分析"])
    );
    expect(wikiNodeCreateArgs.map((args) => args[args.indexOf("--title") + 1])).toEqual(
      expect.arrayContaining([
        "03 当前进度",
        "04 关键结论与决策",
        "05 待办与日程索引",
        "06 会议索引",
        "09 转写引用",
        "10 关联资料",
        "11 风险与假设",
        "12 变更记录"
      ])
    );
    expect(wikiNodeCreateArgs.every((args) => !args.includes("--parent-node-token"))).toBe(true);
    expect(updateArgs[0]).toEqual(
      expect.arrayContaining([
        "docs",
        "+update",
        "--api-version",
        "v2",
        "--doc",
        "doc_1",
        "--command",
        "append",
        "--doc-format",
        "markdown",
        "--as",
        "user"
      ])
    );
    const firstUpdateContent = updateArgs[0][updateArgs[0].indexOf("--content") + 1];
    expect(firstUpdateContent).toContain("# 01 整体目标");
    expect(repos.listCliRuns().map((run) => run.status)).toEqual(
      Array(1 + childPageCount * 2).fill("success")
    );
  });
});
