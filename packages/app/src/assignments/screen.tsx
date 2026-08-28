import { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, type Href } from "expo-router";
import {
  Ban,
  Check,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  Pencil,
  Play,
  Plus,
  RefreshCw,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  buildAssignmentRoute,
  buildAssignmentsRoute,
  buildTeamRunRoute,
} from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { formatTimeAgo } from "@/utils/time";
import { TeamRunFormSheet } from "@/teams/team-run-form-sheet";
import type { AggregatedTeam } from "@/teams/data";
import { useTeams } from "@/teams/use-teams";
import { AssignmentArtifactCard } from "./artifact-card";
import { AssignmentFormSheet } from "./assignment-form-sheet";
import { AssignmentTeamPickerSheet } from "./assignment-team-picker-sheet";
import { type AggregatedAssignment, type AssignmentHostState } from "./data";
import {
  isAssignmentRunEnabled,
  isAssignmentTeamPickerReady,
  resolveActiveAssignmentKey,
  teamsForAssignment,
  type AssignmentsView,
} from "./screen-state";
import { useAssignmentArtifacts } from "./use-assignment-artifacts";
import { useAssignmentMutations } from "./use-assignment-mutations";
import { useAssignmentRuns } from "./use-assignment-runs";
import { useAssignments } from "./use-assignments";

export type { AssignmentsView } from "./screen-state";

type FormState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; assignment: AggregatedAssignment };

type RunState =
  | { kind: "closed" }
  | { kind: "choose-team"; assignment: AggregatedAssignment }
  | { kind: "preflight"; assignment: AggregatedAssignment; team: AggregatedTeam };

function rpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function assignmentTestIdentity(assignment: AggregatedAssignment): string {
  return `${encodeURIComponent(assignment.serverId)}-${encodeURIComponent(assignment.id)}`;
}

interface AssignmentSelectionInput {
  view: AssignmentsView;
  compact: boolean;
  assignments: AggregatedAssignment[];
  hosts: AssignmentHostState[];
}

interface AssignmentSelection {
  routed: AggregatedAssignment | null;
  selected: AggregatedAssignment | null;
  selectedKey: string | null;
  detailHost: AssignmentHostState | null;
  detailLoading: boolean;
}

function resolveAssignmentSelection(input: AssignmentSelectionInput): AssignmentSelection {
  let routed: AggregatedAssignment | null = null;
  if (input.view.kind === "detail") {
    const { serverId, assignmentId } = input.view;
    routed =
      input.assignments.find(
        (assignment) => assignment.serverId === serverId && assignment.id === assignmentId,
      ) ?? null;
  }
  let selected = routed;
  if (!selected && !input.compact && input.view.kind === "list") {
    selected = input.assignments[0] ?? null;
  }
  const detailServerId =
    selected?.serverId ?? (input.view.kind === "detail" ? input.view.serverId : null);
  const detailHost = detailServerId
    ? (input.hosts.find((host) => host.serverId === detailServerId) ?? null)
    : null;
  let detailLoading = input.hosts.some(
    (host) => host.status === "connecting" || host.status === "loading",
  );
  if (input.view.kind === "detail") {
    detailLoading = detailHost?.status === "connecting" || detailHost?.status === "loading";
  }
  return {
    routed,
    selected,
    selectedKey: resolveActiveAssignmentKey(input.view, selected),
    detailHost,
    detailLoading,
  };
}

export function AssignmentsScreen({ view }: { view: AssignmentsView }): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <AssignmentsScreenContent view={view} />;
}

function AssignmentsScreenContent({ view }: { view: AssignmentsView }): ReactElement {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const data = useAssignments();
  const teamsData = useTeams();
  const [form, setForm] = useState<FormState>({ kind: "closed" });
  const [run, setRun] = useState<RunState>({ kind: "closed" });
  const eligibleHosts = useMemo(
    () =>
      data.hosts
        .filter((host) => host.status === "ready" && host.canAuthor)
        .map((host) => ({ serverId: host.serverId, label: host.serverName })),
    [data.hosts],
  );
  const selection = resolveAssignmentSelection({
    view,
    compact,
    assignments: data.assignments,
    hosts: data.hosts,
  });
  const selectedAssignment = selection.selected;
  const openCreate = useCallback(() => setForm({ kind: "create" }), []);
  const openEdit = useCallback(
    (assignment: AggregatedAssignment) => setForm({ kind: "edit", assignment }),
    [],
  );
  const closeForm = useCallback(() => setForm({ kind: "closed" }), []);
  const openAssignment = useCallback((assignment: AggregatedAssignment) => {
    router.push(buildAssignmentRoute(assignment.serverId, assignment.id) as Href);
  }, []);
  const saved = useCallback((serverId: string, assignment: AssignmentDto) => {
    setForm({ kind: "closed" });
    router.replace(buildAssignmentRoute(serverId, assignment.id) as Href);
  }, []);
  const back = useCallback(() => router.replace(buildAssignmentsRoute() as Href), []);
  const closeRun = useCallback(() => setRun({ kind: "closed" }), []);
  const openRun = useCallback(
    (assignment: AggregatedAssignment) => {
      if (!isAssignmentTeamPickerReady(assignment.serverId, teamsData.hosts)) return;
      setRun({ kind: "choose-team", assignment });
    },
    [teamsData.hosts],
  );
  const chooseTeam = useCallback((team: AggregatedTeam) => {
    setRun((current) =>
      current.kind === "choose-team"
        ? { kind: "preflight", assignment: current.assignment, team }
        : current,
    );
  }, []);
  const runStarted = useCallback(
    (started: TeamRunDto) => {
      if (run.kind !== "preflight") return;
      const serverId = run.assignment.serverId;
      setRun({ kind: "closed" });
      router.push(buildTeamRunRoute(serverId, started.teamId, started.id) as Href);
    },
    [run],
  );

  const list = (
    <AssignmentsList
      hosts={data.hosts}
      selectedKey={selection.selectedKey}
      createEnabled={eligibleHosts.length > 0}
      onCreate={openCreate}
      onOpen={openAssignment}
      onRetry={data.refetchHost}
    />
  );
  const runEnabled = isAssignmentRunEnabled(
    selectedAssignment,
    selection.detailHost,
    teamsData.hosts,
  );
  const pickerTeams =
    run.kind === "choose-team" ? teamsForAssignment(run.assignment, teamsData.teams) : [];
  const detail = (
    <AssignmentDetail
      assignment={selectedAssignment}
      host={selection.detailHost}
      loading={selection.detailLoading}
      requested={view.kind === "detail"}
      runEnabled={runEnabled}
      onEdit={openEdit}
      onRun={openRun}
    />
  );

  let content: ReactElement;
  if (!compact) {
    content = (
      <View style={styles.container}>
        <MenuHeader title={t("assignments.title")} />
        <View style={styles.desktopBody}>
          <View style={styles.rail}>{list}</View>
          <View style={styles.detailPane}>{detail}</View>
        </View>
      </View>
    );
  } else if (view.kind === "detail") {
    content = (
      <View style={styles.container}>
        <BackHeader title={selection.routed?.title ?? t("assignments.title")} onBack={back} />
        {detail}
      </View>
    );
  } else {
    content = (
      <View style={styles.container}>
        <MenuHeader title={t("assignments.title")} />
        {list}
      </View>
    );
  }

  return (
    <>
      {content}
      {form.kind === "create" ? (
        <AssignmentFormSheet
          key="create"
          mode="create"
          hosts={eligibleHosts}
          selectedServerId={eligibleHosts.length === 1 ? eligibleHosts[0]!.serverId : null}
          authoringEnabled={eligibleHosts.length > 0}
          onClose={closeForm}
          onSaved={saved}
        />
      ) : null}
      {form.kind === "edit" ? (
        <AssignmentFormSheet
          key={`edit:${form.assignment.key}:${form.assignment.revision}`}
          mode="edit"
          hosts={[{ serverId: form.assignment.serverId, label: form.assignment.serverName }]}
          selectedServerId={form.assignment.serverId}
          assignment={form.assignment}
          authoringEnabled={data.hosts.some(
            (host) =>
              host.serverId === form.assignment.serverId &&
              host.status === "ready" &&
              host.canAuthor,
          )}
          onClose={closeForm}
          onSaved={saved}
        />
      ) : null}
      {run.kind === "choose-team" ? (
        <AssignmentTeamPickerSheet teams={pickerTeams} onClose={closeRun} onSelect={chooseTeam} />
      ) : null}
      {run.kind === "preflight" ? (
        <TeamRunFormSheet
          key={`assignment-run:${run.assignment.key}:${run.assignment.revision}:${run.team.id}:${run.team.revision}`}
          serverId={run.assignment.serverId}
          team={run.team}
          assignment={run.assignment}
          onClose={closeRun}
          onStarted={runStarted}
        />
      ) : null}
    </>
  );
}

function AssignmentsList({
  hosts,
  selectedKey,
  createEnabled,
  onCreate,
  onOpen,
  onRetry,
}: {
  hosts: AssignmentHostState[];
  selectedKey: string | null;
  createEnabled: boolean;
  onCreate: () => void;
  onOpen: (assignment: AggregatedAssignment) => void;
  onRetry: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.listPane}>
      <View style={styles.listToolbar}>
        <Text style={styles.listHeading}>{t("assignments.title")}</Text>
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onPress={onCreate}
          disabled={!createEnabled}
          testID="assignments-new"
        >
          {t("assignments.newAssignment")}
        </Button>
      </View>
      <ScrollView
        style={styles.listScroll}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        testID="assignments-list"
      >
        {hosts.length === 0 ? (
          <ListEmpty message={t("assignments.noHosts")} />
        ) : (
          hosts.map((host) => (
            <AssignmentHostGroup
              key={host.serverId}
              host={host}
              selectedKey={selectedKey}
              onOpen={onOpen}
              onRetry={onRetry}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function AssignmentHostGroup({
  host,
  selectedKey,
  onOpen,
  onRetry,
}: {
  host: AssignmentHostState;
  selectedKey: string | null;
  onOpen: (assignment: AggregatedAssignment) => void;
  onRetry: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const retry = useCallback(() => onRetry(host.serverId), [host.serverId, onRetry]);
  return (
    <View style={styles.hostGroup} testID={`assignments-host-${host.serverId}`}>
      <View style={styles.hostHeadingRow}>
        <Text style={styles.hostName} numberOfLines={1}>
          {host.serverName}
        </Text>
        <Text style={styles.hostStatus}>{t(`assignments.hostStates.${host.status}`)}</Text>
      </View>
      {host.status === "error" ? (
        <View style={styles.hostMessageRow}>
          <Text style={styles.hostMessage}>{host.error ?? t("assignments.errors.load")}</Text>
          <Button variant="ghost" size="sm" leftIcon={RefreshCw} onPress={retry} />
        </View>
      ) : null}
      {host.status === "unsupported" ? (
        <Text style={styles.hostMessage}>{t("assignments.hostStates.unsupportedDetail")}</Text>
      ) : null}
      {host.issues.length > 0 ? (
        <View style={styles.issueBanner} testID={`assignments-issues-${host.serverId}`}>
          {host.issues.map((issue) => (
            <Text key={`${issue.collection}:${issue.fileName}`} style={styles.issueText}>
              {issue.fileName}: {issue.message}
            </Text>
          ))}
        </View>
      ) : null}
      {host.assignments.map((assignment) => (
        <AssignmentRow
          key={assignment.key}
          assignment={assignment}
          selected={assignment.key === selectedKey}
          onOpen={onOpen}
        />
      ))}
      {host.status === "ready" && host.assignments.length === 0 ? (
        <Text style={styles.hostMessage}>{t("assignments.emptyHost")}</Text>
      ) : null}
    </View>
  );
}

function AssignmentRow({
  assignment,
  selected,
  onOpen,
}: {
  assignment: AggregatedAssignment;
  selected: boolean;
  onOpen: (assignment: AggregatedAssignment) => void;
}): ReactElement {
  const { t } = useTranslation();
  const press = useCallback(() => onOpen(assignment), [assignment, onOpen]);
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.assignmentRow,
      selected && styles.assignmentRowSelected,
      (pressed || hovered) && styles.assignmentRowHovered,
    ],
    [selected],
  );
  return (
    <Pressable
      onPress={press}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={t("assignments.openAssignment", {
        title: assignment.title,
        host: assignment.serverName,
      })}
      testID={`assignment-row-${assignmentTestIdentity(assignment)}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {assignment.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {assignment.workItem?.identifier ?? t("assignments.noWorkItem")}
        </Text>
      </View>
      <StatusBadge
        label={t(`assignments.status.${assignment.state.status}`)}
        variant={assignmentStatusVariant(assignment.state.status)}
      />
      <ChevronRight size={16} color={styles.chevron.color} />
    </Pressable>
  );
}

function ListEmpty({ message }: { message: string }): ReactElement {
  return (
    <View style={styles.empty}>
      <ClipboardList size={32} color={styles.emptyIcon.color} />
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

function AssignmentDetail({
  assignment,
  host,
  loading,
  requested,
  runEnabled,
  onEdit,
  onRun,
}: {
  assignment: AggregatedAssignment | null;
  host: AssignmentHostState | null;
  loading: boolean;
  requested: boolean;
  runEnabled: boolean;
  onEdit: (assignment: AggregatedAssignment) => void;
  onRun: (assignment: AggregatedAssignment) => void;
}): ReactElement {
  const { t } = useTranslation();
  const mutations = useAssignmentMutations();
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null);
  const editable = Boolean(
    assignment && assignment.state.status === "open" && host?.status === "ready" && host.canAuthor,
  );
  const currentKey = assignment?.key ?? null;
  const error = currentKey && actionError?.key === currentKey ? actionError.message : null;
  const edit = useCallback(() => assignment && onEdit(assignment), [assignment, onEdit]);
  const run = useCallback(() => assignment && onRun(assignment), [assignment, onRun]);
  const openWorkItem = useCallback(async () => {
    if (!assignment?.workItem) return;
    setActionError(null);
    try {
      await Linking.openURL(assignment.workItem.url);
    } catch (linkError) {
      setActionError({ key: assignment.key, message: toErrorMessage(linkError) });
    }
  }, [assignment]);
  const transition = useCallback(
    async (kind: "complete" | "cancel") => {
      if (!assignment || !editable) return;
      const confirmed = await confirmDialog({
        title: t(`assignments.${kind}.title`),
        message: t(`assignments.${kind}.message`, { title: assignment.title }),
        confirmLabel: t(`assignments.actions.${kind}`),
        destructive: kind === "cancel",
      });
      if (!confirmed) return;
      setActionError(null);
      try {
        await mutations[kind].mutateAsync({
          serverId: assignment.serverId,
          assignmentId: assignment.id,
          expectedRevision: assignment.revision,
        });
      } catch (transitionError) {
        const code = rpcErrorCode(transitionError);
        setActionError({
          key: assignment.key,
          message: assignmentTransitionErrorMessage(code, transitionError, t),
        });
      }
    },
    [assignment, editable, mutations, t],
  );
  const complete = useCallback(() => void transition("complete"), [transition]);
  const cancel = useCallback(() => void transition("cancel"), [transition]);

  if (!assignment) {
    if (loading) {
      return (
        <View style={styles.detailEmpty}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      );
    }
    if (requested) {
      return <ListEmpty message={missingAssignmentMessage(host, t)} />;
    }
    return <ListEmpty message={t("assignments.selectAssignment")} />;
  }
  const testIdentity = assignmentTestIdentity(assignment);
  let readOnlyNotice: string | null = null;
  if (host?.status !== "ready") {
    readOnlyNotice = readOnlyAssignmentMessage(host, t);
  }

  return (
    <ScrollView
      style={styles.detailScroll}
      contentContainerStyle={styles.detailContent}
      showsVerticalScrollIndicator={false}
      testID={`assignment-detail-${testIdentity}`}
    >
      <View style={styles.detailTitleRow}>
        <View style={styles.detailTitleText}>
          <Text style={styles.detailTitle}>{assignment.title}</Text>
          <Text style={styles.detailHost}>{assignment.serverName}</Text>
        </View>
        <View style={styles.detailActions}>
          <Button
            variant="default"
            size="sm"
            leftIcon={Play}
            onPress={run}
            disabled={!runEnabled}
            testID={`assignment-run-open-${testIdentity}`}
          >
            {t("assignments.actions.run")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={Pencil}
            onPress={edit}
            disabled={!editable}
            testID={`assignment-edit-${testIdentity}`}
          >
            {t("assignments.actions.edit")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={Check}
            onPress={complete}
            disabled={!editable || mutations.complete.isPending}
            loading={mutations.complete.isPending}
            testID={`assignment-complete-${testIdentity}`}
          >
            {t("assignments.actions.complete")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Ban}
            onPress={cancel}
            disabled={!editable || mutations.cancel.isPending}
            loading={mutations.cancel.isPending}
            testID={`assignment-cancel-${testIdentity}`}
          >
            {t("assignments.actions.cancel")}
          </Button>
        </View>
      </View>
      <View
        style={styles.statusRow}
        testID={`assignment-status-${testIdentity}-${assignment.state.status}`}
      >
        <StatusBadge
          label={t(`assignments.status.${assignment.state.status}`)}
          variant={assignmentStatusVariant(assignment.state.status)}
        />
        <Text style={styles.rowMeta}>
          {t("assignments.detail.revision", { revision: assignment.revision })} ·{" "}
          {formatTimeAgo(new Date(assignment.updatedAt))}
        </Text>
      </View>
      {readOnlyNotice ? <Text style={styles.notice}>{readOnlyNotice}</Text> : null}
      <DetailSection title={t("assignments.detail.objective")}>
        <Text style={styles.bodyText}>{assignment.objective}</Text>
      </DetailSection>
      <DetailSection title={t("assignments.detail.workItem")}>
        {assignment.workItem ? (
          <Pressable
            onPress={openWorkItem}
            style={styles.workItemCard}
            accessibilityRole="link"
            accessibilityLabel={t("assignments.detail.openWorkItem", {
              identifier: assignment.workItem.identifier,
            })}
            testID={`assignment-work-item-${testIdentity}`}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{assignment.workItem.title}</Text>
              <Text style={styles.rowMeta}>
                {assignment.workItem.sourceLabel} · {assignment.workItem.identifier}
              </Text>
            </View>
            <ExternalLink size={16} color={styles.chevron.color} />
          </Pressable>
        ) : (
          <Text style={styles.hostMessage}>{t("assignments.noWorkItem")}</Text>
        )}
      </DetailSection>
      <DetailSection title={t("assignments.detail.runs")}>
        <AssignmentRuns assignment={assignment} />
      </DetailSection>
      <DetailSection title={t("assignments.detail.artifacts")}>
        <AssignmentArtifacts assignment={assignment} />
      </DetailSection>
      {error ? (
        <Text
          style={styles.error}
          accessibilityRole="alert"
          testID={`assignment-action-error-${testIdentity}`}
        >
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function missingAssignmentMessage(
  host: AssignmentHostState | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!host) return t("assignments.errors.hostMissing");
  if (host.status === "unsupported") return t("assignments.hostStates.unsupportedDetail");
  if (host.status === "offline") return t("assignments.errors.hostOffline");
  if (host.status === "error") return host.error ?? t("assignments.errors.load");
  return t("assignments.errors.notFound");
}

function readOnlyAssignmentMessage(
  host: AssignmentHostState | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!host) return t("assignments.errors.hostMissing");
  if (host.status === "unsupported") return t("assignments.hostStates.unsupportedDetail");
  if (host.status === "offline") return t("assignments.hostStates.readOnlyOffline");
  if (host.status === "error") return host.error ?? t("assignments.errors.load");
  return t(`assignments.hostStates.${host.status}`);
}

function assignmentTransitionErrorMessage(
  code: string | null,
  error: unknown,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (code === "assignment_has_active_run") return t("assignments.errors.activeRun");
  if (code === "assignment_revision_conflict") return t("assignments.errors.conflict");
  return toErrorMessage(error);
}

function AssignmentRuns({ assignment }: { assignment: AggregatedAssignment }): ReactElement {
  const { t } = useTranslation();
  const query = useAssignmentRuns(assignment.serverId, assignment.id);
  const { refetch, fetchNextPage } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  const open = useCallback(
    (run: TeamRunDto) =>
      router.push(buildTeamRunRoute(assignment.serverId, run.teamId, run.id) as Href),
    [assignment.serverId],
  );
  if (query.isLoading) {
    return (
      <View style={styles.smallLoading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }
  return (
    <View style={styles.cards}>
      {query.isError ? (
        <View style={styles.hostMessageRow}>
          <Text style={styles.hostMessage}>{toErrorMessage(query.error)}</Text>
          <Button variant="ghost" size="sm" onPress={retry}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {!query.isError && query.runs.length === 0 ? (
        <Text style={styles.hostMessage}>
          {t(query.canLoad ? "assignments.runs.empty" : "assignments.runs.offline")}
        </Text>
      ) : null}
      {query.runs.map((run) => (
        <AssignmentRunRow
          key={run.id}
          run={run}
          testIdentity={assignmentTestIdentity(assignment)}
          onOpen={open}
        />
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

function AssignmentRunRow({
  run,
  testIdentity,
  onOpen,
}: {
  run: TeamRunDto;
  testIdentity: string;
  onOpen: (run: TeamRunDto) => void;
}): ReactElement {
  const { t } = useTranslation();
  const press = useCallback(() => onOpen(run), [onOpen, run]);
  return (
    <Pressable
      onPress={press}
      style={styles.runRow}
      accessibilityRole="button"
      accessibilityLabel={t("assignments.runs.open", { team: run.teamSnapshot.name })}
      testID={`assignment-run-${testIdentity}-${encodeURIComponent(run.id)}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{run.teamSnapshot.name}</Text>
        <Text style={styles.rowMeta}>
          {run.workspace.displayName} · {formatTimeAgo(new Date(run.createdAt))}
        </Text>
      </View>
      <StatusBadge label={t(`teams.runs.status.${run.state.status}`)} />
      <ChevronRight size={16} color={styles.chevron.color} />
    </Pressable>
  );
}

function AssignmentArtifacts({ assignment }: { assignment: AggregatedAssignment }): ReactElement {
  const { t } = useTranslation();
  const query = useAssignmentArtifacts(assignment.serverId, assignment.id);
  const { refetch, fetchNextPage } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  if (query.isLoading) {
    return (
      <View style={styles.smallLoading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }
  return (
    <View style={styles.cards}>
      {query.isError ? (
        <View style={styles.hostMessageRow}>
          <Text style={styles.hostMessage}>{toErrorMessage(query.error)}</Text>
          <Button variant="ghost" size="sm" onPress={retry}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {query.issues.length > 0 ? (
        <View
          style={styles.issueBanner}
          testID={`assignment-artifact-issues-${assignmentTestIdentity(assignment)}`}
        >
          {query.issues.map((issue) => (
            <Text key={`${issue.collection}:${issue.fileName}`} style={styles.issueText}>
              {issue.fileName}: {issue.message}
            </Text>
          ))}
        </View>
      ) : null}
      {!query.isError && query.artifacts.length === 0 ? (
        <Text style={styles.hostMessage}>
          {t(query.canLoad ? "assignments.artifacts.empty" : "assignments.artifacts.offline")}
        </Text>
      ) : null}
      {query.artifacts.map((artifact) => (
        <AssignmentArtifactCard
          key={artifact.id}
          artifact={artifact}
          serverId={assignment.serverId}
        />
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
    <View style={styles.detailSection}>
      <Text style={styles.detailSectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function assignmentStatusVariant(status: AssignmentDto["state"]["status"]): StatusBadgeVariant {
  if (status === "completed") return "success";
  if (status === "canceled") return "error";
  return "muted";
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  desktopBody: { flex: 1, minHeight: 0, flexDirection: "row" },
  rail: { width: 320, flexShrink: 0, borderRightWidth: 1, borderRightColor: theme.colors.border },
  detailPane: { flex: 1, minWidth: 0 },
  listPane: { flex: 1, minHeight: 0 },
  listToolbar: {
    padding: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  listHeading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  listScroll: { flex: 1, minHeight: 0 },
  listContent: { flexGrow: 1, padding: theme.spacing[3], gap: theme.spacing[6] },
  hostGroup: { gap: theme.spacing[2] },
  hostHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  hostName: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hostStatus: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  hostMessageRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  hostMessage: {
    flex: 1,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
  },
  issueBanner: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  issueText: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  assignmentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  assignmentRowSelected: { backgroundColor: theme.colors.surface2 },
  assignmentRowHovered: { backgroundColor: theme.colors.surface3 },
  rowText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  rowMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chevron: { color: theme.colors.foregroundExtraMuted },
  empty: {
    flex: 1,
    minHeight: 180,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyIcon: { color: theme.colors.foregroundExtraMuted },
  emptyText: { color: theme.colors.foregroundMuted, textAlign: "center" },
  detailEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  spinner: { color: theme.colors.foregroundMuted },
  detailScroll: { flex: 1, minHeight: 0 },
  detailContent: {
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    padding: { xs: theme.spacing[4], md: theme.spacing[8] },
    paddingBottom: theme.spacing[12],
    gap: theme.spacing[8],
  },
  detailTitleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[4],
  },
  detailTitleText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  detailTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  detailHost: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  detailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    flexShrink: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  notice: {
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  detailSection: { gap: theme.spacing[3] },
  detailSectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  bodyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, lineHeight: 22 },
  workItemCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  cards: { gap: theme.spacing[3] },
  smallLoading: { minHeight: 72, alignItems: "center", justifyContent: "center" },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
