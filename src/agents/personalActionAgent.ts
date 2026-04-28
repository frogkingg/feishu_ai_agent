import { ActionItemDraft, ActionItemDraftSchema } from "../schemas";
import { Repositories, MeetingRow, ActionItemRow } from "../services/store/repositories";
import { createId } from "../utils/id";

export interface PersonalActionDraftRecord {
  row: ActionItemRow;
  draft: ActionItemDraft;
  recipient: string | null;
}

export async function runPersonalActionAgent(input: {
  repos: Repositories;
  meeting: MeetingRow;
  actionItems: ActionItemDraft[];
}): Promise<PersonalActionDraftRecord[]> {
  const records: PersonalActionDraftRecord[] = [];

  for (const item of input.actionItems) {
    const draft = ActionItemDraftSchema.parse(item);
    if (draft.confidence < 0.7 && draft.owner === null) {
      continue;
    }

    const row = input.repos.createActionItem({
      id: createId("act"),
      meeting_id: input.meeting.id,
      kb_id: null,
      title: draft.title,
      description: draft.description,
      owner: draft.owner,
      collaborators_json: JSON.stringify(draft.collaborators),
      due_date: draft.due_date,
      priority: draft.priority,
      evidence: draft.evidence,
      confidence: draft.confidence,
      suggested_reason: draft.suggested_reason,
      missing_fields_json: JSON.stringify(draft.missing_fields),
      confirmation_status: "sent",
      feishu_task_guid: null,
      task_url: null,
      rejection_reason: null
    });

    records.push({
      row,
      draft,
      recipient: draft.owner ?? input.meeting.organizer
    });
  }

  return records;
}
