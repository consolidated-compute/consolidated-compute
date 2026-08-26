import { useMemo } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import { useFetchInfiniteQuery, useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  isTerminalTeamRunStatus,
  flattenTeamRunPages,
  teamRunListQueryKey,
  teamRunQueryKey,
  type TeamRunPageData,
} from "./run-data";

const TEAM_RUN_PAGE_LIMIT = 20;
const ACTIVE_TEAM_RUN_REFRESH_INTERVAL_MS = 2_000;

export type TeamRunPage = TeamRunPageData;

export function useTeamRuns(serverId: string | null, teamId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const enabled = Boolean(serverId && teamId && client && connected);
  const queryKey = useMemo(
    () => teamRunListQueryKey(serverId ?? "", teamId ?? ""),
    [serverId, teamId],
  );
  const query = useFetchInfiniteQuery<
    TeamRunPage,
    Error,
    InfiniteData<TeamRunPage, string | null>,
    ReturnType<typeof teamRunListQueryKey>,
    string | null
  >({
    queryKey,
    dataShape: "list",
    enabled,
    initialPageParam: null,
    staleTimeMs: 0,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      if (!client || !teamId) throw new Error("Host is offline");
      const payload = await client.listTeamRuns({
        teamId,
        limit: TEAM_RUN_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      return { runs: payload.runs, nextCursor: payload.nextCursor };
    },
  });
  const runs = useMemo(() => flattenTeamRunPages(query.data?.pages ?? []), [query.data]);
  return { ...query, runs };
}

export function useTeamRun(serverId: string, runId: string, options: { enabled?: boolean } = {}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: teamRunQueryKey(serverId, runId),
    dataShape: "value",
    staleTimeMs: 0,
    enabled: Boolean((options.enabled ?? true) && client && connected && runId),
    refetchInterval: (query) =>
      query.state.data && !isTerminalTeamRunStatus(query.state.data.state.status)
        ? ACTIVE_TEAM_RUN_REFRESH_INTERVAL_MS
        : false,
    queryFn: async () => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.getTeamRun(runId);
      return payload.run;
    },
  });
}
