import equal from "fast-deep-equal";
import {
  deriveAgentStateBucket,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { ProjectSummary } from "@/utils/projects";
import {
  buildHostMap,
  buildKnownWorkspaceMap,
  compareText,
  getOrCreateLocation,
  operationsAgentKey,
  type AgentDraft,
  type ProjectDraft,
} from "./drafts";
import { buildProjects, connectAgentHierarchy, summarizeAgents } from "./hierarchy";

export type OperationsHostState =
  | { kind: "initial_loading" }
  | { kind: "ready" }
  | { kind: "revalidating" }
  | { kind: "offline"; hasLoadedDirectory: boolean; error: string | null }
  | { kind: "error"; hasLoadedDirectory: boolean; isOnline: boolean; error: string };

export interface OperationsHostFacts {
  serverId: string;
  serverName: string;
  state: OperationsHostState;
}

export interface OperationsSummary {
  working: number;
  attention: number;
  idle: number;
}

export type OperationsWorkspaceKind = "known" | "unavailable" | "unassigned";

export type OperationsParentRelationshipKind = "nested" | "cross_workspace" | "missing" | "cycle";

export interface OperationsParentRelationship {
  kind: OperationsParentRelationshipKind;
  key: string;
  serverId: string;
  agentId: string;
  workspaceKey: string | null;
  title: string | null;
}

export interface OperationsAgentNode {
  key: string;
  serverId: string;
  agentId: string;
  workspaceKey: string;
  title: string | null;
  provider: AggregatedAgent["provider"];
  state: WorkspaceStateBucket;
  isLastKnown: boolean;
  lastActivityAt: Date;
  parent: OperationsParentRelationship | null;
  children: readonly OperationsAgentNode[];
}

export interface OperationsWorkspace {
  key: string;
  kind: OperationsWorkspaceKind;
  serverId: string;
  serverName: string;
  workspaceId: string | null;
  name: string;
  title: string | null;
  currentBranch: string | null;
  isLastKnown: boolean;
  liveMostUrgentState: WorkspaceStateBucket | null;
  lastActivityAt: Date;
  agents: readonly OperationsAgentNode[];
}

export interface OperationsProject {
  key: string;
  viewKey: string | null;
  name: string;
  liveMostUrgentState: WorkspaceStateBucket | null;
  lastActivityAt: Date;
  workspaces: readonly OperationsWorkspace[];
}

export interface OperationsModel {
  hosts: readonly OperationsHostFacts[];
  projects: readonly OperationsProject[];
  summary: OperationsSummary;
  agentCount: number;
  liveAgentCount: number;
  isInitialLoading: boolean;
  isRevalidating: boolean;
  hasPartialData: boolean;
}

export interface BuildOperationsModelInput {
  hosts: readonly OperationsHostFacts[];
  projects: readonly ProjectSummary[];
  agents: readonly AggregatedAgent[];
  previous?: OperationsModel | null;
}

function compareHosts(left: OperationsHostFacts, right: OperationsHostFacts): number {
  return (
    compareText(left.serverName, right.serverName) || compareText(left.serverId, right.serverId)
  );
}

function hasLoadedDirectory(host: OperationsHostFacts): boolean {
  if (host.state.kind === "ready" || host.state.kind === "revalidating") return true;
  if (host.state.kind === "offline" || host.state.kind === "error") {
    return host.state.hasLoadedDirectory;
  }
  return false;
}

function hasLiveDirectory(host: OperationsHostFacts): boolean {
  return host.state.kind === "ready" || host.state.kind === "revalidating";
}

function stabilizeByKey<T extends { key: string }>(
  next: readonly T[],
  previous: readonly T[] | undefined,
): readonly T[] {
  if (!previous) return next;
  const previousByKey = new Map(previous.map((item) => [item.key, item] as const));
  const stable = next.map((item) => {
    const prior = previousByKey.get(item.key);
    return prior && equal(prior, item) ? prior : item;
  });
  return stable.length === previous.length &&
    stable.every((item, index) => item === previous[index])
    ? previous
    : stable;
}

function stabilizeHosts(
  next: readonly OperationsHostFacts[],
  previous: readonly OperationsHostFacts[] | undefined,
): readonly OperationsHostFacts[] {
  if (!previous) return next;
  const previousById = new Map(previous.map((host) => [host.serverId, host] as const));
  const stable = next.map((host) => {
    const prior = previousById.get(host.serverId);
    return prior && equal(prior, host) ? prior : host;
  });
  return stable.length === previous.length &&
    stable.every((host, index) => host === previous[index])
    ? previous
    : stable;
}

export function buildOperationsModel(input: BuildOperationsModelInput): OperationsModel {
  const visibleAgents = input.agents.filter((agent) => !agent.archivedAt);
  const hostByServerId = buildHostMap(input.hosts, visibleAgents);
  const hosts = stabilizeHosts(
    [...hostByServerId.values()].sort(compareHosts),
    input.previous?.hosts,
  );
  const knownWorkspaces = buildKnownWorkspaceMap(input.projects);
  const projectDrafts = new Map<string, ProjectDraft>();
  const agentDrafts: AgentDraft[] = [];
  const draftsByKey = new Map<string, AgentDraft>();

  for (const agent of visibleAgents) {
    const workspace = getOrCreateLocation({ agent, knownWorkspaces, projectDrafts });
    const host = hostByServerId.get(agent.serverId);
    const draft: AgentDraft = {
      key: operationsAgentKey(agent.serverId, agent.id),
      workspaceKey: workspace.key,
      agent,
      state: deriveAgentStateBucket(agent),
      isLastKnown: !host || !hasLiveDirectory(host),
      parent: null,
      children: [],
    };
    workspace.agents.push(draft);
    agentDrafts.push(draft);
    draftsByKey.set(draft.key, draft);
  }

  const parentByChild = connectAgentHierarchy(agentDrafts, draftsByKey);
  const projects = stabilizeByKey(
    buildProjects(projectDrafts, parentByChild),
    input.previous?.projects,
  );
  const nextSummary = summarizeAgents(agentDrafts);
  const summary =
    input.previous && equal(input.previous.summary, nextSummary)
      ? input.previous.summary
      : nextSummary;
  const liveAgentCount = nextSummary.working + nextSummary.attention + nextSummary.idle;
  const isInitialLoading =
    hosts.some((host) => host.state.kind === "initial_loading") &&
    hosts.every((host) => !hasLoadedDirectory(host));
  const isRevalidating = hosts.some((host) => host.state.kind === "revalidating");
  const hasPartialData = hosts.some((host) => host.state.kind !== "ready");

  return {
    hosts,
    projects,
    summary,
    agentCount: agentDrafts.length,
    liveAgentCount,
    isInitialLoading,
    isRevalidating,
    hasPartialData,
  };
}
