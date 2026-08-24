import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type {
  OperationsAgentNode,
  OperationsModel,
  OperationsParentRelationshipKind,
  OperationsProviderSubagentNode,
  OperationsWorkspaceKind,
} from "../model";
import { resolveVisualStatePresentation } from "./presentation";

export type VisualLayoutMode = "compact" | "wide";

export interface VisualRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualProjectRegion {
  key: string;
  projectKey: string;
  name: string;
  rect: VisualRect;
  workspaceKeys: readonly string[];
}

export interface VisualWorkspaceRegion {
  key: string;
  projectKey: string;
  workspaceKey: string;
  kind: OperationsWorkspaceKind;
  serverId: string;
  serverName: string;
  workspaceId: string | null;
  name: string;
  title: string;
  directoryState: WorkspaceStateBucket | null;
  liveMostUrgentState: WorkspaceStateBucket | null;
  isLastKnown: boolean;
  rect: VisualRect;
  nodeKeys: readonly string[];
}

interface VisualNodeBase {
  key: string;
  serverId: string;
  workspaceRegionKey: string;
  title: string;
  provider: OperationsAgentNode["provider"] | OperationsProviderSubagentNode["provider"];
  state: WorkspaceStateBucket;
  isLastKnown: boolean;
  canAnimate: boolean;
  depth: number;
  rect: VisualRect;
}

export interface VisualManagedNode extends VisualNodeBase {
  kind: "managed";
  agentId: string;
}

export interface VisualProviderNode extends VisualNodeBase {
  kind: "provider";
  parentAgentId: string;
  subagentId: string;
  subtitle: string;
}

export type VisualNode = VisualManagedNode | VisualProviderNode;

export type VisualRelationshipKind = OperationsParentRelationshipKind | "provider";

export interface VisualRelationship {
  key: string;
  kind: VisualRelationshipKind;
  sourceNodeKey: string;
  targetNodeKey: string | null;
  targetTitle: string;
}

export interface VisualTopology {
  mode: VisualLayoutMode;
  bounds: { width: number; height: number };
  projects: readonly VisualProjectRegion[];
  workspaces: readonly VisualWorkspaceRegion[];
  nodes: readonly VisualNode[];
  relationships: readonly VisualRelationship[];
}

interface LayoutConfig {
  scenePadding: number;
  projectColumns: number;
  projectWidth: number;
  projectGap: number;
  projectPadding: number;
  projectHeaderHeight: number;
  workspaceGap: number;
  workspacePadding: number;
  workspaceHeaderHeight: number;
  nodeColumns: number;
  nodeGap: number;
  nodeHeight: number;
}

const LAYOUT_CONFIG: Record<VisualLayoutMode, LayoutConfig> = {
  compact: {
    scenePadding: 12,
    projectColumns: 1,
    projectWidth: 360,
    projectGap: 16,
    projectPadding: 12,
    projectHeaderHeight: 36,
    workspaceGap: 12,
    workspacePadding: 12,
    workspaceHeaderHeight: 56,
    nodeColumns: 1,
    nodeGap: 12,
    nodeHeight: 96,
  },
  wide: {
    scenePadding: 20,
    projectColumns: 2,
    projectWidth: 480,
    projectGap: 20,
    projectPadding: 16,
    projectHeaderHeight: 36,
    workspaceGap: 16,
    workspacePadding: 16,
    workspaceHeaderHeight: 56,
    nodeColumns: 2,
    nodeGap: 12,
    nodeHeight: 96,
  },
};

type VisualNodeDraft = Omit<VisualManagedNode, "rect"> | Omit<VisualProviderNode, "rect">;

interface WorkspaceLayoutDraft {
  key: string;
  workspaceKey: string;
  kind: OperationsWorkspaceKind;
  serverId: string;
  serverName: string;
  workspaceId: string | null;
  name: string;
  title: string;
  directoryState: WorkspaceStateBucket | null;
  liveMostUrgentState: WorkspaceStateBucket | null;
  isLastKnown: boolean;
  height: number;
  nodes: VisualNodeDraft[];
}

interface ProjectLayoutDraft {
  key: string;
  projectKey: string;
  name: string;
  height: number;
  workspaces: WorkspaceLayoutDraft[];
}

interface ProviderRelationshipSource {
  sourceNodeKey: string;
  targetNodeKey: string;
  targetTitle: string;
}

function identity(kind: string, ...parts: string[]): string {
  return JSON.stringify([kind, ...parts]);
}

function compareIdentity(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function visualProjectRegionKey(projectKey: string): string {
  return identity("project", projectKey);
}

export function visualWorkspaceRegionKey(projectKey: string, workspaceKey: string): string {
  return identity("workspace", projectKey, workspaceKey);
}

export function visualManagedNodeKey(serverId: string, agentId: string): string {
  return identity("managed", serverId, agentId);
}

export function visualProviderNodeKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return identity("provider", serverId, parentAgentId, subagentId);
}

function workspaceHeight(nodeCount: number, config: LayoutConfig): number {
  const rows = Math.ceil(nodeCount / config.nodeColumns);
  const nodeHeight = rows * config.nodeHeight + Math.max(0, rows - 1) * config.nodeGap;
  return config.workspaceHeaderHeight + config.workspacePadding * 2 + nodeHeight;
}

function projectHeight(workspaces: readonly WorkspaceLayoutDraft[], config: LayoutConfig): number {
  return (
    config.projectHeaderHeight +
    config.projectPadding * 2 +
    workspaces.reduce((total, workspace) => total + workspace.height, 0) +
    Math.max(0, workspaces.length - 1) * config.workspaceGap
  );
}

export function buildVisualTopology(
  model: Pick<OperationsModel, "projects">,
  mode: VisualLayoutMode,
): VisualTopology {
  const config = LAYOUT_CONFIG[mode];
  const seenManaged = new Set<string>();
  const seenProvider = new Set<string>();
  const managedNodeKeyByOperationsKey = new Map<string, string>();
  const managedRelationshipSources = new Map<string, OperationsAgentNode>();
  const providerRelationshipSources: ProviderRelationshipSource[] = [];

  const collectManagedNode = (
    node: OperationsAgentNode,
    workspaceRegionKey: string,
    depth: number,
    target: VisualNodeDraft[],
  ) => {
    const key = visualManagedNodeKey(node.serverId, node.agentId);
    if (seenManaged.has(key)) return;
    seenManaged.add(key);
    managedNodeKeyByOperationsKey.set(node.key, key);
    managedRelationshipSources.set(node.key, node);
    target.push({
      key,
      kind: "managed",
      serverId: node.serverId,
      agentId: node.agentId,
      workspaceRegionKey,
      title: node.title?.trim() || node.agentId,
      provider: node.provider,
      state: node.state,
      isLastKnown: node.isLastKnown,
      canAnimate: resolveVisualStatePresentation({
        state: node.state,
        isLastKnown: node.isLastKnown,
      }).canAnimate,
      depth,
    });

    for (const provider of [...node.providerSubagents].sort((left, right) =>
      compareIdentity(left.key, right.key),
    )) {
      const providerKey = visualProviderNodeKey(
        provider.serverId,
        provider.parentAgentId,
        provider.subagentId,
      );
      if (seenProvider.has(providerKey)) continue;
      seenProvider.add(providerKey);
      const title = provider.label.trim() || provider.subagentId;
      target.push({
        key: providerKey,
        kind: "provider",
        serverId: provider.serverId,
        parentAgentId: provider.parentAgentId,
        subagentId: provider.subagentId,
        workspaceRegionKey,
        title,
        subtitle: provider.subtitle,
        provider: provider.provider,
        state: provider.state,
        isLastKnown: provider.isLastKnown,
        canAnimate: resolveVisualStatePresentation({
          state: provider.state,
          isLastKnown: provider.isLastKnown,
        }).canAnimate,
        depth: depth + 1,
      });
      providerRelationshipSources.push({
        sourceNodeKey: providerKey,
        targetNodeKey: key,
        targetTitle: node.title?.trim() || node.agentId,
      });
    }

    for (const child of [...node.children].sort((left, right) =>
      compareIdentity(left.key, right.key),
    )) {
      collectManagedNode(child, workspaceRegionKey, depth + 1, target);
    }
  };

  const projectDrafts: ProjectLayoutDraft[] = [...model.projects]
    .sort((left, right) => compareIdentity(left.key, right.key))
    .map((project) => {
      const workspaces = [...project.workspaces]
        .sort((left, right) => {
          const leftKey = visualWorkspaceRegionKey(project.key, left.key);
          const rightKey = visualWorkspaceRegionKey(project.key, right.key);
          return compareIdentity(leftKey, rightKey);
        })
        .map((workspace): WorkspaceLayoutDraft => {
          const key = visualWorkspaceRegionKey(project.key, workspace.key);
          const nodes: VisualNodeDraft[] = [];
          for (const node of [...workspace.agents].sort((left, right) =>
            compareIdentity(left.key, right.key),
          )) {
            collectManagedNode(node, key, 0, nodes);
          }
          return {
            key,
            workspaceKey: workspace.key,
            kind: workspace.kind,
            serverId: workspace.serverId,
            serverName: workspace.serverName,
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            title: workspace.title?.trim() || workspace.name,
            directoryState: workspace.directoryState,
            liveMostUrgentState: workspace.liveMostUrgentState,
            isLastKnown: workspace.isLastKnown,
            height: workspaceHeight(nodes.length, config),
            nodes,
          };
        });
      return {
        key: visualProjectRegionKey(project.key),
        projectKey: project.key,
        name: project.name,
        height: projectHeight(workspaces, config),
        workspaces,
      };
    });

  const projects: VisualProjectRegion[] = [];
  const workspaces: VisualWorkspaceRegion[] = [];
  const nodes: VisualNode[] = [];
  let rowY = config.scenePadding;

  for (let rowStart = 0; rowStart < projectDrafts.length; rowStart += config.projectColumns) {
    const row = projectDrafts.slice(rowStart, rowStart + config.projectColumns);
    const rowHeight = Math.max(...row.map((project) => project.height));
    for (const [column, project] of row.entries()) {
      const projectX = config.scenePadding + column * (config.projectWidth + config.projectGap);
      const projectRect: VisualRect = {
        x: projectX,
        y: rowY,
        width: config.projectWidth,
        height: project.height,
      };
      projects.push({
        key: project.key,
        projectKey: project.projectKey,
        name: project.name,
        rect: projectRect,
        workspaceKeys: project.workspaces.map((workspace) => workspace.key),
      });

      let workspaceY = rowY + config.projectPadding + config.projectHeaderHeight;
      const workspaceWidth = config.projectWidth - config.projectPadding * 2;
      for (const workspace of project.workspaces) {
        const workspaceRect: VisualRect = {
          x: projectX + config.projectPadding,
          y: workspaceY,
          width: workspaceWidth,
          height: workspace.height,
        };
        const nodeKeys = workspace.nodes.map((node) => node.key);
        workspaces.push({
          key: workspace.key,
          projectKey: project.projectKey,
          workspaceKey: workspace.workspaceKey,
          kind: workspace.kind,
          serverId: workspace.serverId,
          serverName: workspace.serverName,
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          title: workspace.title,
          directoryState: workspace.directoryState,
          liveMostUrgentState: workspace.liveMostUrgentState,
          isLastKnown: workspace.isLastKnown,
          rect: workspaceRect,
          nodeKeys,
        });

        const innerWidth = workspaceWidth - config.workspacePadding * 2;
        const nodeWidth =
          (innerWidth - Math.max(0, config.nodeColumns - 1) * config.nodeGap) / config.nodeColumns;
        for (const [index, node] of workspace.nodes.entries()) {
          const nodeColumn = index % config.nodeColumns;
          const nodeRow = Math.floor(index / config.nodeColumns);
          nodes.push({
            ...node,
            rect: {
              x:
                workspaceRect.x +
                config.workspacePadding +
                nodeColumn * (nodeWidth + config.nodeGap),
              y:
                workspaceRect.y +
                config.workspacePadding +
                config.workspaceHeaderHeight +
                nodeRow * (config.nodeHeight + config.nodeGap),
              width: nodeWidth,
              height: config.nodeHeight,
            },
          } as VisualNode);
        }
        workspaceY += workspace.height + config.workspaceGap;
      }
    }
    rowY += rowHeight + config.projectGap;
  }

  const relationships: VisualRelationship[] = [];
  for (const [operationsKey, node] of managedRelationshipSources) {
    if (!node.parent) continue;
    const sourceNodeKey = managedNodeKeyByOperationsKey.get(operationsKey);
    if (!sourceNodeKey) continue;
    const targetNodeKey = managedNodeKeyByOperationsKey.get(node.parent.key) ?? null;
    relationships.push({
      key: identity(
        "relationship",
        node.parent.kind,
        sourceNodeKey,
        targetNodeKey ?? node.parent.key,
      ),
      kind: node.parent.kind,
      sourceNodeKey,
      targetNodeKey,
      targetTitle: node.parent.title?.trim() || node.parent.agentId,
    });
  }
  for (const source of providerRelationshipSources) {
    relationships.push({
      key: identity("relationship", "provider", source.sourceNodeKey, source.targetNodeKey),
      kind: "provider",
      sourceNodeKey: source.sourceNodeKey,
      targetNodeKey: source.targetNodeKey,
      targetTitle: source.targetTitle,
    });
  }

  const usedColumns = Math.min(projectDrafts.length, config.projectColumns);
  const boundsWidth =
    config.scenePadding * 2 +
    usedColumns * config.projectWidth +
    Math.max(0, usedColumns - 1) * config.projectGap;
  const boundsHeight =
    projectDrafts.length === 0
      ? config.scenePadding * 2
      : rowY - config.projectGap + config.scenePadding;

  return {
    mode,
    bounds: { width: boundsWidth, height: boundsHeight },
    projects: projects.sort((left, right) => compareIdentity(left.key, right.key)),
    workspaces: workspaces.sort((left, right) => compareIdentity(left.key, right.key)),
    nodes,
    relationships: relationships.sort((left, right) => compareIdentity(left.key, right.key)),
  };
}
