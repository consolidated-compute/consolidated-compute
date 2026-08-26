import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { teamListQueryKey } from "./data";
import { invalidateTeamList, prepareTeamListMutation } from "./mutation-cache";

const existingTeam: TeamDefinitionDto = {
  id: "team-1",
  revision: 1,
  name: "Existing",
  instructions: "Ship safely.",
  roles: [{ id: "builder", name: "Builder", instructions: "Build.", profileId: "builder" }],
  workflow: [{ id: "build", roleId: "builder", instructions: null }],
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

describe("Team mutation cache coordination", () => {
  it("prevents an in-flight list response from overwriting a mutation result", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = teamListQueryKey("host-a");
    let resolveList!: (teams: TeamDefinitionDto[]) => void;
    const listRequest = queryClient
      .fetchQuery({
        queryKey,
        queryFn: ({ signal }) =>
          new Promise<TeamDefinitionDto[]>((resolve) => {
            resolveList = resolve;
            signal.addEventListener("abort", () => resolve([existingTeam]));
          }),
      })
      .catch(() => undefined);

    expect(typeof resolveList).toBe("function");
    await prepareTeamListMutation(queryClient, "host-a");
    const createdTeam = { ...existingTeam, id: "team-2", name: "Created" };
    queryClient.setQueryData(queryKey, [createdTeam]);
    resolveList([existingTeam]);
    await listRequest;

    expect(queryClient.getQueryData(queryKey)).toEqual([createdTeam]);
  });

  it("invalidates the host list after a mutation settles", () => {
    const queryClient = new QueryClient();
    const queryKey = teamListQueryKey("host-a");
    queryClient.setQueryData(queryKey, [existingTeam]);

    invalidateTeamList(queryClient, "host-a");

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  });
});
