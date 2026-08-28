import type { TeamRunDto } from "@getpaseo/protocol/team/types";

export const assignmentRunsQueryBaseKey = ["assignmentRuns"] as const;

export interface AssignmentRunPage {
  runs: TeamRunDto[];
  nextCursor: string | null;
}

export function assignmentRunListQueryKey(serverId: string, assignmentId: string) {
  return [...assignmentRunsQueryBaseKey, serverId, assignmentId, "list"] as const;
}

export function flattenAssignmentRunPages(pages: readonly AssignmentRunPage[]): TeamRunDto[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.runs.filter((run) => {
      if (seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    }),
  );
}
