import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toErrorMessage } from "@/utils/error-messages";
import type { TeamSupervisionResponseFormModel } from "./supervision-response-form-model";
import { useTeamRunSupervisionMutations } from "./use-team-run-supervision-mutations";

function rpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function useTeamSupervisionResponseSubmission(
  model: TeamSupervisionResponseFormModel,
  onResponded: () => void,
  onConflict: () => void,
) {
  const { t } = useTranslation();
  const mutations = useTeamRunSupervisionMutations();
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
  const submit = useCallback(async () => {
    const submission = model.getState().submission;
    if (!submission) return;
    model.setSubmitError(null);
    try {
      await mutations.respond.mutateAsync(submission);
      if (acceptsCompletionRef.current) onResponded();
    } catch (error) {
      if (!acceptsCompletionRef.current) return;
      const code = rpcErrorCode(error);
      if (
        code === "team_run_supervision_human_request_revision_conflict" ||
        code === "team_run_supervision_human_request_conflict"
      ) {
        model.setSubmitError(t("teams.runs.supervision.response.conflict"));
        onConflict();
        return;
      }
      model.setSubmitError(toErrorMessage(error));
    }
  }, [model, mutations.respond, onConflict, onResponded, t]);
  const submitPress = useCallback(() => void submit(), [submit]);
  return {
    cancelCompletion,
    pending: mutations.respond.isPending,
    submitPress,
  };
}
