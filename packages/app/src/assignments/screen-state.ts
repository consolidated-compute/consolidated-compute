import type { AggregatedTeam } from "@/teams/data";
import { assignmentKey, type AggregatedAssignment } from "./data";

export type AssignmentsView =
  | { kind: "list" }
  | { kind: "detail"; serverId: string; assignmentId: string };

export function resolveActiveAssignmentKey(
  view: AssignmentsView,
  selectedAssignment: AggregatedAssignment | null,
): string | null {
  if (view.kind === "detail") return assignmentKey(view.serverId, view.assignmentId);
  return selectedAssignment?.key ?? null;
}

export function teamsForAssignment(
  assignment: AggregatedAssignment,
  teams: readonly AggregatedTeam[],
): AggregatedTeam[] {
  return teams.filter((team) => team.serverId === assignment.serverId);
}
