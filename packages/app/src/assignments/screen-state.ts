import type { AggregatedTeam, TeamHostState } from "@/teams/data";
import { assignmentKey, type AggregatedAssignment, type AssignmentHostState } from "./data";

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

export function isAssignmentTeamPickerReady(
  serverId: string,
  hosts: readonly TeamHostState[],
): boolean {
  const host = hosts.find((entry) => entry.serverId === serverId);
  return host?.status === "ready" && host.canAuthor;
}

export function isAssignmentRunEnabled(
  assignment: AggregatedAssignment | null,
  assignmentHost: AssignmentHostState | null,
  teamHosts: readonly TeamHostState[],
): boolean {
  if (!assignment || assignment.state.status !== "open") return false;
  if (assignmentHost?.status !== "ready" || !assignmentHost.canAuthor) return false;
  return isAssignmentTeamPickerReady(assignment.serverId, teamHosts);
}
