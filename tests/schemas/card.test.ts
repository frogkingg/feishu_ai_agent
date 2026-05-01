import { DryRunConfirmationCardSchema } from "../../src/schemas";

describe("DryRunConfirmationCardSchema", () => {
  it("accepts the dry-run card confirmation shape", () => {
    const parsed = DryRunConfirmationCardSchema.parse({
      card_type: "action_confirmation",
      request_id: "conf_001",
      target_id: "act_001",
      recipient: "张三",
      status: "sent",
      title: "确认待办：整理流程",
      summary: "负责人：张三；截止：2026-05-01",
      sections: [
        {
          title: "待办草稿",
          fields: [
            {
              key: "title",
              label: "标题",
              value: "整理流程",
              value_text: "整理流程"
            }
          ]
        }
      ],
      editable_fields: [
        {
          key: "title",
          label: "标题",
          input_type: "text",
          value: "整理流程",
          required: true
        },
        {
          key: "owner",
          label: "负责人",
          input_type: "person",
          value: null,
          required: true
        }
      ],
      actions: [
        {
          key: "confirm",
          label: "确认创建待办",
          style: "primary",
          action_type: "http_post",
          endpoint: "/dev/confirmations/conf_001/confirm",
          payload_template: {
            edited_payload: "$editable_fields"
          }
        },
        {
          key: "reject",
          label: "拒绝",
          style: "danger",
          action_type: "http_post",
          endpoint: "/dev/confirmations/conf_001/reject",
          payload_template: {
            reason: "$reason"
          }
        }
      ],
      dry_run: true,
      version: "dry_run_v1"
    });

    expect(parsed.card_type).toBe("action_confirmation");
  });
});
