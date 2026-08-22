import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { ProjectSummary, WorkspaceSummary } from "@/utils/projects";
import {
  buildOperationsModel,
  type OperationsAgentNode,
  type OperationsHostFacts,
  type OperationsHostState,
} from "./model";

function host(
  serverId: string,
  options: { serverName?: string; state?: OperationsHostState } = {},
): OperationsHostFacts {
  return {
    serverId,
    serverName: options.serverName ?? serverId,
    state: options.state ?? { kind: "ready" },
  };
}

function workspace(id: string, name: string): WorkspaceSummary {
  return {
    id,
    name,
    workspaceKind: "worktree",
    status: "done",
    currentBranch: `branch/${id}`,
  };
}

function project(input: {
  viewKey: string;
  name: string;
  hosts: Array<{ serverId: string; serverName?: string; workspaces: WorkspaceSummary[] }>;
}): ProjectSummary {
  return {
    viewKey: input.viewKey,
    projectName: input.name,
    hosts: input.hosts.map((entry) => ({
      serverId: entry.serverId,
      projectId: `project-${entry.serverId}`,
      projectName: input.name,
      projectCustomName: null,
      serverName: entry.serverName ?? entry.serverId,
      isOnline: true,
      repoRoot: `/repo/${input.name}`,
      workspaceCount: entry.workspaces.length,
      workspaces: entry.workspaces,
    })),
    totalWorkspaceCount: input.hosts.reduce((sum, entry) => sum + entry.workspaces.length, 0),
    hostCount: input.hosts.length,
    onlineHostCount: input.hosts.length,
  };
}

function agent(
  input: Partial<AggregatedAgent> & Pick<AggregatedAgent, "id" | "serverId">,
): AggregatedAgent {
  const updatedAt = input.lastActivityAt ?? new Date("2026-08-22T12:00:00.000Z");
  return {
    id: input.id,
    serverId: input.serverId,
    serverLabel: input.serverLabel ?? input.serverId,
    title: input.title ?? input.id,
    status: input.status ?? "closed",
    lastActivityAt: updatedAt,
    cwd: input.cwd ?? `/repo/${input.id}`,
    workspaceId: input.workspaceId,
    provider: input.provider ?? "codex",
    pendingPermissionCount: input.pendingPermissionCount ?? 0,
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: input.attentionTimestamp ?? null,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? updatedAt,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.labels ?? {},
    projectPlacement: input.projectPlacement ?? null,
  };
}

function flatten(nodes: readonly OperationsAgentNode[]): OperationsAgentNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function flattenModelProjects(
  projects: ReturnType<typeof buildOperationsModel>["projects"],
): OperationsAgentNode[] {
  const nodes: OperationsAgentNode[] = [];
  for (const item of projects) {
    for (const itemWorkspace of item.workspaces) nodes.push(...flatten(itemWorkspace.agents));
  }
  return nodes;
}

describe("buildOperationsModel", () => {
  it("groups managed agents once, preserves hierarchy, and excludes offline rows from live totals", () => {
    const model = buildOperationsModel({
      hosts: [
        host("online", { serverName: "Online" }),
        host("offline", {
          state: { kind: "offline", hasLoadedDirectory: true, error: null },
        }),
      ],
      projects: [
        project({
          viewKey: "project-view",
          name: "acme/app",
          hosts: [
            {
              serverId: "online",
              serverName: "Online",
              workspaces: [workspace("main", "Main"), workspace("review", "Review")],
            },
            {
              serverId: "offline",
              workspaces: [workspace("cached", "Cached")],
            },
          ],
        }),
      ],
      agents: [
        agent({ id: "root", serverId: "online", workspaceId: "main", status: "running" }),
        agent({
          id: "same-workspace-child",
          serverId: "online",
          workspaceId: "main",
          parentAgentId: "root",
          pendingPermissionCount: 1,
        }),
        agent({
          id: "cross-workspace-child",
          serverId: "online",
          workspaceId: "review",
          parentAgentId: "root",
          status: "error",
        }),
        agent({
          id: "review-attention",
          serverId: "online",
          workspaceId: "review",
          requiresAttention: true,
          attentionReason: "finished",
        }),
        agent({ id: "idle", serverId: "online", workspaceId: "review" }),
        agent({
          id: "stale-running",
          serverId: "offline",
          workspaceId: "cached",
          status: "running",
        }),
        agent({
          id: "archived",
          serverId: "online",
          workspaceId: "main",
          archivedAt: new Date("2026-08-22T12:30:00.000Z"),
        }),
      ],
    });

    expect(model.summary).toEqual({ working: 1, attention: 3, idle: 1 });
    expect(model.agentCount).toBe(6);
    expect(model.liveAgentCount).toBe(5);
    expect(model.hasPartialData).toBe(true);

    const allNodes = flattenModelProjects(model.projects);
    expect(allNodes.map((node) => `${node.serverId}:${node.agentId}`).sort()).toEqual(
      [
        "online:root",
        "online:same-workspace-child",
        "online:cross-workspace-child",
        "online:review-attention",
        "online:idle",
        "offline:stale-running",
      ].sort(),
    );

    const root = allNodes.find((node) => node.agentId === "root");
    expect(root?.children.map((child) => child.agentId)).toEqual(["same-workspace-child"]);
    expect(root?.children[0]?.state).toBe("needs_input");

    const crossWorkspaceChild = allNodes.find((node) => node.agentId === "cross-workspace-child");
    expect(crossWorkspaceChild?.parent).toMatchObject({
      kind: "cross_workspace",
      agentId: "root",
      workspaceKey: root?.workspaceKey,
    });
    expect(crossWorkspaceChild?.state).toBe("failed");
    expect(allNodes.find((node) => node.agentId === "stale-running")?.isLastKnown).toBe(true);
  });

  it("keeps fallback work visible and breaks malformed parent cycles deterministically", () => {
    const model = buildOperationsModel({
      hosts: [host("alpha"), host("beta")],
      projects: [],
      agents: [
        agent({ id: "a", serverId: "alpha", parentAgentId: "b" }),
        agent({ id: "b", serverId: "alpha", parentAgentId: "a" }),
        agent({ id: "orphan", serverId: "alpha", parentAgentId: "missing" }),
        agent({ id: "a", serverId: "beta" }),
      ],
    });

    expect(model.projects).toHaveLength(2);
    const alphaProject = model.projects.find((item) => item.key.includes("alpha"));
    const alphaNodes = flatten(alphaProject?.workspaces[0]?.agents ?? []);
    expect(alphaNodes).toHaveLength(3);
    expect(new Set(alphaNodes.map((node) => node.key)).size).toBe(3);
    expect(alphaNodes.find((node) => node.agentId === "a")?.parent?.kind).toBe("cycle");
    expect(alphaNodes.find((node) => node.agentId === "b")?.parent?.kind).toBe("nested");
    expect(alphaNodes.find((node) => node.agentId === "orphan")?.parent).toMatchObject({
      kind: "missing",
      agentId: "missing",
    });

    const allNodes = flattenModelProjects(model.projects);
    expect(allNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: "alpha", agentId: "a" }),
        expect.objectContaining({ serverId: "beta", agentId: "a" }),
      ]),
    );
  });

  it("keeps unaffected project references stable across updates", () => {
    const projects = [
      project({
        viewKey: "alpha-project",
        name: "Alpha",
        hosts: [{ serverId: "alpha", workspaces: [workspace("alpha-workspace", "Alpha")] }],
      }),
      project({
        viewKey: "beta-project",
        name: "Beta",
        hosts: [{ serverId: "beta", workspaces: [workspace("beta-workspace", "Beta")] }],
      }),
    ];
    const agents = [
      agent({ id: "alpha-agent", serverId: "alpha", workspaceId: "alpha-workspace" }),
      agent({ id: "beta-agent", serverId: "beta", workspaceId: "beta-workspace" }),
    ];
    const first = buildOperationsModel({
      hosts: [host("alpha"), host("beta")],
      projects,
      agents,
    });
    const betaUpdate = { ...agents[1]!, status: "running" as const };
    const second = buildOperationsModel({
      hosts: [host("alpha"), host("beta")],
      projects,
      agents: [agents[0]!, betaUpdate],
      previous: first,
    });

    const firstAlpha = first.projects.find((item) => item.viewKey === "alpha-project");
    const secondAlpha = second.projects.find((item) => item.viewKey === "alpha-project");
    const firstBeta = first.projects.find((item) => item.viewKey === "beta-project");
    const secondBeta = second.projects.find((item) => item.viewKey === "beta-project");
    expect(secondAlpha).toBe(firstAlpha);
    expect(secondBeta).not.toBe(firstBeta);
  });

  it("keeps temporarily unmatched workspace placement in an explicit unavailable group", () => {
    const model = buildOperationsModel({
      hosts: [host("alpha")],
      projects: [],
      agents: [
        agent({
          id: "unmatched",
          serverId: "alpha",
          workspaceId: "missing-workspace",
          projectPlacement: {
            projectKey: "opaque-project-key",
            projectName: "Recovered project",
            workspaceName: "Review branch",
            checkout: {
              cwd: "/repo/review",
              isGit: false,
              currentBranch: null,
              remoteUrl: null,
              worktreeRoot: null,
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          },
        }),
      ],
    });

    expect(model.projects).toHaveLength(1);
    expect(model.projects[0]).toMatchObject({
      viewKey: null,
      name: "Recovered project",
      workspaces: [
        {
          kind: "unavailable",
          workspaceId: "missing-workspace",
          name: "Review branch",
        },
      ],
    });
  });

  it("treats revalidating rows as live and errored directory rows as last-known", () => {
    const model = buildOperationsModel({
      hosts: [
        host("revalidating", { state: { kind: "revalidating" } }),
        host("errored", {
          state: {
            kind: "error",
            hasLoadedDirectory: true,
            isOnline: true,
            error: "directory failed",
          },
        }),
      ],
      projects: [],
      agents: [
        agent({ id: "live", serverId: "revalidating", status: "running" }),
        agent({ id: "stale", serverId: "errored", status: "running" }),
      ],
    });

    expect(model.summary).toEqual({ working: 1, attention: 0, idle: 0 });
    expect(model.isRevalidating).toBe(true);
    expect(model.hasPartialData).toBe(true);
    expect(
      flattenModelProjects(model.projects).find((node) => node.agentId === "stale")?.isLastKnown,
    ).toBe(true);
  });

  it("reports initial loading only while an unloaded host is actively loading", () => {
    const loading = buildOperationsModel({
      hosts: [host("alpha", { state: { kind: "initial_loading" } })],
      projects: [],
      agents: [],
    });
    const offline = buildOperationsModel({
      hosts: [
        host("alpha", {
          state: { kind: "offline", hasLoadedDirectory: false, error: null },
        }),
      ],
      projects: [],
      agents: [],
    });

    expect(loading.isInitialLoading).toBe(true);
    expect(offline.isInitialLoading).toBe(false);
  });
});
