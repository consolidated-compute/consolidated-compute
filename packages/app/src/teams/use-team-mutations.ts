import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  TeamDefinitionDto,
  TeamDefinitionInputDto,
  TeamDefinitionPatchDto,
} from "@getpaseo/protocol/team/types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { teamListQueryKey } from "./data";
import { invalidateTeamList, prepareTeamListMutation, upsertTeam } from "./mutation-cache";

export interface CreateTeamInput {
  serverId: string;
  definition: TeamDefinitionInputDto;
}

export interface UpdateTeamInput {
  serverId: string;
  teamId: string;
  expectedRevision: number;
  patch: TeamDefinitionPatchDto;
}

export interface DeleteTeamInput {
  serverId: string;
  teamId: string;
  expectedRevision: number;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host is offline");
  return client;
}

export function useTeamMutations() {
  const queryClient = useQueryClient();
  const updateCachedList = useCallback(
    (serverId: string, update: (current: TeamDefinitionDto[]) => TeamDefinitionDto[]) => {
      queryClient.setQueryData<TeamDefinitionDto[]>(teamListQueryKey(serverId), (current) =>
        update(current ?? []),
      );
    },
    [queryClient],
  );

  const create = useMutation({
    mutationFn: async (input: CreateTeamInput) =>
      requireClient(input.serverId).createTeam(input.definition),
    onSuccess: async (payload, input) => {
      await prepareTeamListMutation(queryClient, input.serverId);
      updateCachedList(input.serverId, (current) => upsertTeam(current, payload.team));
    },
    onSettled: (_payload, _error, input) => invalidateTeamList(queryClient, input.serverId),
  });

  const update = useMutation({
    mutationFn: async (input: UpdateTeamInput) =>
      requireClient(input.serverId).updateTeam({
        teamId: input.teamId,
        expectedRevision: input.expectedRevision,
        patch: input.patch,
      }),
    onSuccess: async (payload, input) => {
      await prepareTeamListMutation(queryClient, input.serverId);
      updateCachedList(input.serverId, (current) =>
        current.map((team) => (team.id === payload.team.id ? payload.team : team)),
      );
    },
    onSettled: (_payload, _error, input) => invalidateTeamList(queryClient, input.serverId),
  });

  const remove = useMutation({
    mutationFn: async (input: DeleteTeamInput) =>
      requireClient(input.serverId).deleteTeam({
        teamId: input.teamId,
        expectedRevision: input.expectedRevision,
      }),
    onSuccess: async (_payload, input) => {
      await prepareTeamListMutation(queryClient, input.serverId);
      updateCachedList(input.serverId, (current) =>
        current.filter((team) => team.id !== input.teamId),
      );
    },
    onSettled: (_payload, _error, input) => invalidateTeamList(queryClient, input.serverId),
  });

  return { create, update, remove };
}
