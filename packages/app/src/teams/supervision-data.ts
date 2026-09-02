import type {
  TeamRunDto,
  TeamRunSupervisionEventDto,
  TeamRunSupervisionStateDto,
  TeamRunSupervisionSummaryDto,
} from "@getpaseo/protocol/team/types";

export const teamRunSupervisionQueryBaseKey = ["teamRunSupervision"] as const;

export interface TeamRunSupervisionEventPage {
  events: TeamRunSupervisionEventDto[];
  nextCursor: string | null;
}

export interface TeamRunSupervisionPresentation {
  labelKey: string | null;
  fallbackLabel: string;
  variant: "success" | "warning" | "error" | "muted";
}

const KNOWN_SUPERVISION_STATUSES = new Set([
  "queued",
  "planning",
  "working",
  "awaiting_human",
  "completed",
  "failed",
  "canceled",
  "interrupted",
]);

export function teamRunSupervisionQueryKey(serverId: string, runId: string) {
  return [...teamRunSupervisionQueryBaseKey, serverId, runId, "state"] as const;
}

export function teamRunSupervisionEventsQueryKey(serverId: string, runId: string) {
  return [...teamRunSupervisionQueryBaseKey, serverId, runId, "events"] as const;
}

export function flattenTeamRunSupervisionEventPages(
  pages: readonly TeamRunSupervisionEventPage[],
): TeamRunSupervisionEventDto[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.events.filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    }),
  );
}

export function teamRunSupervisionPresentation(
  summary: TeamRunSupervisionSummaryDto,
): TeamRunSupervisionPresentation {
  if (summary.pendingHumanRequest) {
    return {
      labelKey: "teams.runs.supervision.needsReview",
      fallbackLabel: "Needs review",
      variant: "warning",
    };
  }
  const labelKey = KNOWN_SUPERVISION_STATUSES.has(summary.status)
    ? `teams.runs.supervision.status.${summary.status}`
    : null;
  let variant: TeamRunSupervisionPresentation["variant"] = "muted";
  if (summary.status === "completed") {
    variant = "success";
  } else if (
    summary.status === "failed" ||
    summary.status === "canceled" ||
    summary.status === "interrupted"
  ) {
    variant = "error";
  } else if (summary.status === "awaiting_human") {
    variant = "warning";
  }
  return { labelKey, fallbackLabel: summary.status, variant };
}

export function toTeamRunSupervisionSummary(
  state: TeamRunSupervisionStateDto,
): TeamRunSupervisionSummaryDto {
  const request = state.humanRequest;
  const pendingRequest = request && !request.resolution && !request.retirement ? request : null;
  return {
    status: state.status,
    supervisorRoleId: state.supervisorRoleId,
    supervisorAgentId: state.supervisorAgentId,
    completedWorkItems: state.completedWorkItems,
    totalWorkItems: state.totalWorkItems,
    ...(pendingRequest
      ? {
          pendingHumanRequest: {
            id: pendingRequest.id,
            kind: pendingRequest.kind,
            title: pendingRequest.title,
            revision: pendingRequest.revision,
          },
        }
      : {}),
    updatedAt: state.updatedAt,
  };
}

export function newestTeamRunSupervisionSummary(
  retained: TeamRunSupervisionSummaryDto | undefined,
  fetched: TeamRunSupervisionStateDto | undefined,
): TeamRunSupervisionSummaryDto | undefined {
  if (!fetched) return retained;
  const fetchedSummary = toTeamRunSupervisionSummary(fetched);
  if (!retained) return fetchedSummary;
  return Date.parse(fetchedSummary.updatedAt) >= Date.parse(retained.updatedAt)
    ? fetchedSummary
    : retained;
}

export function updateTeamRunSupervisionSummary(
  run: TeamRunDto | undefined,
  state: TeamRunSupervisionStateDto,
): TeamRunDto | undefined {
  if (!run || run.id !== state.runId) return run;
  return {
    ...run,
    supervision: toTeamRunSupervisionSummary(state),
    updatedAt:
      Date.parse(state.updatedAt) > Date.parse(run.updatedAt) ? state.updatedAt : run.updatedAt,
  };
}
