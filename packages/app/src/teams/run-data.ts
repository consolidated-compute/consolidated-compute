import type { TeamRunDto } from "@getpaseo/protocol/team/types";

export const teamRunsQueryBaseKey = ["teamRuns"] as const;

export interface TeamRunPageData {
  runs: TeamRunDto[];
  nextCursor: string | null;
}

export function teamRunListQueryKey(serverId: string, teamId: string) {
  return [...teamRunsQueryBaseKey, serverId, "team", teamId, "list"] as const;
}

export function teamRunQueryKey(serverId: string, runId: string) {
  return [...teamRunsQueryBaseKey, serverId, "run", runId] as const;
}

export function isTerminalTeamRunStatus(status: TeamRunDto["state"]["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled" ||
    status === "interrupted"
  );
}

export function canCancelTeamRun(status: TeamRunDto["state"]["status"]): boolean {
  return !isTerminalTeamRunStatus(status) && status !== "stopping";
}

export function matchesTeamRunRoute(run: TeamRunDto, teamId: string): boolean {
  return run.teamId === teamId && run.teamSnapshot.id === teamId;
}

export function upsertTeamRun(runs: readonly TeamRunDto[], run: TeamRunDto): TeamRunDto[] {
  const next = runs.filter((entry) => entry.id !== run.id);
  next.push(run);
  return next.sort((left, right) => {
    const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return created || right.id.localeCompare(left.id);
  });
}

export function upsertTeamRunPages(
  pages: readonly TeamRunPageData[],
  run: TeamRunDto,
): TeamRunPageData[] {
  if (pages.length === 0) return [{ runs: [run], nextCursor: null }];
  return pages.map((page, index) => ({
    ...page,
    runs:
      index === 0
        ? upsertTeamRun(page.runs, run)
        : page.runs.filter((entry) => entry.id !== run.id),
  }));
}

export function flattenTeamRunPages(pages: readonly TeamRunPageData[]): TeamRunDto[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.runs.filter((run) => {
      if (seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    }),
  );
}

export function newestTeamRunSnapshot(listRun: TeamRunDto, detailRun?: TeamRunDto): TeamRunDto {
  if (!detailRun) return listRun;
  return Date.parse(detailRun.updatedAt) >= Date.parse(listRun.updatedAt) ? detailRun : listRun;
}
