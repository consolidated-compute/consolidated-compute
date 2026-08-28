import type {
  AssignmentCollectionIssueDto,
  AssignmentDto,
} from "@getpaseo/protocol/assignment/types";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export const assignmentsQueryBaseKey = ["assignments"] as const;

export function assignmentListQueryKey(serverId: string) {
  return [...assignmentsQueryBaseKey, serverId, "list"] as const;
}

export function assignmentQueryKey(serverId: string, assignmentId: string) {
  return [...assignmentsQueryBaseKey, serverId, "detail", assignmentId] as const;
}

export interface AssignmentHostIdentity {
  serverId: string;
  serverName: string;
}

export interface AggregatedAssignment extends AssignmentDto {
  serverId: string;
  serverName: string;
  key: string;
}

export type AssignmentHostStatus =
  | "connecting"
  | "loading"
  | "ready"
  | "unsupported"
  | "offline"
  | "error";

export interface AssignmentHostState extends AssignmentHostIdentity {
  status: AssignmentHostStatus;
  assignments: AggregatedAssignment[];
  issues: AssignmentCollectionIssueDto[];
  canAuthor: boolean;
  error: string | null;
}

export interface AssignmentListData {
  assignments: AssignmentDto[];
  issues: AssignmentCollectionIssueDto[];
}

export interface AssignmentHostQuerySnapshot {
  data: AssignmentListData | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

export interface ResolveAssignmentHostStateInput extends AssignmentHostIdentity {
  connectionStatus: HostRuntimeConnectionStatus;
  assignmentsFeature: boolean | null;
  query: AssignmentHostQuerySnapshot;
  connectionError: string | null;
}

export function assignmentKey(serverId: string, assignmentId: string): string {
  return JSON.stringify([serverId, assignmentId]);
}

export function qualifyAssignments(
  host: AssignmentHostIdentity,
  assignments: readonly AssignmentDto[],
): AggregatedAssignment[] {
  return assignments.map((assignment) => ({
    ...assignment,
    serverId: host.serverId,
    serverName: host.serverName,
    key: assignmentKey(host.serverId, assignment.id),
  }));
}

export function resolveAssignmentHostState(
  input: ResolveAssignmentHostStateInput,
): AssignmentHostState {
  const assignments = qualifyAssignments(input, input.query.data?.assignments ?? []);
  const issues = input.query.data?.issues ?? [];
  const base = {
    serverId: input.serverId,
    serverName: input.serverName,
    assignments,
    issues,
  };

  if (input.connectionStatus === "connecting" || input.connectionStatus === "idle") {
    return { ...base, status: "connecting", canAuthor: false, error: null };
  }
  if (input.connectionStatus !== "online") {
    return { ...base, status: "offline", canAuthor: false, error: input.connectionError };
  }
  if (input.assignmentsFeature === false) {
    return { ...base, status: "unsupported", canAuthor: false, error: null };
  }
  if (input.assignmentsFeature === null || input.query.isLoading) {
    return { ...base, status: "loading", canAuthor: false, error: null };
  }
  if (input.query.isError) {
    return {
      ...base,
      status: "error",
      canAuthor: false,
      error: input.query.error?.message ?? "Unable to load Assignments",
    };
  }
  return { ...base, status: "ready", canAuthor: true, error: null };
}

export function upsertAssignment(
  assignments: readonly AssignmentDto[],
  assignment: AssignmentDto,
): AssignmentDto[] {
  return [...assignments.filter((entry) => entry.id !== assignment.id), assignment].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id),
  );
}
