import { useIsFocused } from "@react-navigation/native";
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  GitBranch,
  MessageCircleQuestion,
  Network,
  RefreshCcw,
  RefreshCw,
  Unlink,
  XCircle,
} from "lucide-react-native";
import { Fragment, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon, type ProviderIconProps } from "@/components/provider-icons";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { OperationsAvailabilityAlerts } from "../availability-alerts";
import { resolveOperationsAvailability } from "../screen-state";
import { useOperationsData } from "../use-operations-data";
import {
  buildVisualTopology,
  type VisualNode,
  type VisualProjectRegion,
  type VisualRect,
  type VisualRelationship,
  type VisualTopology,
  type VisualWorkspaceRegion,
} from "./topology";
import {
  resolveVisualRelationshipPresentation,
  resolveVisualStatePresentation,
} from "./presentation";
import { fitVisualRectToWidth, resolveVisualLayoutMode } from "./viewport";
import { useVisualWorkingClock } from "./working-clock";

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
const ThemedNeedsInputGlyph = withUnistyles(MessageCircleQuestion, (theme) => ({
  color: getStatusDotColor({ theme, bucket: "needs_input" }) ?? theme.colors.foreground,
}));
const ThemedFailedGlyph = withUnistyles(XCircle, (theme) => ({
  color: getStatusDotColor({ theme, bucket: "failed" }) ?? theme.colors.foreground,
}));
const ThemedWorkingGlyph = withUnistyles(Activity, (theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? theme.colors.foreground,
}));
const ThemedAttentionGlyph = withUnistyles(Bell, (theme) => ({
  color: getStatusDotColor({ theme, bucket: "attention" }) ?? theme.colors.foreground,
}));
const ThemedDoneGlyph = withUnistyles(CheckCircle2, (theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));
const ThemedNestedGlyph = withUnistyles(GitBranch, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedProviderRelationshipGlyph = withUnistyles(Network, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedCrossWorkspaceGlyph = withUnistyles(ExternalLink, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedMissingGlyph = withUnistyles(Unlink, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedCycleGlyph = withUnistyles(RefreshCcw, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function StaticStateGlyph({ state }: { state: VisualNode["state"] }): ReactElement {
  switch (state) {
    case "needs_input":
      return <ThemedNeedsInputGlyph size={15} />;
    case "failed":
      return <ThemedFailedGlyph size={15} />;
    case "running":
      return <ThemedWorkingGlyph size={15} />;
    case "attention":
      return <ThemedAttentionGlyph size={15} />;
    case "done":
      return <ThemedDoneGlyph size={15} />;
  }
}

function AnimatedWorkingGlyph({ phase }: { phase: SharedValue<number> }): ReactElement {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + phase.value * 0.45,
    transform: [{ scale: 0.92 + phase.value * 0.08 }],
  }));
  return (
    <Animated.View style={animatedStyle} testID="visual-working-animation">
      <ThemedWorkingGlyph size={15} />
    </Animated.View>
  );
}

function VisualStateGlyph({
  state,
  canAnimate = false,
  phase = null,
  testID,
}: {
  state: VisualNode["state"];
  canAnimate?: boolean;
  phase?: SharedValue<number> | null;
  testID: string;
}): ReactElement {
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.semanticGlyph}
      testID={testID}
    >
      {state === "running" && canAnimate && phase ? (
        <AnimatedWorkingGlyph phase={phase} />
      ) : (
        <StaticStateGlyph state={state} />
      )}
    </View>
  );
}

function VisualRelationshipGlyph({
  relationship,
}: {
  relationship: VisualRelationship;
}): ReactElement {
  const { icon } = resolveVisualRelationshipPresentation(relationship.kind);
  let glyph: ReactElement;
  switch (icon) {
    case "nested":
      glyph = <ThemedNestedGlyph size={13} />;
      break;
    case "provider":
      glyph = <ThemedProviderRelationshipGlyph size={13} />;
      break;
    case "cross_workspace":
      glyph = <ThemedCrossWorkspaceGlyph size={13} />;
      break;
    case "missing":
      glyph = <ThemedMissingGlyph size={13} />;
      break;
    case "cycle":
      glyph = <ThemedCycleGlyph size={13} />;
      break;
  }
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.semanticGlyph}
    >
      {glyph}
    </View>
  );
}

function positionedRect(rect: VisualRect): ViewStyle {
  return inlineUnistylesStyle({
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

function interactiveNodeStyle(
  rect: VisualRect,
  node: VisualNode,
  state: PressableStateCallbackType & { hovered?: boolean; focused?: boolean },
): StyleProp<ViewStyle> {
  return [
    styles.node,
    positionedRect(rect),
    node.isLastKnown && styles.nodeLastKnown,
    resolveVisualStatePresentation(node).emphasis === "urgent" && styles.nodeUrgent,
    state.hovered && styles.nodeHovered,
    state.focused && styles.nodeFocused,
    state.pressed && styles.pressed,
  ];
}

function interactiveWorkspaceHeaderStyle(
  state: PressableStateCallbackType & { hovered?: boolean; focused?: boolean },
): StyleProp<ViewStyle> {
  return [
    styles.workspaceHeader,
    state.hovered && styles.workspaceHeaderHovered,
    state.focused && styles.workspaceHeaderFocused,
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

function displayVisualState(
  state: VisualNode["state"],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return state === "done" ? t("visual.states.done") : t(`operations.states.${state}`);
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
  const stateLabel = displayVisualState(state, t);
  const metadata = [
    workspace.serverName,
    stateLabel,
    workspace.isLastKnown ? t("operations.lastKnown") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const content = (
    <>
      <VisualStateGlyph state={state} testID={`visual-workspace-state-${state}`} />
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
  const accessibilityLabel = [
    t("visual.workspaceRegion", {
      workspace: title,
      host: workspace.serverName,
      state: stateLabel,
    }),
    workspace.isLastKnown ? t("operations.lastKnown") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  const openWorkspace = useCallback(() => {
    if (!workspace.workspaceId) return;
    navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
  }, [workspace.serverId, workspace.workspaceId]);

  return (
    <View
      style={[
        styles.workspace,
        positionedRect(rect),
        workspace.isLastKnown && styles.workspaceLastKnown,
      ]}
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

function visualRelationshipLabel(
  relationship: VisualRelationship | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!relationship) return null;
  const { labelKey } = resolveVisualRelationshipPresentation(relationship.kind);
  return t(labelKey, { parent: relationship.targetTitle });
}

function NodeContent({
  node,
  relationship,
  workingPhase,
  workingMotionActive,
}: {
  node: VisualNode;
  relationship: VisualRelationship | undefined;
  workingPhase: SharedValue<number>;
  workingMotionActive: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const stateLabel = displayVisualState(node.state, t);
  const kindLabel =
    node.kind === "managed" ? t("visual.managedAgent") : t("operations.providerSubagent");
  const metadata = [
    String(node.provider),
    kindLabel,
    node.isLastKnown ? t("operations.lastKnown") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const relationshipLabel = visualRelationshipLabel(relationship, t);
  const statePresentation = resolveVisualStatePresentation(node);
  return (
    <>
      <View style={styles.nodeLeading}>
        <ThemedProviderGlyph provider={node.provider} />
      </View>
      <View style={styles.nodeBody}>
        <Text numberOfLines={1} style={styles.nodeTitle}>
          {node.title}
        </Text>
        <View style={styles.nodeStateRow}>
          <VisualStateGlyph
            state={node.state}
            canAnimate={node.canAnimate && workingMotionActive}
            phase={workingPhase}
            testID={`visual-node-state-${node.state}`}
          />
          <Text
            numberOfLines={1}
            style={[
              styles.nodeState,
              statePresentation.emphasis === "urgent" && styles.nodeStateUrgent,
            ]}
          >
            {stateLabel}
          </Text>
          <Text numberOfLines={1} style={styles.nodeMeta}>
            {metadata}
          </Text>
        </View>
        {relationship && relationshipLabel ? (
          <View
            style={styles.relationshipRow}
            testID={`visual-node-relationship-${relationship.kind}`}
          >
            <VisualRelationshipGlyph relationship={relationship} />
            <Text numberOfLines={1} style={styles.relationshipText}>
              {relationshipLabel}
            </Text>
          </View>
        ) : null}
      </View>
      {node.kind === "managed" ? <ThemedChevronRight size={14} /> : null}
    </>
  );
}

function VisualComputeNode({
  node,
  rect,
  workspace,
  relationship,
  workingPhase,
  workingMotionActive,
}: {
  node: VisualNode;
  rect: VisualRect;
  workspace: VisualWorkspaceRegion | undefined;
  relationship: VisualRelationship | undefined;
  workingPhase: SharedValue<number>;
  workingMotionActive: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const stateLabel = displayVisualState(node.state, t);
  const relationshipLabel = visualRelationshipLabel(relationship, t);
  const workspaceName = workspace ? displayWorkspaceName(workspace, t) : null;
  const accessibilityLabel = [
    node.kind === "managed" ? t("operations.actions.openAgent", { agent: node.title }) : node.title,
    String(node.provider),
    stateLabel,
    workspaceName,
    workspace?.serverName ?? node.serverId,
    relationshipLabel,
    node.isLastKnown ? t("operations.lastKnown") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
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
    (state: PressableStateCallbackType & { hovered?: boolean; focused?: boolean }) =>
      interactiveNodeStyle(rect, node, state),
    [node, rect],
  );

  if (node.kind === "provider") {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.node,
          styles.providerNode,
          positionedRect(rect),
          node.isLastKnown && styles.nodeLastKnown,
          resolveVisualStatePresentation(node).emphasis === "urgent" && styles.nodeUrgent,
        ]}
        testID={`visual-provider-subagent-${node.serverId}-${node.parentAgentId}-${node.subagentId}`}
      >
        <NodeContent
          node={node}
          relationship={relationship}
          workingPhase={workingPhase}
          workingMotionActive={workingMotionActive}
        />
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={openAgent}
      style={nodeStyle}
      testID={`visual-agent-${node.serverId}-${node.agentId}`}
    >
      <NodeContent
        node={node}
        relationship={relationship}
        workingPhase={workingPhase}
        workingMotionActive={workingMotionActive}
      />
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
  const workingClock = useVisualWorkingClock(topology.nodes);
  const { workspacesByProject, nodesByWorkspace, relationshipBySource } = useMemo(() => {
    const nextWorkspacesByProject = new Map<string, VisualWorkspaceRegion[]>();
    for (const workspace of topology.workspaces) {
      const group = nextWorkspacesByProject.get(workspace.projectKey) ?? [];
      group.push(workspace);
      nextWorkspacesByProject.set(workspace.projectKey, group);
    }
    const nextNodesByWorkspace = new Map<string, VisualNode[]>();
    for (const node of topology.nodes) {
      const group = nextNodesByWorkspace.get(node.workspaceRegionKey) ?? [];
      group.push(node);
      nextNodesByWorkspace.set(node.workspaceRegionKey, group);
    }
    return {
      workspacesByProject: nextWorkspacesByProject,
      nodesByWorkspace: nextNodesByWorkspace,
      relationshipBySource: new Map(
        topology.relationships.map((relationship) => [relationship.sourceNodeKey, relationship]),
      ),
    };
  }, [topology.nodes, topology.relationships, topology.workspaces]);
  return (
    <View
      style={[
        styles.scene,
        inlineUnistylesStyle({ width: viewportWidth, height: topology.bounds.height }),
      ]}
      testID={`visual-layout-${topology.mode}`}
    >
      {topology.projects.map((project) => (
        <Fragment key={project.key}>
          <VisualProject project={project} rect={fitRect(project.rect, topology, viewportWidth)} />
          {(workspacesByProject.get(project.projectKey) ?? []).map((workspace) => (
            <Fragment key={workspace.key}>
              <VisualWorkspace
                workspace={workspace}
                rect={fitRect(workspace.rect, topology, viewportWidth)}
              />
              {(nodesByWorkspace.get(workspace.key) ?? []).map((node) => (
                <VisualComputeNode
                  key={node.key}
                  node={node}
                  rect={fitRect(node.rect, topology, viewportWidth)}
                  relationship={relationshipBySource.get(node.key)}
                  workspace={workspace}
                  workingPhase={workingClock.phase}
                  workingMotionActive={workingClock.isActive}
                />
              ))}
            </Fragment>
          ))}
        </Fragment>
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
  const { fontScale } = useWindowDimensions();
  const operations = useOperationsData();
  const availability = useMemo(() => resolveOperationsAvailability(operations), [operations]);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [didManualRefreshFail, setDidManualRefreshFail] = useState(false);
  const isRefreshing = isManualRefresh || operations.isRevalidating;
  const layoutMode = resolveVisualLayoutMode(viewportWidth);
  const topology = useMemo(
    () => buildVisualTopology(operations, layoutMode, fontScale),
    [fontScale, layoutMode, operations],
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
          style={[styles.viewport, inlineUnistylesStyle({ minHeight: topology.bounds.height })]}
          testID="visual-viewport"
        >
          {viewportWidth > 0 ? (
            <VisualScene topology={topology} viewportWidth={viewportWidth} />
          ) : null}
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.container} testID="visual-screen">
      <MenuHeader title={t("visual.title")} rightContent={headerAction} />
      <OperationsAvailabilityAlerts
        availability={availability}
        isRevalidating={operations.isRevalidating}
        didManualRefreshFail={didManualRefreshFail}
        surface="visual"
      />
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
  workspaceLastKnown: {
    opacity: 0.68,
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
  workspaceHeaderFocused: {
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.accent,
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
  nodeLastKnown: {
    opacity: 0.64,
  },
  nodeUrgent: {
    borderWidth: theme.borderWidth[2],
  },
  nodeHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface4,
  },
  nodeFocused: {
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface4,
  },
  pressed: {
    opacity: 0.8,
  },
  nodeLeading: {
    width: theme.iconSize.md,
    alignItems: "center",
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
  nodeStateRow: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  nodeState: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  nodeStateUrgent: {
    fontWeight: theme.fontWeight.medium,
  },
  nodeMeta: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  relationshipRow: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  relationshipText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  semanticGlyph: {
    width: 15,
    height: 15,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
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
