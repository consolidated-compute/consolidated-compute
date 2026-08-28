import { useMemo } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import { useFetchInfiniteQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  assignmentArtifactIssues,
  assignmentArtifactListQueryKey,
  flattenAssignmentArtifactPages,
  loadNextTeamRunArtifactPage,
  type AssignmentArtifactPage,
} from "./artifact-data";

const ASSIGNMENT_ARTIFACT_PAGE_LIMIT = 50;
const ASSIGNMENT_ARTIFACT_REFRESH_INTERVAL_MS = 5_000;

export function useAssignmentArtifacts(
  serverId: string,
  assignmentId: string,
  options: { teamRunId?: string } = {},
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const enabled = Boolean(client && connected && assignmentId);
  const query = useFetchInfiniteQuery<
    AssignmentArtifactPage,
    Error,
    InfiniteData<AssignmentArtifactPage, string | null>,
    ReturnType<typeof assignmentArtifactListQueryKey>,
    string | null
  >({
    queryKey: assignmentArtifactListQueryKey(serverId, assignmentId, options.teamRunId),
    dataShape: "list",
    enabled,
    initialPageParam: null,
    staleTimeMs: 0,
    refetchInterval: ASSIGNMENT_ARTIFACT_REFRESH_INTERVAL_MS,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      if (!client) throw new Error("Host is offline");
      const loadPage = async (cursor: string | null): Promise<AssignmentArtifactPage> => {
        const payload = await client.listAssignmentArtifacts({
          assignmentId,
          limit: ASSIGNMENT_ARTIFACT_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        return {
          artifacts: payload.artifacts,
          nextCursor: payload.nextCursor,
          issues: payload.issues ?? [],
        };
      };
      return options.teamRunId
        ? loadNextTeamRunArtifactPage({ teamRunId: options.teamRunId, cursor: pageParam, loadPage })
        : loadPage(pageParam);
    },
  });
  const artifacts = useMemo(
    () => flattenAssignmentArtifactPages(query.data?.pages ?? []),
    [query.data?.pages],
  );
  const issues = useMemo(
    () => assignmentArtifactIssues(query.data?.pages ?? []),
    [query.data?.pages],
  );
  return { ...query, artifacts, issues, canLoad: enabled };
}
