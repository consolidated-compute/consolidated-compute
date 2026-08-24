import { useIsFocused } from "@react-navigation/native";
import { ChevronRight, RefreshCw } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon, type ProviderIconProps } from "@/components/provider-icons";
import { MenuHeader } from "@/components/headers/menu-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { resolveOperationsAvailability, shouldShowUnavailableHostsAlert } from "../screen-state";
import { useOperationsData } from "../use-operations-data";
import {
  buildVisualTopology,
  type VisualNode,
  type VisualProjectRegion,
  type VisualRect,
  type VisualTopology,
  type VisualWorkspaceRegion,
} from "./topology";
import { fitVisualRectToWidth, resolveVisualLayoutMode } from "./viewport";

function ProviderGlyph({ provider, size, color }: ProviderIconProps & { provider: string }) {
  const ProviderIcon = getProviderIcon(provider);
  return <ProviderIcon size={size} color={color} />;
}

const ThemedProviderGlyph = withUnistyles(ProviderGlyph, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));
const ThemedChevronRight = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function statusDotStyle(state: VisualNode["state"]): StyleProp<ViewStyle> {
  switch (state) {
    case "needs_input":
      return [styles.statusDot, styles.statusDotNeedsInput];
    case "failed":
      return [styles.statusDot, styles.statusDotFailed];
    case "running":
      return [styles.statusDot, styles.statusDotRunning];
    case "attention":
      return [styles.statusDot, styles.statusDotAttention];
    case "done":
      return [styles.statusDot, styles.statusDotDone];
  }
}

function positionedRect(rect: VisualRect): ViewStyle {
  return {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function interactiveNodeStyle(
  rect: VisualRect,
  state: PressableStateCallbackType & { hovered?: boolean },
): StyleProp<ViewStyle> {
  return [
    styles.node,
    positionedRect(rect),
    state.hovered && styles.nodeHovered,
    state.pressed && styles.pressed,
  ];
}

function interactiveWorkspaceHeaderStyle(
  state: PressableStateCallbackType & { hovered?: boolean },
): StyleProp<ViewStyle> {
  return [
    styles.workspaceHeader,
    state.hovered && styles.workspaceHeaderHovered,
    state.pressed && styles.pressed,
  ];
}

function displayProjectName(
  project: VisualProjectRegion,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return project.name === "Other work" ? t("operations.otherWork") : project.name;
}

function displayWorkspaceName(
  workspace: VisualWorkspaceRegion,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (workspace.kind === "unavailable" && workspace.name === "Unavailable workspace") {
    return t("operations.unavailableWorkspace");
  }
  if (workspace.kind === "unassigned" && workspace.name === "Other work") {
    return t("operations.otherWork");
  }
  return workspace.title;
}

function VisualProject({
  project,
  rect,
}: {
  project: VisualProjectRegion;
  rect: VisualRect;
}): ReactElement {
  const { t } = useTranslation();
  const name = displayProjectName(project, t);
  return (
    <View
      accessible
      accessibilityLabel={t("visual.projectRegion", { project: name })}
      pointerEvents="none"
      style={[styles.project, positionedRect(rect)]}
      testID={`visual-project-${encodeURIComponent(project.projectKey)}`}
    >
      <Text accessibilityRole="header" numberOfLines={1} style={styles.projectTitle}>
        {name}
      </Text>
    </View>
  );
}

function VisualWorkspace({
  workspace,
  rect,
}: {
  workspace: VisualWorkspaceRegion;
  rect: VisualRect;
}): ReactElement {
  const { t } = useTranslation();
  const title = displayWorkspaceName(workspace, t);
  const state = workspace.directoryState ?? workspace.liveMostUrgentState ?? "done";
  const stateLabel = t(`operations.states.${state}`);
  const metadata = [
    workspace.serverName,
    stateLabel,
    workspace.isLastKnown ? t("operations.lastKnown") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const content = (
    <>
      <View style={statusDotStyle(state)} testID={`visual-workspace-state-${state}`} />
      <View style={styles.workspaceHeaderBody}>
        <Text numberOfLines={1} style={styles.workspaceTitle}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.workspaceMeta}>
          {metadata}
        </Text>
      </View>
      {workspace.workspaceId ? <ThemedChevronRight size={14} /> : null}
    </>
  );
  const accessibilityLabel = t("visual.workspaceRegion", {
    workspace: title,
    host: workspace.serverName,
    state: stateLabel,
  });
  const openWorkspace = useCallback(() => {
    if (!workspace.workspaceId) return;
    navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
  }, [workspace.serverId, workspace.workspaceId]);

  return (
    <View
      style={[styles.workspace, positionedRect(rect)]}
      testID={`visual-workspace-${workspace.serverId}-${workspace.workspaceId ?? workspace.kind}`}
    >
      {workspace.workspaceId ? (
        <Pressable
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          onPress={openWorkspace}
          style={interactiveWorkspaceHeaderStyle}
        >
          {content}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={accessibilityLabel} style={styles.workspaceHeader}>
          {content}
        </View>
      )}
    </View>
  );
}

function NodeContent({ node }: { node: VisualNode }): ReactElement {
  const { t } = useTranslation();
  const stateLabel = t(`operations.states.${node.state}`);
  const kindLabel =
    node.kind === "managed" ? t("visual.managedAgent") : t("operations.providerSubagent");
  const metadata = [stateLabel, kindLabel, node.isLastKnown ? t("operations.lastKnown") : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <>
      <View style={styles.nodeLeading}>
        <View style={statusDotStyle(node.state)} testID={`visual-node-state-${node.state}`} />
        <ThemedProviderGlyph provider={node.provider} />
      </View>
      <View style={styles.nodeBody}>
        <Text numberOfLines={1} style={styles.nodeTitle}>
          {node.title}
        </Text>
        <Text numberOfLines={1} style={styles.nodeMeta}>
          {metadata}
        </Text>
      </View>
      {node.kind === "managed" ? <ThemedChevronRight size={14} /> : null}
    </>
  );
}

function VisualComputeNode({
  node,
  rect,
  workspace,
}: {
  node: VisualNode;
  rect: VisualRect;
  workspace: VisualWorkspaceRegion | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const stateLabel = t(`operations.states.${node.state}`);
  const lastKnown = node.isLastKnown ? `. ${t("operations.lastKnown")}` : "";
  const managedAgentId = node.kind === "managed" ? node.agentId : "";
  const openAgent = useCallback(() => {
    if (!managedAgentId) return;
    navigateToAgent({
      serverId: node.serverId,
      agentId: managedAgentId,
      workspaceId: workspace?.workspaceId ?? undefined,
      pin: true,
    });
  }, [managedAgentId, node.serverId, workspace?.workspaceId]);
  const nodeStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) =>
      interactiveNodeStyle(rect, state),
    [rect],
  );

  if (node.kind === "provider") {
    return (
      <View
        accessible
        accessibilityLabel={`${node.title}. ${t("operations.providerSubagent")}. ${stateLabel}${lastKnown}`}
        style={[styles.node, styles.providerNode, positionedRect(rect)]}
        testID={`visual-provider-subagent-${node.serverId}-${node.parentAgentId}-${node.subagentId}`}
      >
        <NodeContent node={node} />
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={`${t("operations.actions.openAgent", { agent: node.title })}. ${stateLabel}${lastKnown}`}
      accessibilityRole="button"
      onPress={openAgent}
      style={nodeStyle}
      testID={`visual-agent-${node.serverId}-${node.agentId}`}
    >
      <NodeContent node={node} />
    </Pressable>
  );
}

function fitRect(rect: VisualRect, topology: VisualTopology, viewportWidth: number): VisualRect {
  return fitVisualRectToWidth(rect, {
    sceneWidth: topology.bounds.width,
    viewportWidth,
  });
}

function VisualScene({
  topology,
  viewportWidth,
}: {
  topology: VisualTopology;
  viewportWidth: number;
}): ReactElement {
  const workspaceByKey = useMemo(
    () => new Map(topology.workspaces.map((workspace) => [workspace.key, workspace] as const)),
    [topology.workspaces],
  );
  return (
    <View
      style={[styles.scene, { width: viewportWidth, height: topology.bounds.height }]}
      testID={`visual-layout-${topology.mode}`}
    >
      {topology.projects.map((project) => (
        <VisualProject
          key={project.key}
          project={project}
          rect={fitRect(project.rect, topology, viewportWidth)}
        />
      ))}
      {topology.workspaces.map((workspace) => (
        <VisualWorkspace
          key={workspace.key}
          workspace={workspace}
          rect={fitRect(workspace.rect, topology, viewportWidth)}
        />
      ))}
      {topology.nodes.map((node) => (
        <VisualComputeNode
          key={node.key}
          node={node}
          rect={fitRect(node.rect, topology, viewportWidth)}
          workspace={workspaceByKey.get(node.workspaceRegionKey)}
        />
      ))}
    </View>
  );
}

export function VisualScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <VisualScreenContent />;
}

function VisualScreenContent(): ReactElement {
  const { t } = useTranslation();
  const operations = useOperationsData();
  const availability = useMemo(() => resolveOperationsAvailability(operations), [operations]);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [didManualRefreshFail, setDidManualRefreshFail] = useState(false);
  const isRefreshing = isManualRefresh || operations.isRevalidating;
  const layoutMode = resolveVisualLayoutMode(viewportWidth);
  const topology = useMemo(
    () => buildVisualTopology(operations, layoutMode),
    [layoutMode, operations],
  );
  const measureViewport = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    setViewportWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);
  const refresh = useCallback(() => {
    setDidManualRefreshFail(false);
    setIsManualRefresh(true);
    void operations
      .refreshAll()
      .catch(() => setDidManualRefreshFail(true))
      .finally(() => setIsManualRefresh(false));
  }, [operations]);
  const headerAction = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={RefreshCw}
        onPress={refresh}
        loading={isRefreshing}
        testID="visual-refresh"
      >
        {t("operations.actions.refresh")}
      </Button>
    ),
    [isRefreshing, refresh, t],
  );

  let body: ReactElement;
  if (availability.body.kind === "initial_loading") {
    body = (
      <View style={styles.centered} testID="visual-initial-loading">
        <ThemedLoadingSpinner size="large" />
      </View>
    );
  } else if (availability.body.kind === "all_hosts_unavailable") {
    body = (
      <View style={styles.centered} testID="visual-unavailable-empty">
        <Text style={styles.emptyTitle}>{t("operations.availability.allUnavailable")}</Text>
        <Text style={styles.emptyText}>{t("operations.availability.noData")}</Text>
        <Button variant="ghost" onPress={refresh} loading={isRefreshing}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  } else if (availability.body.kind === "empty") {
    body = (
      <View style={styles.centered} testID="visual-empty">
        <Text style={styles.emptyTitle}>{t("operations.empty")}</Text>
        <Text style={styles.emptyText}>{t("operations.emptyDescription")}</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} testID="visual-scroll">
        <View
          onLayout={measureViewport}
          style={[styles.viewport, { minHeight: topology.bounds.height }]}
          testID="visual-viewport"
        >
          {viewportWidth > 0 ? (
            <VisualScene topology={topology} viewportWidth={viewportWidth} />
          ) : null}
        </View>
      </ScrollView>
    );
  }

  const showUpdating = operations.isRevalidating || availability.isPartiallyLoading;
  const showUnavailable = shouldShowUnavailableHostsAlert(availability);
  const showProviderUnavailable = availability.providerSubagentIssueHosts.length > 0;
  return (
    <View style={styles.container} testID="visual-screen">
      <MenuHeader title={t("visual.title")} rightContent={headerAction} />
      {didManualRefreshFail || showUpdating || showUnavailable || showProviderUnavailable ? (
        <View style={styles.statusAlerts}>
          {didManualRefreshFail ? (
            <Alert
              variant="error"
              title={t("visual.availability.refreshFailed")}
              testID="visual-refresh-failed"
            />
          ) : null}
          {showUpdating ? (
            <Alert
              variant="info"
              title={t("visual.availability.updating")}
              testID="visual-revalidating"
            />
          ) : null}
          {showUnavailable ? (
            <Alert
              variant={availability.areAllHostsUnavailable ? "error" : "warning"}
              title={t(
                availability.areAllHostsUnavailable
                  ? "operations.availability.allUnavailable"
                  : "operations.availability.partial",
              )}
              testID="visual-partial-hosts"
            />
          ) : null}
          {showProviderUnavailable ? (
            <Alert
              variant="warning"
              title={t("operations.availability.providerSubagentsPartial")}
              testID="visual-provider-subagents-partial"
            />
          ) : null}
        </View>
      ) : null}
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  viewport: {
    width: "100%",
  },
  scene: {
    position: "relative",
  },
  project: {
    position: "absolute",
    zIndex: 0,
    overflow: "hidden",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
  },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  workspace: {
    position: "absolute",
    zIndex: 1,
    overflow: "hidden",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  workspaceHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  workspaceHeaderHovered: {
    backgroundColor: theme.colors.surface3,
  },
  workspaceHeaderBody: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  workspaceTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  workspaceMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  node: {
    position: "absolute",
    zIndex: 2,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    overflow: "hidden",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  providerNode: {
    borderStyle: "dashed",
  },
  nodeHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface4,
  },
  pressed: {
    opacity: 0.8,
  },
  nodeLeading: {
    width: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  nodeBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  nodeTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  nodeMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  statusDotNeedsInput: {
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
  },
  statusDotFailed: {
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  statusDotRunning: {
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
  },
  statusDotAttention: {
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  statusDotDone: {
    backgroundColor:
      getStatusDotColor({ theme, bucket: "done", showDoneAsInactive: true }) ??
      theme.colors.foregroundExtraMuted,
  },
  statusAlerts: {
    width: "100%",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
    gap: theme.spacing[3],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
