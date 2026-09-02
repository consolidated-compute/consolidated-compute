import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS,
  type TeamRunSupervisionHumanRequestDto,
} from "@getpaseo/protocol/team/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { TeamSupervisionResponseValidationIssue } from "./supervision-response-form-model";
import { useTeamSupervisionResponseFormModel } from "./use-team-supervision-response-form-model";
import { useTeamSupervisionResponseSubmission } from "./use-team-supervision-response-submission";

function validationMessage(
  issue: TeamSupervisionResponseValidationIssue | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  return issue ? t(`teams.runs.supervision.response.validation.${issue}`) : null;
}

export function TeamSupervisionResponseSheet({
  serverId,
  runId,
  request,
  onClose,
  onConflict,
}: {
  serverId: string;
  runId: string;
  request: TeamRunSupervisionHumanRequestDto;
  onClose: () => void;
  onConflict: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const model = useTeamSupervisionResponseFormModel({ serverId, runId, request });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { cancelCompletion, pending, submitPress } = useTeamSupervisionResponseSubmission(
    model,
    onClose,
    onConflict,
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: t("teams.runs.supervision.response.title"), subtitle: request.title }),
    [request.title, t],
  );
  const actionOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      request.actions.map((action) => ({
        id: action.id,
        value: action.id,
        label: action.label,
        description: action.description,
        testID: `team-supervision-response-action-${action.id}`,
      })),
    [request.actions],
  );
  const selectedAction = request.actions.find((action) => action.id === state.selectedActionId);
  const close = useCallback(() => {
    if (pending) return;
    cancelCompletion();
    onClose();
  }, [cancelCompletion, onClose, pending]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={close} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={submitPress}
          disabled={!state.canSubmit || pending}
          loading={pending}
          testID="team-supervision-response-submit"
        >
          {t("teams.runs.supervision.response.submit")}
        </Button>
      </View>
    ),
    [close, pending, state.canSubmit, submitPress, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      footer={footer}
      desktopMaxWidth={560}
      snapPoints={["72%"]}
      dismissible={!pending}
      testID="team-supervision-response-sheet"
    >
      <View style={styles.body}>
        <View style={styles.requestCard}>
          <Text style={styles.requestTitle}>{request.title}</Text>
          <Text style={styles.requestDetail}>{request.detail}</Text>
        </View>
        <SelectField
          label={t("teams.runs.supervision.response.action")}
          value={state.selectedActionId}
          selectedDisplay={state.selectedActionDisplay}
          options={actionOptions}
          onChange={model.setAction}
          placeholder={t("teams.runs.supervision.response.selectAction")}
          emptyText={t("teams.runs.supervision.response.noActions")}
          disabled={pending}
          size={controlSize}
          testID="team-supervision-response-action-field"
        />
        {selectedAction ? (
          <Field
            label={
              selectedAction.requiresNote
                ? t("teams.runs.supervision.response.note")
                : t("teams.runs.supervision.response.optionalNote")
            }
          >
            <FormTextInput
              initialValue={state.note}
              onChangeText={model.setNote}
              maxLength={TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS}
              multiline
              numberOfLines={4}
              editable={!pending}
              size={controlSize}
              style={styles.note}
              accessibilityLabel={t("teams.runs.supervision.response.note")}
              testID="team-supervision-response-note"
            />
          </Field>
        ) : null}
        {state.submitError ? (
          <Text
            style={styles.error}
            accessibilityRole="alert"
            testID="team-supervision-response-error"
          >
            {state.submitError}
          </Text>
        ) : null}
        {state.validationIssue && state.validationIssue !== "action_required" ? (
          <Text style={styles.validation} testID="team-supervision-response-validation">
            {validationMessage(state.validationIssue, t)}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[6], gap: theme.spacing[4] },
  requestCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  requestTitle: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  requestDetail: { color: theme.colors.foregroundMuted, lineHeight: 22 },
  note: { minHeight: 104 },
  validation: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
