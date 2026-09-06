import {
  useCallback,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, type Href } from "expo-router";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectField } from "@/components/ui/select-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchInfiniteQuery } from "@/data/query";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { AssignmentFormSheet } from "@/assignments/assignment-form-sheet";
import { buildAssignmentRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import {
  INITIAL_BROWSER_STATE,
  normalizeGitHubSite,
  reduceBrowserState,
  type BrowserAction,
  type BrowserState,
} from "./browser-state";
import {
  repositoryWorkToAssignmentReference,
  type Repository,
  type RepositoryWorkItem,
} from "./data";
import { repositoryQueryOptions, workQueryOptions } from "./queries";
import { WorkPreviewSheet } from "./work-preview-sheet";

export function GitHubWorkScreen(): ReactElement {
  const focused = useIsFocused();
  return focused ? <GitHubWorkContent /> : <View style={styles.container} />;
}

function GitHubWorkContent(): ReactElement {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [state, dispatch] = useReducer(reduceBrowserState, INITIAL_BROWSER_STATE);
  const {
    serverId,
    available,
    assignmentsSupported,
    hostOptions,
    display,
    repositories,
    work,
    repositoryItems,
    workItems,
    availabilityMessage,
  } = useBrowserData(state);
  const closeSelection = useCallback(() => dispatch({ type: "close" }), []);
  const selectHost = useCallback(
    (id: string, selected: { label: string }) =>
      dispatch({ type: "host", host: { serverId: id, label: selected.label } }),
    [],
  );
  const searchRepositories = useCallback(
    (site: string, query: string) => dispatch({ type: "repository-search", site, query }),
    [],
  );
  const searchWork = useCallback(
    (_site: string, query: string) => dispatch({ type: "work-search", query }),
    [],
  );
  const clearRepository = useCallback(() => dispatch({ type: "repository", repository: null }), []);
  const createAssignment = useCallback(() => dispatch({ type: "create" }), []);
  const saved = useCallback((savedServerId: string, assignment: AssignmentDto) => {
    dispatch({ type: "close" });
    router.push(buildAssignmentRoute(savedServerId, assignment.id) as Href);
  }, []);

  return (
    <View style={styles.container} testID="github-work-screen">
      <MenuHeader title={t("githubWork.title")} />
      <View style={styles.hostBar}>
        <SelectField
          label={t("githubWork.host")}
          value={state.host?.serverId ?? null}
          selectedDisplay={display}
          options={hostOptions}
          onChange={selectHost}
          placeholder={t("githubWork.selectHost")}
          emptyText={t("githubWork.noHosts")}
          size={compact ? "md" : "sm"}
          testID="github-work-host-field"
        />
      </View>
      {availabilityMessage ? (
        <Text style={styles.empty} testID="github-work-unavailable">
          {availabilityMessage}
        </Text>
      ) : (
        <View style={compact ? styles.compactBody : styles.desktopBody}>
          {!compact || !state.repository ? (
            <ScrollView
              style={compact ? styles.pane : styles.repositoryPane}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
            >
              <SearchFields
                key={serverId}
                site={state.site}
                query={state.repositoryQuery}
                onSearch={searchRepositories}
              />
              <QueryStatus
                query={repositories}
                empty={repositoryItems.length === 0}
                emptyLabel={t("githubWork.noRepositories")}
              >
                {repositoryItems.map((repository) => (
                  <RepositoryRow
                    key={repository.id}
                    repository={repository}
                    selected={repository.id === state.repository?.id}
                    dispatch={dispatch}
                  />
                ))}
              </QueryStatus>
            </ScrollView>
          ) : null}
          {!compact || state.repository ? (
            <ScrollView
              style={styles.pane}
              contentContainerStyle={styles.workContent}
              keyboardShouldPersistTaps="handled"
            >
              {state.repository ? (
                <>
                  {compact ? (
                    <Button
                      variant="ghost"
                      leftIcon={ChevronLeft}
                      onPress={clearRepository}
                      testID="github-work-back"
                    >
                      {t("githubWork.repositories")}
                    </Button>
                  ) : null}
                  <Text style={styles.heading} testID="github-work-repository-title">
                    {state.repository.fullName}
                  </Text>
                  <Text style={styles.meta}>
                    {state.host?.label} · GitHub · {state.repository.host}
                  </Text>
                  <WorkFilters state={state} dispatch={dispatch} />
                  <SearchFields
                    key={`${serverId}:${state.repository.id}`}
                    query={state.workQuery}
                    onSearch={searchWork}
                  />
                  <QueryStatus
                    query={work}
                    empty={workItems.length === 0}
                    emptyLabel={t("githubWork.noWork")}
                  >
                    {workItems.map((item) => (
                      <WorkRow key={item.id} item={item} dispatch={dispatch} />
                    ))}
                  </QueryStatus>
                </>
              ) : (
                <Text style={styles.empty}>{t("githubWork.selectRepository")}</Text>
              )}
            </ScrollView>
          ) : null}
        </View>
      )}
      <BrowserSelection
        state={state}
        available={available}
        assignmentsSupported={assignmentsSupported}
        onClose={closeSelection}
        onCreate={createAssignment}
        onSaved={saved}
      />
    </View>
  );
}

interface BrowserSelectionProps {
  state: BrowserState;
  available: boolean;
  assignmentsSupported: boolean;
  onClose: () => void;
  onCreate: () => void;
  onSaved: (serverId: string, assignment: AssignmentDto) => void;
}

function BrowserSelection({
  state,
  available,
  assignmentsSupported,
  onClose: closeSelection,
  onCreate: createAssignment,
  onSaved: saved,
}: BrowserSelectionProps) {
  const serverId = state.host?.serverId ?? "";
  const assignmentHosts = useMemo(() => (state.host ? [state.host] : []), [state.host]);
  const reference = state.selection
    ? repositoryWorkToAssignmentReference(state.selection.item)
    : null;

  return (
    <>
      {available && state.selection?.kind === "preview" && state.repository ? (
        <WorkPreviewSheet
          item={state.selection.item}
          repository={state.repository}
          hostLabel={state.host?.label ?? serverId}
          canCreate={assignmentsSupported}
          onClose={closeSelection}
          onCreate={createAssignment}
        />
      ) : null}
      {state.selection?.kind === "create" && reference ? (
        <AssignmentFormSheet
          mode="create"
          hosts={assignmentHosts}
          selectedServerId={serverId}
          initialWorkItem={reference}
          authoringEnabled={available && assignmentsSupported}
          onClose={closeSelection}
          onSaved={saved}
        />
      ) : null}
    </>
  );
}

function useBrowserData(state: BrowserState) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverId = state.host?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const connection = useHostRuntimeConnectionStatus(serverId);
  const supported = useSessionStore(
    (store) =>
      store.sessions[serverId]?.serverInfo?.features?.forgeRepositoryDiscovery?.includes(
        "github",
      ) === true,
  );
  const assignmentsSupported = useHostFeature(serverId, "assignments");
  const hostExists = hosts.some((host) => host.serverId === serverId);
  const available = hostExists && connection === "online" && supported;
  const hostOptions = useMemo(
    () =>
      hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label || host.serverId,
        testID: `github-work-host-${host.serverId}`,
      })),
    [hosts],
  );
  const display = useMemo(() => (state.host ? { label: state.host.label } : null), [state.host]);
  const repositories = useFetchInfiniteQuery({
    ...repositoryQueryOptions({
      client,
      serverId,
      site: state.site,
      query: state.repositoryQuery,
      enabled: available,
    }),
    dataShape: "list",
    staleTimeMs: 30_000,
  });
  const work = useFetchInfiniteQuery({
    ...workQueryOptions({
      client,
      serverId,
      repository: state.repository,
      query: state.workQuery,
      kind: state.kind,
      state: state.workState,
      enabled: available,
    }),
    dataShape: "list",
    staleTimeMs: 30_000,
  });
  const repositoryItems = useMemo(() => {
    const items = repositories.data?.pages.flatMap((page) => page.items) ?? [];
    return [...new Map(items.map((item) => [item.id, item])).values()];
  }, [repositories.data]);
  const workItems = useMemo(() => {
    const items = work.data?.pages.flatMap((page) => page.items) ?? [];
    return [...new Map(items.map((item) => [item.id, item])).values()];
  }, [work.data]);

  let availabilityMessage: string | null = null;
  if (!hostExists) availabilityMessage = t("githubWork.selectHost");
  else if (connection !== "online") availabilityMessage = t("githubWork.hostOffline");
  else if (!supported) availabilityMessage = t("githubWork.updateHost");

  return {
    serverId,
    available,
    assignmentsSupported,
    hostOptions,
    display,
    repositories,
    work,
    repositoryItems,
    workItems,
    availabilityMessage,
  };
}

interface SearchFieldsProps {
  site?: string;
  query: string;
  onSearch: (site: string, query: string) => void;
}

function SearchFields(props: SearchFieldsProps): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [draft, edit] = useReducer(
    (
      current: { site: string; query: string },
      patch: Partial<{ site: string; query: string }>,
    ) => ({ ...current, ...patch }),
    { site: props.site ?? "github.com", query: props.query },
  );
  const validSite = normalizeGitHubSite(draft.site) !== null;
  const { onSearch } = props;
  const submit = useCallback(() => {
    if (validSite) onSearch(draft.site, draft.query);
  }, [validSite, onSearch, draft.site, draft.query]);
  const editSite = useCallback((site: string) => edit({ site }), []);
  const editQuery = useCallback((query: string) => edit({ query }), []);
  const scope = props.site === undefined ? "work" : "repositories";
  return (
    <View style={styles.fields}>
      {props.site !== undefined ? (
        <Field label={t("githubWork.site")} error={!validSite ? t("githubWork.invalidSite") : null}>
          <FormTextInput
            initialValue={props.site}
            onChangeText={editSite}
            maxLength={253}
            autoCapitalize="none"
            autoCorrect={false}
            size={size}
            accessibilityLabel={t("githubWork.site")}
            testID="github-work-site"
          />
        </Field>
      ) : null}
      <Field
        label={t(scope === "work" ? "githubWork.searchWork" : "githubWork.searchRepositories")}
      >
        <FormTextInput
          initialValue={props.query}
          onChangeText={editQuery}
          onSubmitEditing={submit}
          maxLength={512}
          size={size}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("common.actions.search")}
          testID={`github-work-${scope}-search`}
        />
      </Field>
      <Button
        variant="secondary"
        size={size}
        leftIcon={Search}
        onPress={submit}
        disabled={!validSite}
        testID={`github-work-${scope}-submit`}
      >
        {t("common.actions.search")}
      </Button>
    </View>
  );
}

function WorkFilters({
  state,
  dispatch,
}: {
  state: BrowserState;
  dispatch: Dispatch<BrowserAction>;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const selectKind = useCallback(
    (kind: BrowserState["kind"]) => dispatch({ type: "kind", kind }),
    [dispatch],
  );
  const selectState = useCallback(
    (workState: BrowserState["workState"]) => dispatch({ type: "work-state", workState }),
    [dispatch],
  );
  const kinds = useMemo(
    () => [
      { value: "issue" as const, label: t("githubWork.issues"), testID: "github-work-issues" },
      {
        value: "change_request" as const,
        label: t("githubWork.pullRequests"),
        testID: "github-work-pull-requests",
      },
    ],
    [t],
  );
  const states = useMemo(
    () => [
      { value: "open" as const, label: t("githubWork.open"), testID: "github-work-open" },
      { value: "closed" as const, label: t("githubWork.closed"), testID: "github-work-closed" },
      { value: "all" as const, label: t("githubWork.all"), testID: "github-work-all" },
    ],
    [t],
  );
  return (
    <View style={styles.filters}>
      <SegmentedControl value={state.kind} onValueChange={selectKind} size={size} options={kinds} />
      <SegmentedControl
        value={state.workState}
        onValueChange={selectState}
        size={size}
        options={states}
      />
    </View>
  );
}

interface QueryStatusProps {
  query: {
    isPending: boolean;
    isFetching: boolean;
    isFetchNextPageError: boolean;
    error: Error | null;
    hasNextPage: boolean;
    refetch: () => Promise<unknown>;
    fetchNextPage: () => Promise<unknown>;
  };
  empty: boolean;
  emptyLabel: string;
  children: ReactNode;
}

function QueryStatus({ query, empty, emptyLabel, children }: QueryStatusProps): ReactElement {
  const { t } = useTranslation();
  const { isFetchNextPageError, fetchNextPage, refetch } = query;
  const retry = useCallback(() => {
    void (isFetchNextPageError ? fetchNextPage() : refetch());
  }, [isFetchNextPageError, fetchNextPage, refetch]);
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  return (
    <View style={styles.fields}>
      {query.error ? (
        <Alert
          variant="error"
          title={t("githubWork.loadFailed")}
          description={toErrorMessage(query.error)}
          testID="github-work-error"
        >
          <Button variant="outline" size="sm" onPress={retry} loading={query.isFetching}>
            {t("common.actions.retry")}
          </Button>
        </Alert>
      ) : null}
      {query.isPending && !query.error ? <LoadingSpinner color={styles.meta.color} /> : null}
      {!query.isPending && !query.error && empty ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : null}
      {children}
      <View style={styles.filters}>
        {query.hasNextPage ? (
          <Button
            variant="ghost"
            disabled={query.isFetching}
            onPress={loadMore}
            testID="github-work-load-more"
          >
            {t("githubWork.loadMore")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={RefreshCw}
          loading={query.isFetching}
          disabled={query.isFetching}
          onPress={refresh}
          accessibilityLabel={t("githubWork.refresh")}
          testID="github-work-refresh"
        />
      </View>
    </View>
  );
}

function rowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, (hovered || pressed) && styles.selectedRow];
}

function RepositoryRow({
  repository,
  selected,
  dispatch,
}: {
  repository: Repository;
  selected: boolean;
  dispatch: Dispatch<BrowserAction>;
}): ReactElement {
  const { t } = useTranslation();
  const onPress = useCallback(
    () => dispatch({ type: "repository", repository }),
    [dispatch, repository],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const selectedStyle = useCallback(
    (press: PressableStateCallbackType & { hovered?: boolean }) => [
      rowStyle(press),
      selected && styles.selectedRow,
    ],
    [selected],
  );
  return (
    <Pressable
      onPress={onPress}
      style={selectedStyle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID={`github-work-repository-${repository.id}`}
    >
      <View style={styles.rowBody}>
        <Text style={styles.text}>{repository.fullName}</Text>
        <Text style={styles.meta}>
          {repository.visibility}
          {repository.archived ? ` · ${t("githubWork.archived")}` : ""}
        </Text>
      </View>
      <ChevronRight size={16} color={styles.meta.color} />
    </Pressable>
  );
}

function WorkRow({
  item,
  dispatch,
}: {
  item: RepositoryWorkItem;
  dispatch: Dispatch<BrowserAction>;
}): ReactElement {
  const onPress = useCallback(() => dispatch({ type: "preview", item }), [dispatch, item]);
  return (
    <Pressable
      onPress={onPress}
      style={rowStyle}
      accessibilityRole="button"
      testID={`github-work-item-${item.id}`}
    >
      <View style={styles.rowBody}>
        <Text style={styles.text}>{item.title}</Text>
        <Text style={styles.meta}>
          #{item.number} · {item.state}
        </Text>
      </View>
      <ChevronRight size={16} color={styles.meta.color} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  hostBar: { padding: theme.spacing[4], maxWidth: 720, width: "100%", alignSelf: "center" },
  desktopBody: { flex: 1, flexDirection: "row" },
  compactBody: { flex: 1 },
  repositoryPane: { width: 320, backgroundColor: theme.colors.surfaceSidebar },
  pane: { flex: 1 },
  listContent: { padding: theme.spacing[4], gap: theme.spacing[4] },
  workContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  fields: { gap: theme.spacing[3] },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], alignItems: "center" },
  row: {
    flexDirection: "row",
    gap: theme.spacing[2],
    alignItems: "center",
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  rowBody: { flex: 1, gap: theme.spacing[1], minWidth: 0 },
  selectedRow: { backgroundColor: theme.colors.surfaceSidebarHover },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  empty: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
