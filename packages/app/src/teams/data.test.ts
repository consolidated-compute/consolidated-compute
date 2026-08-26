import { describe, expect, it } from "vitest";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { qualifyTeams, resolveTeamHostState } from "./data";

function team(id: string): TeamDefinitionDto {
  return {
    id,
    revision: 1,
    name: `Team ${id}`,
    instructions: "Work together.",
    roles: [{ id: "builder", name: "Builder", instructions: "Build.", profileId: "codex" }],
    workflow: [{ id: "build", roleId: "builder", instructions: null }],
    createdAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
  };
}

describe("Team host state", () => {
  it("qualifies duplicate daemon-local Team IDs by host", () => {
    const first = qualifyTeams({ serverId: "host-a", serverName: "A" }, [team("same")]);
    const second = qualifyTeams({ serverId: "host-b", serverName: "B" }, [team("same")]);

    expect([first[0]?.key, second[0]?.key]).toEqual(["host-a:same", "host-b:same"]);
  });

  it("keeps cached Teams visible while their host is offline", () => {
    const state = resolveTeamHostState({
      serverId: "host-a",
      serverName: "A",
      connectionStatus: "offline",
      teamsFeature: true,
      agentProfilesFeature: true,
      query: { data: [team("cached")], isLoading: false, isError: false, error: null },
      connectionError: "Host disconnected",
    });

    expect(state).toMatchObject({
      status: "offline",
      canAuthor: false,
      teams: [{ key: "host-a:cached" }],
    });
  });

  it("allows authoring only with both Team and Agent Profile capabilities", () => {
    const state = resolveTeamHostState({
      serverId: "host-a",
      serverName: "A",
      connectionStatus: "online",
      teamsFeature: true,
      agentProfilesFeature: false,
      query: { data: [], isLoading: false, isError: false, error: null },
      connectionError: null,
    });

    expect(state).toMatchObject({ status: "ready", canAuthor: false });
  });

  it("does not call an unsupported host empty", () => {
    const state = resolveTeamHostState({
      serverId: "old-host",
      serverName: "Old host",
      connectionStatus: "online",
      teamsFeature: false,
      agentProfilesFeature: true,
      query: { data: undefined, isLoading: false, isError: false, error: null },
      connectionError: null,
    });

    expect(state.status).toBe("unsupported");
  });

  it.each([
    {
      label: "connecting",
      connectionStatus: "connecting" as const,
      teamsFeature: null,
      isLoading: true,
      isError: false,
      expected: "connecting",
    },
    {
      label: "feature discovery",
      connectionStatus: "online" as const,
      teamsFeature: null,
      isLoading: true,
      isError: false,
      expected: "loading",
    },
    {
      label: "query loading",
      connectionStatus: "online" as const,
      teamsFeature: true,
      isLoading: true,
      isError: false,
      expected: "loading",
    },
    {
      label: "query failure",
      connectionStatus: "online" as const,
      teamsFeature: true,
      isLoading: false,
      isError: true,
      expected: "error",
    },
  ])("resolves the $label state explicitly", (input) => {
    const state = resolveTeamHostState({
      serverId: "host-a",
      serverName: "A",
      connectionStatus: input.connectionStatus,
      teamsFeature: input.teamsFeature,
      agentProfilesFeature: true,
      query: {
        data: undefined,
        isLoading: input.isLoading,
        isError: input.isError,
        error: input.isError ? new Error("Failed") : null,
      },
      connectionError: null,
    });

    expect(state.status).toBe(input.expected);
  });
});
