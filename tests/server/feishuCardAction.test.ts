import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { MockLlmClient } from "../../src/services/llm/mockLlmClient";
import { createMemoryDatabase } from "../../src/services/store/db";
import { ConfirmationRequestRow, createRepositories } from "../../src/services/store/repositories";

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function createAppWithConfirmations() {
  const repos = createRepositories(createMemoryDatabase());
  const app = buildServer({
    config: loadConfig({
      feishuDryRun: true,
      larkCliBin: "definitely-not-real-lark",
      sqlitePath: ":memory:",
      larkVerificationToken: null
    }),
    repos,
    llm: new MockLlmClient()
  });

  await app.inject({
    method: "POST",
    url: "/dev/meetings/manual",
    payload: {
      title: "无人机操作方案初步访谈",
      participants: ["张三", "李四"],
      organizer: "张三",
      started_at: "2026-04-28T10:00:00+08:00",
      ended_at: "2026-04-28T11:00:00+08:00",
      transcript_text: readFileSync(
        join(process.cwd(), "fixtures/meetings/drone_interview_01.txt"),
        "utf8"
      )
    }
  });

  const action = repos.listConfirmationRequests().find((item) => item.request_type === "action");
  const calendar = repos
    .listConfirmationRequests()
    .find((item) => item.request_type === "calendar");

  return {
    app,
    repos,
    action: action as ConfirmationRequestRow,
    calendar: calendar as ConfirmationRequestRow
  };
}

describe("POST /webhooks/feishu/card-action", () => {
  it("returns a toast 404 when the confirmation does not exist", async () => {
    const { app } = await createAppWithConfirmations();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: "nonexistent",
            action: "confirm"
          }
        }
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      toast: {
        type: "error",
        content: "确认请求不存在"
      }
    });
  });

  it("confirms and rejects requests from Feishu card callbacks", async () => {
    const { app, repos, action, calendar } = await createAppWithConfirmations();

    const confirmResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: action.id,
            action: "confirm"
          }
        }
      }
    });
    expect(confirmResponse.statusCode).toBe(200);
    expect(confirmResponse.json()).toMatchObject({
      confirmation_id: action.id,
      action: "confirm",
      toast: {
        type: "success",
        content: "已确认，正在处理中…"
      }
    });
    await flushAsyncWork();
    expect(repos.getConfirmationRequest(action.id)?.status).toBe("executed");

    const rejectResponse = await app.inject({
      method: "POST",
      url: "/webhooks/feishu/card-action",
      payload: {
        open_id: "ou_test",
        action: {
          value: {
            confirmation_id: calendar.id,
            action: "reject"
          }
        }
      }
    });
    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json()).toMatchObject({
      ok: true,
      confirmation_id: calendar.id,
      toast: {
        type: "success",
        content: "已拒绝"
      }
    });
    expect(repos.getConfirmationRequest(calendar.id)?.status).toBe("rejected");
  });

  it("returns dry-run toasts for card actions planned for PR-2", async () => {
    const { app, action } = await createAppWithConfirmations();

    for (const callbackAction of ["remind_later", "convert_to_task", "append_current_only"]) {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/feishu/card-action",
        payload: {
          open_id: "ou_test",
          action: {
            value: {
              confirmation_id: action.id,
              action: callbackAction
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        dry_run: true,
        confirmation_id: action.id,
        action: callbackAction,
        message: "此操作暂未实现，将在 PR-2 中完成",
        toast: {
          type: "success",
          content: "此操作暂未实现，将在 PR-2 中完成"
        }
      });
    }
  });
});
