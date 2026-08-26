import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import {
  TEAM_OBJECTIVE_MAX_CHARS,
  type TeamDefinitionDto,
  type TeamRunDto,
} from "@getpaseo/protocol/team/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useFetchQueries } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostWorkspaces } from "@/stores/session-store-hooks";
import { useAgentProfiles } from "@/agent-profiles";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildTeamRunWorkspaceOptions,
  buildTeamRunFeatureRequest,
  openTeamRunForm,
  type TeamRunFormValidationIssue,
} from "./run-form-model";
import { useTeamRunMutations } from "./use-team-run-mutations";

export interface TeamRunFormSheetProps {
  serverId: string;
  team: TeamDefinitionDto;
  onClose: () => void;
  onStarted: (run: TeamRunDto) => void;
}

const TEAM_RUN_SHEET_SNAP_POINTS = ["90%"];

function validationMessage(
  issue: TeamRunFormValidationIssue | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  return issue ? t(`teams.runs.form.validation.${issue}`) : null;
}

export function TeamRunFormSheet(props: TeamRunFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const liveWorkspaces = useHostWorkspaces(props.serverId);
  const workspaceOptions = useMemo(
    () => buildTeamRunWorkspaceOptions(liveWorkspaces),
    [liveWorkspaces],
  );
  const { profiles } = useAgentProfiles(props.serverId);
  const [model] = useState(() =>
    openTeamRunForm({
      serverId: props.serverId,
      team: props.team,
      workspaces: workspaceOptions,
      profiles,
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const client = useHostRuntimeClient(props.serverId);
  const connected = useHostRuntimeIsConnected(props.serverId);
  const providerSnapshot = useProvidersSnapshot(props.serverId, {
    cwd: state.selectedWorkspaceCwd,
    enabled: state.selectedWorkspaceCwd !== null,
  });
  const mutations = useTeamRunMutations();
  const pending = mutations.start.isPending;
  const acceptsCompletionRef = useRef(true);
  const featureRequests = useMemo(
    () =>
      state.roleResolutions.flatMap((resolution) => {
        const request = buildTeamRunFeatureRequest(resolution, state.selectedWorkspaceCwd);
        return request ? [request] : [];
      }),
    [state.roleResolutions, state.selectedWorkspaceCwd],
  );
  const featureQueries = useFetchQueries<readonly AgentFeature[]>(
    featureRequests.map((request) => ({
      queryKey: ["teamRunFeatures", props.serverId, request.requestKey],
      dataShape: "value" as const,
      staleTimeMs: 0,
      enabled: Boolean(client && connected),
      queryFn: async () => {
        if (!client) throw new Error("Host is offline");
        const payload = await client.listProviderFeatures(request.config);
        if (payload.error) throw new Error(payload.error);
        return payload.features ?? [];
      },
    })),
  );

  useEffect(
    () => () => {
      acceptsCompletionRef.current = false;
      model.close();
    },
    [model],
  );
  useEffect(() => model.applyWorkspaces(workspaceOptions), [model, workspaceOptions]);
  useEffect(() => model.applyProfiles(profiles), [model, profiles]);
  useEffect(() => {
    if (!state.selectedWorkspaceId || !state.selectedWorkspaceCwd) return;
    model.applyProviderCatalog(
      state.selectedWorkspaceId,
      state.selectedWorkspaceCwd,
      providerSnapshot.entries ?? (providerSnapshot.error ? [] : null),
    );
  }, [
    model,
    providerSnapshot.entries,
    providerSnapshot.error,
    state.selectedWorkspaceCwd,
    state.selectedWorkspaceId,
  ]);
  useEffect(() => {
    featureRequests.forEach((request, index) => {
      const query = featureQueries[index];
      if (query?.data) {
        model.applyFeatureCatalog(request.roleId, request.requestKey, query.data);
      } else if (query?.isError) {
        model.applyFeatureCatalog(request.roleId, request.requestKey, null);
      }
    });
  }, [featureQueries, featureRequests, model]);

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
  const close = useCallback(() => {
    acceptsCompletionRef.current = false;
    props.onClose();
  }, [props]);
  const start = useCallback(async () => {
    const submission = model.getState().submission;
    if (!submission) return;
    model.setSubmitError(null);
    try {
      const payload = await mutations.start.mutateAsync(submission);
      if (!acceptsCompletionRef.current) return;
      props.onStarted(payload.run);
    } catch (error) {
      if (!acceptsCompletionRef.current) return;
      model.setSubmitError(toErrorMessage(error));
    }
  }, [model, mutations.start, props]);
  const startPress = useCallback(() => void start(), [start]);

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
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("teams.runs.form.launchPlan")}</Text>
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
              >
                {t(`teams.runs.profileStates.${resolution.status}`)}
              </Text>
            </View>
          ))}
        </View>
        {state.submitError ? (
          <Text style={styles.error} testID="team-run-submit-error">
            {state.submitError}
          </Text>
        ) : null}
        {state.validationIssue && state.validationIssue !== "profiles_loading" ? (
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
  section: { gap: theme.spacing[3] },
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
