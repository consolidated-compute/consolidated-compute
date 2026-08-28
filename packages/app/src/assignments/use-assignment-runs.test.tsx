/**
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { useAssignmentRuns } from "./use-assignment-runs";

const { activeOptions, client, historyData, infiniteOptions, recentOptions } = vi.hoisted(() => ({
  activeOptions: { current: [] as Record<string, unknown>[] },
  client: { getTeamRun: vi.fn(), listTeamRuns: vi.fn() },
  historyData: { current: undefined as unknown },
  infiniteOptions: { current: null as Record<string, unknown> | null },
  recentOptions: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/data/query", () => ({
  useFetchInfiniteQuery: (options: Record<string, unknown>) => {
    infiniteOptions.current = options;
    return { data: historyData.current, refetch: vi.fn() };
  },
  useFetchQuery: (options: Record<string, unknown>) => {
    recentOptions.current = options;
    return { data: undefined };
  },
  useFetchQueries: (options: Record<string, unknown>[]) => {
    activeOptions.current = options;
    return [];
  },
}));

describe("useAssignmentRuns", () => {
  afterEach(() => {
    cleanup();
    activeOptions.current = [];
    historyData.current = undefined;
    infiniteOptions.current = null;
    recentOptions.current = null;
    client.listTeamRuns.mockReset();
  });

  it("polls only a bounded recent page while leaving deep history unpolled", async () => {
    client.listTeamRuns.mockResolvedValue({ runs: [], nextCursor: null });

    renderHook(() => useAssignmentRuns("host-1", "assignment-1", { watchForNewRuns: true }));

    expect(infiniteOptions.current).not.toHaveProperty("refetchInterval");
    expect(recentOptions.current).toMatchObject({
      queryKey: ["assignmentRuns", "host-1", "assignment-1", "recent"],
      refetchInterval: 5_000,
    });
    const queryFn = recentOptions.current?.queryFn;
    if (typeof queryFn !== "function") throw new Error("Recent queryFn was not captured");
    await queryFn();
    expect(client.listTeamRuns).toHaveBeenCalledWith({ limit: 100 });
  });

  it("refreshes loaded active runs by ID until they become terminal", () => {
    const runningRun = {
      id: "run-1",
      assignmentId: "assignment-1",
      state: { status: "running", startedAt: "2026-08-27T00:00:00.000Z" },
    } as TeamRunDto;
    historyData.current = {
      pages: [{ runs: [runningRun], nextCursor: null }],
      pageParams: [null],
    };

    renderHook(() => useAssignmentRuns("host-1", "assignment-1"));

    expect(activeOptions.current).toHaveLength(1);
    expect(activeOptions.current[0]).toMatchObject({
      queryKey: ["teamRuns", "host-1", "run", "run-1"],
    });
    const refetchInterval = activeOptions.current[0]?.refetchInterval;
    if (typeof refetchInterval !== "function") {
      throw new Error("Active-run refetchInterval was not captured");
    }
    expect(refetchInterval({ state: { data: runningRun } })).toBe(5_000);
    expect(
      refetchInterval({
        state: {
          data: {
            ...runningRun,
            state: {
              status: "succeeded",
              startedAt: "2026-08-27T00:00:00.000Z",
              endedAt: "2026-08-27T00:01:00.000Z",
            },
          },
        },
      }),
    ).toBe(false);
  });
});
