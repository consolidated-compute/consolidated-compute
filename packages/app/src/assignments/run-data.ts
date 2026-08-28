import type { TeamRunDto } from "@getpaseo/protocol/team/types";

export const assignmentRunsQueryBaseKey = ["assignmentRuns"] as const;

export interface AssignmentRunPage {
  runs: TeamRunDto[];
  nextCursor: string | null;
}

interface AssignmentRunReference {
  assignmentId?: string;
}

interface AssignmentRunScanPage<TRun extends AssignmentRunReference> {
  runs: TRun[];
  nextCursor: string | null;
}

export function assignmentRunListQueryKey(serverId: string, assignmentId: string) {
  return [...assignmentRunsQueryBaseKey, serverId, assignmentId, "list"] as const;
}

export function assignmentRunRecentQueryKey(serverId: string, assignmentId: string) {
  return [...assignmentRunsQueryBaseKey, serverId, assignmentId, "recent"] as const;
}

export function hasUnrecordedAssignmentRuns(
  recentRuns: readonly { id: string }[],
  recordedRuns: readonly { id: string }[],
): boolean {
  const recordedIds = new Set(recordedRuns.map((run) => run.id));
  return recentRuns.some((run) => !recordedIds.has(run.id));
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

export async function loadNextAssignmentRunPage<TRun extends AssignmentRunReference>(input: {
  assignmentId: string;
  cursor: string | null;
  loadPage: (cursor: string | null) => Promise<AssignmentRunScanPage<TRun>>;
}): Promise<AssignmentRunScanPage<TRun>> {
  let cursor = input.cursor;
  while (true) {
    const page = await input.loadPage(cursor);
    const runs = page.runs.filter((run) => run.assignmentId === input.assignmentId);
    if (runs.length > 0 || page.nextCursor === null) {
      return { runs, nextCursor: page.nextCursor };
    }
    cursor = page.nextCursor;
  }
}
