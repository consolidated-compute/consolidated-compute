import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { ProjectSummary, WorkspaceSummary } from "@/utils/projects";
import type {
  OperationsHostFacts,
  OperationsParentRelationship,
  OperationsWorkspaceKind,
} from "./model";

interface KnownWorkspace {
  projectKey: string;
  projectViewKey: string;
  projectName: string;
  hostName: string;
  workspace: WorkspaceSummary;
}

export interface ProjectDraft {
  key: string;
  viewKey: string | null;
  name: string;
  workspaces: Map<string, WorkspaceDraft>;
}

export interface WorkspaceDraft {
  key: string;
  kind: OperationsWorkspaceKind;
  serverId: string;
  serverName: string;
  workspaceId: string | null;
  name: string;
  title: string | null;
  currentBranch: string | null;
  agents: AgentDraft[];
}

export interface AgentDraft {
  key: string;
  workspaceKey: string;
  agent: AggregatedAgent;
  state: WorkspaceStateBucket;
  isLastKnown: boolean;
  parent: OperationsParentRelationship | null;
  children: AgentDraft[];
}

export function operationsAgentKey(serverId: string, agentId: string): string {
  return `${serverId}\0${agentId}`;
}

export function operationsWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}\0${workspaceId}`;
}

export function compareText(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function buildHostMap(
  hosts: readonly OperationsHostFacts[],
  agents: readonly AggregatedAgent[],
): Map<string, OperationsHostFacts> {
  const byServerId = new Map(hosts.map((host) => [host.serverId, host] as const));
  for (const agent of agents) {
    if (byServerId.has(agent.serverId)) continue;
    byServerId.set(agent.serverId, {
      serverId: agent.serverId,
      serverName: agent.serverLabel,
      state: { kind: "offline", hasLoadedDirectory: false, error: null },
    });
  }
  return byServerId;
}

export function buildKnownWorkspaceMap(
  projects: readonly ProjectSummary[],
): Map<string, KnownWorkspace> {
  const known = new Map<string, KnownWorkspace>();
  const sortedProjects = [...projects].sort(
    (left, right) =>
      compareText(left.viewKey, right.viewKey) || compareText(left.projectName, right.projectName),
  );
  for (const project of sortedProjects) {
    for (const host of project.hosts) {
      for (const workspace of host.workspaces) {
        const workspaceKey = operationsWorkspaceKey(host.serverId, workspace.id);
        if (known.has(workspaceKey)) continue;
        known.set(workspaceKey, {
          projectKey: `known\0${project.viewKey}`,
          projectViewKey: project.viewKey,
          projectName: project.projectName,
          hostName: host.serverName,
          workspace,
        });
      }
    }
  }
  return known;
}

function fallbackLocation(agent: AggregatedAgent): {
  projectKey: string;
  projectName: string;
  workspace: Omit<WorkspaceDraft, "agents">;
} {
  const placement = agent.projectPlacement;
  const projectName = placement?.projectName?.trim() || "Other work";
  const projectKey = placement?.projectKey
    ? `unavailable-project\0${agent.serverId}\0${placement.projectKey}`
    : `other-project\0${agent.serverId}`;
  if (agent.workspaceId) {
    return {
      projectKey,
      projectName,
      workspace: {
        key: operationsWorkspaceKey(agent.serverId, agent.workspaceId),
        kind: "unavailable",
        serverId: agent.serverId,
        serverName: agent.serverLabel,
        workspaceId: agent.workspaceId,
        name: placement?.workspaceName?.trim() || "Unavailable workspace",
        title: null,
        currentBranch: placement?.checkout.currentBranch ?? null,
      },
    };
  }
  return {
    projectKey,
    projectName,
    workspace: {
      key: `unassigned-workspace\0${agent.serverId}`,
      kind: "unassigned",
      serverId: agent.serverId,
      serverName: agent.serverLabel,
      workspaceId: null,
      name: "Other work",
      title: null,
      currentBranch: placement?.checkout.currentBranch ?? null,
    },
  };
}

export function getOrCreateLocation(input: {
  agent: AggregatedAgent;
  knownWorkspaces: ReadonlyMap<string, KnownWorkspace>;
  projectDrafts: Map<string, ProjectDraft>;
}): WorkspaceDraft {
  const knownWorkspace = input.agent.workspaceId
    ? input.knownWorkspaces.get(
        operationsWorkspaceKey(input.agent.serverId, input.agent.workspaceId),
      )
    : undefined;
  const fallback = knownWorkspace ? null : fallbackLocation(input.agent);
  const projectKey = knownWorkspace?.projectKey ?? fallback!.projectKey;
  let project = input.projectDrafts.get(projectKey);
  if (!project) {
    project = {
      key: projectKey,
      viewKey: knownWorkspace?.projectViewKey ?? null,
      name: knownWorkspace?.projectName ?? fallback!.projectName,
      workspaces: new Map(),
    };
    input.projectDrafts.set(projectKey, project);
  }

  const workspaceShape: Omit<WorkspaceDraft, "agents"> = knownWorkspace
    ? {
        key: operationsWorkspaceKey(input.agent.serverId, knownWorkspace.workspace.id),
        kind: "known",
        serverId: input.agent.serverId,
        serverName: knownWorkspace.hostName,
        workspaceId: knownWorkspace.workspace.id,
        name: knownWorkspace.workspace.name,
        title: knownWorkspace.workspace.title ?? null,
        currentBranch: knownWorkspace.workspace.currentBranch,
      }
    : fallback!.workspace;
  let workspace = project.workspaces.get(workspaceShape.key);
  if (!workspace) {
    workspace = { ...workspaceShape, agents: [] };
    project.workspaces.set(workspaceShape.key, workspace);
  }
  return workspace;
}
