import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { Link2, Unlink } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  ASSIGNMENT_OBJECTIVE_MAX_CHARS,
  ASSIGNMENT_TITLE_MAX_CHARS,
  type AssignmentDto,
  type AssignmentWorkItemReferenceDto,
} from "@getpaseo/protocol/assignment/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AssignmentFormHostOption, AssignmentFormValidationIssue } from "./form-model";
import { useAssignmentFormModel } from "./use-assignment-form-model";
import { useAssignmentFormSubmission } from "./use-assignment-form-submission";
import { AssignmentWorkItemPickerSheet } from "./work-item-picker-sheet";

export interface AssignmentFormSheetProps {
  mode: "create" | "edit";
  hosts: AssignmentFormHostOption[];
  selectedServerId?: string | null;
  assignment?: AssignmentDto;
  initialWorkItem?: AssignmentWorkItemReferenceDto;
  authoringEnabled?: boolean;
  onClose: () => void;
  onSaved: (serverId: string, assignment: AssignmentDto) => void;
}

const ASSIGNMENT_SHEET_SNAP_POINTS = ["90%"];

function validationMessage(
  issue: AssignmentFormValidationIssue | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  return issue ? t(`assignments.form.validation.${issue}`) : null;
}

export function AssignmentFormSheet(props: AssignmentFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [pickerOpen, setPickerOpen] = useState(false);
  const model = useAssignmentFormModel({
    mode: props.mode,
    hosts: props.hosts,
    selectedServerId: props.selectedServerId,
    ...(props.assignment ? { assignment: props.assignment } : {}),
    ...(props.initialWorkItem ? { initialWorkItem: props.initialWorkItem } : {}),
  });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { cancelCompletion, pending, savePress } = useAssignmentFormSubmission(
    model,
    props.onSaved,
    t("assignments.errors.conflictRecovered"),
  );
  const formDisabled = pending || props.authoringEnabled === false;
  const header = useMemo<SheetHeader>(
    () => ({
      title: t(
        props.mode === "create" ? "assignments.form.createTitle" : "assignments.form.editTitle",
      ),
    }),
    [props.mode, t],
  );
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: `assignment-form-host-${host.serverId}`,
      })),
    [state.hosts],
  );
  const selectedHostDisplay = useMemo(
    () => (state.selectedHostDisplay ? { label: state.selectedHostDisplay } : null),
    [state.selectedHostDisplay],
  );
  const selectHost = useCallback(
    (serverId: string, display: { label: string }) => model.setHost(serverId, display.label),
    [model],
  );
  const close = useCallback(() => {
    if (pending) return;
    cancelCompletion();
    props.onClose();
  }, [cancelCompletion, pending, props]);
  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const selectWorkItem = useCallback(
    (workItem: AssignmentWorkItemReferenceDto) => model.setWorkItem(workItem),
    [model],
  );
  const removeWorkItem = useCallback(() => model.setWorkItem(null), [model]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={close} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={savePress}
          disabled={!state.canSubmit || formDisabled}
          loading={pending}
          testID="assignment-form-save"
        >
          {t(props.mode === "create" ? "assignments.actions.create" : "assignments.actions.save")}
        </Button>
      </View>
    ),
    [close, formDisabled, pending, props.mode, savePress, state.canSubmit, t],
  );

  return (
    <>
      <AdaptiveModalSheet
        visible
        onClose={close}
        header={header}
        footer={footer}
        desktopMaxWidth={680}
        snapPoints={ASSIGNMENT_SHEET_SNAP_POINTS}
        testID="assignment-form-sheet"
        dismissible={!pending}
      >
        <View style={styles.body}>
          {props.mode === "create" ? (
            <SelectField
              label={t("assignments.form.host")}
              value={state.selectedServerId}
              selectedDisplay={selectedHostDisplay}
              options={hostOptions}
              onChange={selectHost}
              placeholder={t("assignments.form.selectHost")}
              emptyText={t("assignments.form.noHosts")}
              disabled={formDisabled}
              size={controlSize}
              testID="assignment-form-host-field"
            />
          ) : (
            <Field label={t("assignments.form.host")}>
              <Text style={styles.immutableHost}>
                {state.selectedHostDisplay ?? state.selectedServerId}
              </Text>
            </Field>
          )}
          <Field label={t("assignments.form.title")}>
            <FormTextInput
              initialValue={state.title}
              onChangeText={model.setTitle}
              placeholder={t("assignments.form.titlePlaceholder")}
              maxLength={ASSIGNMENT_TITLE_MAX_CHARS}
              editable={!formDisabled}
              size={controlSize}
              accessibilityLabel={t("assignments.form.title")}
              testID="assignment-form-title"
            />
          </Field>
          <Field label={t("assignments.form.objective")}>
            <FormTextInput
              initialValue={state.objective}
              onChangeText={model.setObjective}
              placeholder={t("assignments.form.objectivePlaceholder")}
              maxLength={ASSIGNMENT_OBJECTIVE_MAX_CHARS}
              multiline
              numberOfLines={6}
              editable={!formDisabled}
              size={controlSize}
              style={styles.multiline}
              accessibilityLabel={t("assignments.form.objective")}
              testID="assignment-form-objective"
            />
          </Field>
          <View style={styles.workItemSection}>
            <Text style={styles.sectionTitle}>{t("assignments.form.workItem")}</Text>
            {state.workItem ? (
              <View style={styles.workItemCard} testID="assignment-form-work-item">
                <Link2 size={18} color={styles.linkIcon.color} />
                <View style={styles.workItemText}>
                  <Text style={styles.workItemTitle}>{state.workItem.title}</Text>
                  <Text style={styles.workItemMeta}>
                    {state.workItem.sourceLabel} · {state.workItem.identifier}
                  </Text>
                </View>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={Unlink}
                  onPress={removeWorkItem}
                  disabled={formDisabled}
                  accessibilityLabel={t("assignments.workItem.remove")}
                  testID="assignment-form-work-item-remove"
                />
              </View>
            ) : (
              <Text style={styles.workItemEmpty}>{t("assignments.workItem.none")}</Text>
            )}
            <Button
              variant="outline"
              size="sm"
              leftIcon={Link2}
              onPress={openPicker}
              disabled={!state.selectedServerId || formDisabled}
              testID="assignment-form-work-item-choose"
            >
              {t(state.workItem ? "assignments.workItem.replace" : "assignments.workItem.choose")}
            </Button>
          </View>
          {state.revisionRecovered ? (
            <Text style={styles.notice} testID="assignment-form-revision-recovered">
              {t("assignments.form.revisionRecovered")}
            </Text>
          ) : null}
          {state.submitError ? (
            <Text style={styles.error} accessibilityRole="alert" testID="assignment-form-error">
              {state.submitError}
            </Text>
          ) : null}
          {state.validationIssue ? (
            <Text style={styles.validation} testID="assignment-form-validation">
              {validationMessage(state.validationIssue, t)}
            </Text>
          ) : null}
        </View>
      </AdaptiveModalSheet>
      {pickerOpen && state.selectedServerId ? (
        <AssignmentWorkItemPickerSheet
          key={`work-item:${state.selectedServerId}`}
          serverId={state.selectedServerId}
          onClose={closePicker}
          onSelect={selectWorkItem}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[6], gap: theme.spacing[6] },
  multiline: { minHeight: 132 },
  immutableHost: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  workItemSection: { gap: theme.spacing[3] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  workItemCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  linkIcon: { color: theme.colors.foregroundMuted },
  workItemText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  workItemTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  workItemMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  workItemEmpty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  validation: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
