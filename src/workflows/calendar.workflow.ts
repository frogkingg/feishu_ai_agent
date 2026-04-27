import { isExplicitCalendarIntent } from "../agent/router";
import { NormalizedMessageEvent, RouterDecision } from "../llm/schemas";

export interface CalendarWorkflowGate {
  shouldEnter: boolean;
  reason: string;
}

export function shouldEnterCalendarWorkflow(event: NormalizedMessageEvent, route: RouterDecision) {
  if (route.primaryDomain !== "calendar") {
    return {
      shouldEnter: false,
      reason: `primaryDomain=${route.primaryDomain}`,
    } satisfies CalendarWorkflowGate;
  }

  if (!isExplicitCalendarIntent(event.text)) {
    return {
      shouldEnter: false,
      reason: "calendar route is not backed by explicit calendar intent",
    } satisfies CalendarWorkflowGate;
  }

  return {
    shouldEnter: true,
    reason: "explicit calendar intent",
  } satisfies CalendarWorkflowGate;
}
