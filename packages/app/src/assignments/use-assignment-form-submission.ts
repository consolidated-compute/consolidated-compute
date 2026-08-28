import { useCallback, useEffect, useRef } from "react";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import type { AssignmentFormModel } from "./form-model";
import { useAssignmentMutations } from "./use-assignment-mutations";

function rpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function useAssignmentFormSubmission(
  model: AssignmentFormModel,
  onSaved: (serverId: string, assignment: AssignmentDto) => void,
  conflictMessage: string,
) {
  const mutations = useAssignmentMutations();
  const acceptsCompletionRef = useRef(true);

  useEffect(
    () => () => {
      acceptsCompletionRef.current = false;
    },
    [],
  );

  const cancelCompletion = useCallback(() => {
    acceptsCompletionRef.current = false;
  }, []);
  const save = useCallback(async () => {
    const submission = model.getState().submission;
    if (!submission) return;
    model.setSubmitError(null);
    try {
      if (submission.kind === "create") {
        const result = await mutations.create.mutateAsync({
          serverId: submission.serverId,
          assignment: submission.assignment,
        });
        if (!acceptsCompletionRef.current) return;
        onSaved(submission.serverId, result.payload.assignment);
        return;
      }
      const result = await mutations.update.mutateAsync({
        serverId: submission.serverId,
        assignmentId: submission.assignmentId,
        expectedRevision: submission.expectedRevision,
        patch: submission.patch,
      });
      if (!acceptsCompletionRef.current) return;
      onSaved(submission.serverId, result.payload.assignment);
    } catch (error) {
      if (!acceptsCompletionRef.current) return;
      if (submission.kind === "update" && rpcErrorCode(error) === "assignment_revision_conflict") {
        try {
          const client = getHostRuntimeStore().getClient(submission.serverId);
          if (!client) throw error;
          const latest = await client.getAssignment(submission.assignmentId);
          if (!acceptsCompletionRef.current) return;
          model.applyRemoteRevision(latest.assignment.revision);
          model.setSubmitError(conflictMessage);
          return;
        } catch (refreshError) {
          if (!acceptsCompletionRef.current) return;
          model.setSubmitError(toErrorMessage(refreshError));
          return;
        }
      }
      model.setSubmitError(toErrorMessage(error));
    }
  }, [conflictMessage, model, mutations.create, mutations.update, onSaved]);
  const savePress = useCallback(() => void save(), [save]);

  return {
    cancelCompletion,
    pending: mutations.create.isPending || mutations.update.isPending,
    savePress,
  };
}
