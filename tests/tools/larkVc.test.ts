import { loadConfig } from "../../src/config";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { type LarkCliRunner } from "../../src/tools/larkCli";
import { fetchTranscript } from "../../src/tools/larkVc";

describe("larkVc.fetchTranscript", () => {
  it("returns dry-run transcript text without calling the CLI", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };

    await expect(
      fetchTranscript({
        repos,
        config: loadConfig({ feishuDryRun: true }),
        meetingId: "om_dry_run",
        runner
      })
    ).resolves.toBe("【transcript pending - dry-run mode】");
    expect(calls).toHaveLength(0);
    expect(repos.listCliRuns()).toHaveLength(0);
  });

  it("calls lark-cli and prefers parsed notes content in real mode", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({ minutes: [{ content: "逐字稿内容" }] }),
        stderr: ""
      };
    };

    const digest = await fetchTranscript({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        larkCliBin: "fake-lark-cli"
      }),
      meetingId: "om_real",
      title: "真实妙记会议",
      runner
    });

    expect(digest).toContain("MeetingAtlas minutes digest input");
    expect(digest).toContain("title: 真实妙记会议");
    expect(digest).toContain("逐字稿内容");
    expect(digest).toContain("full_transcript: omitted_by_design");

    expect(calls).toEqual([
      {
        bin: "fake-lark-cli",
        args: ["vc", "+notes", "--meeting-ids", "om_real", "--format", "json"]
      }
    ]);
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.vc.notes",
      dry_run: 0,
      status: "success"
    });
  });

  it("can fetch real transcript while Feishu writes remain dry-run", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: string[][] = [];
    const runner: LarkCliRunner = async (_bin, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({ minutes: [{ content: "只读 canary 逐字稿" }] }),
        stderr: ""
      };
    };

    const digest = await fetchTranscript({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuReadDryRun: false
      }),
      meetingId: "om_read_canary",
      runner
    });

    expect(digest).toContain("只读 canary 逐字稿");

    expect(calls).toEqual([
      ["vc", "+notes", "--meeting-ids", "om_read_canary", "--format", "json"]
    ]);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.vc.notes",
      dry_run: 0,
      status: "success"
    });
  });

  it("reads structured notes artifacts instead of returning full transcript text", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const fullTranscript = [
      "开头证据。".repeat(250),
      "FULL_TRANSCRIPT_SHOULD_NOT_SURVIVE",
      "结尾证据。".repeat(600)
    ].join("\n");
    const runner: LarkCliRunner = async () => ({
      stdout: JSON.stringify({
        data: {
          notes: [
            {
              artifacts: {
                summary: "妙记 AI 摘要：本次会议确认交付策略。",
                todos: [{ text: "张三整理交付风险。" }],
                chapters: [{ title: "交付策略", summary: "讨论范围和节奏。" }],
                key_points: ["优先处理高风险项"]
              },
              url: "https://example.feishu.cn/minutes/min_digest",
              transcript: fullTranscript
            }
          ]
        }
      }),
      stderr: ""
    });

    const digest = await fetchTranscript({
      repos,
      config: loadConfig({ feishuDryRun: false }),
      meetingId: "om_digest",
      title: "交付策略会",
      runner
    });

    expect(digest).toContain("title: 交付策略会");
    expect(digest).toContain("妙记 AI 摘要");
    expect(digest).toContain("张三整理交付风险");
    expect(digest).toContain("交付策略");
    expect(digest).toContain("https://example.feishu.cn/minutes/min_digest");
    expect(digest).not.toContain("FULL_TRANSCRIPT_SHOULD_NOT_SURVIVE");
    expect(digest.length).toBeLessThanOrEqual(7000);
  });

  it("reads notes content from array or root payloads", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const outputs = [
      JSON.stringify([{ content: "数组逐字稿" }]),
      JSON.stringify({ content: "根逐字稿" })
    ];
    const runner: LarkCliRunner = async () => ({
      stdout: outputs.shift() ?? "",
      stderr: ""
    });

    await expect(
      fetchTranscript({
        repos,
        config: loadConfig({ feishuDryRun: false }),
        meetingId: "om_array",
        runner
      })
    ).resolves.toContain("数组逐字稿");
    await expect(
      fetchTranscript({
        repos,
        config: loadConfig({ feishuDryRun: false }),
        meetingId: "om_root",
        runner
      })
    ).resolves.toContain("根逐字稿");
  });

  it("falls back to raw stdout text when JSON fields are absent", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const runner: LarkCliRunner = async () => ({
      stdout: "plain transcript from stdout\n",
      stderr: ""
    });

    await expect(
      fetchTranscript({
        repos,
        config: loadConfig({ feishuDryRun: false }),
        meetingId: "om_stdout",
        runner
      })
    ).resolves.toContain("plain transcript from stdout");
  });
});
