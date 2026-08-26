/**
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTeamRuns } from "./use-team-runs";

const { client, queryOptions } = vi.hoisted(() => ({
  client: { listTeamRuns: vi.fn() },
  queryOptions: {
    current: null as null | {
      enabled?: boolean;
      queryKey?: readonly unknown[];
      refetchInterval?: number;
    },
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/data/query", () => ({
  useFetchInfiniteQuery: (options: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
    refetchInterval?: number;
  }) => {
    queryOptions.current = options;
    return { data: undefined };
  },
  useFetchQuery: vi.fn(),
}));

describe("useTeamRuns", () => {
  afterEach(() => {
    cleanup();
    queryOptions.current = null;
  });

  it("polls visible Team Run history for remote-client mutations", () => {
    const { rerender } = renderHook(
      ({ teamId }: { teamId: string | null }) => useTeamRuns("host-a", teamId),
      { initialProps: { teamId: "team-1" as string | null } },
    );

    expect(queryOptions.current).toMatchObject({
      enabled: true,
      queryKey: ["teamRuns", "host-a", "team", "team-1", "list"],
      refetchInterval: 5_000,
    });

    rerender({ teamId: null });
    expect(queryOptions.current?.enabled).toBe(false);
  });
});
