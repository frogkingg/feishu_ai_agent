import { ConfirmationRequestSchema } from "../../src/schemas";

describe("ConfirmationRequestSchema", () => {
  it("accepts the MVP confirmation shape", () => {
    const parsed = ConfirmationRequestSchema.parse({
      id: "conf_001",
      request_type: "action",
      target_id: "act_001",
      recipient: "张三",
      status: "draft",
      original_payload: { title: "整理流程" },
      edited_payload: null,
      created_at: "2026-04-28T10:00:00.000Z"
    });

    expect(parsed.id).toBe("conf_001");
  });
});
