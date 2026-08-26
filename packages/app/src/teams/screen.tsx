import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, type Href } from "expo-router";
import {
  Bot,
  ChevronRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamDefinitionDto, TeamRunDto } from "@getpaseo/protocol/team/types";
import { AgentProfileGlyph, buildAgentProfileTags, useAgentProfiles } from "@/agent-profiles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  buildSettingsHostSectionRoute,
  buildTeamRoute,
  buildTeamRunRoute,
  buildTeamsRoute,
} from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { formatTimeAgo } from "@/utils/time";
import { teamKey, type AggregatedTeam, type TeamHostState } from "./data";
import { isTerminalTeamRunStatus, newestTeamRunSnapshot } from "./run-data";
import { resolveActiveTeamKey, type TeamsView } from "./screen-state";
import { TeamFormSheet } from "./team-form-sheet";
import { TeamRunFormSheet } from "./team-run-form-sheet";
import { useTeamMutations } from "./use-team-mutations";
import { useTeamRun, useTeamRuns } from "./use-team-runs";
import { useTeams } from "./use-teams";

export type { TeamsView } from "./screen-state";

type FormState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; serverId: string; team: TeamDefinitionDto };

type RunFormState = { kind: "closed" } | { kind: "open"; team: AggregatedTeam };

function rpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function TeamsScreen({ view }: { view: TeamsView }): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <TeamsScreenContent view={view} />;
}

function TeamsScreenContent({ view }: { view: TeamsView }): ReactElement {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const data = useTeams();
  const [form, setForm] = useState<FormState>({ kind: "closed" });
  const [runForm, setRunForm] = useState<RunFormState>({ kind: "closed" });
  const eligibleHosts = useMemo(
    () =>
      data.hosts
        .filter((host) => host.status === "ready" && host.canAuthor)
        .map((host) => ({ serverId: host.serverId, label: host.serverName })),
    [data.hosts],
  );
  const routedTeam =
    view.kind === "detail"
      ? (data.teams.find((team) => team.serverId === view.serverId && team.id === view.teamId) ??
        null)
      : null;
  const selectedTeam = routedTeam ?? (!compact && view.kind === "list" ? data.teams[0] : null);
  const activeTeamKey = resolveActiveTeamKey(view, selectedTeam);

  const openCreate = useCallback(() => setForm({ kind: "create" }), []);
  const openEdit = useCallback(
    (team: AggregatedTeam) => setForm({ kind: "edit", serverId: team.serverId, team }),
    [],
  );
  const closeForm = useCallback(() => setForm({ kind: "closed" }), []);
  const openRun = useCallback((team: AggregatedTeam) => setRunForm({ kind: "open", team }), []);
  const closeRun = useCallback(() => setRunForm({ kind: "closed" }), []);
  const runStarted = useCallback(
    (run: TeamRunDto) => {
      if (runForm.kind !== "open") return;
      setRunForm({ kind: "closed" });
      router.push(buildTeamRunRoute(runForm.team.serverId, run.teamId, run.id) as Href);
    },
    [runForm],
  );
  const openTeam = useCallback((team: AggregatedTeam) => {
    router.push(buildTeamRoute(team.serverId, team.id) as Href);
  }, []);
  const saved = useCallback((serverId: string, team: TeamDefinitionDto) => {
    setForm({ kind: "closed" });
    router.replace(buildTeamRoute(serverId, team.id) as Href);
  }, []);
  const backToTeams = useCallback(() => router.replace(buildTeamsRoute() as Href), []);

  const list = (
    <TeamsList
      hosts={data.hosts}
      selectedKey={selectedTeam ? teamKey(selectedTeam.serverId, selectedTeam.id) : null}
      createEnabled={eligibleHosts.length > 0}
      onCreate={openCreate}
      onOpen={openTeam}
      onRetry={data.refetchHost}
    />
  );

  let content: ReactElement;
  if (compact) {
    content =
      view.kind === "detail" ? (
        <View style={styles.container}>
          <BackHeader title={routedTeam?.name ?? t("teams.title")} onBack={backToTeams} />
          <TeamDetail
            team={routedTeam}
            host={data.hosts.find((host) => host.serverId === view.serverId) ?? null}
            loading={data.hosts.some(
              (host) =>
                host.serverId === view.serverId &&
                (host.status === "connecting" || host.status === "loading"),
            )}
            activeTeamKey={activeTeamKey}
            onEdit={openEdit}
            onRun={openRun}
          />
        </View>
      ) : (
        <View style={styles.container}>
          <MenuHeader title={t("teams.title")} />
          {list}
        </View>
      );
  } else {
    content = (
      <View style={styles.container}>
        <MenuHeader title={t("teams.title")} />
        <View style={styles.desktopBody}>
          <View style={styles.rail}>{list}</View>
          <View style={styles.detailPane}>
            <TeamDetail
              team={selectedTeam}
              host={
                selectedTeam
                  ? (data.hosts.find((host) => host.serverId === selectedTeam.serverId) ?? null)
                  : null
              }
              loading={data.hosts.some(
                (host) => host.status === "connecting" || host.status === "loading",
              )}
              activeTeamKey={activeTeamKey}
              onEdit={openEdit}
              onRun={openRun}
            />
          </View>
        </View>
      </View>
    );
  }

  return (
    <>
      {content}
      {form.kind === "create" ? (
        <TeamFormSheet
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
        <TeamFormSheet
          key={`edit:${form.serverId}:${form.team.id}:${form.team.revision}`}
          mode="edit"
          hosts={[
            {
              serverId: form.serverId,
              label:
                data.hosts.find((host) => host.serverId === form.serverId)?.serverName ??
                form.serverId,
            },
          ]}
          selectedServerId={form.serverId}
          team={form.team}
          authoringEnabled={data.hosts.some(
            (host) => host.serverId === form.serverId && host.status === "ready" && host.canAuthor,
          )}
          onClose={closeForm}
          onSaved={saved}
        />
      ) : null}
      {runForm.kind === "open" ? (
        <TeamRunFormSheet
          key={`run:${runForm.team.serverId}:${runForm.team.id}:${runForm.team.revision}`}
          serverId={runForm.team.serverId}
          team={runForm.team}
          onClose={closeRun}
          onStarted={runStarted}
        />
      ) : null}
    </>
  );
}

function TeamsList({
  hosts,
  selectedKey,
  createEnabled,
  onCreate,
  onOpen,
  onRetry,
}: {
  hosts: TeamHostState[];
  selectedKey: string | null;
  createEnabled: boolean;
  onCreate: () => void;
  onOpen: (team: AggregatedTeam) => void;
  onRetry: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.listPane}>
      <View style={styles.listToolbar}>
        <Text style={styles.listHeading}>{t("teams.title")}</Text>
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onPress={onCreate}
          disabled={!createEnabled}
          testID="teams-new"
        >
          {t("teams.newTeam")}
        </Button>
      </View>
      <ScrollView
        style={styles.listScroll}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        testID="teams-list"
      >
        {hosts.length === 0 ? (
          <ListEmpty message={t("teams.noHosts")} />
        ) : (
          hosts.map((host) => (
            <TeamHostGroup
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

function TeamHostGroup({
  host,
  selectedKey,
  onOpen,
  onRetry,
}: {
  host: TeamHostState;
  selectedKey: string | null;
  onOpen: (team: AggregatedTeam) => void;
  onRetry: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const retry = useCallback(() => onRetry(host.serverId), [host.serverId, onRetry]);
  return (
    <View style={styles.hostGroup} testID={`teams-host-${host.serverId}`}>
      <View style={styles.hostHeadingRow}>
        <Text style={styles.hostName} numberOfLines={1}>
          {host.serverName}
        </Text>
        <Text style={styles.hostStatus}>{t(`teams.hostStates.${host.status}`)}</Text>
      </View>
      {host.status === "error" ? (
        <View style={styles.hostMessageRow}>
          <Text style={styles.hostMessage} numberOfLines={2}>
            {host.error ?? t("teams.errors.load")}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={RefreshCw}
            onPress={retry}
            accessibilityLabel={t("teams.actions.retry")}
            testID={`teams-retry-${host.serverId}`}
          />
        </View>
      ) : null}
      {host.status === "unsupported" ? (
        <Text style={styles.hostMessage}>{t("teams.hostStates.unsupportedDetail")}</Text>
      ) : null}
      {host.status === "ready" && !host.agentProfilesSupported ? (
        <Text style={styles.hostMessage}>{t("teams.hostStates.profilesUnsupported")}</Text>
      ) : null}
      {host.teams.map((team) => (
        <TeamListRow
          key={team.key}
          team={team}
          selected={team.key === selectedKey}
          onPress={onOpen}
        />
      ))}
      {host.status === "ready" && host.teams.length === 0 ? (
        <Text style={styles.hostMessage}>{t("teams.emptyHost")}</Text>
      ) : null}
    </View>
  );
}

function TeamListRow({
  team,
  selected,
  onPress,
}: {
  team: AggregatedTeam;
  selected: boolean;
  onPress: (team: AggregatedTeam) => void;
}): ReactElement {
  const { t } = useTranslation();
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.teamRow,
      selected && styles.teamRowSelected,
      (pressed || hovered) && styles.teamRowHovered,
    ],
    [selected],
  );
  const handlePress = useCallback(() => onPress(team), [onPress, team]);
  return (
    <Pressable
      onPress={handlePress}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={t("teams.openTeam", { name: team.name, host: team.serverName })}
      testID={`team-row-${encodeURIComponent(team.serverId)}-${encodeURIComponent(team.id)}`}
    >
      <View style={styles.teamRowText}>
        <Text style={styles.teamName} numberOfLines={1}>
          {team.name}
        </Text>
        <Text style={styles.teamMeta} numberOfLines={1}>
          {t("teams.roleStepCount", {
            roles: team.roles.length,
            steps: team.workflow.length,
          })}
        </Text>
      </View>
      <ChevronRight size={16} color={styles.chevron.color} />
    </Pressable>
  );
}

function ListEmpty({ message }: { message: string }): ReactElement {
  return (
    <View style={styles.empty}>
      <Users size={32} color={styles.emptyIcon.color} />
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

function TeamDetail({
  team,
  host,
  loading,
  activeTeamKey,
  onEdit,
  onRun,
}: {
  team: AggregatedTeam | null;
  host: TeamHostState | null;
  loading: boolean;
  activeTeamKey: string | null;
  onEdit: (team: AggregatedTeam) => void;
  onRun: (team: AggregatedTeam) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { profiles } = useAgentProfiles(team?.serverId ?? null);
  const { entries } = useProvidersSnapshot(team?.serverId ?? null, { cwd: null });
  const mutations = useTeamMutations();
  const activeTeamKeyRef = useRef(activeTeamKey);
  activeTeamKeyRef.current = activeTeamKey;
  const [deleteFailure, setDeleteFailure] = useState<{
    teamKey: string;
    message: string;
  } | null>(null);
  const profileById = useMemo(
    () => new Map((profiles ?? []).map((profile) => [profile.id, profile])),
    [profiles],
  );
  const editable = Boolean(team && host?.status === "ready" && host.canAuthor);
  const deleteError = team && deleteFailure?.teamKey === team.key ? deleteFailure.message : null;

  const edit = useCallback(() => {
    if (team) onEdit(team);
  }, [onEdit, team]);
  const startRun = useCallback(() => {
    if (team) onRun(team);
  }, [onRun, team]);
  const openRunDetail = useCallback(
    (run: TeamRunDto) => {
      if (!team) return;
      router.push(buildTeamRunRoute(team.serverId, team.id, run.id) as Href);
    },
    [team],
  );
  const manageProfiles = useCallback(() => {
    if (team) router.push(buildSettingsHostSectionRoute(team.serverId, "agents"));
  }, [team]);
  const remove = useCallback(async () => {
    if (!team) return;
    const confirmed = await confirmDialog({
      title: t("teams.delete.title"),
      message: t("teams.delete.message", { name: team.name }),
      confirmLabel: t("teams.actions.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    setDeleteFailure(null);
    try {
      await mutations.remove.mutateAsync({
        serverId: team.serverId,
        teamId: team.id,
        expectedRevision: team.revision,
      });
      if (activeTeamKeyRef.current === team.key) {
        router.replace(buildTeamsRoute() as Href);
      }
    } catch (error) {
      setDeleteFailure({
        teamKey: team.key,
        message:
          rpcErrorCode(error) === "team_revision_conflict"
            ? t("teams.errors.conflict")
            : toErrorMessage(error),
      });
    }
  }, [mutations.remove, t, team]);

  if (!team) {
    if (loading) {
      return (
        <View style={styles.detailEmpty}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      );
    }
    return <ListEmpty message={t("teams.selectTeam")} />;
  }

  return (
    <ScrollView
      style={styles.detailScroll}
      contentContainerStyle={styles.detailContent}
      showsVerticalScrollIndicator={false}
      testID={`team-detail-${encodeURIComponent(team.serverId)}-${encodeURIComponent(team.id)}`}
    >
      <View style={styles.detailTitleRow}>
        <View style={styles.detailTitleText}>
          <Text style={styles.detailTitle}>{team.name}</Text>
          <Text style={styles.detailHost}>{team.serverName}</Text>
        </View>
        <View style={styles.detailActions}>
          <Button
            variant="default"
            size="sm"
            leftIcon={Play}
            onPress={startRun}
            disabled={!editable}
            testID={`team-run-open-${team.serverId}-${team.id}`}
          >
            {t("teams.runs.actions.runTeam")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={Pencil}
            onPress={edit}
            disabled={!editable}
            testID={`team-edit-${team.serverId}-${team.id}`}
          >
            {t("teams.actions.edit")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Trash2}
            onPress={remove}
            disabled={!editable || mutations.remove.isPending}
            loading={mutations.remove.isPending}
            testID={`team-delete-${team.serverId}-${team.id}`}
          >
            {t("teams.actions.delete")}
          </Button>
        </View>
      </View>
      {!editable ? (
        <Text style={styles.notice} testID="team-detail-readonly">
          {host?.status === "ready" && !host.agentProfilesSupported
            ? t("teams.hostStates.profilesUnsupported")
            : t("teams.hostStates.readOnlyOffline")}
        </Text>
      ) : null}
      <DetailSection title={t("teams.detail.sharedInstructions")}>
        <Text style={styles.instructions}>{team.instructions}</Text>
      </DetailSection>
      <DetailSection title={t("teams.detail.roles")}>
        <View style={styles.detailCards}>
          {team.roles.map((role) => (
            <RoleDetail
              key={`${team.key}:${role.id}`}
              teamKey={team.key}
              role={role}
              profile={profileById.get(role.profileId) ?? null}
              entries={entries}
            />
          ))}
        </View>
      </DetailSection>
      <DetailSection title={t("teams.detail.workflow")}>
        <View style={styles.detailCards}>
          {team.workflow.map((step, index) => {
            const role = team.roles.find((candidate) => candidate.id === step.roleId);
            return (
              <View
                key={`${team.key}:${step.id}`}
                style={styles.workflowRow}
                testID={`team-step-${encodeURIComponent(team.serverId)}-${encodeURIComponent(team.id)}-${step.id}`}
              >
                <View style={styles.stepNumber}>
                  <Text style={styles.stepNumberText}>{index + 1}</Text>
                </View>
                <View style={styles.workflowContent}>
                  <Text style={styles.workflowRole}>
                    {role?.name ?? t("teams.detail.missingRole")}
                  </Text>
                  <Text style={styles.workflowInstructions}>
                    {step.instructions || t("teams.detail.noStepInstructions")}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </DetailSection>
      <DetailSection title={t("teams.runs.recent.title")}>
        <TeamRecentRuns serverId={team.serverId} teamId={team.id} onOpen={openRunDetail} />
      </DetailSection>
      <Button variant="outline" onPress={manageProfiles} testID="team-detail-manage-profiles">
        {t("teams.actions.manageProfiles")}
      </Button>
      {deleteError ? <Text style={styles.error}>{deleteError}</Text> : null}
    </ScrollView>
  );
}

function TeamRecentRuns({
  serverId,
  teamId,
  onOpen,
}: {
  serverId: string;
  teamId: string;
  onOpen: (run: TeamRunDto) => void;
}): ReactElement {
  const { t } = useTranslation();
  const runsQuery = useTeamRuns(serverId, teamId);
  const { refetch, fetchNextPage } = runsQuery;
  const retry = useCallback(() => void refetch(), [refetch]);
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  return (
    <View style={styles.detailCards}>
      {runsQuery.isLoading ? (
        <View style={styles.runsLoading}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      ) : null}
      {runsQuery.isError ? (
        <View style={styles.hostMessageRow}>
          <Text style={styles.hostMessage}>{toErrorMessage(runsQuery.error)}</Text>
          <Button variant="ghost" size="sm" onPress={retry}>
            {t("teams.actions.retry")}
          </Button>
        </View>
      ) : null}
      {!runsQuery.isLoading && !runsQuery.isError && runsQuery.runs.length === 0 ? (
        <Text style={styles.hostMessage}>{t("teams.runs.recent.empty")}</Text>
      ) : null}
      {runsQuery.runs.map((run) => (
        <TeamRunRow key={run.id} serverId={serverId} run={run} onOpen={onOpen} />
      ))}
      {runsQuery.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          onPress={loadMore}
          disabled={runsQuery.isFetchingNextPage}
          loading={runsQuery.isFetchingNextPage}
        >
          {t("teams.runs.actions.loadMore")}
        </Button>
      ) : null}
    </View>
  );
}

function TeamRunRow({
  serverId,
  run,
  onOpen,
}: {
  serverId: string;
  run: TeamRunDto;
  onOpen: (run: TeamRunDto) => void;
}): ReactElement {
  const { t } = useTranslation();
  const activeRunQuery = useTeamRun(serverId, run.id, {
    enabled: !isTerminalTeamRunStatus(run.state.status),
  });
  const displayedRun = newestTeamRunSnapshot(run, activeRunQuery.data);
  const handlePress = useCallback(() => onOpen(displayedRun), [displayedRun, onOpen]);
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.runRow,
      (pressed || hovered) && styles.teamRowHovered,
    ],
    [],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={t("teams.runs.recent.open", {
        objective: displayedRun.objective,
        status: t(`teams.runs.status.${displayedRun.state.status}`),
      })}
      testID={`team-run-row-${run.id}`}
    >
      <View style={styles.teamRowText}>
        <Text style={styles.teamName} numberOfLines={1}>
          {displayedRun.objective}
        </Text>
        <Text style={styles.teamMeta} numberOfLines={1}>
          {displayedRun.workspace.displayName} · {formatTimeAgo(new Date(displayedRun.createdAt))}
        </Text>
      </View>
      <StatusBadge label={t(`teams.runs.status.${displayedRun.state.status}`)} />
      <ChevronRight size={16} color={styles.chevron.color} />
    </Pressable>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactElement;
}): ReactElement {
  return (
    <View style={styles.detailSection}>
      <Text style={styles.detailSectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function RoleDetail({
  teamKey: qualifiedTeamKey,
  role,
  profile,
  entries,
}: {
  teamKey: string;
  role: TeamDefinitionDto["roles"][number];
  profile: AgentProfile | null;
  entries: ReturnType<typeof useProvidersSnapshot>["entries"];
}): ReactElement {
  const { t } = useTranslation();
  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );
  const summary = profile
    ? buildAgentProfileTags({ profile, entries, formatFeatureCount })
        .map((tag) => tag.label)
        .join(" · ")
    : null;
  return (
    <View
      style={styles.roleCard}
      testID={`team-role-${encodeURIComponent(qualifiedTeamKey)}-${role.id}`}
    >
      <View style={styles.roleTitleRow}>
        {profile ? (
          <AgentProfileGlyph icon={profile.icon} color={profile.color} />
        ) : (
          <Bot size={18} color={styles.emptyIcon.color} />
        )}
        <View style={styles.roleTitleText}>
          <Text style={styles.roleName}>{role.name}</Text>
          <Text style={profile ? styles.profileName : styles.missingProfile}>
            {profile?.name ?? `${role.profileId} · ${t("teams.detail.missingProfile")}`}
          </Text>
          {summary ? <Text style={styles.profileSummary}>{summary}</Text> : null}
        </View>
      </View>
      <Text style={styles.instructions}>{role.instructions}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  desktopBody: { flex: 1, minHeight: 0, flexDirection: "row" },
  rail: {
    width: 320,
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
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
  teamRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  teamRowSelected: { backgroundColor: theme.colors.surface2 },
  teamRowHovered: { backgroundColor: theme.colors.surface3 },
  teamRowText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  teamName: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  teamMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
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
  instructions: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  detailCards: { gap: theme.spacing[3] },
  roleCard: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  roleTitleRow: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  roleTitleText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  roleName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  profileName: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  missingProfile: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  profileSummary: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  workflowRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  stepNumberText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  workflowContent: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  workflowRole: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  workflowInstructions: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  runsLoading: { minHeight: 72, alignItems: "center", justifyContent: "center" },
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
