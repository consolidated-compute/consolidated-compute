import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { TeamSupervisionResponseSubmission } from "./supervision-response-form-model";
import {
  teamRunSupervisionEventsQueryKey,
  teamRunSupervisionQueryKey,
  updateTeamRunSupervisionSummary,
} from "./supervision-data";
import { teamRunQueryKey } from "./run-data";

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host is offline");
  return client;
}

export function useTeamRunSupervisionMutations() {
  const queryClient = useQueryClient();
  const respond = useMutation({
    mutationFn: async (input: TeamSupervisionResponseSubmission) => {
      const payload = await requireClient(input.serverId).respondToTeamRunSupervisionHumanRequest({
        runId: input.runId,
        humanRequestId: input.humanRequestId,
        expectedRevision: input.expectedRevision,
        actionId: input.actionId,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      });
      return { input, supervision: payload.supervision };
    },
    onSuccess: async ({ input, supervision }) => {
      queryClient.setQueryData(
        teamRunSupervisionQueryKey(input.serverId, input.runId),
        supervision,
      );
      queryClient.setQueryData<TeamRunDto>(teamRunQueryKey(input.serverId, input.runId), (run) =>
        updateTeamRunSupervisionSummary(run, supervision),
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: teamRunSupervisionEventsQueryKey(input.serverId, input.runId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: teamRunQueryKey(input.serverId, input.runId),
          exact: true,
        }),
      ]);
    },
  });
  return { respond };
}
