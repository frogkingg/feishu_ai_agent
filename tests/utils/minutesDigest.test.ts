import {
  buildMinutesDigestTranscriptText,
  extractMinutesDigestArtifacts
} from "../../src/utils/minutesDigest";

describe("minutes digest builder", () => {
  it("builds compact transcript_text from summary, todos, chapters, and key points", () => {
    const hugeTranscript = [
      "第一句可以作为证据。".repeat(120),
      "FULL_TRANSCRIPT_SHOULD_NOT_SURVIVE",
      "后面还有很多逐字稿。".repeat(600)
    ].join("\n");

    const digest = buildMinutesDigestTranscriptText({
      title: "产品路线评审",
      externalMeetingId: "om_001",
      minutesUrl: "https://example.feishu.cn/minutes/min_001",
      summary: "会议确认下一版路线围绕交付风险、用户反馈和发布节奏收敛。",
      todos: [
        { title: "整理用户反馈", owner: "张三", due_date: "2026-05-06" },
        { title: "补齐发布风险清单", owner: "李四" }
      ],
      chapters: [
        { title: "风险复盘", summary: "讨论上线前阻塞项。" },
        { title: "发布节奏", summary: "确认灰度与复盘节点。" }
      ],
      keyPoints: ["先完成风险清单", "灰度后复盘用户反馈"],
      transcriptText: hugeTranscript
    });

    expect(digest).toContain("MeetingAtlas minutes digest input");
    expect(digest).toContain("title: 产品路线评审");
    expect(digest).toContain("https://example.feishu.cn/minutes/min_001");
    expect(digest).toContain("会议确认下一版路线");
    expect(digest).toContain("整理用户反馈");
    expect(digest).toContain("风险复盘");
    expect(digest).toContain("灰度后复盘用户反馈");
    expect(digest).toContain("full_transcript: omitted_by_design");
    expect(digest).not.toContain("FULL_TRANSCRIPT_SHOULD_NOT_SURVIVE");
    expect(digest.length).toBeLessThanOrEqual(7000);
  });

  it("extracts Feishu-style artifacts from nested notes payloads", () => {
    const artifacts = extractMinutesDigestArtifacts({
      data: {
        notes: [
          {
            topic: "复盘会",
            url: "https://example.feishu.cn/minutes/min_002",
            artifacts: {
              summary: "本次复盘聚焦问题闭环。",
              todos: [{ text: "王五整理复盘结论。" }],
              chapters: [{ title: "问题定位", content: "确认根因和后续动作。" }],
              key_points: ["先关掉高风险项"]
            },
            transcript: "这是一段很长的逐字稿原文。"
          }
        ]
      }
    });

    expect(artifacts.title).toBe("复盘会");
    expect(artifacts.sourceLinks).toContain("https://example.feishu.cn/minutes/min_002");
    expect(artifacts.summary).toContain("本次复盘聚焦问题闭环。");
    expect(artifacts.todos[0]).toContain("王五整理复盘结论");
    expect(artifacts.chapters[0]).toContain("问题定位");
    expect(artifacts.keyPoints).toContain("先关掉高风险项");
    expect(artifacts.transcriptText).toBe("这是一段很长的逐字稿原文。");
  });
});
