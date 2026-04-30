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

    await expect(
      fetchTranscript({
        repos,
        config: loadConfig({
          feishuDryRun: true,
          feishuReadDryRun: false
        }),
        meetingId: "om_read_canary",
        runner
      })
    ).resolves.toBe("只读 canary 逐字稿");

    expect(calls).toEqual([
      ["vc", "+notes", "--meeting-ids", "om_read_canary", "--format", "json"]
    ]);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.vc.notes",
      dry_run: 0,
      status: "success"
    });
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
    ).resolves.toBe("数组逐字稿");
    await expect(
      fetchTranscript({
        repos,
        config: loadConfig({ feishuDryRun: false }),
        meetingId: "om_root",
        runner
      })
    ).resolves.toBe("根逐字稿");
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
