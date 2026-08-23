import { describe, expect, it } from "vitest";
import type { OperationsHostFacts, OperationsModel } from "./model";
import { resolveOperationsAvailability } from "./screen-state";

function model(input: {
  hosts?: OperationsHostFacts[];
  agentCount?: number;
  isInitialLoading?: boolean;
}): OperationsModel {
  return {
    hosts: input.hosts ?? [],
    projects: [],
    summary: { working: 0, attention: 0, idle: 0 },
    agentCount: input.agentCount ?? 0,
    liveAgentCount: 0,
    isInitialLoading: input.isInitialLoading ?? false,
    isRevalidating: false,
    hasPartialData: false,
  };
}

describe("resolveOperationsAvailability", () => {
  it("keeps first load distinct from an empty collection", () => {
    expect(resolveOperationsAvailability(model({ isInitialLoading: true })).body).toEqual({
      kind: "initial_loading",
    });
    expect(resolveOperationsAvailability(model({})).body).toEqual({ kind: "empty" });
  });

  it("reports all-host failure when no cached agents remain", () => {
    const hosts: OperationsHostFacts[] = [
      {
        serverId: "offline",
        serverName: "Offline",
        state: { kind: "offline", hasLoadedDirectory: false, error: null },
      },
      {
        serverId: "error",
        serverName: "Error",
        state: {
          kind: "error",
          hasLoadedDirectory: false,
          isOnline: true,
          error: "Directory failed",
        },
      },
    ];

    expect(resolveOperationsAvailability(model({ hosts }))).toEqual({
      body: { kind: "all_hosts_unavailable" },
      unavailableHosts: hosts,
      providerSubagentIssueHosts: [],
      areAllHostsUnavailable: true,
      isPartiallyLoading: false,
    });
  });

  it("keeps cached last-known agents visible when every host is unavailable", () => {
    const offline: OperationsHostFacts = {
      serverId: "offline",
      serverName: "Offline",
      state: { kind: "offline", hasLoadedDirectory: true, error: null },
    };

    expect(resolveOperationsAvailability(model({ hosts: [offline], agentCount: 2 }))).toEqual({
      body: { kind: "content" },
      unavailableHosts: [offline],
      providerSubagentIssueHosts: [],
      areAllHostsUnavailable: true,
      isPartiallyLoading: false,
    });
  });

  it("keeps mixed-host loading visible after another host has loaded", () => {
    const hosts: OperationsHostFacts[] = [
      {
        serverId: "ready",
        serverName: "Ready",
        state: { kind: "ready" },
      },
      {
        serverId: "loading",
        serverName: "Loading",
        state: { kind: "initial_loading" },
      },
    ];

    expect(resolveOperationsAvailability(model({ hosts }))).toEqual({
      body: { kind: "empty" },
      unavailableHosts: [],
      providerSubagentIssueHosts: [],
      areAllHostsUnavailable: false,
      isPartiallyLoading: true,
    });
  });

  it("retains partial-host errors alongside an empty result", () => {
    const unavailable: OperationsHostFacts = {
      serverId: "offline",
      serverName: "Offline",
      state: { kind: "offline", hasLoadedDirectory: false, error: null },
    };
    const hosts: OperationsHostFacts[] = [
      { serverId: "ready", serverName: "Ready", state: { kind: "ready" } },
      unavailable,
    ];

    expect(resolveOperationsAvailability(model({ hosts }))).toEqual({
      body: { kind: "empty" },
      unavailableHosts: [unavailable],
      providerSubagentIssueHosts: [],
      areAllHostsUnavailable: false,
      isPartiallyLoading: false,
    });
  });

  it("reports unsupported and failed provider subagent snapshots without hiding managed data", () => {
    const unsupported: OperationsHostFacts = {
      serverId: "old",
      serverName: "Old",
      state: { kind: "ready" },
      providerSubagentActivity: { kind: "unsupported" },
    };
    const failed: OperationsHostFacts = {
      serverId: "failed",
      serverName: "Failed",
      state: { kind: "ready" },
      providerSubagentActivity: {
        kind: "error",
        hasSnapshot: true,
        error: "snapshot failed",
      },
    };

    expect(
      resolveOperationsAvailability(model({ hosts: [unsupported, failed], agentCount: 2 })),
    ).toEqual({
      body: { kind: "content" },
      unavailableHosts: [],
      providerSubagentIssueHosts: [unsupported, failed],
      areAllHostsUnavailable: false,
      isPartiallyLoading: false,
    });
  });
});
