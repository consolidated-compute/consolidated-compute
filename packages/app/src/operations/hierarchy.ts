import {
  getWorkspaceStateBucketPriority,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import type {
  OperationsAgentNode,
  OperationsParentRelationship,
  OperationsProject,
  OperationsSummary,
  OperationsWorkspace,
} from "./model";
import {
  compareText,
  operationsAgentKey,
  type AgentDraft,
  type ProjectDraft,
  type WorkspaceDraft,
} from "./drafts";

const EMPTY_DATE = new Date(0);
const OFFLINE_PRIORITY = 5;

function makeParentRelationship(
  draft: AgentDraft,
  parent: AgentDraft | undefined,
): OperationsParentRelationship | null {
  const parentAgentId = draft.agent.parentAgentId;
  if (!parentAgentId) return null;
  const parentKey = operationsAgentKey(draft.agent.serverId, parentAgentId);
  if (!parent) {
    return {
      kind: parentKey === draft.key ? "cycle" : "missing",
      key: parentKey,
      serverId: draft.agent.serverId,
      agentId: parentAgentId,
      workspaceKey: null,
      title: null,
    };
  }
  return {
    kind: parent.workspaceKey === draft.workspaceKey ? "nested" : "cross_workspace",
    key: parent.key,
    serverId: parent.agent.serverId,
    agentId: parent.agent.id,
    workspaceKey: parent.workspaceKey,
    title: parent.agent.title,
  };
}

function breakCycleAt(
  breakKey: string,
  parentByChild: Map<string, string>,
  draftsByKey: ReadonlyMap<string, AgentDraft>,
): void {
  parentByChild.delete(breakKey);
  const draft = draftsByKey.get(breakKey);
  if (draft?.parent) draft.parent = { ...draft.parent, kind: "cycle" };
}

function breakNestingCycles(
  parentByChild: Map<string, string>,
  draftsByKey: ReadonlyMap<string, AgentDraft>,
): void {
  const complete = new Set<string>();
  for (const start of [...parentByChild.keys()].sort(compareText)) {
    if (complete.has(start)) continue;
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !complete.has(current)) {
      const cycleAt = pathIndex.get(current);
      if (cycleAt !== undefined) {
        const cycle = path.slice(cycleAt).sort(compareText);
        const breakKey = cycle[0];
        if (breakKey) breakCycleAt(breakKey, parentByChild, draftsByKey);
        break;
      }
      pathIndex.set(current, path.length);
      path.push(current);
      current = parentByChild.get(current);
    }
    for (const key of path) complete.add(key);
  }
}

export function connectAgentHierarchy(
  agentDrafts: readonly AgentDraft[],
  draftsByKey: ReadonlyMap<string, AgentDraft>,
): Map<string, string> {
  const parentByChild = new Map<string, string>();
  for (const draft of agentDrafts) {
    const parent = draft.agent.parentAgentId
      ? draftsByKey.get(operationsAgentKey(draft.agent.serverId, draft.agent.parentAgentId))
      : undefined;
    draft.parent = makeParentRelationship(draft, parent);
    if (draft.parent?.kind === "nested") parentByChild.set(draft.key, draft.parent.key);
  }
  breakNestingCycles(parentByChild, draftsByKey);
  for (const [childKey, parentKey] of parentByChild) {
    const child = draftsByKey.get(childKey);
    const parent = draftsByKey.get(parentKey);
    if (child && parent) parent.children.push(child);
  }
  return parentByChild;
}

function livePriority(draft: AgentDraft): number {
  return draft.isLastKnown ? OFFLINE_PRIORITY : getWorkspaceStateBucketPriority(draft.state);
}

function treePriority(draft: AgentDraft): number {
  let priority = livePriority(draft);
  for (const child of draft.children) priority = Math.min(priority, treePriority(child));
  return priority;
}

function treeLastActivity(draft: AgentDraft): number {
  let latest = draft.agent.lastActivityAt.getTime();
  for (const child of draft.children) latest = Math.max(latest, treeLastActivity(child));
  return latest;
}

function compareAgentDrafts(left: AgentDraft, right: AgentDraft): number {
  return (
    treePriority(left) - treePriority(right) ||
    treeLastActivity(right) - treeLastActivity(left) ||
    compareText(left.agent.title ?? "", right.agent.title ?? "") ||
    compareText(left.key, right.key)
  );
}

function toAgentNode(draft: AgentDraft): OperationsAgentNode {
  draft.children.sort(compareAgentDrafts);
  return {
    key: draft.key,
    serverId: draft.agent.serverId,
    agentId: draft.agent.id,
    workspaceKey: draft.workspaceKey,
    title: draft.agent.title,
    provider: draft.agent.provider,
    state: draft.state,
    isLastKnown: draft.isLastKnown,
    lastActivityAt: draft.agent.lastActivityAt,
    parent: draft.parent,
    children: draft.children.map(toAgentNode),
  };
}

function flattenNodes(nodes: readonly OperationsAgentNode[]): OperationsAgentNode[] {
  const flattened: OperationsAgentNode[] = [];
  const visit = (node: OperationsAgentNode) => {
    flattened.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return flattened;
}

function aggregateNodes(nodes: readonly OperationsAgentNode[]): {
  liveMostUrgentState: WorkspaceStateBucket | null;
  lastActivityAt: Date;
} {
  let priority = Number.POSITIVE_INFINITY;
  let state: WorkspaceStateBucket | null = null;
  let lastActivity = 0;
  for (const node of flattenNodes(nodes)) {
    lastActivity = Math.max(lastActivity, node.lastActivityAt.getTime());
    if (node.isLastKnown) continue;
    const nextPriority = getWorkspaceStateBucketPriority(node.state);
    if (nextPriority < priority) {
      priority = nextPriority;
      state = node.state;
    }
  }
  return {
    liveMostUrgentState: state,
    lastActivityAt: lastActivity > 0 ? new Date(lastActivity) : EMPTY_DATE,
  };
}

function compareWorkspaces(left: OperationsWorkspace, right: OperationsWorkspace): number {
  const leftPriority = left.liveMostUrgentState
    ? getWorkspaceStateBucketPriority(left.liveMostUrgentState)
    : OFFLINE_PRIORITY;
  const rightPriority = right.liveMostUrgentState
    ? getWorkspaceStateBucketPriority(right.liveMostUrgentState)
    : OFFLINE_PRIORITY;
  return (
    leftPriority - rightPriority ||
    right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
    compareText(left.title ?? left.name, right.title ?? right.name) ||
    compareText(left.key, right.key)
  );
}

function buildWorkspace(draft: WorkspaceDraft, parentByChild: ReadonlyMap<string, string>) {
  const roots = draft.agents.filter((agent) => !parentByChild.has(agent.key));
  roots.sort(compareAgentDrafts);
  const agents = roots.map(toAgentNode);
  return {
    key: draft.key,
    kind: draft.kind,
    serverId: draft.serverId,
    serverName: draft.serverName,
    workspaceId: draft.workspaceId,
    name: draft.name,
    title: draft.title,
    currentBranch: draft.currentBranch,
    isLastKnown: draft.agents.every((agent) => agent.isLastKnown),
    ...aggregateNodes(agents),
    agents,
  } satisfies OperationsWorkspace;
}

function compareProjects(left: OperationsProject, right: OperationsProject): number {
  const leftPriority = left.liveMostUrgentState
    ? getWorkspaceStateBucketPriority(left.liveMostUrgentState)
    : OFFLINE_PRIORITY;
  const rightPriority = right.liveMostUrgentState
    ? getWorkspaceStateBucketPriority(right.liveMostUrgentState)
    : OFFLINE_PRIORITY;
  return (
    leftPriority - rightPriority ||
    right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
    compareText(left.name, right.name) ||
    compareText(left.key, right.key)
  );
}

export function buildProjects(
  drafts: ReadonlyMap<string, ProjectDraft>,
  parentByChild: ReadonlyMap<string, string>,
): OperationsProject[] {
  const projects: OperationsProject[] = [];
  for (const draft of drafts.values()) {
    const workspaces = [...draft.workspaces.values()]
      .map((workspace) => buildWorkspace(workspace, parentByChild))
      .sort(compareWorkspaces);
    let liveMostUrgentState: WorkspaceStateBucket | null = null;
    let priority = Number.POSITIVE_INFINITY;
    let lastActivity = 0;
    for (const workspace of workspaces) {
      lastActivity = Math.max(lastActivity, workspace.lastActivityAt.getTime());
      if (!workspace.liveMostUrgentState) continue;
      const nextPriority = getWorkspaceStateBucketPriority(workspace.liveMostUrgentState);
      if (nextPriority < priority) {
        priority = nextPriority;
        liveMostUrgentState = workspace.liveMostUrgentState;
      }
    }
    projects.push({
      key: draft.key,
      viewKey: draft.viewKey,
      name: draft.name,
      liveMostUrgentState,
      lastActivityAt: lastActivity > 0 ? new Date(lastActivity) : EMPTY_DATE,
      workspaces,
    });
  }
  return projects.sort(compareProjects);
}

export function summarizeAgents(agents: readonly AgentDraft[]): OperationsSummary {
  const summary: OperationsSummary = { working: 0, attention: 0, idle: 0 };
  for (const agent of agents) {
    if (agent.isLastKnown) continue;
    if (agent.state === "running") summary.working += 1;
    else if (agent.state === "done") summary.idle += 1;
    else summary.attention += 1;
  }
  return summary;
}
