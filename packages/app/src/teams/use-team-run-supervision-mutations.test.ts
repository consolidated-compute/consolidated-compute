import { QueryClient } from "@tanstack/react-query";
import type { TeamRunSupervisionStateDto } from "@getpaseo/protocol/team/types";
import { describe, expect, it, vi } from "vitest";
import { teamRunSupervisionQueryKey } from "./supervision-data";
import { teamRunQueryKey } from "./run-data";
import { applyTeamRunSupervisionResponse } from "./use-team-run-supervision-mutations";

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => null }),
}));

describe("Team Run supervision mutations", () => {
  it("cancels stale detail requests before committing the response", async () => {
    const queryClient = new QueryClient();
    const cancelResolvers: Array<() => void> = [];
    const cancelSpy = vi
      .spyOn(queryClient, "cancelQueries")
      .mockImplementation(() => new Promise<void>((resolve) => cancelResolvers.push(resolve)));
    const setSpy = vi.spyOn(queryClient, "setQueryData");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const supervision = {
      runId: "run-1",
      revision: 4,
      status: "planning",
      supervisorRoleId: "supervisor",
      supervisorAgentId: "agent-1",
      completedWorkItems: 0,
      totalWorkItems: 1,
      humanRequest: null,
      updatedAt: "2026-09-02T14:00:00.000Z",
    } satisfies TeamRunSupervisionStateDto;

    const response = applyTeamRunSupervisionResponse(
      queryClient,
      { serverId: "host-1", runId: "run-1" },
      supervision,
    );

    expect(cancelSpy).toHaveBeenNthCalledWith(1, {
      queryKey: teamRunSupervisionQueryKey("host-1", "run-1"),
      exact: true,
    });
    expect(cancelSpy).toHaveBeenNthCalledWith(2, {
      queryKey: teamRunQueryKey("host-1", "run-1"),
      exact: true,
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();

    for (const resolve of cancelResolvers) resolve();
    await response;

    expect(setSpy).toHaveBeenCalledWith(teamRunSupervisionQueryKey("host-1", "run-1"), supervision);
    expect(setSpy).toHaveBeenCalledWith(teamRunQueryKey("host-1", "run-1"), expect.any(Function));
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});
