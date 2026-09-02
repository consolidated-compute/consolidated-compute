import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TeamRunDto, TeamRunSupervisionStateDto } from "@getpaseo/protocol/team/types";
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

export async function applyTeamRunSupervisionResponse(
  queryClient: QueryClient,
  input: Pick<TeamSupervisionResponseSubmission, "serverId" | "runId">,
  supervision: TeamRunSupervisionStateDto,
): Promise<void> {
  const supervisionKey = teamRunSupervisionQueryKey(input.serverId, input.runId);
  const runKey = teamRunQueryKey(input.serverId, input.runId);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: supervisionKey, exact: true }),
    queryClient.cancelQueries({ queryKey: runKey, exact: true }),
  ]);
  queryClient.setQueryData(supervisionKey, supervision);
  queryClient.setQueryData<TeamRunDto>(runKey, (run) =>
    updateTeamRunSupervisionSummary(run, supervision),
  );
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: teamRunSupervisionEventsQueryKey(input.serverId, input.runId),
      exact: true,
    }),
    queryClient.invalidateQueries({ queryKey: runKey, exact: true }),
  ]);
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
      await applyTeamRunSupervisionResponse(queryClient, input, supervision);
    },
  });
  return { respond };
}
