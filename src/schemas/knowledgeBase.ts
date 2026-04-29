import { z } from "zod";

export const KnowledgeBaseStatusSchema = z.enum(["candidate", "active", "archived"]);

export const KnowledgeBasePageSchema = z.object({
  title: z.string().min(1),
  markdown: z.string().min(1),
  page_type: z.enum([
    "home",
    "goal",
    "analysis",
    "progress",
    "decisions",
    "index",
    "meeting_summary",
    "transcript",
    "sources",
    "risks",
    "changelog"
  ])
});

export const KnowledgeBaseDraftSchema = z.object({
  kb_id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().nullable(),
  description: z.string().nullable(),
  owner: z.string().nullable(),
  status: KnowledgeBaseStatusSchema.default("candidate"),
  confidence_origin: z.number().min(0).max(1),
  related_keywords: z.array(z.string()).default([]),
  created_from_meetings: z.array(z.string()).default([]),
  pages: z.array(KnowledgeBasePageSchema).min(1)
});

export const KnowledgeUpdateSchema = z.object({
  update_id: z.string().min(1),
  kb_id: z.string().min(1),
  update_type: z.enum([
    "meeting_added",
    "source_added",
    "progress_changed",
    "decision_added",
    "conflict_detected",
    "kb_created"
  ]),
  summary: z.string().min(1),
  source_ids: z.array(z.string()).default([]),
  before: z.string().nullable(),
  after: z.string().nullable(),
  created_by: z.enum(["agent", "user"]),
  confirmed_by: z.string().nullable(),
  created_at: z.string().min(1)
});

export type KnowledgeBasePage = z.infer<typeof KnowledgeBasePageSchema>;
export type KnowledgeBaseDraft = z.infer<typeof KnowledgeBaseDraftSchema>;
export type KnowledgeUpdate = z.infer<typeof KnowledgeUpdateSchema>;
