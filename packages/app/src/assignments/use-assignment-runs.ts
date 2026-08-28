import { useEffect, useMemo } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { useFetchInfiniteQuery, useFetchQueries, useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  isTerminalTeamRunStatus,
  newestTeamRunSnapshot,
  teamRunQueryKey,
  upsertTeamRun,
} from "@/teams/run-data";
import {
  assignmentRunListQueryKey,
  assignmentRunRecentQueryKey,
  flattenAssignmentRunPages,
  hasUnrecordedAssignmentRuns,
  loadNextAssignmentRunPage,
  type AssignmentRunPage,
} from "./run-data";

const ASSIGNMENT_RUN_PAGE_LIMIT = 50;
const ASSIGNMENT_RUN_RECENT_LIMIT = 100;
const ASSIGNMENT_RUN_ACTIVITY_REFRESH_INTERVAL_MS = 5_000;

export function useAssignmentRuns(
  serverId: string,
  assignmentId: string,
  options: { watchForNewRuns?: boolean } = {},
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const enabled = Boolean(client && connected && assignmentId);
  const historyQuery = useFetchInfiniteQuery<
    AssignmentRunPage,
    Error,
    InfiniteData<AssignmentRunPage, string | null>,
    ReturnType<typeof assignmentRunListQueryKey>,
    string | null
  >({
    queryKey: assignmentRunListQueryKey(serverId, assignmentId),
    dataShape: "list",
    enabled,
    initialPageParam: null,
    staleTimeMs: 0,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      if (!client) throw new Error("Host is offline");
      return loadNextAssignmentRunPage({
        assignmentId,
        cursor: pageParam,
        loadPage: async (cursor) => {
          const payload = await client.listTeamRuns({
            limit: ASSIGNMENT_RUN_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          });
          return { runs: payload.runs, nextCursor: payload.nextCursor };
        },
      });
    },
  });
  const recentQuery = useFetchQuery<
    AssignmentRunPage,
    Error,
    AssignmentRunPage,
    ReturnType<typeof assignmentRunRecentQueryKey>
  >({
    queryKey: assignmentRunRecentQueryKey(serverId, assignmentId),
    dataShape: "value",
    enabled: Boolean(enabled && options.watchForNewRuns),
    staleTimeMs: 0,
    refetchInterval: options.watchForNewRuns ? ASSIGNMENT_RUN_ACTIVITY_REFRESH_INTERVAL_MS : false,
    queryFn: async () => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.listTeamRuns({ limit: ASSIGNMENT_RUN_RECENT_LIMIT });
      return {
        runs: payload.runs.filter((run) => run.assignmentId === assignmentId),
        nextCursor: null,
      };
    },
  });
  const historyRuns = useMemo(
    () => flattenAssignmentRunPages(historyQuery.data?.pages ?? []),
    [historyQuery.data?.pages],
  );
  const recentRuns = recentQuery.data?.runs ?? [];
  const shouldRefreshHistory =
    historyQuery.data !== undefined && hasUnrecordedAssignmentRuns(recentRuns, historyRuns);
  const { refetch: refetchHistory } = historyQuery;
  useEffect(() => {
    if (shouldRefreshHistory) void refetchHistory();
  }, [refetchHistory, shouldRefreshHistory]);
  const observedRuns = useMemo(
    () =>
      flattenAssignmentRunPages([
        ...(recentQuery.data ? [recentQuery.data] : []),
        ...(historyQuery.data?.pages ?? []),
      ]),
    [historyQuery.data?.pages, recentQuery.data],
  );
  const activeRuns = observedRuns.filter((run) => !isTerminalTeamRunStatus(run.state.status));
  const activeRunQueries = useFetchQueries<TeamRunDto>(
    activeRuns.map((run) => ({
      queryKey: teamRunQueryKey(serverId, run.id),
      dataShape: "value",
      staleTimeMs: 0,
      enabled,
      refetchInterval: (query) =>
        query.state.data && isTerminalTeamRunStatus(query.state.data.state.status)
          ? false
          : ASSIGNMENT_RUN_ACTIVITY_REFRESH_INTERVAL_MS,
      queryFn: async () => {
        if (!client) throw new Error("Host is offline");
        const payload = await client.getTeamRun(run.id);
        return payload.run;
      },
    })),
  );
  const runs = activeRunQueries.reduce((currentRuns, activeRunQuery) => {
    if (!activeRunQuery.data) return currentRuns;
    const listedRun = currentRuns.find((run) => run.id === activeRunQuery.data?.id);
    return upsertTeamRun(
      currentRuns,
      listedRun ? newestTeamRunSnapshot(listedRun, activeRunQuery.data) : activeRunQuery.data,
    );
  }, observedRuns);
  return { ...historyQuery, runs, canLoad: enabled };
}
