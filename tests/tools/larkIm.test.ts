import { buildActionConfirmationCard } from "../../src/agents/cardInteractionAgent";
import { loadConfig } from "../../src/config";
import { createMemoryDatabase } from "../../src/services/store/db";
import { createRepositories } from "../../src/services/store/repositories";
import { buildFeishuInteractiveCard, sendCard } from "../../src/tools/larkIm";

const card = buildActionConfirmationCard({
  id: "conf_card_send",
  target_id: "act_card_send",
  recipient: "ou_recipient",
  status: "sent",
  original_payload: {
    draft: {
      title: "整理无人机操作流程",
      description: "把现有操作步骤整理成清单。",
      owner: "张三",
      collaborators: [],
      due_date: "2026-05-01",
      priority: "P1",
      evidence: "张三：我可以整理现有操作流程。",
      confidence: 0.91,
      suggested_reason: "会议中明确了负责人。",
      missing_fields: []
    },
    meeting_id: "mtg_001"
  }
});

describe("larkIm.sendCard", () => {
  it("builds an interactive card payload from the dry-run preview", () => {
    const interactive = buildFeishuInteractiveCard(card);

    expect(interactive.header.title.content).toBe(card.title);
    expect(JSON.stringify(interactive)).toContain(card.summary);
    expect(JSON.stringify(interactive)).toContain("/dev/confirmations/conf_card_send/confirm");
    expect(JSON.stringify(interactive)).toContain("点击确认前不会创建飞书任务、日程、Wiki 或 Doc");
  });

  it("records dry-run send-card cli_runs without executing the lark binary", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      recipient: "ou_test_user"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "planned",
      dry_run: true,
      card_message_id: null,
      recipient: "ou_test_user"
    });
    const runs = repos.listCliRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 1,
      status: "planned"
    });
    const args = JSON.parse(runs[0].args_json) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "im",
        "+messages-send",
        "--user-id",
        "ou_test_user",
        "--msg-type",
        "interactive"
      ])
    );
    expect(args).not.toContain("--dry-run");
  });

  it("fails in real mode when the CLI is unavailable", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      chatId: "oc_test_chat"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      dry_run: false,
      card_message_id: null,
      chat_id: "oc_test_chat"
    });
    expect(result.error).toContain("lark.im.send_card failed");
    const runs = repos.listCliRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 0,
      status: "failed"
    });
  });

  it("can attempt real card sending while other Feishu writes stay dry-run", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: true,
        feishuCardDryRun: false,
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      chatId: "oc_test_chat"
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      dry_run: false,
      card_message_id: null,
      chat_id: "oc_test_chat"
    });
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 0,
      status: "failed"
    });
  });

  it("can keep card sending dry-run even when other Feishu writes are real", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({
        feishuDryRun: false,
        feishuCardDryRun: true,
        larkCliBin: "definitely-not-real-lark"
      }),
      card,
      chatId: "oc_test_chat"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "planned",
      dry_run: true,
      card_message_id: null,
      chat_id: "oc_test_chat"
    });
    expect(repos.listCliRuns()).toHaveLength(1);
    expect(repos.listCliRuns()[0]).toMatchObject({
      tool: "lark.im.send_card",
      dry_run: 1,
      status: "planned"
    });
  });

  it("fails without a destination instead of pretending to send", async () => {
    const repos = createRepositories(createMemoryDatabase());
    const result = await sendCard({
      repos,
      config: loadConfig({ feishuDryRun: true }),
      card,
      recipient: null,
      chatId: null
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      cli_run_id: null,
      error: "lark.im.send_card requires recipient or chat_id"
    });
    expect(repos.listCliRuns()).toHaveLength(0);
  });
});
