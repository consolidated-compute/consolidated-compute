import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssignmentInputDto, AssignmentPatchDto } from "@getpaseo/protocol/assignment/types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { applyAssignmentMutation } from "./mutation-cache";

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("Host is offline");
  return client;
}

export function useAssignmentMutations() {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: async (input: { serverId: string; assignment: AssignmentInputDto }) => ({
      serverId: input.serverId,
      payload: await requireClient(input.serverId).createAssignment(input.assignment),
    }),
    onSuccess: async ({ serverId, payload }) =>
      applyAssignmentMutation(queryClient, serverId, payload.assignment),
  });
  const update = useMutation({
    mutationFn: async (input: {
      serverId: string;
      assignmentId: string;
      expectedRevision: number;
      patch: AssignmentPatchDto;
    }) => ({
      serverId: input.serverId,
      payload: await requireClient(input.serverId).patchAssignment({
        assignmentId: input.assignmentId,
        expectedRevision: input.expectedRevision,
        patch: input.patch,
      }),
    }),
    onSuccess: async ({ serverId, payload }) =>
      applyAssignmentMutation(queryClient, serverId, payload.assignment),
  });
  const complete = useMutation({
    mutationFn: async (input: {
      serverId: string;
      assignmentId: string;
      expectedRevision: number;
    }) => ({
      serverId: input.serverId,
      payload: await requireClient(input.serverId).completeAssignment({
        assignmentId: input.assignmentId,
        expectedRevision: input.expectedRevision,
      }),
    }),
    onSuccess: async ({ serverId, payload }) =>
      applyAssignmentMutation(queryClient, serverId, payload.assignment),
  });
  const cancel = useMutation({
    mutationFn: async (input: {
      serverId: string;
      assignmentId: string;
      expectedRevision: number;
    }) => ({
      serverId: input.serverId,
      payload: await requireClient(input.serverId).cancelAssignment({
        assignmentId: input.assignmentId,
        expectedRevision: input.expectedRevision,
      }),
    }),
    onSuccess: async ({ serverId, payload }) =>
      applyAssignmentMutation(queryClient, serverId, payload.assignment),
  });
  return { create, update, complete, cancel };
}
