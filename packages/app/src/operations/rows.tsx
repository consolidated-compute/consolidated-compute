import { ChevronRight, FolderGit2 } from "lucide-react-native";
import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon, type ProviderIconProps } from "@/components/provider-icons";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type {
  OperationsAgentNode,
  OperationsProject,
  OperationsProviderSubagentNode,
  OperationsWorkspace,
} from "./model";

interface OperationsAgentRowProps {
  agent: OperationsAgentNode;
  workspaceId: string | null;
}

function ProviderGlyph({ provider, size, color }: ProviderIconProps & { provider: string }) {
  const ProviderIcon = getProviderIcon(provider);
  return <ProviderIcon size={size} color={color} />;
}

const ThemedProviderGlyph = withUnistyles(ProviderGlyph, (theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foregroundMuted,
}));
const ThemedChevronRight = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedFolderGit2 = withUnistyles(FolderGit2, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function rowStyle(state: PressableStateCallbackType & { hovered?: boolean }): StyleProp<ViewStyle> {
  return [styles.row, state.hovered && styles.rowHovered, state.pressed && styles.rowPressed];
}

function parentText(
  agent: OperationsAgentNode,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!agent.parent || agent.parent.kind === "nested") return null;
  const parentTitle = agent.parent.title || agent.parent.agentId;
  if (agent.parent.kind === "cross_workspace") {
    return t("operations.relationship.crossWorkspace", { parent: parentTitle });
  }
  if (agent.parent.kind === "missing") {
    return t("operations.relationship.missing", { parent: parentTitle });
  }
  return t("operations.relationship.cycle");
}

function workspaceTitle(
  workspace: OperationsWorkspace,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (workspace.title) return workspace.title;
  if (workspace.kind === "unavailable" && workspace.name === "Unavailable workspace") {
    return t("operations.unavailableWorkspace");
  }
  if (workspace.kind === "unassigned" && workspace.name === "Other work") {
    return t("operations.otherWork");
  }
  return workspace.name;
}

function projectTitle(
  project: OperationsProject,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return project.viewKey === null && project.name === "Other work"
    ? t("operations.otherWork")
    : project.name;
}

function statusDotStyle(state: OperationsAgentNode["state"]): StyleProp<ViewStyle> {
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

function OperationsProviderSubagentRow({
  subagent,
}: {
  subagent: OperationsProviderSubagentNode;
}): ReactElement {
  const { t } = useTranslation();
  const title = subagent.label || t("operations.untitledProviderSubagent");
  const stateLabel = t(`operations.states.${subagent.state}`);
  const accessibilityLabel = [
    title,
    t("operations.providerSubagent"),
    stateLabel,
    subagent.isLastKnown ? t("operations.lastKnown") : null,
    subagent.subtitle || null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={styles.row}
      testID={`operations-provider-subagent-${encodeURIComponent(subagent.serverId)}-${encodeURIComponent(subagent.parentAgentId)}-${encodeURIComponent(subagent.subagentId)}`}
    >
      <View style={styles.agentLeading}>
        <View
          style={statusDotStyle(subagent.state)}
          testID={`operations-provider-subagent-state-${subagent.state}`}
        />
        <ThemedProviderGlyph provider={subagent.provider} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.stateText}>{stateLabel}</Text>
          <Text style={styles.metaText}>{t("operations.providerSubagent")}</Text>
          {subagent.isLastKnown ? (
            <Text style={styles.metaText}>{t("operations.lastKnown")}</Text>
          ) : null}
          {subagent.subtitle ? (
            <Text style={styles.metaText} numberOfLines={1}>
              {subagent.subtitle}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function OperationsAgentRow({ agent, workspaceId }: OperationsAgentRowProps): ReactElement {
  const { t } = useTranslation();
  const title = agent.title || t("operations.untitledAgent");
  const stateLabel = t(`operations.states.${agent.state}`);
  const relationship = parentText(agent, t);
  const accessibilityLabel = [
    t("operations.actions.openAgent", { agent: title }),
    stateLabel,
    agent.isLastKnown ? t("operations.lastKnown") : null,
    relationship,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  const openAgent = useCallback(() => {
    navigateToAgent({
      serverId: agent.serverId,
      agentId: agent.agentId,
      workspaceId: workspaceId ?? undefined,
      pin: true,
    });
  }, [agent.agentId, agent.serverId, workspaceId]);

  return (
    <View style={styles.agentTree}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={openAgent}
        style={rowStyle}
        testID={`operations-agent-${agent.serverId}-${agent.agentId}`}
      >
        <View style={styles.agentLeading}>
          <View
            style={statusDotStyle(agent.state)}
            testID={`operations-agent-state-${agent.state}`}
          />
          <ThemedProviderGlyph provider={agent.provider} />
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.metaRow}>
            <Text style={styles.stateText}>{stateLabel}</Text>
            {agent.isLastKnown ? (
              <Text style={styles.metaText}>{t("operations.lastKnown")}</Text>
            ) : null}
            {relationship ? (
              <Text style={styles.metaText} numberOfLines={1}>
                {relationship}
              </Text>
            ) : null}
          </View>
        </View>
        <ThemedChevronRight size={14} />
      </Pressable>
      {agent.children.length > 0 || agent.providerSubagents.length > 0 ? (
        <View
          style={styles.children}
          testID={`operations-agent-children-${agent.serverId}-${agent.agentId}`}
        >
          {agent.children.map((child) => (
            <OperationsAgentRow key={child.key} agent={child} workspaceId={workspaceId} />
          ))}
          {agent.providerSubagents.map((subagent) => (
            <OperationsProviderSubagentRow key={subagent.key} subagent={subagent} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function OperationsWorkspaceRows({
  workspace,
}: {
  workspace: OperationsWorkspace;
}): ReactElement {
  const { t } = useTranslation();
  const title = workspaceTitle(workspace, t);
  const openWorkspace = useCallback(() => {
    if (!workspace.workspaceId) return;
    navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
  }, [workspace.serverId, workspace.workspaceId]);
  const workspaceMeta = workspace.currentBranch
    ? `${workspace.serverName} · ${workspace.currentBranch}`
    : workspace.serverName;
  const accessibilityLabel = [
    t("operations.actions.openWorkspace", { workspace: title }),
    workspaceMeta,
    workspace.isLastKnown ? t("operations.lastKnown") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");

  const content = (
    <>
      <ThemedFolderGit2 size={14} />
      <View style={styles.rowBody}>
        <Text style={styles.workspaceTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.metaText} numberOfLines={1}>
          {workspaceMeta}
          {workspace.isLastKnown ? ` · ${t("operations.lastKnown")}` : ""}
        </Text>
      </View>
      {workspace.workspaceId ? <ThemedChevronRight size={14} /> : null}
    </>
  );

  return (
    <View
      style={styles.workspace}
      testID={`operations-workspace-${workspace.serverId}-${workspace.workspaceId ?? workspace.kind}`}
    >
      {workspace.workspaceId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={openWorkspace}
          style={rowStyle}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.row}>{content}</View>
      )}
      <View style={styles.workspaceAgents}>
        {workspace.agents.map((agent) => (
          <OperationsAgentRow key={agent.key} agent={agent} workspaceId={workspace.workspaceId} />
        ))}
      </View>
    </View>
  );
}

export function OperationsProjectRows({ project }: { project: OperationsProject }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.project} testID={`operations-project-${encodeURIComponent(project.key)}`}>
      <Text accessibilityRole="header" style={styles.projectTitle}>
        {projectTitle(project, t)}
      </Text>
      {project.workspaces.map((workspace) => (
        <OperationsWorkspaceRows key={workspace.key} workspace={workspace} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  project: {
    gap: theme.spacing[1],
  },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  workspace: {
    gap: theme.spacing[1],
  },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  workspaceTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[2],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  stateText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  agentLeading: {
    width: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
  workspaceAgents: {
    marginLeft: theme.spacing[4],
    paddingLeft: theme.spacing[2],
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
  },
  agentTree: {
    gap: theme.spacing[1],
  },
  children: {
    marginLeft: theme.spacing[4],
    paddingLeft: theme.spacing[2],
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
  },
}));
