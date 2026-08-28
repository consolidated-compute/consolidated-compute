import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, type Href } from "expo-router";
import { Bot, RefreshCw, Square } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TeamRunDto, TeamRunStepDto } from "@getpaseo/protocol/team/types";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { AssignmentArtifactCard } from "@/assignments/artifact-card";
import { useAssignmentArtifacts } from "@/assignments/use-assignment-artifacts";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  buildHostAgentDetailRoute,
  buildHostWorkspaceRoute,
  buildAssignmentRoute,
  buildTeamRoute,
} from "@/utils/host-routes";
import { formatTimeAgo } from "@/utils/time";
import { toErrorMessage } from "@/utils/error-messages";
import { canCancelTeamRun, matchesTeamRunRoute } from "./run-data";
import { useTeamRunMutations } from "./use-team-run-mutations";
import { useTeamRun } from "./use-team-runs";

export function TeamRunScreen({
  serverId,
  teamId,
  runId,
}: {
  serverId: string;
  teamId: string;
  runId: string;
}): ReactElement {
  const { t } = useTranslation();
  const isFocused = useIsFocused();
  const connected = useHostRuntimeIsConnected(serverId);
  const query = useTeamRun(serverId, runId, { enabled: isFocused });
  const { refetch } = query;
  const mutations = useTeamRunMutations();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const run = query.data && matchesTeamRunRoute(query.data, teamId) ? query.data : null;
  const back = useCallback(
    () =>
      router.replace(
        (run?.assignmentId
          ? buildAssignmentRoute(serverId, run.assignmentId)
          : buildTeamRoute(serverId, teamId)) as Href,
      ),
    [run?.assignmentId, serverId, teamId],
  );
  const openWorkspace = useCallback(() => {
    if (!run) return;
    router.push(buildHostWorkspaceRoute(serverId, run.workspace.workspaceId) as Href);
  }, [run, serverId]);
  const cancel = useCallback(async () => {
    if (!run || !canCancelTeamRun(run.state.status)) return;
    const confirmed = await confirmDialog({
      title: t("teams.runs.cancel.title"),
      message: t("teams.runs.cancel.message", { name: run.teamSnapshot.name }),
      confirmLabel: t("teams.runs.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setCancelError(null);
    try {
      await mutations.cancel.mutateAsync({ serverId, runId: run.id });
    } catch (error) {
      setCancelError(toErrorMessage(error));
    }
  }, [mutations.cancel, run, serverId, t]);
  const cancelPress = useCallback(() => void cancel(), [cancel]);
  const retry = useCallback(() => void refetch(), [refetch]);
  const missingRunMessage = connected
    ? t("teams.runs.errors.notFound")
    : t("teams.runs.errors.hostOffline");
  const loadError = query.error ? toErrorMessage(query.error) : missingRunMessage;

  let content: ReactElement;
  if (query.isLoading) {
    content = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (!run) {
    content = (
      <View style={styles.centered}>
        <Text style={styles.error}>{loadError}</Text>
        <Button variant="outline" leftIcon={RefreshCw} onPress={retry} disabled={!connected}>
          {t("teams.actions.retry")}
        </Button>
      </View>
    );
  } else {
    content = (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID={`team-run-detail-${encodeURIComponent(serverId)}-${encodeURIComponent(run.id)}`}
      >
        <View style={styles.titleRow}>
          <View style={styles.titleText}>
            <Text style={styles.title}>{run.teamSnapshot.name}</Text>
            <Text style={styles.meta}>
              {t("teams.runs.detail.revision", { revision: run.teamRevision })} ·{" "}
              {formatTimeAgo(new Date(run.createdAt))}
            </Text>
          </View>
          <View style={styles.actions}>
            <Button variant="outline" onPress={openWorkspace}>
              {t("teams.runs.actions.openWorkspace")}
            </Button>
            {canCancelTeamRun(run.state.status) ? (
              <Button
                variant="destructive"
                leftIcon={Square}
                onPress={cancelPress}
                disabled={mutations.cancel.isPending || !connected}
                loading={mutations.cancel.isPending}
                testID="team-run-cancel"
              >
                {t("teams.runs.actions.cancel")}
              </Button>
            ) : null}
          </View>
        </View>
        <View style={styles.runStatus} accessibilityLiveRegion="polite" testID="team-run-status">
          <View testID={`team-run-status-${run.state.status}`}>
            <StatusBadge
              label={t(`teams.runs.status.${run.state.status}`)}
              variant={teamRunStatusBadgeVariant(run.state.status)}
            />
          </View>
        </View>
        <DetailSection title={t("teams.runs.detail.objective")}>
          <Text style={styles.bodyText}>{run.objective}</Text>
        </DetailSection>
        {run.assignmentSnapshot ? (
          <DetailSection title={t("teams.runs.detail.frozenAssignment")}>
            <View
              style={styles.card}
              testID={`team-run-frozen-assignment-${encodeURIComponent(serverId)}-${encodeURIComponent(run.assignmentSnapshot.id)}`}
            >
              <Text style={styles.cardTitle}>{run.assignmentSnapshot.title}</Text>
              <Text style={styles.meta}>
                {t("assignments.detail.revision", {
                  revision: run.assignmentSnapshot.revision,
                })}
              </Text>
              <Text style={styles.bodyText}>{run.assignmentSnapshot.objective}</Text>
              {run.assignmentSnapshot.workItem ? (
                <View style={styles.frozenReference}>
                  <Text style={styles.cardTitle}>{run.assignmentSnapshot.workItem.title}</Text>
                  <Text style={styles.meta}>
                    {run.assignmentSnapshot.workItem.sourceLabel} ·{" "}
                    {run.assignmentSnapshot.workItem.identifier}
                  </Text>
                </View>
              ) : null}
            </View>
          </DetailSection>
        ) : null}
        <DetailSection title={t("teams.runs.detail.workspace")}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{run.workspace.displayName}</Text>
            <Text style={styles.meta}>{run.workspace.cwd}</Text>
          </View>
        </DetailSection>
        <DetailSection title={t("teams.runs.detail.steps")}>
          <View style={styles.cards}>
            {run.steps.map((step, index) => (
              <RunStepCard
                key={step.snapshot.stepId}
                serverId={serverId}
                workspaceId={run.workspace.workspaceId}
                step={step}
                index={index}
              />
            ))}
          </View>
        </DetailSection>
        <DetailSection title={t("teams.runs.detail.frozenTeam")}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{run.teamSnapshot.name}</Text>
            <Text style={styles.bodyText}>{run.teamSnapshot.instructions}</Text>
            <View style={styles.frozenRoles}>
              {run.teamSnapshot.roles.map((role) => (
                <View key={role.id} style={styles.frozenRole}>
                  <Text style={styles.cardTitle}>{role.name}</Text>
                  <Text style={styles.meta}>{role.profileId}</Text>
                  <Text style={styles.bodyText}>{role.instructions}</Text>
                </View>
              ))}
            </View>
          </View>
        </DetailSection>
        <DetailSection title={t("teams.runs.detail.artifacts")}>
          {run.assignmentId ? (
            <TeamRunArtifacts serverId={serverId} assignmentId={run.assignmentId} runId={run.id} />
          ) : (
            <Text style={styles.bodyText}>{t("assignments.artifacts.legacy")}</Text>
          )}
        </DetailSection>
        {"error" in run.state ? <Text style={styles.error}>{run.state.error}</Text> : null}
        {cancelError ? <Text style={styles.error}>{cancelError}</Text> : null}
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <BackHeader title={run?.teamSnapshot.name ?? t("teams.runs.detail.title")} onBack={back} />
      {content}
    </View>
  );
}

function TeamRunArtifacts({
  serverId,
  assignmentId,
  runId,
}: {
  serverId: string;
  assignmentId: string;
  runId: string;
}): ReactElement {
  const { t } = useTranslation();
  const query = useAssignmentArtifacts(serverId, assignmentId, { teamRunId: runId });
  const artifacts = query.artifacts;
  const { refetch, fetchNextPage } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  if (query.isLoading) {
    return (
      <View style={styles.artifactLoading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }

  return (
    <View
      style={styles.cards}
      testID={`team-run-artifacts-${encodeURIComponent(serverId)}-${encodeURIComponent(assignmentId)}-${encodeURIComponent(runId)}`}
    >
      {query.isError ? (
        <View style={styles.inlineAction}>
          <Text style={styles.error}>{toErrorMessage(query.error)}</Text>
          <Button variant="ghost" size="sm" onPress={retry}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {query.issues.map((issue) => (
        <Text key={`${issue.collection}:${issue.fileName}`} style={styles.error}>
          {issue.fileName}: {issue.message}
        </Text>
      ))}
      {!query.isError && artifacts.length === 0 ? (
        <Text style={styles.bodyText}>
          {t(query.canLoad ? "assignments.artifacts.empty" : "assignments.artifacts.offline")}
        </Text>
      ) : null}
      {artifacts.map((artifact) => (
        <AssignmentArtifactCard key={artifact.id} artifact={artifact} serverId={serverId} />
      ))}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          onPress={loadMore}
          disabled={query.isFetchingNextPage}
          loading={query.isFetchingNextPage}
        >
          {t("teams.runs.actions.loadMore")}
        </Button>
      ) : null}
    </View>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactElement }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function RunStepCard({
  serverId,
  workspaceId,
  step,
  index,
}: {
  serverId: string;
  workspaceId: string;
  step: TeamRunStepDto;
  index: number;
}): ReactElement {
  const { t } = useTranslation();
  const launch = step.snapshot.resolvedLaunch;
  const agentId = "agentId" in step.state ? step.state.agentId : null;
  const openAgent = useCallback(() => {
    if (!agentId) return;
    router.push(buildHostAgentDetailRoute(serverId, agentId, workspaceId) as Href);
  }, [agentId, serverId, workspaceId]);
  const launchSummary = useMemo(
    () =>
      [launch.provider, launch.model, launch.modeId, launch.thinkingOptionId]
        .filter(Boolean)
        .join(" · "),
    [launch.modeId, launch.model, launch.provider, launch.thinkingOptionId],
  );
  const featureEntries = useMemo(
    () => Object.entries(launch.featureValues),
    [launch.featureValues],
  );
  return (
    <View style={styles.card} testID={`team-run-step-${step.snapshot.stepId}`}>
      <View style={styles.stepHeading}>
        <View style={styles.stepNumber}>
          <Text style={styles.stepNumberText}>{index + 1}</Text>
        </View>
        <View style={styles.stepTitleText}>
          <Text style={styles.cardTitle}>{step.snapshot.roleName}</Text>
          <View
            style={styles.stepBadge}
            testID={`team-run-step-status-${step.snapshot.stepId}-${step.state.status}`}
          >
            <StatusBadge
              label={t(`teams.runs.status.${step.state.status}`)}
              variant={teamRunStatusBadgeVariant(step.state.status)}
            />
          </View>
        </View>
        {agentId ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Bot}
            onPress={openAgent}
            testID={`team-run-step-agent-${step.snapshot.stepId}`}
          >
            {t("teams.runs.actions.openAgent")}
          </Button>
        ) : null}
      </View>
      <Text style={styles.bodyText}>{step.snapshot.roleInstructions}</Text>
      {step.snapshot.stepInstructions ? (
        <Text style={styles.bodyText}>{step.snapshot.stepInstructions}</Text>
      ) : null}
      <View style={styles.launchBox}>
        <Text style={styles.profileLabel}>{launch.profileId}</Text>
        <Text style={styles.meta}>{launchSummary}</Text>
        {featureEntries.map(([featureId, value]) => (
          <Text key={featureId} style={styles.meta}>
            {featureId}: {formatFeatureValue(value)}
          </Text>
        ))}
      </View>
      {"error" in step.state ? <Text style={styles.error}>{step.state.error}</Text> : null}
    </View>
  );
}

function formatFeatureValue(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded ?? String(value);
}

function teamRunStatusBadgeVariant(
  status: TeamRunDto["state"]["status"] | TeamRunStepDto["state"]["status"],
): StatusBadgeVariant {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "interrupted" || status === "stop_failed") {
    return "error";
  }
  if (status === "waiting_for_permission" || status === "stopping") return "warning";
  return "muted";
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  scroll: { flex: 1, minHeight: 0 },
  content: {
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    padding: { xs: theme.spacing[4], md: theme.spacing[8] },
    paddingBottom: theme.spacing[12],
    gap: theme.spacing[8],
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[3] },
  spinner: { color: theme.colors.foregroundMuted },
  titleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[4],
  },
  titleText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    flexShrink: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  runStatus: { alignSelf: "flex-start" },
  section: { gap: theme.spacing[3] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  cards: { gap: theme.spacing[3] },
  card: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  cardTitle: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  frozenRoles: { gap: theme.spacing[2] },
  frozenRole: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  frozenReference: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  bodyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, lineHeight: 22 },
  stepHeading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  stepNumberText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  stepTitleText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  stepBadge: { alignSelf: "flex-start" },
  launchBox: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  profileLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  artifactLoading: { minHeight: 72, alignItems: "center", justifyContent: "center" },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
