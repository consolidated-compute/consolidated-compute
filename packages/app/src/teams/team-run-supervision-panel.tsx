import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { Bot, RefreshCw, ShieldAlert } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  TeamRunDto,
  TeamRunStepDto,
  TeamRunSupervisionEventDto,
  TeamRunSupervisionHumanRequestDto,
  TeamRunSupervisionSummaryDto,
} from "@getpaseo/protocol/team/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { formatTimeAgo } from "@/utils/time";
import { isTerminalTeamRunStatus } from "./run-data";
import {
  newestTeamRunSupervisionSummary,
  teamRunSupervisionPresentation,
} from "./supervision-data";
import { TeamSupervisionResponseSheet } from "./team-supervision-response-sheet";
import { useTeamRunSupervision, useTeamRunSupervisionEvents } from "./use-team-run-supervision";

export function TeamRunSupervisionPanel({
  serverId,
  run,
  enabled,
}: {
  serverId: string;
  run: TeamRunDto;
  enabled: boolean;
}): ReactElement | null {
  const runIsActive = !isTerminalTeamRunStatus(run.state.status);
  const stateQuery = useTeamRunSupervision(serverId, run.id, {
    enabled,
    runIsActive,
  });
  const eventsQuery = useTeamRunSupervisionEvents(serverId, run.id, {
    enabled,
    runIsActive,
  });
  const [responseRequestId, setResponseRequestId] = useState<string | null>(null);
  const summary = newestTeamRunSupervisionSummary(run.supervision, stateQuery.data);
  const requestCandidate = unresolvedRequest(stateQuery.data?.humanRequest ?? null);
  const pendingRequest = matchingPendingRequest(summary, requestCandidate);
  const responseRequest = pendingRequest?.id === responseRequestId ? pendingRequest : null;
  const waitingStep = run.steps.find(
    (step) => step.state.status === "waiting_for_permission" && step.state.agentId,
  );
  const { refetch: refetchState } = stateQuery;
  const { fetchNextPage, refetch: refetchEvents } = eventsQuery;
  const retainedEventUpdatedAt = useRef(run.supervision?.updatedAt);
  const review = useCallback(() => {
    const requestId = pendingRequest?.id ?? summary?.pendingHumanRequest?.id;
    if (requestId) setResponseRequestId(requestId);
  }, [pendingRequest?.id, summary?.pendingHumanRequest?.id]);
  const closeResponse = useCallback(() => setResponseRequestId(null), []);
  const refreshState = useCallback(() => void refetchState(), [refetchState]);
  const refreshEvents = useCallback(() => void refetchEvents(), [refetchEvents]);
  const loadMoreEvents = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  useEffect(() => {
    const updatedAt = run.supervision?.updatedAt;
    if (!updatedAt || retainedEventUpdatedAt.current === updatedAt) return;
    retainedEventUpdatedAt.current = updatedAt;
    if (enabled && eventsQuery.canLoad) void refetchEvents();
  }, [enabled, eventsQuery.canLoad, refetchEvents, run.supervision?.updatedAt]);
  const openWaitingAgent = useCallback(() => {
    if (!waitingStep || !("agentId" in waitingStep.state) || !waitingStep.state.agentId) return;
    router.push(
      buildHostAgentDetailRoute(
        serverId,
        waitingStep.state.agentId,
        run.workspace.workspaceId,
      ) as Href,
    );
  }, [run.workspace.workspaceId, serverId, waitingStep]);

  if (!summary) return null;
  const supervisor = run.teamSnapshot.roles.find((role) => role.id === summary.supervisorRoleId);

  return (
    <View style={styles.container} testID="team-run-supervision">
      <SupervisionSummaryCard
        summary={summary}
        supervisorName={supervisor?.name ?? summary.supervisorRoleId}
      />
      <HumanRequestCallout
        summary={summary.pendingHumanRequest}
        request={pendingRequest}
        supported={stateQuery.supported}
        canLoad={stateQuery.canLoad}
        loading={stateQuery.isLoading}
        error={stateQuery.error}
        onReview={review}
        onRetry={refreshState}
      />
      <ProviderPermissionCallout step={waitingStep} onOpen={openWaitingAgent} />
      <SupervisionActivity
        supported={eventsQuery.supported}
        canLoad={eventsQuery.canLoad}
        loading={eventsQuery.isLoading}
        error={eventsQuery.error}
        events={eventsQuery.events}
        hasNextPage={eventsQuery.hasNextPage}
        loadingNextPage={eventsQuery.isFetchingNextPage}
        onRetry={refreshEvents}
        onLoadMore={loadMoreEvents}
      />

      {responseRequest ? (
        <TeamSupervisionResponseSheet
          key={`${responseRequest.id}:${responseRequest.revision}`}
          serverId={serverId}
          runId={run.id}
          request={responseRequest}
          onClose={closeResponse}
          onConflict={refreshState}
        />
      ) : null}
    </View>
  );
}

function SupervisionSummaryCard({
  summary,
  supervisorName,
}: {
  summary: TeamRunSupervisionSummaryDto;
  supervisorName: string;
}): ReactElement {
  const { t } = useTranslation();
  const presentation = teamRunSupervisionPresentation(summary);
  return (
    <View style={styles.summaryCard} testID="team-run-supervision-summary">
      <View style={styles.summaryHeading}>
        <View style={styles.summaryTitleGroup}>
          <Text style={styles.summaryTitle}>{t("teams.runs.supervision.title")}</Text>
          <Text style={styles.meta}>
            {t("teams.runs.supervision.supervisor", { name: supervisorName })}
          </Text>
        </View>
        <StatusBadge
          label={presentation.labelKey ? t(presentation.labelKey) : presentation.fallbackLabel}
          variant={presentation.variant}
        />
      </View>
      <Text style={styles.meta}>
        {t("teams.runs.supervision.progress", {
          completed: summary.completedWorkItems,
          total: summary.totalWorkItems,
        })}
      </Text>
    </View>
  );
}

function HumanRequestCallout({
  summary,
  request,
  supported,
  canLoad,
  loading,
  error,
  onReview,
  onRetry,
}: {
  summary: TeamRunSupervisionSummaryDto["pendingHumanRequest"];
  request: TeamRunSupervisionHumanRequestDto | null;
  supported: boolean;
  canLoad: boolean;
  loading: boolean;
  error: Error | null;
  onReview: () => void;
  onRetry: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!summary) return null;
  return (
    <View
      style={[styles.callout, styles.reviewCallout]}
      accessibilityRole="alert"
      testID={`team-run-supervision-request-${summary.id}`}
    >
      <View style={styles.calloutText}>
        <Text style={styles.calloutEyebrow}>{t("teams.runs.supervision.needsReview")}</Text>
        <Text style={styles.cardTitle}>{summary.title}</Text>
        {request ? <Text style={styles.bodyText}>{request.detail}</Text> : null}
        {loading ? (
          <Text style={styles.meta}>{t("teams.runs.supervision.loadingRequest")}</Text>
        ) : null}
        {supported && !canLoad ? (
          <Text style={styles.meta}>{t("teams.runs.supervision.offline")}</Text>
        ) : null}
        {!supported ? (
          <Text style={styles.meta}>{t("teams.runs.supervision.updateRequired")}</Text>
        ) : null}
        {error ? <Text style={styles.error}>{toErrorMessage(error)}</Text> : null}
      </View>
      <View style={styles.calloutActions}>
        {error ? (
          <Button variant="ghost" size="sm" leftIcon={RefreshCw} onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
        ) : null}
        <Button
          variant="default"
          size="sm"
          onPress={onReview}
          disabled={!request || !canLoad}
          testID="team-run-supervision-review"
        >
          {t("teams.runs.supervision.reviewRequest")}
        </Button>
      </View>
    </View>
  );
}

function ProviderPermissionCallout({
  step,
  onOpen,
}: {
  step: TeamRunStepDto | undefined;
  onOpen: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!step || step.state.status !== "waiting_for_permission" || !step.state.agentId) return null;
  return (
    <View style={styles.callout} testID="team-run-provider-permission">
      <ShieldAlert size={20} color={styles.permissionIcon.color} />
      <View style={styles.calloutText}>
        <Text style={styles.cardTitle}>{t("teams.runs.supervision.permission.title")}</Text>
        <Text style={styles.bodyText}>
          {t("teams.runs.supervision.permission.detail", { role: step.snapshot.roleName })}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        leftIcon={Bot}
        onPress={onOpen}
        testID="team-run-provider-permission-open-agent"
      >
        {t("teams.runs.supervision.permission.openAgent")}
      </Button>
    </View>
  );
}

function SupervisionActivity({
  supported,
  canLoad,
  loading,
  error,
  events,
  hasNextPage,
  loadingNextPage,
  onRetry,
  onLoadMore,
}: {
  supported: boolean;
  canLoad: boolean;
  loading: boolean;
  error: Error | null;
  events: readonly TeamRunSupervisionEventDto[];
  hasNextPage: boolean;
  loadingNextPage: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}): ReactElement {
  const { t } = useTranslation();
  let content: ReactElement;
  if (!supported) {
    content = <Text style={styles.notice}>{t("teams.runs.supervision.updateRequired")}</Text>;
  } else if (!canLoad) {
    content = <Text style={styles.notice}>{t("teams.runs.supervision.offline")}</Text>;
  } else if (loading) {
    content = (
      <View style={styles.loading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  } else {
    content = (
      <View style={styles.events}>
        {error ? (
          <View style={styles.inlineAction}>
            <Text style={styles.error}>{toErrorMessage(error)}</Text>
            <Button variant="ghost" size="sm" onPress={onRetry}>
              {t("common.actions.retry")}
            </Button>
          </View>
        ) : null}
        {!error && events.length === 0 ? (
          <Text style={styles.bodyText}>{t("teams.runs.supervision.emptyActivity")}</Text>
        ) : null}
        {events.map((event) => (
          <SupervisionEventCard key={event.id} event={event} />
        ))}
        {hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            onPress={onLoadMore}
            disabled={loadingNextPage}
            loading={loadingNextPage}
          >
            {t("teams.runs.actions.loadMore")}
          </Button>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.activity} testID="team-run-supervision-activity">
      <Text style={styles.sectionTitle}>{t("teams.runs.supervision.activity")}</Text>
      {content}
    </View>
  );
}

function unresolvedRequest(
  request: TeamRunSupervisionHumanRequestDto | null,
): TeamRunSupervisionHumanRequestDto | null {
  return request && !request.resolution && !request.retirement ? request : null;
}

function matchingPendingRequest(
  summary: TeamRunSupervisionSummaryDto | undefined,
  request: TeamRunSupervisionHumanRequestDto | null,
): TeamRunSupervisionHumanRequestDto | null {
  const retained = summary?.pendingHumanRequest;
  if (!retained || !request) return null;
  return retained.id === request.id && retained.revision === request.revision ? request : null;
}

function SupervisionEventCard({ event }: { event: TeamRunSupervisionEventDto }): ReactElement {
  const { t } = useTranslation();
  const references = useMemo(
    () => [
      ...(event.decisionId
        ? [[t("teams.runs.supervision.references.decision"), event.decisionId] as const]
        : []),
      ...(event.actionId
        ? [[t("teams.runs.supervision.references.action"), event.actionId] as const]
        : []),
      ...(event.workItemId
        ? [[t("teams.runs.supervision.references.workItem"), event.workItemId] as const]
        : []),
      ...(event.attemptId
        ? [[t("teams.runs.supervision.references.attempt"), event.attemptId] as const]
        : []),
      ...(event.humanRequestId
        ? [[t("teams.runs.supervision.references.request"), event.humanRequestId] as const]
        : []),
      ...referenceGroup(t("teams.runs.supervision.references.roles"), event.roleIds),
      ...referenceGroup(t("teams.runs.supervision.references.agents"), event.agentIds),
      ...referenceGroup(t("teams.runs.supervision.references.steps"), event.stepIds),
      ...referenceGroup(t("teams.runs.supervision.references.artifacts"), event.artifactIds),
    ],
    [event, t],
  );
  return (
    <View style={styles.eventCard} testID={`team-run-supervision-event-${event.id}`}>
      <View style={styles.eventHeading}>
        <Text style={styles.cardTitle}>{event.title}</Text>
        <Text style={styles.meta}>{formatTimeAgo(new Date(event.createdAt))}</Text>
      </View>
      {event.detail ? <Text style={styles.bodyText}>{event.detail}</Text> : null}
      <Text style={styles.eventKind}>{event.kind}</Text>
      {references.map(([label, value]) => (
        <Text key={`${label}:${value}`} style={styles.reference} selectable>
          {label}: {value}
        </Text>
      ))}
    </View>
  );
}

function referenceGroup(
  label: string,
  values: readonly string[],
): ReadonlyArray<readonly [string, string]> {
  return values.length > 0 ? [[label, values.join(", ")]] : [];
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[4] },
  summaryCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  summaryHeading: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  summaryTitleGroup: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  summaryTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  callout: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  reviewCallout: { borderColor: theme.colors.statusWarning },
  calloutText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  calloutActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  calloutEyebrow: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  permissionIcon: { color: theme.colors.statusWarning },
  activity: { gap: theme.spacing[3] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  events: { gap: theme.spacing[3] },
  eventCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  eventHeading: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  eventKind: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  reference: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  cardTitle: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  bodyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, lineHeight: 22 },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  inlineAction: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  loading: { minHeight: 64, alignItems: "center", justifyContent: "center" },
  spinner: { color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
