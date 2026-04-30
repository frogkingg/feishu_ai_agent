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

  it("calls lark-cli and prefers parsed transcript or text fields in real mode", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: LarkCliRunner = async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({ transcript: "逐字稿内容" }),
        stderr: ""
      };
    };

    await expect(
      fetchTranscript({
        repos,
        config: loadConfig({
          feishuDryRun: false,
          larkCliBin: "fake-lark-cli"
        }),
        meetingId: "om_real",
        runner
      })
    ).resolves.toBe("逐字稿内容");

    expect(calls).toEqual([
      {
        bin: "fake-lark-cli",
        args: ["vc", "transcript", "get", "--meeting-id", "om_real"]
      }
    ]);
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.vc.transcript.get",
      dry_run: 0,
      status: "success"
    });
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
    ).resolves.toBe("plain transcript from stdout");
  });
});
