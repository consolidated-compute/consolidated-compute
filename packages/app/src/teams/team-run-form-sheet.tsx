import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  TEAM_OBJECTIVE_MAX_CHARS,
  type TeamDefinitionDto,
  type TeamRunDto,
} from "@getpaseo/protocol/team/types";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { useHostWorkspaces } from "@/stores/session-store-hooks";
import { useAgentProfiles } from "@/agent-profiles";
import {
  buildTeamRunWorkspaceOptions,
  type TeamRunExecutionMode,
  type TeamRunFormValidationIssue,
} from "./run-form-model";
import { useTeamRunFormFeatureCatalogs } from "./use-team-run-form-feature-catalogs";
import { useTeamRunFormModel } from "./use-team-run-form-model";
import { useTeamRunFormProviderSnapshot } from "./use-team-run-form-provider-snapshot";
import { useTeamRunFormSecurityPreview } from "./use-team-run-form-security-preview";
import { useTeamRunFormSubmission } from "./use-team-run-form-submission";
import { TeamSecurityPostureFacts, TeamSecurityPostureNotice } from "./security-posture-facts";

export interface TeamRunFormSheetProps {
  serverId: string;
  team: TeamDefinitionDto;
  assignment?: AssignmentDto;
  onClose: () => void;
  onStarted: (run: TeamRunDto) => void;
}

const TEAM_RUN_SHEET_SNAP_POINTS = ["90%"];

export function supportsSupervisedTeamRunAdmission(
  features: ServerInfoStatusPayload["features"],
): boolean {
  return features?.teamSupervision === true && features.teamSupervisionAdmission === "available";
}

function validationMessage(
  issue: TeamRunFormValidationIssue | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  return issue ? t(`teams.runs.form.validation.${issue}`) : null;
}

export function TeamRunFormSheet(props: TeamRunFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const onClose = props.onClose;
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const liveWorkspaces = useHostWorkspaces(props.serverId);
  const workspaceOptions = useMemo(
    () => buildTeamRunWorkspaceOptions(liveWorkspaces),
    [liveWorkspaces],
  );
  const { profiles } = useAgentProfiles(props.serverId);
  const supervisionSupported = useSessionStore((store) =>
    supportsSupervisedTeamRunAdmission(store.sessions[props.serverId]?.serverInfo?.features),
  );
  const model = useTeamRunFormModel({
    serverId: props.serverId,
    team: props.team,
    workspaces: workspaceOptions,
    profiles,
    assignment: props.assignment,
    supervisionSupported,
  });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useTeamRunFormProviderSnapshot(model, state);
  const { connected } = useTeamRunFormFeatureCatalogs(model, state);
  const { retry: retrySecurityPreview } = useTeamRunFormSecurityPreview(model, state);
  const { cancelCompletion, pending, startPress } = useTeamRunFormSubmission(
    model,
    props.onStarted,
    retrySecurityPreview,
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("teams.runs.form.title"),
      subtitle: props.team.name,
    }),
    [props.team.name, t],
  );
  const selectOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.workspaces.map((workspace) => ({
        id: workspace.workspaceId,
        value: workspace.workspaceId,
        label: workspace.display.label,
        description: workspace.display.description,
        testID: `team-run-workspace-${workspace.workspaceId}`,
      })),
    [state.workspaces],
  );
  const executionOptions = useMemo<SegmentedControlOption<TeamRunExecutionMode>[]>(
    () => [
      {
        value: "sequential",
        label: t("teams.runs.form.executionModes.sequential"),
        testID: "team-run-mode-sequential",
      },
      {
        value: "supervised",
        label: t("teams.runs.form.executionModes.supervised"),
        testID: "team-run-mode-supervised",
      },
    ],
    [t],
  );
  const supervisorOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.supervisorOptions.map((option) => ({
        id: option.roleId,
        value: option.roleId,
        label: option.display.label,
        description: option.display.description,
        testID: `team-run-supervisor-${option.roleId}`,
      })),
    [state.supervisorOptions],
  );
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
          onPress={startPress}
          disabled={!state.canSubmit || pending || !connected}
          loading={pending}
          testID="team-run-start"
        >
          {t("teams.runs.actions.start")}
        </Button>
      </View>
    ),
    [close, connected, pending, startPress, state.canSubmit, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      footer={footer}
      desktopMaxWidth={680}
      snapPoints={TEAM_RUN_SHEET_SNAP_POINTS}
      testID="team-run-form-sheet"
      dismissible={!pending}
    >
      <View style={styles.body}>
        <SelectField
          label={t("teams.runs.form.workspace")}
          value={state.selectedWorkspaceId}
          selectedDisplay={state.selectedWorkspaceDisplay}
          options={selectOptions}
          onChange={model.setWorkspace}
          placeholder={t("teams.runs.form.selectWorkspace")}
          emptyText={t("teams.runs.form.noWorkspaces")}
          disabled={pending}
          size={controlSize}
          testID="team-run-workspace-field"
        />
        {state.assignment ? (
          <View style={styles.assignmentCard} testID="team-run-assignment">
            <Text style={styles.assignmentTitle}>{state.assignment.title}</Text>
            <Text style={styles.assignmentObjective}>{state.assignment.objective}</Text>
            {state.assignment.workItem ? (
              <Text style={styles.assignmentMeta}>
                {state.assignment.workItem.sourceLabel} · {state.assignment.workItem.identifier}
              </Text>
            ) : null}
          </View>
        ) : (
          <Field label={t("teams.runs.form.objective")}>
            <FormTextInput
              initialValue={state.objective}
              onChangeText={model.setObjective}
              placeholder={t("teams.runs.form.objectivePlaceholder")}
              maxLength={TEAM_OBJECTIVE_MAX_CHARS}
              multiline
              numberOfLines={5}
              editable={!pending}
              size={controlSize}
              style={styles.multiline}
              accessibilityLabel={t("teams.runs.form.objective")}
              testID="team-run-objective"
            />
          </Field>
        )}
        {state.assignment && state.supervisionSupported ? (
          <View style={styles.section}>
            <Field label={t("teams.runs.form.execution")}>
              <SegmentedControl
                options={executionOptions}
                value={state.executionMode}
                onValueChange={model.setExecutionMode}
                size={controlSize}
                testID="team-run-execution-mode"
              />
            </Field>
            {state.executionMode === "supervised" ? (
              <SelectField
                label={t("teams.runs.form.supervisor")}
                value={state.selectedSupervisorRoleId}
                selectedDisplay={state.selectedSupervisorDisplay}
                options={supervisorOptions}
                onChange={model.setSupervisor}
                placeholder={t("teams.runs.form.selectSupervisor")}
                emptyText={t("teams.runs.form.noSupervisors")}
                disabled={pending}
                size={controlSize}
                testID="team-run-supervisor-field"
              />
            ) : null}
          </View>
        ) : null}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("teams.runs.form.launchPlan")}</Text>
          {state.securityPreviewStatus === "unsupported" ? (
            <TeamSecurityPostureNotice
              kind="update_required"
              testID="team-run-security-preview-update-required"
            />
          ) : null}
          {state.securityPreviewStatus === "pending" ? (
            <TeamSecurityPostureNotice kind="pending" testID="team-run-security-preview-pending" />
          ) : null}
          {state.securityPreviewStatus === "error" ? (
            <View style={styles.securityPreviewError}>
              <TeamSecurityPostureNotice
                kind="error"
                message={state.securityPreviewError ?? undefined}
                testID="team-run-security-preview-error"
              />
              <Button
                variant="outline"
                size="sm"
                onPress={retrySecurityPreview}
                disabled={pending || !connected}
                testID="team-run-security-preview-retry"
              >
                {t("common.actions.retry")}
              </Button>
            </View>
          ) : null}
          {state.roleResolutions.map((resolution) => (
            <View
              key={resolution.roleId}
              style={styles.roleRow}
              testID={`team-run-role-${resolution.roleId}`}
            >
              <View style={styles.roleText}>
                <Text style={styles.roleName}>{resolution.roleName}</Text>
                <Text style={styles.profileName}>
                  {resolution.profileName ?? resolution.profileId}
                </Text>
                {resolution.provider ? (
                  <Text style={styles.launchSummary}>
                    {[
                      resolution.provider,
                      resolution.model,
                      resolution.modeId,
                      resolution.thinkingOptionId,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                ) : null}
              </View>
              <Text
                style={
                  resolution.status === "ready" ? styles.readyStatus : styles.unavailableStatus
                }
                testID={`team-run-role-status-${resolution.roleId}-${resolution.status}`}
              >
                {t(`teams.runs.profileStates.${resolution.status}`)}
              </Text>
              {resolution.securityPosture ? (
                <View style={styles.posture}>
                  <TeamSecurityPostureFacts
                    posture={resolution.securityPosture}
                    testIDPrefix={`team-run-role-posture-${resolution.roleId}`}
                  />
                </View>
              ) : null}
            </View>
          ))}
        </View>
        {state.submitError ? (
          <Text style={styles.error} testID="team-run-submit-error">
            {state.submitError}
          </Text>
        ) : null}
        {state.validationIssue &&
        state.validationIssue !== "profiles_loading" &&
        state.validationIssue !== "security_preview_loading" &&
        state.validationIssue !== "security_preview_failed" ? (
          <Text style={styles.validation} testID="team-run-validation">
            {validationMessage(state.validationIssue, t)}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[6], gap: theme.spacing[6] },
  multiline: { minHeight: 120 },
  assignmentCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  assignmentTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  assignmentObjective: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  assignmentMeta: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  section: { gap: theme.spacing[3] },
  securityPreviewError: { alignItems: "flex-start", gap: theme.spacing[2] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  roleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  roleText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  posture: { flexBasis: "100%", minWidth: 0 },
  roleName: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  profileName: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  launchSummary: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  readyStatus: { color: theme.colors.success, fontSize: theme.fontSize.sm },
  unavailableStatus: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  validation: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
