import { TopicMatchResultSchema } from "../../src/schemas";

describe("TopicMatchResultSchema", () => {
  it("enforces score thresholds", () => {
    expect(
      TopicMatchResultSchema.parse({
        current_meeting_id: "m_001",
        matched_kb_id: null,
        matched_kb_name: null,
        score: 0.55,
        match_reasons: [],
        suggested_action: "no_action",
        candidate_meeting_ids: ["m_001"]
      }).suggested_action
    ).toBe("no_action");

    expect(() =>
      TopicMatchResultSchema.parse({
        current_meeting_id: "m_001",
        matched_kb_id: null,
        matched_kb_name: null,
        score: 0.72,
        match_reasons: ["弱相关"],
        suggested_action: "ask_append",
        candidate_meeting_ids: ["m_001"]
      })
    ).toThrow(/observe/);
  });

  it("requires at least two meetings for ask_create", () => {
    expect(() =>
      TopicMatchResultSchema.parse({
        current_meeting_id: "m_001",
        matched_kb_id: null,
        matched_kb_name: null,
        score: 0.92,
        match_reasons: ["强相关"],
        suggested_action: "ask_create",
        candidate_meeting_ids: ["m_001"]
      })
    ).toThrow(/at least two/);
  });
});
