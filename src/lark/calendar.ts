// Calendar behavior is still hosted in app.ts for this MVP refactor.
// This module marks the boundary for the next extraction step.
export interface CalendarWorkflowBoundary {
  explicitOnly: true;
}

export const calendarWorkflowBoundary: CalendarWorkflowBoundary = { explicitOnly: true };
