import { useCallback, useEffect, useRef } from "react";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { toErrorMessage } from "@/utils/error-messages";
import type { TeamRunFormModel } from "./run-form-model";
import { useTeamRunMutations } from "./use-team-run-mutations";

export function useTeamRunFormSubmission(
  model: TeamRunFormModel,
  onStarted: (run: TeamRunDto) => void,
) {
  const mutations = useTeamRunMutations();
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
  const start = useCallback(async () => {
    const submission = model.getState().submission;
    if (!submission) return;
    model.setSubmitError(null);
    try {
      const payload = await mutations.start.mutateAsync(submission);
      if (!acceptsCompletionRef.current) return;
      onStarted(payload.run);
    } catch (error) {
      if (!acceptsCompletionRef.current) return;
      model.setSubmitError(toErrorMessage(error));
    }
  }, [model, mutations.start, onStarted]);
  const startPress = useCallback(() => void start(), [start]);

  return {
    cancelCompletion,
    pending: mutations.start.isPending,
    startPress,
  };
}
