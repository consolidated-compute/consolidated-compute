import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Link2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { AssignmentWorkItemReferenceDto } from "@getpaseo/protocol/assignment/types";
import type { PluginAttachmentItem, PluginAttachmentSourceContribution } from "@getpaseo/plugin";
import { searchPluginAttachments } from "@getpaseo/plugin/host";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { getForgePresentation } from "@/git/forge";
import { useForgeSearchQuery } from "@/git/use-forge-search-query";
import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useHostWorkspaces } from "@/stores/session-store-hooks";
import {
  forgeSearchItemToWorkItem,
  pluginAttachmentItemToWorkItem,
  resolveWorkItemSearchSnapshot,
} from "./work-item";

type WorkItemSource =
  | {
      kind: "forge";
      id: string;
      label: string;
      description: string;
      cwd: string;
    }
  | {
      kind: "plugin";
      id: string;
      label: string;
      description: string;
      plugin: InstalledPlugin;
      source: PluginAttachmentSourceContribution;
    };

interface WorkItemResult {
  id: string;
  label: string;
  description?: string;
  workItem: AssignmentWorkItemReferenceDto;
}

function sourceOptions(sources: readonly WorkItemSource[]): SelectFieldOption<string>[] {
  return sources.map((source) => ({
    id: source.id,
    value: source.id,
    label: source.label,
    description: source.description,
    testID: `assignment-work-item-source-${source.id}`,
  }));
}

function forgeResults(items: readonly ForgeSearchItem[]): WorkItemResult[] {
  return items.map((item) => {
    const workItem = forgeSearchItemToWorkItem(item);
    return {
      id: `${workItem.sourceId}:${workItem.resourceId}`,
      label: `${workItem.identifier} ${workItem.title}`,
      description: getForgePresentation(item.forge ?? "github").brandLabel,
      workItem,
    };
  });
}

function pluginResults(
  source: Extract<WorkItemSource, { kind: "plugin" }> | null,
  items: readonly PluginAttachmentItem[],
): WorkItemResult[] {
  if (!source) return [];
  return items.map((item) => ({
    id: `${source.plugin.id}:${source.source.id}:${item.id}`,
    label: `${item.identifier} ${item.title}`,
    description: item.subtitle,
    workItem: pluginAttachmentItemToWorkItem(
      source.plugin.id,
      source.source.id,
      source.source.title,
      item,
    ),
  }));
}

function buildSources(
  serverId: string,
  workspaces: ReturnType<typeof useHostWorkspaces>,
  plugins: readonly InstalledPlugin[],
): WorkItemSource[] {
  const forgeSources: WorkItemSource[] = workspaces
    .filter((workspace) => workspace.archivingAt === null)
    .map((workspace) => ({
      kind: "forge" as const,
      id: `forge:${workspace.id}`,
      label: workspace.title ?? workspace.name,
      description: workspace.projectDisplayName,
      cwd: workspace.workspaceDirectory,
    }));
  const pluginSources: WorkItemSource[] = plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) =>
      plugin.attachmentSources.map((source) => ({
        kind: "plugin" as const,
        id: `plugin:${plugin.id}:${source.id}`,
        label: source.title,
        description: plugin.id,
        plugin,
        source,
      })),
    );
  return [...forgeSources, ...pluginSources];
}

function useWorkItemPicker(serverId: string) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const workspaces = useHostWorkspaces(serverId);
  const plugins = useInstalledPlugins();
  const supportsForgeSearch = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.forgeSearch === true,
  );
  const sources = useMemo(
    () => buildSources(serverId, workspaces, plugins),
    [plugins, serverId, workspaces],
  );
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(() =>
    sources.length === 1 ? sources[0]!.id : null,
  );
  const [query, setQuery] = useState("");
  const activeSource = sources.find((source) => source.id === selectedSourceId) ?? null;
  const activeForge = activeSource?.kind === "forge" ? activeSource : null;
  const activePlugin = activeSource?.kind === "plugin" ? activeSource : null;
  const trimmedQuery = query.trim();
  const forgeQuery = useForgeSearchQuery({
    client,
    serverId,
    cwd: activeForge?.cwd ?? "",
    query: trimmedQuery,
    supportsForgeSearch,
    enabled: connected && activeForge !== null,
  });
  const pluginQuery = useFetchQuery(
    {
      queryKey: [
        "assignment-work-item-plugin-search",
        serverId,
        activePlugin?.plugin.id ?? "",
        activePlugin?.source.id ?? "",
        trimmedQuery,
      ],
      dataShape: "list" as const,
      staleTimeMs: 30_000,
      enabled: connected && activePlugin !== null,
      queryFn: async () => {
        if (!client || !activePlugin) throw new Error("Plugin host is offline");
        return searchPluginAttachments(
          activePlugin.source,
          (method, input) => client.invokePluginRpc(activePlugin.plugin.id, method, input),
          trimmedQuery,
        );
      },
    },
    activePlugin?.plugin.queryClient,
  );
  const results = useMemo(
    () =>
      activeForge
        ? forgeResults(forgeQuery.data?.items ?? [])
        : pluginResults(activePlugin, pluginQuery.data?.items ?? []),
    [activeForge, activePlugin, forgeQuery.data?.items, pluginQuery.data?.items],
  );
  const options = useMemo(() => sourceOptions(sources), [sources]);
  const sourceDisplay = useMemo(
    () =>
      activeSource ? { label: activeSource.label, description: activeSource.description } : null,
    [activeSource],
  );
  const selectSource = useCallback((sourceId: string) => {
    setSelectedSourceId(sourceId);
    setQuery("");
  }, []);
  const searchSnapshot = resolveWorkItemSearchSnapshot({
    useForge: activeForge !== null,
    forge: forgeQuery,
    plugin: pluginQuery,
    forgeSetupError: t("workspace.git.forgeSetup.generic", { brand: "Forge" }),
  });
  return {
    activeSource,
    connected,
    error: searchSnapshot.error,
    loading: searchSnapshot.isFetching,
    options,
    pluginSearchPlaceholder: activePlugin?.source.searchPlaceholder ?? null,
    query,
    results,
    selectedSourceId,
    selectSource,
    setQuery,
    sourceDisplay,
  };
}

export function AssignmentWorkItemPickerSheet({
  serverId,
  onClose,
  onSelect,
}: {
  serverId: string;
  onClose: () => void;
  onSelect: (workItem: AssignmentWorkItemReferenceDto) => void;
}): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const picker = useWorkItemPicker(serverId);
  const selectResult = useCallback(
    (workItem: AssignmentWorkItemReferenceDto) => {
      onSelect(workItem);
      onClose();
    },
    [onClose, onSelect],
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: t("assignments.workItem.pickerTitle") }),
    [t],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={680}
      snapPoints={["85%"]}
      testID="assignment-work-item-picker"
    >
      <View style={styles.body}>
        <SelectField
          label={t("assignments.workItem.source")}
          value={picker.selectedSourceId}
          selectedDisplay={picker.sourceDisplay}
          options={picker.options}
          onChange={picker.selectSource}
          placeholder={t("assignments.workItem.selectSource")}
          emptyText={t("assignments.workItem.noSources")}
          disabled={!picker.connected}
          size={controlSize}
          testID="assignment-work-item-source"
        />
        <Field label={t("assignments.workItem.search")}>
          <FormTextInput
            initialValue={picker.query}
            resetKey={picker.selectedSourceId ?? "none"}
            onChangeText={picker.setQuery}
            placeholder={
              picker.pluginSearchPlaceholder ?? t("assignments.workItem.searchPlaceholder")
            }
            editable={picker.activeSource !== null && picker.connected}
            size={controlSize}
            accessibilityLabel={t("assignments.workItem.search")}
            testID="assignment-work-item-search"
          />
        </Field>
        {picker.error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {picker.error instanceof Error ? picker.error.message : String(picker.error)}
          </Text>
        ) : null}
        <View style={styles.results} testID="assignment-work-item-results">
          {picker.results.map((result) => (
            <WorkItemResultRow key={result.id} result={result} onSelect={selectResult} />
          ))}
          {picker.activeSource &&
          !picker.loading &&
          !picker.error &&
          picker.results.length === 0 ? (
            <Text style={styles.empty}>{t("assignments.workItem.noResults")}</Text>
          ) : null}
          {picker.loading ? (
            <Text style={styles.empty}>{t("assignments.workItem.searching")}</Text>
          ) : null}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function WorkItemResultRow({
  result,
  onSelect,
}: {
  result: WorkItemResult;
  onSelect: (workItem: AssignmentWorkItemReferenceDto) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(result.workItem), [onSelect, result.workItem]);
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.result,
      (pressed || hovered) && styles.resultHovered,
    ],
    [],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={result.label}
      testID={`assignment-work-item-result-${encodeURIComponent(result.id)}`}
    >
      <Link2 size={16} color={styles.icon.color} />
      <View style={styles.resultText}>
        <Text style={styles.resultTitle}>{result.label}</Text>
        {result.description ? <Text style={styles.resultMeta}>{result.description}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[6], gap: theme.spacing[6] },
  results: { gap: theme.spacing[2] },
  result: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  resultHovered: { backgroundColor: theme.colors.surface2 },
  resultText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  resultTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  resultMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  icon: { color: theme.colors.foregroundMuted },
  empty: { color: theme.colors.foregroundMuted, textAlign: "center", padding: theme.spacing[4] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
