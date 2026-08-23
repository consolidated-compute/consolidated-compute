import { describe, expect, it } from "vitest";
import type {
  OperationsAgentNode,
  OperationsModel,
  OperationsParentRelationship,
  OperationsProject,
  OperationsProviderSubagentNode,
  OperationsWorkspace,
} from "../model";
import { buildVisualTopology, type VisualRect, type VisualTopology } from "./topology";

const NOW = new Date("2026-08-23T12:00:00.000Z");

function providerNode(
  parent: OperationsAgentNode,
  subagentId: string,
  options: Partial<OperationsProviderSubagentNode> = {},
): OperationsProviderSubagentNode {
  return {
    key: `${parent.serverId}\0${parent.agentId}\0${subagentId}`,
    serverId: parent.serverId,
    parentAgentId: parent.agentId,
    subagentId,
    provider: "codex",
    label: `Provider ${subagentId}`,
    subtitle: "reviewer",
    state: "done",
    isLastKnown: false,
    lastActivityAt: NOW,
    ...options,
  };
}

function managedNode(
  serverId: string,
  agentId: string,
  workspaceKey: string,
  options: Partial<OperationsAgentNode> = {},
): OperationsAgentNode {
  return {
    key: `${serverId}\0${agentId}`,
    serverId,
    agentId,
    workspaceKey,
    title: `Agent ${agentId}`,
    provider: "codex",
    state: "done",
    isLastKnown: false,
    lastActivityAt: NOW,
    parent: null,
    children: [],
    providerSubagents: [],
    ...options,
  };
}

function parentRelationship(
  node: OperationsAgentNode,
  kind: OperationsParentRelationship["kind"],
  options: Partial<OperationsParentRelationship> = {},
): OperationsParentRelationship {
  return {
    kind,
    key: node.key,
    serverId: node.serverId,
    agentId: node.agentId,
    workspaceKey: node.workspaceKey,
    title: node.title,
    ...options,
  };
}

function operationsWorkspace(
  serverId: string,
  workspaceId: string,
  agents: readonly OperationsAgentNode[],
  options: Partial<OperationsWorkspace> = {},
): OperationsWorkspace {
  return {
    key: `${serverId}\0${workspaceId}`,
    kind: "known",
    serverId,
    serverName: `Host ${serverId}`,
    workspaceId,
    name: `Workspace ${workspaceId}`,
    title: null,
    workspaceDirectory: `/repo/${workspaceId}`,
    currentBranch: "main",
    directoryState: "done",
    forgeContext: { kind: "none" },
    isLastKnown: false,
    liveMostUrgentState: "done",
    lastActivityAt: NOW,
    agents,
    ...options,
  };
}

function operationsProject(
  key: string,
  workspaces: readonly OperationsWorkspace[],
  options: Partial<OperationsProject> = {},
): OperationsProject {
  return {
    key,
    viewKey: key,
    name: `Project ${key}`,
    liveMostUrgentState: "done",
    lastActivityAt: NOW,
    workspaces,
    ...options,
  };
}

function model(projects: readonly OperationsProject[]): OperationsModel {
  return {
    hosts: [],
    projects,
    summary: { working: 0, attention: 0, idle: 0 },
    agentCount: 0,
    liveAgentCount: 0,
    isInitialLoading: false,
    isRevalidating: false,
    hasPartialData: false,
  };
}

function placement(topology: VisualTopology) {
  return {
    projects: Object.fromEntries(topology.projects.map((project) => [project.key, project.rect])),
    workspaces: Object.fromEntries(
      topology.workspaces.map((workspace) => [workspace.key, workspace.rect]),
    ),
    nodes: Object.fromEntries(topology.nodes.map((node) => [node.key, node.rect])),
  };
}

function overlaps(left: VisualRect, right: VisualRect): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function contains(outer: VisualRect, inner: VisualRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

describe("buildVisualTopology", () => {
  it("returns stable empty scenes in compact and wide modes", () => {
    expect(buildVisualTopology(model([]), "compact")).toEqual({
      mode: "compact",
      bounds: { width: 24, height: 24 },
      projects: [],
      workspaces: [],
      nodes: [],
      relationships: [],
    });
    expect(buildVisualTopology(model([]), "wide")).toEqual({
      mode: "wide",
      bounds: { width: 40, height: 40 },
      projects: [],
      workspaces: [],
      nodes: [],
      relationships: [],
    });
  });

  it("uses identity-only ordering and keeps coordinates stable across presentation changes", () => {
    const workspaceKey = "alpha\0main";
    const first = managedNode("alpha", "a", workspaceKey, { state: "running" });
    const second = managedNode("alpha", "b", workspaceKey);
    const initial = model([
      operationsProject("project-b", [operationsWorkspace("alpha", "main", [second, first])]),
      operationsProject("project-a", [
        operationsWorkspace("alpha", "other", [managedNode("alpha", "c", "alpha\0other")]),
      ]),
    ]);
    const shuffled = model([
      initial.projects[1]!,
      {
        ...initial.projects[0]!,
        workspaces: [
          {
            ...initial.projects[0]!.workspaces[0]!,
            agents: [first, second],
          },
        ],
      },
    ]);

    expect(buildVisualTopology(shuffled, "wide")).toEqual(buildVisualTopology(initial, "wide"));

    const changed = model([
      {
        ...initial.projects[0]!,
        name: "Renamed project",
        lastActivityAt: new Date("2030-01-01T00:00:00.000Z"),
        workspaces: [
          {
            ...initial.projects[0]!.workspaces[0]!,
            name: "Renamed workspace",
            directoryState: "failed",
            liveMostUrgentState: "attention",
            isLastKnown: true,
            lastActivityAt: new Date("2030-01-01T00:00:00.000Z"),
            agents: [
              {
                ...second,
                title: "Renamed agent",
                state: "needs_input",
                isLastKnown: true,
              },
              {
                ...first,
                state: "done",
                isLastKnown: true,
                lastActivityAt: new Date("2030-01-01T00:00:00.000Z"),
              },
            ],
          },
        ],
      },
      initial.projects[1]!,
    ]);
    const before = buildVisualTopology(initial, "wide");
    const after = buildVisualTopology(changed, "wide");

    expect(placement(after)).toEqual(placement(before));
    expect(after.projects.find((project) => project.projectKey === "project-b")?.name).toBe(
      "Renamed project",
    );
    expect(
      after.nodes.find((node) => node.kind === "managed" && node.agentId === "b"),
    ).toMatchObject({ title: "Renamed agent", state: "needs_input" });
  });

  it("places every node without overlap inside its workspace and project", () => {
    const workspaceKey = "alpha\0main";
    const agents = Array.from({ length: 5 }, (_, index) =>
      managedNode("alpha", `agent-${index}`, workspaceKey),
    );
    for (const mode of ["compact", "wide"] as const) {
      const topology = buildVisualTopology(
        model([operationsProject("project", [operationsWorkspace("alpha", "main", agents)])]),
        mode,
      );
      const project = topology.projects[0]!;
      const workspace = topology.workspaces[0]!;

      expect(contains(project.rect, workspace.rect)).toBe(true);
      for (const node of topology.nodes) expect(contains(workspace.rect, node.rect)).toBe(true);
      for (const [index, node] of topology.nodes.entries()) {
        for (const other of topology.nodes.slice(index + 1)) {
          expect(overlaps(node.rect, other.rect)).toBe(false);
        }
      }
    }
  });

  it("qualifies workspace, managed-agent, and provider identities across hosts", () => {
    const alphaWorkspace = "alpha\0main";
    const betaWorkspace = "beta\0main";
    const alpha = managedNode("alpha", "shared", alphaWorkspace);
    const beta = managedNode("beta", "shared", betaWorkspace);
    alpha.providerSubagents = [providerNode(alpha, "shared-child")];
    beta.providerSubagents = [providerNode(beta, "shared-child")];
    const extra = Array.from({ length: 13 }, (_, index) =>
      managedNode("alpha", `extra-${index}`, alphaWorkspace),
    );
    for (const mode of ["compact", "wide"] as const) {
      const topology = buildVisualTopology(
        model([
          operationsProject("project", [
            operationsWorkspace("alpha", "main", [alpha, ...extra]),
            operationsWorkspace("beta", "main", [beta]),
          ]),
        ]),
        mode,
      );

      expect(topology.nodes).toHaveLength(17);
      expect(new Set(topology.nodes.map((node) => node.key)).size).toBe(17);
      expect(new Set(topology.workspaces.map((workspace) => workspace.key)).size).toBe(2);
      expect(
        topology.nodes
          .filter((node) => node.kind === "managed" && node.agentId === "shared")
          .map((node) => node.serverId)
          .sort(),
      ).toEqual(["alpha", "beta"]);
    }
  });

  it("keeps same-host unassigned workspace regions distinct across projects", () => {
    const sharedWorkspaceKey = "unassigned-workspace\0alpha";
    const first = operationsWorkspace(
      "alpha",
      "unused-a",
      [managedNode("alpha", "first", sharedWorkspaceKey)],
      {
        key: sharedWorkspaceKey,
        kind: "unassigned",
        workspaceId: null,
      },
    );
    const second = operationsWorkspace(
      "alpha",
      "unused-b",
      [managedNode("alpha", "second", sharedWorkspaceKey)],
      {
        key: sharedWorkspaceKey,
        kind: "unassigned",
        workspaceId: null,
      },
    );
    const topology = buildVisualTopology(
      model([operationsProject("project-a", [first]), operationsProject("project-b", [second])]),
      "wide",
    );

    expect(topology.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      sharedWorkspaceKey,
      sharedWorkspaceKey,
    ]);
    expect(new Set(topology.workspaces.map((workspace) => workspace.key)).size).toBe(2);
  });

  it("projects nested, provider, cross-workspace, missing, and cycle relationships without recursion", () => {
    const mainKey = "alpha\0main";
    const reviewKey = "alpha\0review";
    const root = managedNode("alpha", "root", mainKey);
    const nested = managedNode("alpha", "nested", mainKey, {
      parent: parentRelationship(root, "nested"),
    });
    root.children = [nested];
    root.providerSubagents = [providerNode(root, "provider")];
    const crossA = managedNode("alpha", "cross-a", mainKey);
    const crossB = managedNode("alpha", "cross-b", reviewKey);
    crossA.parent = parentRelationship(crossB, "cross_workspace");
    crossB.parent = parentRelationship(crossA, "cross_workspace");
    const missing = managedNode("alpha", "missing-child", reviewKey, {
      parent: {
        kind: "missing",
        key: "alpha\0gone",
        serverId: "alpha",
        agentId: "gone",
        workspaceKey: null,
        title: null,
      },
    });
    const cycle = managedNode("alpha", "cycle", reviewKey);
    cycle.parent = parentRelationship(cycle, "cycle");
    const topology = buildVisualTopology(
      model([
        operationsProject("project", [
          operationsWorkspace("alpha", "main", [crossA, root]),
          operationsWorkspace("alpha", "review", [cycle, crossB, missing]),
        ]),
      ]),
      "wide",
    );

    expect(topology.nodes).toHaveLength(7);
    expect(topology.relationships.map((relationship) => relationship.kind).sort()).toEqual([
      "cross_workspace",
      "cross_workspace",
      "cycle",
      "missing",
      "nested",
      "provider",
    ]);
    expect(
      topology.relationships.find((relationship) => relationship.kind === "missing"),
    ).toMatchObject({ targetNodeKey: null, targetTitle: "gone" });
    expect(new Set(topology.relationships.map((relationship) => relationship.key)).size).toBe(6);
  });

  it("allows motion only for live running nodes", () => {
    const workspaceKey = "alpha\0main";
    const live = managedNode("alpha", "live", workspaceKey, { state: "running" });
    const stale = managedNode("alpha", "stale", workspaceKey, {
      state: "running",
      isLastKnown: true,
    });
    live.providerSubagents = [
      providerNode(live, "live-provider", { state: "running" }),
      providerNode(live, "stale-provider", { state: "running", isLastKnown: true }),
    ];
    const topology = buildVisualTopology(
      model([operationsProject("project", [operationsWorkspace("alpha", "main", [stale, live])])]),
      "compact",
    );

    expect(Object.fromEntries(topology.nodes.map((node) => [node.title, node.canAnimate]))).toEqual(
      {
        "Agent live": true,
        "Agent stale": false,
        "Provider live-provider": true,
        "Provider stale-provider": false,
      },
    );
  });
});
