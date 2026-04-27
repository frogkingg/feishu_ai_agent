import { isExplicitCalendarIntent } from "../agent/router";
import { NormalizedMessageEvent, RouterDecision } from "../llm/schemas";

export function shouldEnterCalendarWorkflow(event: NormalizedMessageEvent, route: RouterDecision) {
  return route.primaryDomain === "calendar" && isExplicitCalendarIntent(event.text);
}
