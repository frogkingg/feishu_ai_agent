import { z } from "zod";
import { ActionItemDraftSchema } from "./actionItem";
import { CalendarEventDraftSchema } from "./calendarDraft";
import { SourceMentionSchema } from "./source";

export const DecisionDraftSchema = z.object({
  decision: z.string().min(1),
  evidence: z.string().min(1)
});

export const RiskDraftSchema = z.object({
  risk: z.string().min(1),
  evidence: z.string().min(1)
});

export const MeetingExtractionResultSchema = z.object({
  meeting_summary: z.string().min(1),
  key_decisions: z.array(DecisionDraftSchema),
  action_items: z.array(ActionItemDraftSchema),
  calendar_drafts: z.array(CalendarEventDraftSchema),
  topic_keywords: z.array(z.string()),
  risks: z.array(RiskDraftSchema),
  source_mentions: z.array(SourceMentionSchema),
  confidence: z.number().min(0).max(1)
});

export type MeetingExtractionResult = z.infer<typeof MeetingExtractionResultSchema>;
export type DecisionDraft = z.infer<typeof DecisionDraftSchema>;
export type RiskDraft = z.infer<typeof RiskDraftSchema>;
