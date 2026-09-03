import { useEffect, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { useAgentProfiles } from "@/agent-profiles";
import { useAssignments } from "@/assignments/use-assignments";
import { useHasHydratedWorkspaces, useHostWorkspaces } from "@/stores/session-store-hooks";
import { useTeams } from "@/teams/use-teams";
import { buildTeamRunWorkspaceOptions, type TeamRunFormState } from "@/teams/run-form-model";
import { useTeamRunFormFeatureCatalogs } from "@/teams/use-team-run-form-feature-catalogs";
import { useTeamRunFormModel } from "@/teams/use-team-run-form-model";
import { useTeamRunFormProviderSnapshot } from "@/teams/use-team-run-form-provider-snapshot";
import { useTeamRunFormSecurityPreview } from "@/teams/use-team-run-form-security-preview";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import {
  TeamSecurityPostureFacts,
  TeamSecurityPostureNotice,
} from "@/teams/security-posture-facts";
import type {
  ScheduleAssignmentTeamCatalog,
  ScheduleFormModel,
  ScheduleFormState,
} from "./schedule-form-model";
import { resolveAssignmentTeamCatalogStatus } from "./schedule-assignment-team-catalog";

interface CatalogSnapshot {
  catalog: ScheduleAssignmentTeamCatalog;
  assignment: AssignmentDto | null;
  team: TeamDefinitionDto | null;
  workspace: WorkspaceDescriptor | null;
}

function useAssignmentTeamCatalog(state: ScheduleFormState): CatalogSnapshot {
  const assignmentsData = useAssignments();
  const teamsData = useTeams();
  const workspaces = useHostWorkspaces(state.selectedServerId);
  const workspacesHydrated = useHasHydratedWorkspaces(state.selectedServerId);
  const host = state.hosts.find((entry) => entry.serverId === state.selectedServerId) ?? null;
  const assignmentHost =
    assignmentsData.hosts.find((entry) => entry.serverId === state.selectedServerId) ?? null;
  const teamHost =
    teamsData.hosts.find((entry) => entry.serverId === state.selectedServerId) ?? null;

  return useMemo(() => {
    const status = resolveAssignmentTeamCatalogStatus({
      supported: host?.supportsAssignmentTeamSchedules === true,
      assignmentsStatus: assignmentHost?.status ?? null,
      teamsStatus: teamHost?.status ?? null,
      workspacesHydrated,
    });
    const hostAssignments = assignmentsData.assignments.filter(
      (assignment) =>
        assignment.serverId === state.selectedServerId && assignment.state.status === "open",
    );
    const hostTeams = teamsData.teams.filter((team) => team.serverId === state.selectedServerId);
    const activeWorkspaces = buildTeamRunWorkspaceOptions(workspaces);
    const assignment =
      hostAssignments.find((entry) => entry.id === state.selectedAssignmentId) ?? null;
    const team = hostTeams.find((entry) => entry.id === state.selectedTeamId) ?? null;
    const workspace =
      workspaces.find(
        (entry) => entry.id === state.selectedWorkspaceId && entry.archivingAt === null,
      ) ?? null;
    const error = assignmentHost?.error ?? teamHost?.error ?? null;
    return {
      catalog: {
        status,
        error,
        assignments: hostAssignments.map((entry) => ({
          id: entry.id,
          revision: entry.revision,
          display: {
            label: entry.title,
            description: entry.workItem
              ? `${entry.workItem.sourceLabel} · ${entry.workItem.identifier}`
              : undefined,
          },
        })),
        teams: hostTeams.map((entry) => ({
          id: entry.id,
          revision: entry.revision,
          display: { label: entry.name, description: `${entry.roles.length} roles` },
        })),
        workspaces: activeWorkspaces.map((entry) => ({
          id: entry.workspaceId,
          cwd: entry.cwd,
          display: entry.display,
        })),
      },
      assignment,
      team,
      workspace,
    };
  }, [
    assignmentHost,
    assignmentsData.assignments,
    host,
    state.selectedAssignmentId,
    state.selectedServerId,
    state.selectedTeamId,
    state.selectedWorkspaceId,
    teamHost,
    teamsData.teams,
    workspaces,
    workspacesHydrated,
  ]);
}

function readinessStatus(state: TeamRunFormState): {
  status: "pending" | "ready" | "blocked";
  message: string | null;
} {
  if (state.canSubmit) return { status: "ready", message: null };
  if (
    state.validationIssue === "profiles_loading" ||
    state.validationIssue === "security_preview_loading"
  ) {
    return { status: "pending", message: null };
  }
  return {
    status: "blocked",
    message:
      state.securityPreviewError ?? state.validationIssue ?? "Team Run admission is unavailable",
  };
}

function ScheduleTeamRunReadinessProbe({
  model,
  requestKey,
  serverId,
  assignment,
  team,
  workspace,
}: {
  model: ScheduleFormModel;
  requestKey: string;
  serverId: string;
  assignment: AssignmentDto;
  team: TeamDefinitionDto;
  workspace: WorkspaceDescriptor;
}): ReactElement | null {
  const { profiles } = useAgentProfiles(serverId);
  const readinessModel = useTeamRunFormModel({
    serverId,
    team,
    assignment,
    profiles,
    workspaces: buildTeamRunWorkspaceOptions([workspace]),
    supervisionSupported: false,
  });
  const state = useSyncExternalStore(
    readinessModel.subscribe,
    readinessModel.getState,
    readinessModel.getState,
  );
  useTeamRunFormProviderSnapshot(readinessModel, state);
  useTeamRunFormFeatureCatalogs(readinessModel, state);
  const { retry } = useTeamRunFormSecurityPreview(readinessModel, state);

  useEffect(() => {
    const apply = () => {
      const result = readinessStatus(readinessModel.getState());
      model.applyTeamRunReadiness(requestKey, result.status, result.message);
    };
    apply();
    return readinessModel.subscribe(apply);
  }, [model, readinessModel, requestKey]);

  return <ScheduleTeamRunReadinessView state={state} retry={retry} />;
}

function ScheduleTeamRunReadinessView({
  state,
  retry,
}: {
  state: TeamRunFormState;
  retry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.readiness} testID="schedule-team-run-readiness">
      <Text style={styles.sectionTitle}>{t("teams.runs.form.launchPlan")}</Text>
      {state.securityPreviewStatus === "pending" ? (
        <TeamSecurityPostureNotice kind="pending" testID="schedule-team-run-preview-pending" />
      ) : null}
      {state.securityPreviewStatus === "unsupported" ? (
        <TeamSecurityPostureNotice
          kind="update_required"
          testID="schedule-team-run-preview-update-required"
        />
      ) : null}
      {state.securityPreviewStatus === "error" ? (
        <View style={styles.errorStack}>
          <TeamSecurityPostureNotice
            kind="error"
            message={state.securityPreviewError ?? undefined}
            testID="schedule-team-run-preview-error"
          />
          <Button
            variant="outline"
            size="sm"
            onPress={retry}
            testID="schedule-team-run-preview-retry"
          >
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {state.roleResolutions.map((resolution) => (
        <View
          key={resolution.roleId}
          style={styles.role}
          testID={`schedule-team-role-${resolution.roleId}`}
        >
          <View style={styles.roleText}>
            <Text style={styles.roleName}>{resolution.roleName}</Text>
            <Text style={styles.roleMeta}>
              {[
                resolution.profileName ?? resolution.profileId,
                resolution.provider,
                resolution.model,
                resolution.modeId,
                resolution.thinkingOptionId,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <Text
            style={resolution.status === "ready" ? styles.ready : styles.blocked}
            testID={`schedule-team-role-status-${resolution.roleId}-${resolution.status}`}
          >
            {t(`teams.runs.profileStates.${resolution.status}`)}
          </Text>
          {resolution.securityPosture ? (
            <View style={styles.posture}>
              <TeamSecurityPostureFacts
                posture={resolution.securityPosture}
                testIDPrefix={`schedule-team-role-posture-${resolution.roleId}`}
              />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function ScheduleAssignmentTeamAdapters({
  model,
  state,
}: {
  model: ScheduleFormModel;
  state: ScheduleFormState;
}): ReactElement | null {
  const snapshot = useAssignmentTeamCatalog(state);
  const serverId = state.selectedServerId;

  useEffect(() => {
    if (!serverId || state.targetKind !== "assignment-team-run") return;
    model.applyAssignmentTeamCatalog(serverId, snapshot.catalog);
  }, [model, serverId, snapshot.catalog, state.targetKind]);

  const request = state.teamRunReadinessRequest;
  if (
    state.targetKind !== "assignment-team-run" ||
    !request ||
    !snapshot.assignment ||
    !snapshot.team ||
    !snapshot.workspace
  ) {
    return null;
  }

  return (
    <ScheduleTeamRunReadinessProbe
      key={request.requestKey}
      model={model}
      requestKey={request.requestKey}
      serverId={request.serverId}
      assignment={snapshot.assignment}
      team={snapshot.team}
      workspace={snapshot.workspace}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  readiness: { gap: theme.spacing[3] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  errorStack: { alignItems: "flex-start", gap: theme.spacing[2] },
  role: {
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
  roleMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  ready: { color: theme.colors.success, fontSize: theme.fontSize.sm },
  blocked: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  posture: { flexBasis: "100%", minWidth: 0 },
}));
