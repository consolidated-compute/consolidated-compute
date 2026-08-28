import { useMemo } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import { useFetchInfiniteQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  assignmentRunListQueryKey,
  flattenAssignmentRunPages,
  type AssignmentRunPage,
} from "./run-data";

const ASSIGNMENT_RUN_PAGE_LIMIT = 50;
const ASSIGNMENT_RUN_REFRESH_INTERVAL_MS = 5_000;

export function useAssignmentRuns(serverId: string, assignmentId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const enabled = Boolean(client && connected && assignmentId);
  const query = useFetchInfiniteQuery<
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
    refetchInterval: ASSIGNMENT_RUN_REFRESH_INTERVAL_MS,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      if (!client) throw new Error("Host is offline");
      const payload = await client.listTeamRuns({
        limit: ASSIGNMENT_RUN_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      return {
        runs: payload.runs.filter((run) => run.assignmentId === assignmentId),
        nextCursor: payload.nextCursor,
      };
    },
  });
  const runs = useMemo(
    () => flattenAssignmentRunPages(query.data?.pages ?? []),
    [query.data?.pages],
  );
  return { ...query, runs, canLoad: enabled };
}
