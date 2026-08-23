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
      areAllHostsUnavailable: true,
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
      areAllHostsUnavailable: true,
    });
  });
});
