import type { ScheduleAssignmentTeamCatalog } from "./schedule-form-model";

export function resolveAssignmentTeamCatalogStatus(input: {
  supported: boolean;
  assignmentsStatus: string | null;
  teamsStatus: string | null;
  workspacesHydrated: boolean;
}): ScheduleAssignmentTeamCatalog["status"] {
  if (!input.supported) return "unsupported";
  if (input.assignmentsStatus === "error" || input.teamsStatus === "error") return "error";
  if (input.assignmentsStatus === "offline" || input.teamsStatus === "offline") return "error";
  if (input.assignmentsStatus === "unsupported" || input.teamsStatus === "unsupported") {
    return "unsupported";
  }
  if (
    input.assignmentsStatus !== "ready" ||
    input.teamsStatus !== "ready" ||
    !input.workspacesHydrated
  ) {
    return "loading";
  }
  return "ready";
}
