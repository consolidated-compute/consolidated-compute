import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { teamRunListQueryKey, teamRunQueryKey, upsertTeamRunPages } from "./run-data";
import type { TeamRunFormSubmission } from "./run-form-model";
import type { TeamRunPage } from "./use-team-runs";

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host is offline");
  return client;
}

function updateRunPages(
  current: InfiniteData<TeamRunPage, string | null> | undefined,
  run: TeamRunDto,
): InfiniteData<TeamRunPage, string | null> | undefined {
  if (!current) return current;
  return {
    ...current,
    pages: upsertTeamRunPages(current.pages, run),
  };
}

export function useTeamRunMutations() {
  const queryClient = useQueryClient();
  const applyRun = async (serverId: string, run: TeamRunDto) => {
    const listKey = teamRunListQueryKey(serverId, run.teamId);
    const detailKey = teamRunQueryKey(serverId, run.id);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: listKey, exact: true }),
      queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
    ]);
    queryClient.setQueryData(detailKey, run);
    queryClient.setQueryData<InfiniteData<TeamRunPage, string | null>>(listKey, (current) =>
      updateRunPages(current, run),
    );
    void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
  };

  const start = useMutation({
    mutationFn: async (input: TeamRunFormSubmission) => {
      const client = requireClient(input.serverId);
      const shared = {
        teamId: input.teamId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        workspaceId: input.workspaceId,
      };
      if (input.assignmentId !== undefined) {
        return client.startAssignmentTeamRun({
          ...shared,
          assignmentId: input.assignmentId,
          expectedAssignmentRevision: input.expectedAssignmentRevision,
        });
      }
      return client.startTeamRun({ ...shared, objective: input.objective });
    },
    onSuccess: async (payload, input) => applyRun(input.serverId, payload.run),
  });

  const cancel = useMutation({
    mutationFn: async (input: { serverId: string; runId: string }) => ({
      serverId: input.serverId,
      payload: await requireClient(input.serverId).cancelTeamRun(input.runId),
    }),
    onSuccess: async ({ serverId, payload }) => applyRun(serverId, payload.run),
  });

  return { start, cancel };
}
