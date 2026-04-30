import {
  formatMeetingReference,
  formatOpenIdsInText,
  formatUserForDisplay
} from "../../src/utils/display";

describe("display utils", () => {
  it("formats Feishu open_ids without changing readable names", () => {
    expect(formatUserForDisplay("张三")).toBe("张三");
    expect(formatUserForDisplay("ou_xxx")).toBe("@用户(xxx)");
    expect(formatUserForDisplay("ou_user_123456")).toBe("@用户(123456)");
    expect(formatOpenIdsInText("负责人 ou_owner_abcdef，协作人 李四")).toBe(
      "负责人 @用户(abcdef)，协作人 李四"
    );
  });

  it("prioritizes meeting links before falling back to meeting id", () => {
    expect(
      formatMeetingReference(
        {
          id: "mtg_001",
          title: "无人机操作方案风险评审",
          minutes_url: "https://example.feishu.cn/minutes/min_001",
          transcript_url: "https://example.feishu.cn/minutes/transcript_001"
        },
        { preferredLink: "transcript" }
      )
    ).toBe("无人机操作方案风险评审（转写记录：https://example.feishu.cn/minutes/transcript_001）");

    expect(
      formatMeetingReference({
        id: "mtg_002",
        title: "没有链接的会议"
      })
    ).toBe("会议 mtg_002：没有链接的会议");
  });
});
